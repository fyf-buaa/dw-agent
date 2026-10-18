import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import type { Job } from "../src/api-jobs.ts";
import type { Stored } from "../src/api-store.ts";
import type { DiaryEntry, LifeView } from "../src/companion-life-types.ts";
import { DEFAULT_ROLEPLAY, type MemoryRecord } from "../src/companion-types.ts";
import { apiFixture, type EventPage, type Page } from "./api-helpers.ts";
import { deferred, tagged } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const alice = "/api/companions/role/alice";
const bob = "/api/companions/role/bob";
interface DiaryJobResult {
	diary: { date: string; revision: number };
}
const diaryPayload = {
	summary: "把紫色纸船的念头留在今天的字里行间",
	body: "今天的交谈里，你提到了紫色纸船。我把这几个字轻轻放进心里，没有替纸船添上湖面与风声，也不知道它后来会漂向哪里。只是听你说起这个念头，就觉得话语中多了一点柔软的颜色。对我来说，值得留下的是这段真实发生过的交谈，而不是替尚未发生的故事补上结局。纸船仍然留在话题里，我也愿意让今天停在这里，等你下次想说的时候，再慢慢听。",
	tags: ["交谈", "纸船"],
};
const derivatives = {
	share_seed: "今天聊到了紫色纸船。",
	dream_fragments: [{ text: "紫色纸船", weight: 0.7 }],
	continuity_thread: { motif: "紫色纸船", status: "ongoing", next_hint: "下次继续听纸船的话题" },
	long_term_events: [],
};
async function setup() {
	const f = await apiFixture(cleanups, true);
	const response = await f.post("/api/personas", {
		id: "role",
		system_prompt: "Respect evidence and keep fictional and real events distinct.",
		roleplay: {
			...structuredClone(DEFAULT_ROLEPLAY),
			enabled: true,
			name: "Mira",
			identity: "虚构图书管理员",
			timezone: "UTC",
		},
	});
	expect(response.status).toBe(201);
	return f;
}

describe("companion life resources and jobs", () => {
	it("keeps passive views inference-free, isolates revisions and durably registers scheduling", async () => {
		const f = await setup();
		expect((await fetch(`${f.origin}${alice}/life`)).status).toBe(401);
		const initial = await f.read<Stored<LifeView>>(`${alice}/life`);
		expect(initial.data.state.initialized).toBe(false);
		const update = {
			expected_revision: initial.data.settings.revision,
			config: { ...initial.data.settings.config, weather_context: "暮色中的薄雾", humanized_state_intensity: 75 },
		};
		expect((await f.patch(`${alice}/life/settings`, update)).status).toBe(200);
		expect((await f.patch(`${alice}/life/settings`, update)).status).toBe(409);
		const advanced = await f.post(`${alice}/life/advance`, {}, "advance-once");
		expect(advanced.status).toBe(200);
		const current = (await advanced.json()) as Stored<LifeView>;
		expect(await (await f.post(`${alice}/life/advance`, {}, "advance-once")).json()).toEqual(current);
		const addedResponse = await f.post(
			`${alice}/life/conditions`,
			{ expected_revision: current.revision, label: "想安静整理心情", duration_hours: 12 },
			"condition-once",
		);
		expect(addedResponse.status).toBe(201);
		const added = (await addedResponse.json()) as Stored<LifeView>;
		const condition = added.data.state.conditions.find((entry) => entry.label === "想安静整理心情")!;
		expect(condition).toBeDefined();
		expect(
			(
				await f.patch(`${alice}/life/conditions/${condition.id}`, {
					expected_revision: current.revision,
					operation: "remove",
				})
			).status,
		).toBe(409);
		expect(
			(
				await f.patch(`${alice}/life/conditions/${condition.id}`, {
					expected_revision: added.revision,
					operation: "remove",
				})
			).status,
		).toBe(200);
		const other = await f.read<Stored<LifeView>>(`${bob}/life`);
		expect(other.data.settings.config.weather_context).toBe("");
		expect(other.data.state.initialized).toBe(false);
		const registration = await f.read<Stored<{ enabled: boolean }>>(`${alice}/schedule`);
		expect(registration.data.enabled).toBe(false);
		const scheduledResponse = await f.patch(`${alice}/schedule`, {
			expected_revision: registration.revision,
			enabled: true,
		});
		expect(scheduledResponse.status).toBe(200);
		const scheduled = await scheduledResponse.json();
		await f.restart();
		expect(await f.read(`${alice}/schedule`)).toEqual(scheduled);
		expect((await f.read<Stored<{ enabled: boolean }>>(`${bob}/schedule`)).data.enabled).toBe(false);
		expect((await f.read<Stored<LifeView>>(`${alice}/life`)).data.settings.config.weather_context).toBe(
			"暮色中的薄雾",
		);
		expect(f.faux.state.callCount).toBe(0);
	});

	it("generates once as a durable job and removes evidence-derived content after forgetting", async () => {
		const f = await setup();
		const session = await f.createSession({ persona_id: "role", user_id: "alice" });
		f.faux.setResponses([fauxAssistantMessage(tagged("我听见了，你今天想聊紫色纸船。"))]);
		const run = (await (
			await f.post(`/api/sessions/${session.id}/messages`, { text: "我今天想和你聊紫色纸船，还没有真的去折。" })
		).json()) as Stored<{ status: string }>;
		await f.settle(`/api/runs/${run.id}`);
		expect(f.faux.state.callCount).toBe(1);
		const episode = (await f.read<Page<MemoryRecord>>(`${alice}/memories?kind=episode`)).items[0];
		expect(
			episode.data.sources.some((source) => source.speaker === "user" && source.quote.includes("紫色纸船")),
		).toBe(true);
		f.faux.setResponses([
			fauxAssistantMessage(JSON.stringify(diaryPayload)),
			fauxAssistantMessage(JSON.stringify(derivatives)),
		]);
		const created = await f.post(`${alice}/jobs`, { kind: "diary" }, "diary-once");
		expect(created.status).toBe(202);
		const job = (await created.json()) as Stored<Job>;
		const completed = await f.settle<Job>(`/api/jobs/${job.id}`);
		const result = completed.data.result as DiaryJobResult;
		const diary = await f.read<Stored<DiaryEntry>>(`${alice}/diaries/${result.diary.date}`);
		expect(diary.data).toMatchObject({ source: "model", model_calls: 2 });
		expect(diary.data.evidence.some((entry) => entry.level === "confirmed" && entry.memory_id === episode.id)).toBe(
			true,
		);
		expect(JSON.stringify(completed.data.result)).not.toContain(diaryPayload.body);
		expect(await (await f.post(`${alice}/jobs`, { kind: "diary" }, "diary-once")).json()).toMatchObject({
			id: job.id,
		});
		expect(f.faux.state.callCount).toBe(3);
		const date = result.diary!.date;
		expect((await f.request(`${bob}/diaries/${date}`)).status).toBe(404);
		expect(
			(
				await f.patch(`${alice}/memories/${episode.id}`, {
					expected_revision: episode.revision,
					operation: "forget",
				})
			).status,
		).toBe(200);
		expect((await f.request(`${alice}/diaries/${date}`)).status).toBe(404);
		expect((await f.read<Page<unknown>>(`${alice}/diaries`)).items).toEqual([]);
		const next = await f.createSession({ persona_id: "role", user_id: "alice" });
		f.faux.setResponses([
			(context) => {
				expect(getCurrentSystemPrompt(context.messages)).not.toContain("紫色纸船");
				return fauxAssistantMessage(tagged("从新的话题继续。"));
			},
		]);
		const nextRun = (await (
			await f.post(`/api/sessions/${next.id}/messages`, { text: "换个新话题。" })
		).json()) as Stored<{ status: string }>;
		await f.settle(`/api/runs/${nextRun.id}`);
		await f.restart();
		expect((await f.request(`${alice}/diaries/${date}`)).status).toBe(404);
		expect((await f.read<Stored<LifeView>>(`${alice}/life`)).data.today_diary_deleted).toBe(true);
		const retainedJob = await f.read<Stored<Job>>(`/api/jobs/${job.id}`);
		expect(retainedJob.data.status).toBe("completed");
		expect(JSON.stringify(retainedJob.data.result)).not.toContain("紫色纸船");
		expect(f.faux.state.callCount).toBe(4);
	});

	it("survives client disconnect until explicit cancellation and never resurrects a tombstoned day", async () => {
		const f = await setup();
		const initial = await f.read<Stored<LifeView>>(`${alice}/life`);
		const entered = deferred();
		const release = deferred();
		const aborted = deferred();
		cleanups.push(async () => {
			release.resolve();
		});
		f.faux.setResponses([
			async (_context, options) => {
				entered.resolve();
				const abort = () => {
					aborted.resolve();
					release.resolve();
				};
				if (options?.signal?.aborted) abort();
				else options?.signal?.addEventListener("abort", abort, { once: true });
				await release.promise;
				return fauxAssistantMessage(JSON.stringify(diaryPayload));
			},
		]);
		const controller = new AbortController();
		const response = await f.request(`${alice}/jobs`, {
			method: "POST",
			headers: { "Idempotency-Key": "disconnect-job" },
			body: JSON.stringify({ kind: "diary" }),
			signal: controller.signal,
		});
		expect(response.status).toBe(202);
		const job = (await response.json()) as Stored<Job>;
		await entered.promise;
		controller.abort();
		expect((await f.read<Stored<Job>>(`/api/jobs/${job.id}`)).data.status).toBe("running");
		const outsiderResponse = await f.post("/api/tokens", {
			name: "Bob jobs",
			permissions: ["read", "manage"],
			companion_scopes: ["role:bob"],
			expires_at: new Date(Date.now() + 3600000).toISOString(),
		});
		const outsider = (await outsiderResponse.json()) as { token: string };
		expect((await f.request(`/api/jobs/${job.id}`, {}, outsider.token)).status).toBe(403);
		expect((await f.post(`/api/jobs/${job.id}/cancel`, {}, "outsider-cancel", outsider.token)).status).toBe(403);
		expect((await f.read<Page<Job>>("/api/jobs", outsider.token)).items).toEqual([]);
		const removed = await f.request(`${alice}/diaries/${initial.data.state.date}?expected_revision=0`, {
			method: "DELETE",
		});
		expect(removed.status).toBe(200);
		expect((await f.post(`/api/jobs/${job.id}/cancel`, {}, "cancel-diary")).status).toBe(202);
		await aborted.promise;
		const cancelled = await f.settle<Job>(`/api/jobs/${job.id}`, "cancelled");
		expect(cancelled.data.usage.input_tokens).toBeGreaterThanOrEqual(0);
		expect(await (await f.post(`/api/jobs/${job.id}/cancel`, {}, "cancel-diary")).json()).toMatchObject({
			id: job.id,
		});
		await f.restart();
		expect((await f.request(`${alice}/diaries/${initial.data.state.date}`)).status).toBe(404);
		expect((await f.read<Stored<Job>>(`/api/jobs/${job.id}`)).data.status).toBe("cancelled");
		const retry = (await (
			await f.post(`${alice}/jobs`, { kind: "diary", force: true, expected_revision: 0 })
		).json()) as Stored<Job>;
		await f.settle<Job>(`/api/jobs/${retry.id}`, "failed");
		expect((await f.request(`${alice}/diaries/${initial.data.state.date}`)).status).toBe(404);
		expect(
			(await f.read<EventPage>("/api/events?stream_id=companion:role:alice")).items.some(
				(event) => event.type === "job.changed" && event.data.status === "cancelled",
			),
		).toBe(true);
		expect(f.faux.state.callCount).toBe(1);
	});
});
