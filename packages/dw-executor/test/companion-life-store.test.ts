import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionLifeStore } from "../src/companion-life-store.ts";
import {
	DEFAULT_LIFE_CONFIG,
	type DiaryEntry,
	type LifeDetail,
	type LifeJob,
	type LifePlan,
	type LifeSimulation,
} from "../src/companion-life-types.ts";
import type { MemoryScope } from "../src/companion-types.ts";

const scope: MemoryScope = { persona_id: "guide", user_id: "alice" };
const otherUser: MemoryScope = { persona_id: "guide", user_id: "bob" };
const otherPersona: MemoryScope = { persona_id: "friend", user_id: "alice" };
const now = 1_800_000_000_000;
const date = "2027-01-15";
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "dw-life-store-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "nested", "companion-life.sqlite");
	const store = await CompanionLifeStore.open(path);
	cleanups.push(() => store.close());
	return { root, path, store };
}

function diary(overrides: Partial<DiaryEntry> = {}): DiaryEntry {
	return {
		date,
		revision: 1,
		generated_at: now,
		persona_revision: "persona-revision-1",
		summary: "记下今天聊过的茶",
		body: "用户今天提到了乌龙茶。我把这段交谈记了下来，想起杯沿轻轻散开的热气。",
		tags: ["茶", "交谈"],
		form: "scene",
		source: "model",
		evidence: [
			{
				level: "confirmed",
				source: "conversation",
				text: "用户说：我喜欢乌龙茶",
				at: now,
				memory_id: "private-memory-id",
				memory_revision: 1,
				run_id: "private-run-id",
				session_id: "private-session-id",
			},
		],
		share_seed: "杯沿的热气",
		dream_fragments: [{ text: "杯沿轻轻散开的热气", weight: 0.5 }],
		continuity_thread: { motif: "茶香", status: "open", next_hint: "下次再聊茶" },
		long_term_events: [],
		model_calls: 2,
		usage: { input_tokens: 100, output_tokens: 80 },
		warnings: [],
		...overrides,
	};
}

function simulation(overrides: Partial<LifeSimulation> = {}): LifeSimulation {
	return {
		revision: 1,
		generated_day: date,
		updated_at: now,
		conditions: [],
		cycle: {
			strategy: "legacy",
			last_start_at: null,
			last_end_at: null,
			next_expected_at: null,
			anchor_at: null,
			offset_signature: "",
			last_discomfort_day: null,
		},
		hunger: { day: date, attempted: [], generated: [] },
		history: [],
		...overrides,
	};
}

function plan(overrides: Partial<LifePlan> = {}): LifePlan {
	return {
		date,
		revision: 1,
		generated_at: now,
		persona_revision: "persona-revision-1",
		source: "configured",
		items: [{ time: "08:00", end: "09:00", activity: "Read a fictional book", mood: "calm" }],
		retry_after: null,
		model_calls: 0,
		usage: { input_tokens: 0, output_tokens: 0 },
		warnings: [],
		...overrides,
	};
}

function detail(overrides: Partial<LifeDetail> = {}): LifeDetail {
	return {
		date,
		segment: "08:00",
		revision: 1,
		generated_at: now,
		persona_revision: "persona-revision-1",
		summary: "虚构的阅读片段",
		location: "虚构书房",
		today_events: [{ time: "08:10", event: "翻开一本旧书", level: "simulated" }],
		model_calls: 1,
		usage: { input_tokens: 20, output_tokens: 10 },
		warnings: [],
		...overrides,
	};
}

function job(overrides: Partial<LifeJob> = {}): LifeJob {
	return {
		id: "job-1",
		kind: "diary",
		date,
		status: "running",
		started_at: now,
		finished_at: null,
		error: null,
		model_calls: 0,
		usage: { input_tokens: 0, output_tokens: 0 },
		warnings: [],
		...overrides,
	};
}

describe("independent companion life storage", () => {
	it("reads cloned default settings and uninitialized state without registering or writing", async () => {
		const { store, path } = await setup();
		const defaults = store.getSettings(scope);
		expect(defaults).toEqual({ revision: 0, config: DEFAULT_LIFE_CONFIG });
		defaults.config.daily_diary_time = "01:02";
		expect(store.getSettings(scope).config.daily_diary_time).toBe("23:10");
		expect(store.getSimulation(scope)).toBeUndefined();
		expect(store.getPlan(scope, date)).toBeUndefined();
		expect(store.details(scope, date)).toEqual([]);
		expect(store.getDiary(scope, date)).toBeUndefined();
		expect(store.getDiaryRevision(scope, date)).toBe(0);
		expect(store.hasDiaryDate(scope, date)).toBe(false);
		expect(store.isDiaryDeleted(scope, date)).toBe(false);
		expect(store.listDiaries(scope)).toEqual({ items: [], next_cursor: null });
		expect(store.jobs(scope)).toEqual([]);
		expect(store.scopes()).toEqual([]);
		store.close();
		const database = new DatabaseSync(path);
		try {
			for (const table of [
				"life_scopes",
				"life_settings",
				"life_simulations",
				"life_plans",
				"life_details",
				"life_diaries",
				"life_jobs",
			])
				expect(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(0);
			expect(database.prepare("PRAGMA application_id").get()?.application_id).toBe(0x44574c46);
			expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
			expect(database.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
		} finally {
			database.close();
		}
	});

	it("isolates settings, private evidence IDs, state, plans, details, jobs and tombstones by both scope IDs", async () => {
		const { store } = await setup();
		store.registerScope(scope, now);
		store.registerScope(scope, now + 1);
		store.saveSettings(scope, {
			expected_revision: 0,
			config: { ...DEFAULT_LIFE_CONFIG, weather_context: "虚构小雨" },
		});
		store.putSimulation(scope, simulation(), 0);
		store.putPlan(scope, plan(), 0);
		store.putDetail(scope, detail(), 0);
		store.putDiary(scope, diary(), 0, 14);
		store.putJob(scope, job());
		store.deleteDiary(scope, "2027-01-14", 0);
		for (const foreign of [otherUser, otherPersona]) {
			expect(store.getSettings(foreign).revision).toBe(0);
			expect(store.getSimulation(foreign)).toBeUndefined();
			expect(store.getPlan(foreign, date)).toBeUndefined();
			expect(store.plans(foreign)).toEqual([]);
			expect(store.getDetail(foreign, date, "08:00")).toBeUndefined();
			expect(store.details(foreign, date)).toEqual([]);
			expect(store.getDiary(foreign, date)).toBeUndefined();
			expect(store.listDiaries(foreign).items).toEqual([]);
			expect(store.jobs(foreign)).toEqual([]);
			expect(store.hasDiaryDate(foreign, "2027-01-14")).toBe(false);
			expect(() => store.deleteDiary(foreign, date, 1)).toThrowError(
				expect.objectContaining({ code: "LIFE_REVISION_MISMATCH" }),
			);
			store.putDiary(foreign, diary({ summary: "独立日记" }), 0, 14);
			store.putJob(foreign, job({ status: "completed", finished_at: now }));
		}
		expect(store.getDiary(scope, date)?.summary).toBe("记下今天聊过的茶");
		expect(store.jobs(scope)[0].status).toBe("running");
		expect(store.scopes()).toEqual([scope]);
		expect(JSON.stringify(store.listDiaries(scope))).not.toMatch(/private-(?:memory|session|run)-id/);
		expect(store.getDiary(scope, date)?.evidence[0].memory_id).toBe("private-memory-id");
	});

	it("requires fresh CAS for settings, simulation, plan, detail and diary writes", async () => {
		const { store } = await setup();
		const settings = store.saveSettings(scope, { expected_revision: 0, config: DEFAULT_LIFE_CONFIG });
		expect(settings.revision).toBe(1);
		settings.config.daily_diary_time = "01:02";
		expect(store.getSettings(scope).config.daily_diary_time).toBe("23:10");
		expect(() => store.saveSettings(scope, { expected_revision: 0, config: DEFAULT_LIFE_CONFIG })).toThrowError(
			expect.objectContaining({ code: "LIFE_REVISION_MISMATCH" }),
		);
		store.putSimulation(scope, simulation(), 0);
		store.putPlan(scope, plan(), 0);
		store.putDetail(scope, detail(), 0);
		store.putDiary(scope, diary(), 0, 14);
		for (const stale of [
			() => store.putSimulation(scope, simulation(), 0),
			() => store.putPlan(scope, plan(), 0),
			() => store.putDetail(scope, detail(), 0),
			() => store.putDiary(scope, diary(), 0, 14),
			() => store.putDiary(scope, diary({ revision: 4 }), 1, 14),
		])
			expect(stale).toThrowError(expect.objectContaining({ code: "LIFE_REVISION_MISMATCH" }));
		store.putSimulation(scope, simulation({ revision: 2, updated_at: now + 1 }), 1);
		store.putDetail(scope, detail({ revision: 2 }), 1);
		expect(store.getDetail(scope, date, "08:00")?.revision).toBe(2);
		store.putPlan(scope, plan({ revision: 2 }), 1);
		store.putDiary(scope, diary({ revision: 2 }), 1, 14);
		expect(store.getSimulation(scope)?.revision).toBe(2);
		expect(store.getPlan(scope, date)?.revision).toBe(2);
		expect(store.getDetail(scope, date, "08:00")).toBeUndefined();
		expect(store.getDiary(scope, date)?.revision).toBe(2);
	});

	it("invalidates every cached detail only for the replaced plan's scope and date, including after reopen", async () => {
		const { store, path } = await setup();
		const nextDate = "2027-01-16";
		const originalPlan = plan({
			items: [{ time: "09:00", end: "10:00", activity: "Read a fictional book", mood: "calm" }],
		});
		const replacement = plan({
			revision: 2,
			items: [{ time: "09:00", end: "10:00", activity: "Walk in a fictional garden", mood: "bright" }],
		});
		const oldDetail = detail({ segment: "09:00" });
		store.putPlan(scope, originalPlan, 0);
		store.putDetail(scope, oldDetail, 0);
		store.putDetail(scope, detail({ segment: "10:00" }), 0);
		store.putPlan(scope, plan({ date: nextDate }), 0);
		store.putDetail(scope, detail({ date: nextDate }), 0);
		for (const foreign of [otherUser, otherPersona]) {
			store.putPlan(foreign, originalPlan, 0);
			store.putDetail(foreign, oldDetail, 0);
		}

		store.putPlan(scope, replacement, 1);
		const expectInvalidated = (current: CompanionLifeStore) => {
			expect(current.getPlan(scope, date)).toEqual(replacement);
			expect(current.getDetail(scope, date, "09:00")).toBeUndefined();
			expect(current.getDetail(scope, date, "10:00")).toBeUndefined();
			expect(current.details(scope, date)).toEqual([]);
			expect(current.getPlan(scope, nextDate)).toEqual(plan({ date: nextDate }));
			expect(current.getDetail(scope, nextDate, "08:00")).toEqual(detail({ date: nextDate }));
			expect(current.details(scope, nextDate)).toEqual([detail({ date: nextDate })]);
			for (const foreign of [otherUser, otherPersona]) {
				expect(current.getPlan(foreign, date)).toEqual(originalPlan);
				expect(current.getDetail(foreign, date, "09:00")).toEqual(oldDetail);
				expect(current.details(foreign, date)).toEqual([oldDetail]);
			}
		};
		expectInvalidated(store);
		store.close();
		const reopened = await CompanionLifeStore.open(path);
		cleanups.push(() => reopened.close());
		expectInvalidated(reopened);
	});

	it("preserves cached details when plan CAS fails or a surrounding transaction rolls back, including after reopen", async () => {
		const { store, path } = await setup();
		const original = plan();
		const cached = detail();
		const replacement = plan({
			revision: 2,
			items: [{ time: "08:00", end: "09:00", activity: "Walk in a fictional garden", mood: "bright" }],
		});
		store.putPlan(scope, original, 0);
		store.putDetail(scope, cached, 0);
		expect(() => store.putPlan(scope, plan(), 0)).toThrowError(
			expect.objectContaining({ code: "LIFE_REVISION_MISMATCH" }),
		);
		expect(store.getPlan(scope, date)).toEqual(original);
		expect(store.getDetail(scope, date, "08:00")).toEqual(cached);
		expect(store.details(scope, date)).toEqual([cached]);
		expect(() =>
			store.transaction(() => {
				store.putPlan(scope, replacement, 1);
				expect(store.details(scope, date)).toEqual([]);
				throw new Error("abort plan replacement");
			}),
		).toThrow();
		expect(store.getPlan(scope, date)).toEqual(original);
		expect(store.getDetail(scope, date, "08:00")).toEqual(cached);
		expect(store.details(scope, date)).toEqual([cached]);
		store.close();
		const reopened = await CompanionLifeStore.open(path);
		cleanups.push(() => reopened.close());
		expect(reopened.getPlan(scope, date)).toEqual(original);
		expect(reopened.getDetail(scope, date, "08:00")).toEqual(cached);
		expect(reopened.details(scope, date)).toEqual([cached]);
	});

	it("tombstones a missing date during an initial generation and permits only explicit fresh-revision regeneration", async () => {
		const { store } = await setup();
		const capturedRevision = store.getDiaryRevision(scope, date);
		const pendingWrite = Promise.resolve().then(() =>
			store.putDiary(scope, diary({ revision: capturedRevision + 1 }), capturedRevision, 14),
		);
		store.deleteDiary(scope, date, 0);
		await expect(pendingWrite).rejects.toMatchObject({ code: "LIFE_REVISION_MISMATCH" });
		expect(store.getDiary(scope, date)).toBeUndefined();
		expect(store.isDiaryDeleted(scope, date)).toBe(true);
		expect(store.hasDiaryDate(scope, date)).toBe(true);
		expect(store.getDiaryRevision(scope, date)).toBe(1);
		store.putDiary(scope, diary({ revision: 2 }), 1, 14);
		expect(store.isDiaryDeleted(scope, date)).toBe(false);
		expect(store.getDiaryRevision(scope, date)).toBe(2);
		expect(() => store.deleteDiary(scope, date, 1)).toThrowError(
			expect.objectContaining({ code: "LIFE_REVISION_MISMATCH" }),
		);
		store.deleteDiary(scope, date, 2);
		expect(store.getDiaryRevision(scope, date)).toBe(3);
		expect(store.listDiaries(scope).items).toEqual([]);
	});

	it("prunes only bodies, retains non-content date revisions, and never automatically reruns a retained marker", async () => {
		const { store, path } = await setup();
		const erased = "PRIVATE-PRUNED-DIARY-BODY-ONLY-486fa02";
		store.putDiary(scope, diary({ date: "2027-01-01", body: erased, summary: erased, dream_fragments: [] }), 0, 2);
		store.putDiary(scope, diary({ date: "2027-01-02" }), 0, 2);
		store.putDiary(scope, diary({ date: "2027-01-03" }), 0, 2);
		expect(store.getDiary(scope, "2027-01-01")).toBeUndefined();
		expect(store.hasDiaryDate(scope, "2027-01-01")).toBe(true);
		expect(store.isDiaryDeleted(scope, "2027-01-01")).toBe(false);
		expect(store.getDiaryRevision(scope, "2027-01-01")).toBe(2);
		expect(() => store.putDiary(scope, diary({ date: "2027-01-01", revision: 2 }), 1, 2)).toThrowError(
			expect.objectContaining({ code: "LIFE_REVISION_MISMATCH" }),
		);
		store.putDiary(otherUser, diary({ date: "2027-01-01" }), 0, 1);
		expect(store.listDiaries(scope, { limit: 1 })).toMatchObject({ items: [{ date: "2027-01-03" }], next_cursor: 1 });
		expect(store.listDiaries(scope, { limit: 1, cursor: 1 })).toMatchObject({
			items: [{ date: "2027-01-02" }],
			next_cursor: null,
		});
		store.close();
		expect((await readFile(path)).includes(Buffer.from(erased))).toBe(false);
		const reopened = await CompanionLifeStore.open(path);
		cleanups.push(() => reopened.close());
		expect(reopened.hasDiaryDate(scope, "2027-01-01")).toBe(true);
		expect(reopened.getDiaryRevision(scope, "2027-01-01")).toBe(2);
		expect(reopened.getDiary(otherUser, "2027-01-01")).toBeDefined();
	});

	it("preserves transactions, registration, deleted revisions and full records across reopen", async () => {
		const { store, path } = await setup();
		expect(() =>
			store.transaction(() => {
				store.registerScope(otherUser, now);
				store.saveSettings(otherUser, { expected_revision: 0, config: DEFAULT_LIFE_CONFIG });
				store.putDiary(otherUser, diary(), 0, 14);
				throw new Error("abort");
			}),
		).toThrow();
		expect(store.scopes()).toEqual([]);
		expect(store.getSettings(otherUser).revision).toBe(0);
		expect(store.hasDiaryDate(otherUser, date)).toBe(false);
		store.transaction(() => {
			store.registerScope(scope, now);
			store.saveSettings(scope, { expected_revision: 0, config: DEFAULT_LIFE_CONFIG });
			store.putSimulation(scope, simulation(), 0);
			store.putPlan(scope, plan(), 0);
			store.putDetail(scope, detail(), 0);
			store.putDiary(scope, diary(), 0, 14);
			store.deleteDiary(scope, "2027-01-14", 0);
			store.putJob(
				scope,
				job({
					status: "failed",
					finished_at: now + 1,
					error: { code: "MODEL_UNAVAILABLE", message: "Model unavailable" },
				}),
			);
		});
		store.close();
		store.close();
		const reopened = await CompanionLifeStore.open(path);
		cleanups.push(() => reopened.close());
		expect(reopened.scopes()).toEqual([scope]);
		expect(reopened.getSettings(scope).revision).toBe(1);
		expect(reopened.getSimulation(scope)).toEqual(simulation());
		expect(reopened.getPlan(scope, date)).toEqual(plan());
		expect(reopened.getDetail(scope, date, "08:00")).toEqual(detail());
		expect(reopened.getDiary(scope, date)).toEqual(diary());
		expect(reopened.getDiaryRevision(scope, "2027-01-14")).toBe(1);
		expect(reopened.isDiaryDeleted(scope, "2027-01-14")).toBe(true);
		expect(reopened.jobs(scope)[0].error?.code).toBe("MODEL_UNAVAILABLE");
	});

	it("keeps fourteen plan/detail days and fifty jobs independently per scope", async () => {
		const { store } = await setup();
		for (let index = 1; index <= 16; index++) {
			const date = `2027-01-${String(index).padStart(2, "0")}`;
			store.putPlan(scope, plan({ date }), 0);
			store.putDetail(scope, detail({ date }), 0);
		}
		store.putPlan(otherUser, plan({ date: "2027-01-01" }), 0);
		for (let index = 0; index < 55; index++)
			store.putJob(scope, job({ id: `job-${index}`, started_at: now + index }));
		store.putJob(otherUser, job());
		expect(store.plans(scope)).toHaveLength(14);
		expect(store.getPlan(scope, "2027-01-02")).toBeUndefined();
		expect(store.getDetail(scope, "2027-01-02", "08:00")).toBeUndefined();
		expect(store.details(scope, "2027-01-03")).toHaveLength(1);
		expect(store.getPlan(otherUser, "2027-01-01")).toBeDefined();
		expect(store.jobs(scope, 50)).toHaveLength(50);
		expect(store.jobs(scope, 50).at(-1)?.id).toBe("job-5");
		expect(store.jobs(otherUser)).toHaveLength(1);
		store.putJob(scope, job({ id: "job-54", started_at: now + 54, status: "completed", finished_at: now + 100 }));
		expect(store.jobs(scope)[0].status).toBe("completed");
	});

	it("stores an uninitialized disabled simulation without consuming a generated day", async () => {
		const { store, path } = await setup();
		store.putSimulation(scope, simulation({ generated_day: null }), 0);
		expect(store.getSimulation(scope)?.generated_day).toBeNull();
		expect(store.hasDiaryDate(scope, date)).toBe(false);
		store.close();
		const reopened = await CompanionLifeStore.open(path);
		cleanups.push(() => reopened.close());
		expect(reopened.getSimulation(scope)?.generated_day).toBeNull();
		reopened.putSimulation(scope, simulation({ revision: 2 }), 1);
		expect(reopened.getSimulation(scope)?.generated_day).toBe(date);
	});

	it("rejects unknown/raw model fields, malformed dates, credentials and invalid records before persisting", async () => {
		const { store } = await setup();
		const secret = "sk-proj-abcdefghijk987654321";
		const unexpectedFields = { ...diary(), raw_response: "raw native completion" };
		const attempts = [
			() => store.putDiary(scope, unexpectedFields, 0, 14),
			() =>
				store.putDiary(scope, diary({ evidence: [{ ...diary().evidence[0], text: `Bearer ${secret}` }] }), 0, 14),
			() => store.putDiary(scope, diary({ date: "2027-02-30" }), 0, 14),
			() => store.putDiary(scope, diary({ body: "  ", dream_fragments: [] }), 0, 14),
			() => store.putDiary(scope, diary({ dream_fragments: [{ text: "not in body", weight: 1 }] }), 0, 14),
			() => store.putPlan(scope, plan({ items: [{ time: "09:00", end: "08:00", activity: "Read", mood: "" }] }), 0),
			() => store.putDetail(scope, detail({ summary: secret }), 0),
			() => store.putJob(scope, job({ error: { code: "provider", message: `api_key=${secret}` } })),
			() =>
				store.saveSettings(scope, {
					expected_revision: 0,
					config: { ...DEFAULT_LIFE_CONFIG, daily_diary_custom_direction: `password=${secret}` },
				}),
			() => store.getDiary({ ...scope, user_id: "../bob" }, date),
			() => store.listDiaries(scope, { cursor: -1 }),
		];
		for (const attempt of attempts) expect(attempt).toThrow();
		expect(store.listDiaries(scope).items).toEqual([]);
		expect(store.plans(scope)).toEqual([]);
		expect(store.jobs(scope)).toEqual([]);
		expect(store.getSettings(scope).revision).toBe(0);
	});

	it("fails closed on arbitrary files, existing empty databases, wrong applications and unknown schemas", async () => {
		const { root } = await setup();
		const textPath = join(root, "foreign.sqlite");
		await writeFile(textPath, "not a SQLite file");
		await expect(CompanionLifeStore.open(textPath)).rejects.toMatchObject({ code: "LIFE_STORE_INVALID" });
		expect(await readFile(textPath, "utf8")).toBe("not a SQLite file");
		for (const [name, sql] of [
			["empty", ""],
			["memory", "PRAGMA application_id=1146569549; PRAGMA user_version=1;"],
			["future", "PRAGMA application_id=1146571846; PRAGMA user_version=2;"],
		] as const) {
			const path = join(root, `${name}.sqlite`);
			const database = new DatabaseSync(path);
			database.exec(sql);
			database.close();
			await expect(CompanionLifeStore.open(path)).rejects.toMatchObject({ code: "LIFE_STORE_INVALID" });
		}
	});

	it.each([
		"unknown_table",
		"unknown_trigger",
		"wrong_revision",
		"wrong_date",
		"credential",
		"raw_response",
		"invalid_marker",
		"malformed_json",
	])("fails closed on persisted %s without silently repairing it", async (kind) => {
		const { store, path } = await setup();
		store.putDiary(scope, diary(), 0, 14);
		store.close();
		const database = new DatabaseSync(path);
		try {
			if (kind === "unknown_table") database.exec("CREATE TABLE unexpected(value TEXT)");
			else if (kind === "unknown_trigger")
				database.exec("CREATE TRIGGER unexpected AFTER INSERT ON life_diaries BEGIN SELECT 1; END");
			else if (kind === "wrong_revision") database.exec("UPDATE life_diaries SET revision=999");
			else if (kind === "wrong_date") database.exec("UPDATE life_diaries SET day='2027-01-16'");
			else if (kind === "invalid_marker") database.exec("UPDATE life_diaries SET data=NULL,deleted=0,generated=0");
			else if (kind === "malformed_json") database.exec("UPDATE life_diaries SET data='{'");
			else {
				const value =
					kind === "credential"
						? { ...diary(), body: `api_key=${"x".repeat(24)}`, dream_fragments: [] }
						: { ...diary(), raw_response: "unvalidated model text" };
				database.prepare("UPDATE life_diaries SET data=?").run(JSON.stringify(value));
			}
		} finally {
			database.close();
		}
		await expect(CompanionLifeStore.open(path)).rejects.toMatchObject({ code: "LIFE_STORE_INVALID" });
	});
});
