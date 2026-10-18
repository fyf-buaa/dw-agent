import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import type { Stored } from "../src/api-store.ts";
import {
	type CompanionProfile,
	DEFAULT_ROLEPLAY,
	type MemoryRecord,
	type RankedMemory,
} from "../src/companion-types.ts";
import { apiFixture, type Page, socketClient } from "./api-helpers.ts";
import { tagged } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const alice = "/api/companions/role/alice";
const bob = "/api/companions/role/bob";
interface Recall {
	core: MemoryRecord[];
	items: RankedMemory[];
}
async function setup() {
	const f = await apiFixture(cleanups, true);
	const response = await f.post("/api/personas", {
		id: "role",
		system_prompt: "Keep fictional and real facts separate.",
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

describe("scoped companion resources", () => {
	it("authorizes each scope, isolates state, binds cursors and keeps recall read-only", async () => {
		const f = await setup();
		expect((await fetch(`${f.origin}${alice}`)).status).toBe(401);
		const response = await f.post("/api/tokens", {
			name: "Alice manager",
			permissions: ["read", "manage"],
			session_ids: [],
			companion_scopes: ["role:alice"],
			expires_at: new Date(Date.now() + 3600000).toISOString(),
		});
		const scoped = (await response.json()) as { token: string };
		expect((await f.request(bob, {}, scoped.token)).status).toBe(403);
		expect(
			(
				await f.post(
					`${bob}/memories`,
					{ kind: "fact", domain: "user", content: "Not allowed" },
					"crossscope",
					scoped.token,
				)
			).status,
		).toBe(403);
		expect((await f.patch(`${alice}/state`, { expected_revision: 0, user_name: "Alice" }, "incorrect")).status).toBe(
			401,
		);
		const firstResponse = await f.post(
			`${alice}/memories`,
			{ kind: "fact", domain: "user", content: "Alice收藏紫色望远镜。", pinned: true },
			"memory-once",
			scoped.token,
		);
		expect(firstResponse.status).toBe(201);
		const memory = (await firstResponse.json()) as Stored<MemoryRecord>;
		expect(memory.data).toMatchObject({
			persona_id: "role",
			user_id: "alice",
			status: "active",
			pinned: true,
			recall_count: 0,
		});
		expect(
			await (
				await f.post(
					`${alice}/memories`,
					{ kind: "fact", domain: "user", content: "Alice收藏紫色望远镜。", pinned: true },
					"memory-once",
					scoped.token,
				)
			).json(),
		).toEqual(memory);
		expect((await f.request(`${bob}/memories/${memory.id}`)).status).toBe(404);
		expect((await f.read<Page<MemoryRecord>>(`${bob}/memories`)).items).toEqual([]);
		await f.post(`${alice}/memories`, { kind: "fact", domain: "user", content: "Alice喜欢安静阅读。" });
		const page = await f.read<Page<MemoryRecord>>(`${alice}/memories?limit=1`);
		expect(page.items).toHaveLength(1);
		expect(typeof page.next_cursor).toBe("string");
		expect(
			(await f.read<Page<MemoryRecord>>(`${alice}/memories?limit=1&cursor=${page.next_cursor}`)).items,
		).toHaveLength(1);
		expect((await f.request(`${bob}/memories?limit=1&cursor=${page.next_cursor}`)).status).toBe(400);
		expect((await f.request(`${alice}/memories?status=pending&cursor=${page.next_cursor}`)).status).toBe(400);
		const preview = await f.read<Stored<Recall>>(`${alice}/recall?q=${encodeURIComponent("紫色望远镜")}`);
		expect(preview.data.core.map((item) => item.id)).toContain(memory.id);
		expect((await f.read<Stored<MemoryRecord>>(`${alice}/memories/${memory.id}`)).data.recall_count).toBe(0);
		const profile = await f.read<Stored<CompanionProfile>>(alice);
		const update = {
			expected_revision: profile.revision,
			user_name: "Alice",
			address: "馆长",
			relationship_background: "共同研究虚构星图。",
			important_dates: [{ date: "02-29", label: "纪念日" }],
		};
		expect((await f.patch(`${alice}/state`, update, scoped.token)).status).toBe(200);
		expect((await f.patch(`${alice}/state`, update, scoped.token)).status).toBe(409);
		expect((await f.read<Stored<CompanionProfile>>(bob)).data.state.user_name).toBe("");
		const forgotten = await f.patch(
			`${alice}/memories/${memory.id}`,
			{ expected_revision: memory.revision, operation: "forget" },
			scoped.token,
		);
		expect(forgotten.status).toBe(200);
		const replay = await f.post(
			`${alice}/memories`,
			{ kind: "fact", domain: "user", content: "Alice收藏紫色望远镜。", pinned: true },
			"memory-once",
			scoped.token,
		);
		expect(replay.status).toBe(201);
		const replayBody = await replay.text();
		expect(replayBody).not.toContain("Alice收藏紫色望远镜。");
		expect(JSON.parse(replayBody)).toMatchObject({
			id: memory.id,
			data: { status: "forgotten", content: "", sources: [] },
		});
		expect(f.faux.state.callCount).toBe(0);
	});

	it("captures sourced proposals, publishes committed changes, corrects and forgets without scope leakage", async () => {
		const f = await setup();
		const observer = await socketClient(f.socketUrl, cleanups);
		await observer.subscribe("companion:role:alice");
		const session = await f.createSession({ persona_id: "role", user_id: "alice" });
		const input = "我喜欢乌龙茶。";
		f.faux.setResponses([
			fauxAssistantMessage(
				`${tagged("记下你的茶饮偏好了。")}<companion>${JSON.stringify({ memories: [{ kind: "fact", domain: "user", content: "用户喜欢乌龙茶。", key: "favorite.tea", confidence: 0.95, importance: 0.8, durability: "durable", evidence: { speaker: "user", quote: input } }] })}</companion>`,
			),
		]);
		const run = (await (await f.post(`/api/sessions/${session.id}/messages`, { text: input })).json()) as Stored<{
			status: string;
		}>;
		await f.settle(`/api/runs/${run.id}`);
		const pending = await f.read<Page<MemoryRecord>>(`${alice}/memories?status=pending&kind=fact`);
		expect(pending.items).toHaveLength(1);
		const proposal = pending.items[0];
		expect(proposal.data.sources).toEqual([
			expect.objectContaining({ speaker: "user", quote: input, session_id: session.id }),
		]);
		await observer.wait(
			(event) => event.type === "memory.changed" && "data" in event && event.data.id === proposal.id,
		);
		expect((await f.read<Page<MemoryRecord>>(`${alice}/memories?kind=fact`)).items).toEqual([]);
		const approvedResponse = await f.patch(`${alice}/memories/${proposal.id}`, {
			expected_revision: proposal.revision,
			operation: "approve",
		});
		expect(approvedResponse.status).toBe(200);
		const approved = (await approvedResponse.json()) as Stored<MemoryRecord>;
		expect(approved.data.status).toBe("active");
		expect(
			(
				await f.patch(`${alice}/memories/${proposal.id}`, {
					expected_revision: proposal.revision,
					operation: "archive",
				})
			).status,
		).toBe(409);
		const correctedResponse = await f.patch(`${alice}/memories/${approved.id}`, {
			expected_revision: approved.revision,
			operation: "correct",
			content: "用户现在喜欢茉莉花茶。",
		});
		expect(correctedResponse.status).toBe(200);
		const corrected = (await correctedResponse.json()) as Stored<MemoryRecord>;
		expect(corrected.data).toMatchObject({
			status: "active",
			content: "用户现在喜欢茉莉花茶。",
			supersedes: approved.id,
		});
		expect((await f.read<Stored<MemoryRecord>>(`${alice}/memories/${approved.id}`)).data.status).toBe("superseded");
		const pinnedResponse = await f.patch(`${alice}/memories/${corrected.id}`, {
			expected_revision: corrected.revision,
			operation: "pin",
		});
		const pinned = (await pinnedResponse.json()) as Stored<MemoryRecord>;
		const next = await f.createSession({ persona_id: "role", user_id: "alice" });
		f.faux.setResponses([
			(context) => {
				expect(getCurrentSystemPrompt(context.messages)).toContain("用户现在喜欢茉莉花茶。");
				return fauxAssistantMessage(tagged("沿用新的偏好。"));
			},
		]);
		const nextRun = (await (
			await f.post(`/api/sessions/${next.id}/messages`, { text: "继续聊吧。" })
		).json()) as Stored<{ status: string }>;
		await f.settle(`/api/runs/${nextRun.id}`);
		const recalled = await f.read<Stored<MemoryRecord>>(`${alice}/memories/${pinned.id}`);
		expect(recalled.data.recall_count).toBe(1);
		expect((await f.read<Stored<Recall>>(`${bob}/recall?q=${encodeURIComponent("茶")}`)).data).toMatchObject({
			core: [],
			items: [],
		});
		const forgotten = await f.patch(`${alice}/memories/${pinned.id}`, {
			expected_revision: recalled.revision,
			operation: "forget",
		});
		expect(forgotten.status).toBe(200);
		expect(await forgotten.json()).toMatchObject({ data: { status: "forgotten", content: "", sources: [] } });
		await f.restart();
		const after = await f.read<Stored<Recall>>(`${alice}/recall?q=${encodeURIComponent("茉莉花茶")}`);
		expect(after.data.core.some((item) => item.id === pinned.id)).toBe(false);
		expect(after.data.items.some((item) => item.item.id === pinned.id)).toBe(false);
		expect(f.faux.state.callCount).toBe(2);
	});
});
