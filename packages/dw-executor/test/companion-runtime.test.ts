import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanionRuntime, sanitizeCompanionMetadata, validateRoleplayConfig } from "../src/companion-runtime.ts";
import { CompanionStore } from "../src/companion-store.ts";
import {
	type CompanionDelta,
	type CompanionTurn,
	DEFAULT_ROLEPLAY,
	type MemoryContextEntry,
	type MemoryScope,
	type RoleplayConfig,
} from "../src/companion-types.ts";

const NOW = Date.UTC(2026, 9, 17, 12);
const DAY = 86_400_000;
const scope: MemoryScope = { persona_id: "guide", user_id: "local" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "dw-companion-runtime-"));
	const store = await CompanionStore.open(join(root, "memory.sqlite"));
	cleanups.push(async () => {
		store.close();
		await rm(root, { recursive: true, force: true });
	});
	const config: RoleplayConfig = {
		...DEFAULT_ROLEPLAY,
		enabled: true,
		timezone: "UTC",
		routine: [],
		important_dates: [],
		goals: [],
	};
	return { store, runtime: new CompanionRuntime(store), config, root };
}

function turn(config: RoleplayConfig, overrides: Partial<CompanionTurn> = {}): CompanionTurn {
	return {
		scope,
		config,
		persona_revision: "frozen-v1",
		session_id: "session-1",
		run_id: "run-1",
		input: "I enjoy mango tea.",
		speech: "I will remember our fictional garden.",
		occurred_at: NOW,
		...overrides,
	};
}

function proposal(
	overrides: Partial<NonNullable<CompanionDelta["memories"]>[number]> = {},
): NonNullable<CompanionDelta["memories"]>[number] {
	return {
		kind: "fact",
		domain: "user",
		content: "The user enjoys mango tea",
		confidence: 0.8,
		importance: 0.5,
		durability: "normal",
		evidence: { speaker: "user", quote: "I enjoy mango tea." },
		...overrides,
	};
}

function affect(delta = 3): NonNullable<CompanionDelta["affect"]> {
	return {
		valence_delta: 0.3,
		arousal_delta: 0.2,
		affinity_delta: delta,
		evidence_quote: "I enjoy mango tea.",
		reason: "A pleasant exchange",
	};
}

function frameData(context: string): {
	memory: { core: MemoryContextEntry[]; relevant: MemoryContextEntry[] };
} {
	const opening = "<companion_context>";
	return JSON.parse(
		context.slice(context.indexOf(opening) + opening.length, context.lastIndexOf("</companion_context>")),
	);
}

describe("companion runtime with SQLite", () => {
	it("is default-off, read-only while preparing, and does not harvest old messages", async () => {
		const { runtime, store, config } = await setup();
		expect(runtime.prepare(scope, undefined, "mango", NOW)).toEqual({
			scope,
			enabled: false,
			context: "",
			memory_ids: [],
		});
		expect(runtime.profile(scope, undefined, NOW)).toMatchObject({
			enabled: false,
			state: { revision: 0, affinity: 0, stage: "neutral" },
		});
		expect(runtime.commit(turn({ ...config, enabled: false }))).toEqual({ applied: false, warnings: [] });
		const frame = runtime.prepare(scope, config, "mango", NOW);
		expect(frame.enabled).toBe(true);
		expect(frame.memory_ids).toEqual([]);
		expect(store.getState(scope)).toBeUndefined();
		expect(store.counts(scope).active).toBe(0);
		expect(store.hasProcessed(scope, "run-1")).toBe(false);
		runtime.commit(turn(config));
		expect(runtime.profile(scope, config, NOW).state.stage).toBe("neutral");
	});

	it("keeps all model proposals pending, preserves provenance, and closes the approval/recall loop", async () => {
		const { runtime, store, config } = await setup();
		const committed = runtime.commit(turn(config, { metadata: { memories: [proposal()], affect: affect() } }));
		expect(committed).toEqual({ applied: true, warnings: [] });
		expect(store.counts(scope)).toMatchObject({ active: 1, pending: 1 });
		const pending = store.list(scope, { status: "pending" }, NOW).items[0];
		expect(pending).toMatchObject({
			domain: "user",
			kind: "fact",
			sources: [{ speaker: "user", quote: "I enjoy mango tea.", run_id: "run-1", session_id: "session-1" }],
		});
		expect(runtime.prepare(scope, config, "mango", NOW).memory_ids).not.toContain(pending.id);
		const approved = store.mutate(
			scope,
			pending.id,
			{ expected_revision: pending.revision, operation: "approve" },
			NOW,
		);
		const frame = runtime.prepare(scope, config, "mango", NOW);
		expect(frame.memory_ids).toContain(approved.id);
		expect(store.get(scope, approved.id)?.recall_count).toBe(0);
		runtime.markInjected(frame, NOW + 1);
		expect(store.get(scope, approved.id)).toMatchObject({ recall_count: 1, last_recalled_at: NOW + 1 });
		expect(runtime.profile(scope, config, NOW).state).toMatchObject({ affinity: 3, valence: 0.3, arousal: 0.2 });
	});

	it("rejects invented evidence and assistant claims about real user facts without breaking the reply episode", async () => {
		const { runtime, store, config } = await setup();
		const result = runtime.commit(
			turn(config, {
				metadata: {
					memories: [
						proposal({ evidence: { speaker: "user", quote: "I live in Paris" } }),
						proposal({ evidence: { speaker: "assistant", quote: "fictional garden" } }),
					],
					affect: { ...affect(), evidence_quote: "fictional garden" },
				},
			}),
		);
		expect(result.applied).toBe(true);
		expect(result.warnings).toHaveLength(3);
		expect(store.counts(scope)).toMatchObject({ active: 1, pending: 0 });
		expect(runtime.profile(scope, config, NOW).state.affinity).toBe(0);
		expect(store.ledger(scope)).toEqual([]);
	});

	it("separates character/world from user and does not turn temporary states or future plans into active facts", async () => {
		const { runtime, store, config } = await setup();
		const input = "I am sad today. Tomorrow I plan to visit the garden.";
		const speech = "In our story I am a moon librarian and the garden floats.";
		runtime.commit(
			turn(config, {
				input,
				speech,
				metadata: {
					memories: [
						proposal({
							kind: "event",
							content: "The user felt sad today",
							evidence: { speaker: "user", quote: "I am sad today." },
						}),
						proposal({
							kind: "commitment",
							content: "The user plans a garden visit tomorrow",
							evidence: { speaker: "user", quote: "Tomorrow I plan to visit the garden." },
						}),
						proposal({
							domain: "character",
							content: "A fictional moon librarian",
							evidence: { speaker: "assistant", quote: "I am a moon librarian" },
						}),
						proposal({
							domain: "world",
							content: "The fictional garden floats",
							evidence: { speaker: "assistant", quote: "the garden floats" },
						}),
					],
				},
			}),
		);
		const pending = store.list(scope, { status: "pending" }, NOW).items;
		expect(pending).toHaveLength(4);
		expect(pending.map((item) => item.domain).sort()).toEqual(["character", "user", "user", "world"]);
		expect(store.list(scope, { status: "active", kind: "fact" }, NOW).items).toEqual([]);
		const episode = store.list(scope, { kind: "episode" }, NOW).items[0];
		expect(JSON.parse(episode.content)).toEqual({ user: input, character_speech: speech });
		expect(episode.domain).toBe("relationship");
	});

	it("shares dynamic state across sessions/revisions but never across users or personas", async () => {
		const { runtime, store, config } = await setup();
		runtime.commit(turn(config, { metadata: { affect: affect() } }));
		runtime.commit(turn(config, { run_id: "run-2", session_id: "session-2", persona_revision: "frozen-v2" }));
		expect(runtime.profile(scope, config, NOW).state).toMatchObject({ affinity: 3, revision: 2 });
		expect(runtime.prepare(scope, config, "mango", NOW).memory_ids).toContain(
			store.list(scope, { kind: "episode" }, NOW).items[0].id,
		);
		for (const other of [
			{ ...scope, user_id: "another" },
			{ ...scope, persona_id: "another" },
		]) {
			expect(runtime.profile(other, config, NOW).state).toMatchObject({ affinity: 0, revision: 0 });
			expect(runtime.prepare(other, config, "mango", NOW).memory_ids).toEqual([]);
			expect(store.counts(other).active).toBe(0);
		}
	});

	it("enforces an absolute daily affinity cap, local midnight reset, and whole-run idempotence", async () => {
		const { runtime, store, config } = await setup();
		config.timezone = "Asia/Shanghai";
		const beforeMidnight = Date.UTC(2026, 9, 17, 15, 59);
		for (const [index, delta] of [3, -3, 3, -3, 3].entries()) {
			runtime.commit(
				turn(config, { run_id: `cap-${index}`, occurred_at: beforeMidnight, metadata: { affect: affect(delta) } }),
			);
		}
		expect(runtime.profile(scope, config, beforeMidnight).state).toMatchObject({
			affinity: 0,
			affinity_daily_change: 12,
			affinity_day: "2026-10-17",
		});
		const replay = turn(config, { run_id: "cap-0", occurred_at: beforeMidnight, metadata: { affect: affect() } });
		const counts = store.counts(scope);
		expect(runtime.commit(replay)).toEqual({ applied: false, warnings: [] });
		expect(store.counts(scope)).toEqual(counts);
		expect(store.ledger(scope)).toHaveLength(5);
		const afterMidnight = beforeMidnight + 120_000;
		runtime.commit(turn(config, { run_id: "next-day", occurred_at: afterMidnight, metadata: { affect: affect() } }));
		expect(runtime.profile(scope, config, afterMidnight).state).toMatchObject({
			affinity: 3,
			affinity_daily_change: 3,
			affinity_day: "2026-10-18",
		});
	});

	it("replays older completed turns against their own persisted day without refreshing mood or newer caps", async () => {
		const { runtime, store, config, root } = await setup();
		const newerAt = NOW + DAY;
		for (let index = 0; index < 3; index++)
			runtime.commit(
				turn(config, {
					run_id: `older-${index}`,
					metadata: { affect: { ...affect(), valence_delta: 0.1, arousal_delta: 0.05 } },
				}),
			);
		for (let index = 0; index < 4; index++)
			runtime.commit(
				turn(config, {
					run_id: `newer-${index}`,
					occurred_at: newerAt,
					metadata: { affect: { ...affect(), valence_delta: 0.1, arousal_delta: 0.05 } },
				}),
			);
		const before = store.getState(scope)!;
		expect(before).toMatchObject({
			affinity: 21,
			affinity_day: "2026-10-18",
			affinity_daily_change: 12,
			updated_at: newerAt,
			last_interaction_at: newerAt,
		});
		expect(store.getDailyAffinity(scope, "2026-10-17")).toBe(9);
		const completed = turn(config, {
			run_id: "delayed-completed",
			speech: "A delayed conversation from the fictional archive.",
			metadata: { memories: [proposal()], affect: affect() },
		});
		expect(runtime.commit(completed)).toEqual({ applied: true, warnings: [] });
		const replayed = store.getState(scope)!;
		expect(replayed).toMatchObject({
			affinity: 24,
			affinity_day: "2026-10-18",
			affinity_daily_change: 12,
			updated_at: newerAt,
			last_interaction_at: newerAt,
			revision: before.revision + 1,
		});
		expect(replayed.valence).toBeCloseTo(before.valence + 0.3 / 64);
		expect(replayed.arousal).toBeCloseTo(before.arousal + 0.2 / 64);
		expect(store.getDailyAffinity(scope, "2026-10-17")).toBe(12);
		expect(store.getDailyAffinity(scope, "2026-10-18")).toBe(12);
		expect(store.ledger(scope).find((event) => event.run_id === completed.run_id)).toMatchObject({
			delta: 3,
			timestamp: NOW,
		});
		const pending = store.list(scope, { status: "pending" }, newerAt).items[0];
		expect(pending).toMatchObject({ created_at: NOW, sources: [{ timestamp: NOW, run_id: completed.run_id }] });
		const episode = store
			.list(scope, { kind: "episode" }, newerAt)
			.items.find((item) => item.sources.some((source) => source.run_id === completed.run_id));
		expect(episode).toMatchObject({
			created_at: NOW,
			sources: [{ timestamp: NOW }, { timestamp: NOW }],
		});
		store.close();
		const reopened = await CompanionStore.open(join(root, "memory.sqlite"));
		try {
			const recovered = new CompanionRuntime(reopened);
			const counts = reopened.counts(scope);
			expect(recovered.commit(completed)).toEqual({ applied: false, warnings: [] });
			expect(reopened.getState(scope)).toEqual(replayed);
			expect(reopened.counts(scope)).toEqual(counts);
			expect(reopened.getDailyAffinity(scope, "2026-10-17")).toBe(12);
			expect(reopened.getDailyAffinity(scope, "2026-10-18")).toBe(12);
			for (const [run_id, occurred_at] of [
				["another-delayed", NOW],
				["another-newer", newerAt],
			] as const) {
				recovered.commit(turn(config, { run_id, occurred_at, metadata: { affect: affect() } }));
				expect(reopened.ledger(scope).find((event) => event.run_id === run_id)?.delta).toBe(0);
			}
			expect(reopened.getState(scope)).toMatchObject({
				affinity: 24,
				affinity_day: "2026-10-18",
				affinity_daily_change: 12,
				updated_at: newerAt,
				last_interaction_at: newerAt,
			});
			for (const other of [
				{ ...scope, user_id: "another" },
				{ ...scope, persona_id: "another" },
			]) {
				expect(reopened.getDailyAffinity(other, "2026-10-17")).toBe(0);
				expect(reopened.getDailyAffinity(other, "2026-10-18")).toBe(0);
				recovered.commit(turn(config, { scope: other, metadata: { affect: affect() } }));
				expect(recovered.profile(other, config, NOW).state.affinity).toBe(3);
				expect(reopened.getDailyAffinity(other, "2026-10-17")).toBe(3);
			}
			expect(reopened.getDailyAffinity(scope, "2026-10-17")).toBe(12);
			expect(reopened.getDailyAffinity(scope, "2026-10-18")).toBe(12);
		} finally {
			reopened.close();
		}
	});

	it("seeds a directly stored daily allowance and charges only affinity actually applied at a bound", async () => {
		const { runtime, store, config } = await setup();
		const initial = runtime.profile(scope, config, NOW).state;
		store.setState(scope, { ...initial, revision: 1, affinity: 99, affinity_daily_change: 10 });
		runtime.commit(turn(config, { metadata: { affect: affect() } }));
		expect(store.getState(scope)).toMatchObject({ affinity: 100, affinity_daily_change: 11 });
		expect(store.getDailyAffinity(scope, "2026-10-17")).toBe(11);
		expect(store.ledger(scope)[0].delta).toBe(1);
		runtime.commit(turn(config, { run_id: "bound-negative", metadata: { affect: affect(-3) } }));
		expect(store.getState(scope)).toMatchObject({ affinity: 99, affinity_daily_change: 12 });
		expect(store.getDailyAffinity(scope, "2026-10-17")).toBe(12);
	});

	it("keeps idempotency across reopening and forgetting so recovery cannot resurrect a completed run", async () => {
		const { runtime, store, config, root } = await setup();
		const completed = turn(config, { metadata: { memories: [proposal()], affect: affect() } });
		runtime.commit(completed);
		const pending = store.list(scope, { status: "pending" }, NOW).items[0];
		store.mutate(scope, pending.id, { operation: "forget", expected_revision: pending.revision }, NOW);
		store.close();
		const reopened = await CompanionStore.open(join(root, "memory.sqlite"));
		try {
			const recovered = new CompanionRuntime(reopened);
			expect(recovered.commit(completed)).toEqual({ applied: false, warnings: [] });
			expect(reopened.get(scope, pending.id)).toMatchObject({ status: "forgotten", content: "" });
			expect(recovered.profile(scope, config, NOW).state.affinity).toBe(3);
			expect(reopened.ledger(scope)).toHaveLength(1);
		} finally {
			reopened.close();
		}
	});

	it("rolls back episode, proposals and relationship together if the final write fails", async () => {
		const { runtime, store, config } = await setup();
		vi.spyOn(store, "markProcessed").mockImplementationOnce(() => {
			throw new Error("simulated unavailable store");
		});
		expect(() => runtime.commit(turn(config, { metadata: { memories: [proposal()], affect: affect() } }))).toThrow();
		expect(store.getState(scope)).toBeUndefined();
		expect(store.counts(scope)).toMatchObject({ active: 0, pending: 0 });
		expect(store.ledger(scope)).toEqual([]);
		expect(store.hasProcessed(scope, "run-1")).toBe(false);
		expect(store.getDailyAffinity(scope, "2026-10-17")).toBe(0);
		expect(runtime.commit(turn(config)).applied).toBe(true);
	});

	it("decays mood with a four-hour half-life and cools affinity toward zero without punishing silence", async () => {
		const { runtime, store, config } = await setup();
		runtime.updateState(scope, config, { expected_revision: 0, affinity: 30, valence: 0.8, arousal: 0.8 }, NOW);
		const revision = store.getState(scope)?.revision;
		const fourHours = runtime.profile(scope, config, NOW + 4 * 3_600_000);
		expect(fourHours.state.valence).toBeCloseTo(0.4);
		expect(fourHours.state.arousal).toBeCloseTo(0.4);
		expect(runtime.profile(scope, config, NOW + 7 * DAY).state.affinity).toBe(30);
		expect(runtime.profile(scope, config, NOW + 8 * DAY).state.affinity).toBe(29);
		expect(runtime.profile(scope, config, NOW + 200 * DAY).state.affinity).toBe(0);
		expect(store.getState(scope)?.revision).toBe(revision);
		expect(store.getState(scope)?.affinity).toBe(30);
		runtime.updateState(scope, config, { expected_revision: revision, affinity: -30 }, NOW);
		expect(runtime.profile(scope, config, NOW + 200 * DAY).state.affinity).toBe(0);
	});

	it("preserves interaction time and continuous decay when only owner profile text changes", async () => {
		const { runtime, store, config } = await setup();
		runtime.commit(turn(config, { metadata: { affect: affect() } }));
		const revision = store.getState(scope)!.revision;
		const updated = runtime.updateState(
			scope,
			config,
			{
				expected_revision: revision,
				user_name: "Alex",
				relationship_background: "Our fictional academy",
			},
			NOW + 4 * 3_600_000,
		);
		expect(updated.state).toMatchObject({
			affinity: 3,
			last_interaction_at: NOW,
			updated_at: NOW + 4 * 3_600_000,
			user_name: "Alex",
			relationship_background: "Our fictional academy",
		});
		expect(updated.state.valence).toBeCloseTo(0.15);
		expect(updated.state.arousal).toBeCloseTo(0.1);
		expect(runtime.profile(scope, config, NOW + 8 * 3_600_000).state.valence).toBeCloseTo(0.075);
		expect(store.ledger(scope)).toHaveLength(1);
	});

	it("uses stage hysteresis and validates manual scoped state without changing the role card", async () => {
		const { runtime, store, config } = await setup();
		const original = JSON.stringify(config);
		let profile = runtime.updateState(
			scope,
			config,
			{
				expected_revision: 0,
				affinity: 17,
				user_name: "Alex",
				address: "friend",
				relationship_background: "Our shared fictional academy",
			},
			NOW,
		);
		expect(profile.state.stage).toBe("neutral");
		for (const [affinity, stage] of [
			[18, "familiar"],
			[13, "familiar"],
			[11, "neutral"],
		] as const) {
			profile = runtime.updateState(scope, config, { expected_revision: profile.state.revision, affinity }, NOW);
			expect(profile.state.stage).toBe(stage);
		}
		expect(JSON.stringify(config)).toBe(original);
		expect(profile.state.user_name).toBe("Alex");
		expect(store.ledger(scope)).toHaveLength(4);
		expect(() => runtime.updateState(scope, config, { expected_revision: 0, affinity: 99 }, NOW)).toThrow(
			expect.objectContaining({ code: "MEMORY_REVISION_MISMATCH" }),
		);
		expect(() =>
			runtime.updateState(
				scope,
				config,
				{ expected_revision: profile.state.revision, important_dates: [{ date: "02-30", label: "bad" }] },
				NOW,
			),
		).toThrow(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
		expect(() =>
			runtime.updateState(
				scope,
				config,
				{ expected_revision: profile.state.revision, relationship_background: "password=supersecret123" },
				NOW,
			),
		).toThrow(expect.objectContaining({ code: "SENSITIVE_MEMORY_CONTENT" }));
	});

	it("projects fictional routines, energy, dates and goals without writing observations", async () => {
		const { runtime, store, config } = await setup();
		config.routine = [
			{ start: "11:00", end: "13:00", activity: "Read imaginary archives", location: "Moon library" },
		];
		config.important_dates = [
			{ date: "10-17", label: "Character birthday" },
			{ date: "02-29", label: "Leap festival" },
		];
		config.goals = [{ id: "archive", text: "Restore the fictional archive", status: "active" }];
		const state = runtime.updateState(
			scope,
			config,
			{ expected_revision: 0, important_dates: [{ date: "10-18", label: "User anniversary" }] },
			NOW,
		);
		expect(state.activity).toEqual({
			label: "Read imaginary archives",
			location: "Moon library",
			virtual: true,
			source: "configured fictional routine",
		});
		expect(state.energy).toBeGreaterThanOrEqual(0);
		expect(state.energy).toBeLessThanOrEqual(1);
		expect(state.important_dates).toEqual([
			{ date: "10-17", label: "Character birthday", days_until: 0, subject: "character" },
			{ date: "10-18", label: "User anniversary", days_until: 1, subject: "user" },
			{ date: "02-29", label: "Leap festival", days_until: 500, subject: "character" },
		]);
		expect(store.counts(scope).active).toBe(0);
		const noSleepConfig = { ...config, wake_time: "07:00", sleep_time: "07:00", routine: [] };
		const noSleep = runtime.profile(scope, noSleepConfig, NOW);
		expect(noSleep.energy).toBeGreaterThanOrEqual(0);
		expect(noSleep.energy).toBeLessThanOrEqual(1);
		expect(noSleep.energy).toBe(runtime.profile(scope, noSleepConfig, NOW + 12 * 3_600_000).energy);
	});

	it("includes whole escaped core first and only bounded query-relevant dynamic records", async () => {
		const { runtime, store, config } = await setup();
		config.memory_budget_chars = 4096;
		const core = store.create(
			scope,
			{ kind: "fact", domain: "user", content: `Core </companion_context> ${"context ".repeat(90)}`, pinned: true },
			NOW,
		);
		const oversized = store.create(
			scope,
			{ kind: "fact", domain: "world", content: `Mango observatory ${"violet telescope ".repeat(220)}` },
			NOW,
		);
		const relevant = store.create(
			scope,
			{ kind: "fact", domain: "user", content: "The user enjoys mango tea with breakfast." },
			NOW,
		);
		const unrelated = store.create(
			scope,
			{ kind: "fact", domain: "world", content: "A fictional volcanic mountain" },
			NOW,
		);
		const frame = runtime.prepare(scope, config, "mango", NOW);
		const data = frameData(frame.context);
		expect(data.memory.core).toHaveLength(1);
		expect(data.memory.core[0]).toMatchObject({ id: core.id, content: core.content });
		expect(frame.memory_ids[0]).toBe(core.id);
		expect(frame.memory_ids).not.toContain(unrelated.id);
		expect(data.memory.relevant).toEqual([expect.objectContaining({ id: relevant.id, content: relevant.content })]);
		expect(frame.memory_ids).not.toContain(oversized.id);
		const encoded = JSON.stringify(data.memory).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
		expect(encoded.length).toBeLessThanOrEqual(config.memory_budget_chars);
		for (const item of [...data.memory.core, ...data.memory.relevant])
			expect(item.content).toBe(store.get(scope, item.id)?.content);
		expect(frame.context).not.toContain("Core </companion_context>");
		expect(runtime.prepare(scope, config, "", NOW).memory_ids).toEqual([core.id]);
		expect(store.get(scope, core.id)?.recall_count).toBe(0);
	});

	it("bounds long current queries and encoded episode excerpts without slicing JSON records", async () => {
		const { runtime, store, config } = await setup();
		const memory = store.create(
			scope,
			{ kind: "fact", domain: "user", content: "The user collects mango recipes." },
			NOW,
		);
		expect(runtime.prepare(scope, config, "mango ".repeat(10_000), NOW).memory_ids).toContain(memory.id);
		runtime.commit(turn(config, { input: "\u0000".repeat(5000), speech: "\u0001".repeat(5000) }));
		const episode = store.list(scope, { kind: "episode" }, NOW).items[0];
		expect(episode.content.length).toBeLessThanOrEqual(8000);
		expect(JSON.parse(episode.content)).toHaveProperty("character_speech");
		for (const evidence of episode.sources) expect(evidence.quote.length).toBeLessThanOrEqual(1400);
	});

	it("projects bounded source times and expiry without raw evidence and resolves relative dates from sources", async () => {
		const { runtime, store, config } = await setup();
		config.memory_budget_chars = 4096;
		store.create(
			scope,
			{ kind: "fact", domain: "world", content: "The fictional observatory is on a hill", pinned: true },
			NOW - DAY,
		);
		const temporal = store.insert(scope, {
			id: "temporal-mango-visit",
			kind: "commitment",
			domain: "user",
			content: `Mango visit tomorrow <garden> ${"\u0000".repeat(300)}`,
			key: null,
			status: "active",
			pinned: false,
			confidence: 1,
			importance: 1,
			durability: "short",
			expires_at: NOW + DAY,
			created_at: NOW - DAY,
			supersedes: null,
			sources: [
				{
					session_id: "old-session",
					run_id: "old-source",
					speaker: "user",
					quote: "UNPROJECTED_USER_LITERAL",
					timestamp: NOW - 2 * DAY,
				},
				{
					session_id: "recent-session",
					run_id: "recent-source",
					speaker: "assistant",
					quote: "UNPROJECTED_ASSISTANT_LITERAL",
					timestamp: NOW - 12 * 3_600_000,
				},
			],
		});
		const frame = runtime.prepare(scope, config, "mango", NOW);
		const data = frameData(frame.context);
		expect(data.memory.relevant[0]).toMatchObject({
			created_at: NOW - DAY,
			expires_at: NOW + DAY,
			source_time: {
				first: new Date(NOW - 2 * DAY).toISOString(),
				last: new Date(NOW - 12 * 3_600_000).toISOString(),
				speakers: ["user", "assistant"],
			},
		});
		const encoded = JSON.stringify(data.memory).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
		expect(encoded.length).toBeLessThanOrEqual(config.memory_budget_chars);
		expect(data.memory.relevant[0].content).toBe(temporal.content);
		expect(encoded).not.toContain("UNPROJECTED_");
		expect(encoded).not.toContain("old-session");
		expect(data.memory.relevant[0]).not.toHaveProperty("sources");
		expect(frame.context).not.toContain("<garden>");
		expect(runtime.prepare(scope, config, "mango", NOW + DAY).memory_ids).not.toContain(temporal.id);
	});

	it("limits recall to six complete records even with a larger budget", async () => {
		const { runtime, store, config } = await setup();
		for (const content of [
			"Mango observatory tracks violet comets",
			"Mango bakery serves walnut pastries",
			"Mango harbor shelters wooden submarines",
			"Mango academy teaches ancient calligraphy",
			"Mango canyon contains emerald crystals",
			"Mango orchestra performs brass concertos",
			"Mango festival celebrates migrating cranes",
			"Mango laboratory studies magnetic storms",
			"Mango railway crosses frozen tundra",
			"Mango museum exhibits bronze sculptures",
		])
			store.create(scope, { kind: "fact", domain: "world", content }, NOW);
		expect(frameData(runtime.prepare(scope, config, "mango", NOW).context).memory.relevant).toHaveLength(6);
	});

	it("records redacted bounded episodes and rejects sensitive proposal evidence and affect", async () => {
		const { runtime, store, config } = await setup();
		const secret = "password=supersecret123";
		const result = runtime.commit(
			turn(config, {
				input: `${secret} ${"a".repeat(5000)}`,
				speech: "No credentials retained.",
				metadata: {
					memories: [proposal({ content: secret, evidence: { speaker: "user", quote: secret } })],
					affect: { ...affect(), evidence_quote: secret },
				},
			}),
		);
		expect(result.warnings).toHaveLength(2);
		expect(store.counts(scope)).toMatchObject({ pending: 0, active: 1 });
		const episode = store.list(scope, { kind: "episode" }, NOW).items[0];
		expect(JSON.stringify(episode)).not.toContain("supersecret123");
		expect(JSON.parse(episode.content).user.length).toBeLessThanOrEqual(1400);
		expect(runtime.profile(scope, config, NOW).state.affinity).toBe(0);
		expect(sanitizeCompanionMetadata({ memories: [{ content: secret }] })).toBeUndefined();
		const safe = { memories: [{ content: "A fictional bird" }] };
		expect(sanitizeCompanionMetadata(safe)).toBe(safe);
		expect(sanitizeCompanionMetadata(undefined)).toBeUndefined();
	});

	it("updates relationship without retaining memory when memory is disabled, and drops malformed control effects", async () => {
		const { runtime, store, config } = await setup();
		config.memory_enabled = false;
		runtime.commit(turn(config, { metadata: { memories: [proposal()], affect: affect() } }));
		expect(store.counts(scope)).toMatchObject({ active: 0, pending: 0 });
		expect(runtime.profile(scope, config, NOW).state.affinity).toBe(3);
		expect(runtime.prepare(scope, config, "mango", NOW).memory_ids).toEqual([]);
		const result = runtime.commit(
			turn(config, { run_id: "bad-meta", metadata: { affect: { affinity_delta: 100 } } }),
		);
		expect(result.applied).toBe(true);
		expect(runtime.profile(scope, config, NOW).state.affinity).toBe(3);
	});
});

describe("roleplay configuration validation", () => {
	it("rejects invalid timezone, clock, calendar dates, overlapping routine and duplicate goals", () => {
		const config: RoleplayConfig = { ...DEFAULT_ROLEPLAY, timezone: "UTC" };
		const invalid: RoleplayConfig[] = [
			{ ...config, timezone: "Moon/Imaginary" },
			{ ...config, wake_time: "24:00" },
			{ ...config, memory_budget_chars: 2048 },
			{ ...config, important_dates: [{ date: "04-31", label: "Impossible" }] },
			{ ...config, routine: [{ start: "10:00", end: "10:00", activity: "Empty", location: "" }] },
			{
				...config,
				routine: [
					{ start: "23:00", end: "02:00", activity: "Night", location: "" },
					{ start: "01:00", end: "03:00", activity: "Overlap", location: "" },
				],
			},
			{
				...config,
				goals: [
					{ id: "same", text: "One", status: "active" },
					{ id: "same", text: "Two", status: "done" },
				],
			},
		];
		for (const value of invalid)
			expect(() => validateRoleplayConfig(value)).toThrow(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
	});

	it("selects adjacent wrapped routine slots at their boundary", async () => {
		const { runtime, config } = await setup();
		config.wake_time = "07:00";
		config.sleep_time = "07:00";
		config.important_dates = [{ date: "02-29", label: "Leap day" }];
		config.routine = [
			{ start: "23:00", end: "02:00", activity: "Night", location: "Archive" },
			{ start: "02:00", end: "03:00", activity: "Later", location: "Garden" },
		];
		expect(runtime.profile(scope, config, Date.UTC(2026, 9, 17, 23, 30)).activity).toMatchObject({
			label: "Night",
			location: "Archive",
		});
		expect(runtime.profile(scope, config, Date.UTC(2026, 9, 18, 2)).activity).toMatchObject({
			label: "Later",
			location: "Garden",
		});
	});
});
