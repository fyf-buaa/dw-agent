import { afterEach, describe, expect, it } from "vitest";
import { CompanionLife } from "../src/companion-life.ts";
import { CompanionLifeStore } from "../src/companion-life-store.ts";
import { DEFAULT_LIFE_CONFIG } from "../src/companion-life-types.ts";
import { type CompanionChange, CompanionStore } from "../src/companion-store.ts";
import { DEFAULT_ROLEPLAY } from "../src/companion-types.ts";
import type { PersonaSnapshot } from "../src/providers.ts";

const scope = { persona_id: "guide", user_id: "alice" };
const now = Date.parse("2026-10-18T23:15:00.000Z");
const persona: PersonaSnapshot = {
	id: "guide",
	revision: "native-revision",
	system_prompt: "Fictional life only",
	roleplay: { ...DEFAULT_ROLEPLAY, enabled: true, timezone: "UTC" },
};
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("native persisted companion notifications", () => {
	it("delivers memory writes after the outer commit, omits no-ops and drops rolled-back changes", async () => {
		const memories = await CompanionStore.open(":memory:");
		cleanups.push(() => memories.close());
		const changes: CompanionChange[] = [];
		memories.subscribeChanges((change) => {
			changes.push(change);
			if (typeof change.data.id === "string") expect(memories.get(scope, change.data.id)).toBeDefined();
		});
		memories.transaction(() => {
			memories.create(scope, { kind: "fact", domain: "user", content: "A native committed fact." }, now);
			expect(changes).toEqual([]);
		});
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ scope, kind: "memory.changed", data: { revision: 1, status: "active" } });
		expect(() =>
			memories.transaction(() => {
				memories.create(scope, { kind: "fact", domain: "user", content: "A rolled back fact." }, now);
				throw new Error("rollback");
			}),
		).toThrow("storage transaction failed");
		expect(changes).toHaveLength(1);
		expect(memories.list(scope, { status: "all" }).items).toHaveLength(1);
	});

	it("publishes scheduled native model commits and usage but reads and completed generation no-ops remain silent", async () => {
		const memories = await CompanionStore.open(":memory:");
		const store = await CompanionLifeStore.open(":memory:");
		cleanups.push(
			() => memories.close(),
			() => store.close(),
		);
		store.saveSettings(scope, {
			expected_revision: 0,
			config: {
				...DEFAULT_LIFE_CONFIG,
				enable_daily_plan: false,
				enable_daily_diary: true,
				daily_diary_time: "22:00",
				enable_detail_enhancement: false,
			},
		});
		let calls = 0;
		const life = new CompanionLife({
			store,
			memories,
			now: () => now,
			loadPersona: async () => persona,
			complete: async (request) => {
				calls++;
				request.on_request();
				return {
					text: "unstructured native output",
					provider: "local",
					model: "deterministic",
					usage: { input_tokens: 12, output_tokens: 3 },
				};
			},
		});
		cleanups.push(() => life.close());
		const changes: CompanionChange[] = [];
		life.subscribeChanges((change) => changes.push(change));
		await life.tick();
		expect(calls).toBe(0);
		life.setSchedule(scope, persona, true);
		await life.tick();
		expect(calls).toBe(1);
		expect(store.getDiary(scope, "2026-10-18")?.source).toBe("evidence");
		expect(changes.some((change) => change.kind === "life.diaries.changed")).toBe(true);
		expect(
			changes.some(
				(change) =>
					change.kind === "life.jobs.changed" &&
					JSON.stringify(change.data.usage) === JSON.stringify({ input_tokens: 12, output_tokens: 3 }),
			),
		).toBe(true);
		const count = changes.length;
		life.view(scope, persona);
		await life.generateDiary(scope, persona);
		expect(changes).toHaveLength(count);
		life.removeSchedule(scope);
		await life.tick(now + 86_400_000);
		expect(calls).toBe(1);
	});

	it("never publishes changes from rolled-back life transactions or repeated native job snapshots", async () => {
		const store = await CompanionLifeStore.open(":memory:");
		cleanups.push(() => store.close());
		const changes: CompanionChange[] = [];
		store.subscribeChanges((change) => changes.push(change));
		expect(() =>
			store.transaction(() => {
				store.saveSettings(scope, { expected_revision: 0, config: DEFAULT_LIFE_CONFIG });
				throw new Error("rollback");
			}),
		).toThrow();
		expect(changes).toEqual([]);
		const job = {
			id: "native-job",
			kind: "plan" as const,
			date: "2026-10-18",
			status: "running" as const,
			started_at: now,
			finished_at: null,
			error: null,
			model_calls: 1,
			usage: { input_tokens: 2, output_tokens: 1 },
			warnings: [],
		};
		store.putJob(scope, job);
		const count = changes.length;
		store.putJob(scope, job);
		expect(changes).toHaveLength(count);
	});
	it("does not silently retry interrupted scheduled work after restart", async () => {
		const memories = await CompanionStore.open(":memory:");
		const store = await CompanionLifeStore.open(":memory:");
		cleanups.push(
			() => memories.close(),
			() => store.close(),
		);
		store.saveSettings(scope, {
			expected_revision: 0,
			config: {
				...DEFAULT_LIFE_CONFIG,
				enable_daily_plan: false,
				enable_daily_diary: true,
				daily_diary_time: "00:00",
				enable_detail_enhancement: false,
			},
		});
		store.putJob(scope, {
			id: "interrupted",
			kind: "diary",
			date: "2026-10-18",
			status: "running",
			started_at: now,
			finished_at: null,
			error: null,
			model_calls: 1,
			usage: { input_tokens: 11, output_tokens: 7 },
			warnings: [],
		});
		let calls = 0;
		const life = new CompanionLife({
			store,
			memories,
			now: () => now,
			loadPersona: async () => persona,
			complete: async () => {
				calls++;
				throw new Error("Unexpected restart request");
			},
		});
		cleanups.push(() => life.close());
		life.setSchedule(scope, persona, true);
		await life.tick();
		expect(calls).toBe(0);
		expect(store.jobs(scope)[0]).toMatchObject({
			status: "cancelled",
			error: { code: "LIFE_INTERRUPTED" },
			usage: { input_tokens: 11, output_tokens: 7 },
		});
	});
});
