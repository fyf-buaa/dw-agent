import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIFE_CONFIG } from "../src/companion-life-types.ts";
import { DEFAULT_ROLEPLAY } from "../src/companion-types.ts";
import { ExecutorService } from "../src/service.ts";
import { deferred, fixture } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(backgroundMaintenance = false) {
	const f = await fixture();
	cleanups.push(f.cleanup);
	await f.service.close();
	const options = { ...f.settings, backgroundMaintenance, personaProvider: undefined };
	const service = new ExecutorService(options);
	await service.initialize();
	cleanups.push(() => service.close());
	const persona = await service.api.companion.createPersona({
		id: "guide",
		system_prompt: "Fictional guide. Never invent user evidence.",
		roleplay: { ...DEFAULT_ROLEPLAY, enabled: true, timezone: "UTC" },
	});
	return { service, options, persona, faux: f.faux, scope: { persona_id: "guide", user_id: "alice" } };
}

describe("canonical companion resources", () => {
	it("binds public persona integer revisions to native UUID CAS and preserves schema metadata", async () => {
		const { service, persona } = await setup();
		expect(persona.revision).toBe(1);
		expect(persona.data.persona.revision).not.toBe(String(persona.revision));
		const saved = await service.api.companion.savePersona("guide", {
			expected_revision: persona.revision,
			system_prompt: "Updated fictional guide.",
		});
		expect(saved.revision).toBe(2);
		expect(saved.data.persona.roleplay?.enabled).toBe(true);
		await expect(
			service.api.companion.savePersona("guide", { expected_revision: persona.revision, system_prompt: "Stale." }),
		).rejects.toMatchObject({ code: "REVISION_MISMATCH" });
		const list = await service.api.companion.getPersonas();
		expect(list.items.find((item) => item.id === "guide")?.data.persona.system_prompt).toBe(
			"Updated fictional guide.",
		);
		expect(list.roleplay_defaults).toEqual(DEFAULT_ROLEPLAY);
	});

	it("uses scoped opaque memory cursors and emits only persisted changes without retaining forgotten bodies", async () => {
		const { service, scope } = await setup();
		const api = service.api.companion;
		const stream = `companion:${scope.persona_id}:${scope.user_id}`;
		const first = await api.createMemory(scope, {
			kind: "fact",
			domain: "user",
			content: "The private lighthouse phrase.",
		});
		await api.createMemory(scope, { kind: "fact", domain: "user", content: "Another independent memory." });
		const page = await api.getMemories(scope, { limit: 1 });
		expect(typeof page.next_cursor).toBe("string");
		await expect(
			api.getMemories({ ...scope, user_id: "bob" }, { limit: 1, cursor: page.next_cursor! }),
		).rejects.toMatchObject({ code: "INVALID_CURSOR" });
		expect((await api.getMemories(scope, { limit: 1, cursor: page.next_cursor! })).items).toHaveLength(1);
		const before = service.api.store.events(stream, 0).latest_seq;
		await api.getCompanion(scope);
		await api.getLife(scope);
		await api.previewRecall(scope, "lighthouse");
		expect(service.api.store.events(stream, 0).latest_seq).toBe(before);
		await api.updateMemory(scope, first.id, { expected_revision: first.revision, operation: "forget" });
		expect((await api.getMemory(scope, first.id)).data).toMatchObject({
			status: "forgotten",
			content: "",
			sources: [],
		});
		const event = service.api.store.events(stream, before).items.find((item) => item.type === "memory.changed");
		expect(event?.data).toMatchObject({ id: first.id, status: "forgotten" });
		expect(JSON.stringify(service.api.store.events(stream, 0))).not.toContain("private lighthouse phrase");
	});

	it("persists explicit scheduling registration, disabled state and removal across restart", async () => {
		const { service, options, scope } = await setup();
		expect(service.api.companion.getSchedule(scope)).toMatchObject({ revision: 0, data: { enabled: false } });
		const enabled = await service.api.companion.saveSchedule(scope, { expected_revision: 0, enabled: true });
		const disabled = await service.api.companion.saveSchedule(scope, {
			expected_revision: enabled.revision,
			enabled: false,
		});
		await service.close();
		const restarted = new ExecutorService(options);
		await restarted.initialize();
		cleanups.push(() => restarted.close());
		expect(restarted.api.companion.getSchedule(scope)).toMatchObject({
			revision: disabled.revision,
			data: { enabled: false },
		});
		await restarted.api.companion.removeSchedule(scope, disabled.revision);
		expect(restarted.api.companion.getSchedule(scope)).toMatchObject({ revision: 0, data: { enabled: false } });
		expect(
			restarted.api.store
				.events("companion:guide:alice", 0)
				.items.some((event) => event.type === "schedule.removed"),
		).toBe(true);
	});
	it("routes automatic generation through the same scoped cancellable canonical native job", async () => {
		const { service, faux, scope } = await setup(true);
		await service.api.companion.saveLifeSettings(scope, {
			expected_revision: 0,
			config: {
				...DEFAULT_LIFE_CONFIG,
				enable_daily_plan: false,
				enable_detail_enhancement: false,
				enable_daily_diary: true,
				daily_diary_time: "00:00",
			},
		});
		const entered = deferred();
		const aborted = deferred();
		const release = deferred();
		cleanups.push(() => release.resolve());
		faux.setResponses([
			async (_context, options) => {
				entered.resolve();
				const cancel = () => {
					aborted.resolve();
					release.resolve();
				};
				if (options?.signal?.aborted) cancel();
				else options?.signal?.addEventListener("abort", cancel, { once: true });
				await release.promise;
				return fauxAssistantMessage("not valid diary JSON");
			},
		]);
		const cancelled = deferred();
		const unsubscribe = service.api.store.subscribe((event) => {
			if (
				event.type === "job.changed" &&
				event.stream_id === "companion:guide:alice" &&
				event.data.status === "cancelled"
			)
				cancelled.resolve();
		});
		await service.api.companion.saveSchedule(scope, { expected_revision: 0, enabled: true });
		await entered.promise;
		const jobs = service.api.jobs.list({ filter: { companion_scope: "guide:alice" } }).items;
		expect(jobs).toHaveLength(1);
		expect(jobs[0].data).toMatchObject({ kind: "diary", status: "running" });
		expect(service.api.jobs.cancel(jobs[0].id).data.cancel_requested).toBe(true);
		await aborted.promise;
		await cancelled.promise;
		unsubscribe();
		expect(service.api.jobs.get(jobs[0].id).data.status).toBe("cancelled");
		expect((await service.api.companion.getLife(scope)).data.today_diary_generated).toBe(false);
		expect(faux.state.callCount).toBe(1);
	});
});
