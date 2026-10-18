import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionLife } from "../src/companion-life.ts";
import { CompanionLifeStore } from "../src/companion-life-store.ts";
import {
	DEFAULT_LIFE_CONFIG,
	type LifeCompletionRequest,
	type LifeCompletionResult,
	type LifeConfig,
	type LifePlanItem,
} from "../src/companion-life-types.ts";
import { CompanionStore } from "../src/companion-store.ts";
import { DEFAULT_ROLEPLAY, type MemoryScope } from "../src/companion-types.ts";
import { ExecutorError } from "../src/errors.ts";
import type { PersonaSnapshot } from "../src/providers.ts";

const scope: MemoryScope = { persona_id: "guide", user_id: "alice" };
const foreign: MemoryScope = { persona_id: "guide", user_id: "bob" };
const date = "2026-10-18";
const start = Date.parse(`${date}T23:15:00.000Z`);
const persona: PersonaSnapshot = {
	id: "guide",
	revision: "1",
	system_prompt: "你是虚构的灯塔守望者。",
	roleplay: { ...DEFAULT_ROLEPLAY, enabled: true, timezone: "UTC", name: "灯塔守望者" },
};
const BODY =
	"用户说起灯塔，我把这几个字在心里轻轻停了一会儿。那种想听得更清楚的心情还留着，不必急着给它一个结尾。说过的话就是今天可握住的一点线索，我只愿意把它记得准确。其余没有说清楚的地方先留白，让这份小小的在意安静地留在这里。";
const PAYLOAD = { summary: "用户说起灯塔，我把这几个字留在心里", body: BODY, tags: ["灯塔", "在意"] };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
interface Latch {
	promise: Promise<void>;
	release: () => void;
}
function latch(): Latch {
	let release: () => void = () => {
		throw new Error("Latch is not initialized");
	};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
function response(value: unknown): LifeCompletionResult {
	return {
		text: typeof value === "string" ? value : JSON.stringify(value),
		provider: "test",
		model: "local-test",
		usage: { input_tokens: 20, output_tokens: 30 },
	};
}
function schedule(): LifePlanItem[] {
	const times = ["07:00", "09:00", "11:00", "12:00", "14:00", "16:00", "18:00", "19:00", "21:00", "23:00", "23:30"];
	return times.slice(0, -1).map((time, index) => ({
		time,
		end: times[index + 1],
		activity: `虚构阅读与整理第${index + 1}段`,
		mood: "平稳",
	}));
}
async function setup(
	handler: (request: LifeCompletionRequest) => Promise<LifeCompletionResult> = async (request) =>
		response(
			request.task.startsWith("daily_plan")
				? { schedule: schedule() }
				: request.task === "diary_derivatives"
					? {}
					: PAYLOAD,
		),
	config: Partial<LifeConfig> = {},
	actualRequests = true,
) {
	const root = await mkdtemp(join(tmpdir(), "dw-companion-life-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const memories = await CompanionStore.open(join(root, "memory.sqlite"));
	cleanups.push(() => memories.close());
	const store = await CompanionLifeStore.open(join(root, "life.sqlite"));
	cleanups.push(() => store.close());
	let now = start;
	let currentPersona = structuredClone(persona);
	const calls: LifeCompletionRequest[] = [];
	const life = new CompanionLife({
		store,
		memories,
		now: () => now,
		loadPersona: async () => currentPersona,
		complete: async (request) => {
			calls.push(request);
			if (actualRequests) request.on_request();
			return handler(request);
		},
	});
	cleanups.push(() => life.close());
	if (Object.keys(config).length)
		store.saveSettings(scope, { expected_revision: 0, config: { ...DEFAULT_LIFE_CONFIG, ...config } });
	return {
		root,
		life,
		store,
		memories,
		calls,
		setNow: (value: number) => {
			now = value;
		},
		setPersona: (value: PersonaSnapshot) => {
			currentPersona = value;
		},
	};
}

describe("fictional companion life coordinator", () => {
	it("keeps all read paths pure and default-aware without scheduling or model calls", async () => {
		const { life, store, calls } = await setup();
		const first = life.view(scope, persona);
		expect(first.settings.config).toEqual(DEFAULT_LIFE_CONFIG);
		expect(first.state.initialized).toBe(false);
		expect(first.today_diary_generated).toBe(false);
		expect(life.projection(scope, persona.roleplay!, start)).toEqual(first.state);
		expect(life.context(scope, persona.roleplay!, start, first.state).length).toBeLessThanOrEqual(3500);
		expect(life.listDiaries(scope).items).toEqual([]);
		expect(store.scopes()).toEqual([]);
		expect(store.getSimulation(scope)).toBeUndefined();
		expect(calls).toEqual([]);
	});

	it("recovers interrupted manual jobs after restart without enrolling scopes or repeating paid work", async () => {
		const { life, store, memories, root } = await setup();
		await life.close();
		store.putJob(scope, {
			id: "interrupted-manual",
			kind: "diary",
			date,
			status: "running",
			started_at: start,
			finished_at: null,
			error: null,
			model_calls: 1,
			usage: { input_tokens: 12, output_tokens: 5 },
			warnings: [],
		});
		store.putJob(foreign, {
			id: "finished-other",
			kind: "plan",
			date,
			status: "completed",
			started_at: start,
			finished_at: start,
			error: null,
			model_calls: 1,
			usage: { input_tokens: 20, output_tokens: 10 },
			warnings: [],
		});
		store.close();
		memories.close();
		const reopenedStore = await CompanionLifeStore.open(join(root, "life.sqlite"));
		cleanups.push(() => reopenedStore.close());
		const reopenedMemories = await CompanionStore.open(join(root, "memory.sqlite"));
		cleanups.push(() => reopenedMemories.close());
		let providerCalls = 0;
		const restarted = new CompanionLife({
			store: reopenedStore,
			memories: reopenedMemories,
			now: () => start - 1,
			loadPersona: async () => persona,
			complete: async () => {
				providerCalls++;
				throw new Error("Unexpected model call during recovery");
			},
		});
		cleanups.push(() => restarted.close());
		expect(restarted.view(scope, persona).jobs[0]).toMatchObject({
			status: "cancelled",
			finished_at: start,
			error: { code: "LIFE_INTERRUPTED" },
			model_calls: 1,
			usage: { input_tokens: 12, output_tokens: 5 },
		});
		expect(reopenedStore.jobs(foreign)[0].status).toBe("completed");
		expect(reopenedStore.scopes()).toEqual([]);
		expect(reopenedStore.getDiary(scope, date)).toBeUndefined();
		expect(providerCalls).toBe(0);
	});

	it("uses literal attributed scoped evidence and source writer/derivative budgets", async () => {
		const { life, memories, calls, store } = await setup(async (request) =>
			response(
				request.task === "diary_derivatives"
					? {
							share_seed: "用户说起灯塔",
							dream_fragments: [
								{ text: "灯塔", weight: 0.7 },
								{ text: "不存在的红色雨伞", weight: 1 },
							],
							continuity_thread: { motif: "灯塔", status: "不存在的状态", next_hint: "先留白" },
							long_term_events: [
								{ title: "先留白", status: "不在正文", next_hint: "不存在的剧情" },
								{ title: "凭空造事", status: "", next_hint: "" },
							],
						}
					: PAYLOAD,
			),
		);
		const sourceTime = start - 60_000;
		const memory = memories.create(
			scope,
			{ kind: "event", domain: "relationship", content: "用户说起灯塔" },
			sourceTime,
		);
		memories.create(foreign, { kind: "event", domain: "user", content: "BOB_PRIVATE_SECRET" }, sourceTime);
		const result = await life.generateDiary(scope, persona);
		const diary = result.diary!;
		expect(diary.source).toBe("model");
		expect(diary.evidence[0]).toMatchObject({
			level: "confirmed",
			source: "人工记录",
			text: "用户说起灯塔",
			at: sourceTime,
			memory_id: memory.id,
			memory_revision: 1,
		});
		expect(calls.map((call) => [call.task, call.max_tokens])).toEqual([
			["diary", 620],
			["diary_derivatives", 320],
		]);
		expect(calls[0].prompt).toContain("110–240");
		expect(calls[0].prompt).not.toContain("BOB_PRIVATE_SECRET");
		expect(diary.model_calls).toBe(2);
		expect(diary.usage).toEqual({ input_tokens: 40, output_tokens: 60 });
		expect(diary.dream_fragments).toEqual([{ text: "灯塔", weight: 0.7 }]);
		expect(diary.continuity_thread).toEqual({ motif: "灯塔", status: "", next_hint: "先留白" });
		expect(diary.long_term_events).toEqual([{ title: "先留白", status: "", next_hint: "" }]);
		expect(store.jobs(scope)[0].status).toBe("completed");
		expect(memories.list(scope).items).toHaveLength(1);
	});

	it("makes exactly one quality rewrite and never extracts derivatives from evidence fallback", async () => {
		const { life, memories, calls } = await setup(async () =>
			response({ summary: "状态", body: "系统 JSON 状态数值", tags: ["错误"] }),
		);
		memories.create(scope, { kind: "event", domain: "character", content: "用户说起灯塔" }, start);
		const result = await life.generateDiary(scope, persona);
		expect(calls.map((call) => [call.task, call.max_tokens])).toEqual([
			["diary", 620],
			["diary_rewrite", 520],
		]);
		expect(result.diary).toMatchObject({ source: "evidence", dream_fragments: [], long_term_events: [] });
		expect(result.warnings.join(" ")).toContain("deterministic fallback");
		expect(result.diary!.body).not.toContain("系统 JSON");
	});

	it("writes a private diary from fictional state even without a conversation and reuses the committed day", async () => {
		const body =
			"今天没有太多可以逐一记下来的小事，但这不意味着心里必须空着。我想让那些尚未清楚的念头先安静待着，不必勉强拼出一段热闹的故事。对自己的感受多留一点耐心，也算一种认真。等到以后回头看时，也许会理解此刻这份平稳。我把这一页留给自己，不替任何没有依据的事情安排结局。";
		const { life, calls } = await setup(async (request) =>
			response(
				request.task === "diary_derivatives" ? {} : { summary: "给安静的感受多留一点耐心", body, tags: ["平稳"] },
			),
		);
		const first = await life.generateDiary(scope, persona);
		const second = await life.generateDiary(scope, persona);
		expect(first.diary!.source).toBe("model");
		expect(first.diary!.evidence.some((item) => item.level === "confirmed")).toBe(false);
		expect(first.diary!.evidence.some((item) => item.level === "state" && item.text.includes("睡眠"))).toBe(true);
		expect(first.view.state.initialized).toBe(true);
		expect(calls[0].prompt).toContain("fictional_state");
		expect(second.diary!.revision).toBe(first.diary!.revision);
		expect(calls).toHaveLength(2);
	});

	it("bounds literal evidence to sixteen items and 180 characters and honors deterministic form", async () => {
		const { life, memories } = await setup();
		for (let index = 0; index < 24; index++)
			memories.create(
				scope,
				{ kind: "event", domain: "character", content: `${index}用户说起灯塔${"长".repeat(240)}` },
				start - index,
			);
		for (let index = 0; index < 8; index++)
			memories.create(
				scope,
				{ kind: "event", domain: "character", content: `${index}昨日参考线索` },
				start - 86_400_000 - index,
			);
		const diary = (await life.generateDiary(scope, persona)).diary!;
		expect(diary.evidence.length).toBeLessThanOrEqual(16);
		expect(diary.evidence.every((item) => item.text.length <= 180)).toBe(true);
		const forms = ["scene", "fragments", "inner_voice", "observation"];
		const seed =
			[...date].reduce((sum, char) => sum + char.codePointAt(0)!, 0) +
			diary.evidence.filter((item) => item.level === "confirmed").length;
		expect(diary.form).toBe(forms[seed % 4]);
	});

	it("deduplicates simultaneous forced generation including across an awaited writer", async () => {
		const entered = latch();
		const release = latch();
		const { life, memories, calls, store } = await setup(async (request) => {
			if (request.task === "diary") {
				entered.release();
				await release.promise;
			}
			return response(request.task === "diary_derivatives" ? {} : PAYLOAD);
		});
		memories.create(scope, { kind: "event", domain: "relationship", content: "用户说起灯塔" }, start);
		const first = life.generateDiary(scope, persona, { force: true, expected_revision: 0 });
		const second = life.generateDiary(scope, persona, { force: true, expected_revision: 0 });
		expect(first).toBe(second);
		await entered.promise;
		expect(store.jobs(scope)).toHaveLength(1);
		expect(store.jobs(scope)[0]).toMatchObject({ status: "running", model_calls: 1 });
		release.release();
		const [a, b] = await Promise.all([first, second]);
		expect(a.diary).toEqual(b.diary);
		expect(calls).toHaveLength(2);
		expect(store.getDiaryRevision(scope, date)).toBe(1);
	});

	it("does not resurrect a date deleted while its writer is awaited", async () => {
		const entered = latch();
		const release = latch();
		const { life, memories, store } = await setup(async () => {
			entered.release();
			await release.promise;
			return response(PAYLOAD);
		});
		memories.create(scope, { kind: "event", domain: "relationship", content: "用户说起灯塔" }, start);
		const pending = life.generateDiary(scope, persona, { force: true });
		await entered.promise;
		life.deleteDiary(scope, persona, date, { expected_revision: 0, operation: "delete" });
		release.release();
		await expect(pending).rejects.toMatchObject({ code: "LIFE_REVISION_MISMATCH" });
		expect(store.getDiary(scope, date)).toBeUndefined();
		expect(store.isDiaryDeleted(scope, date)).toBe(true);
		expect(store.jobs(scope)[0].status).toBe("failed");
		expect((await life.generateDiary(scope, persona)).diary).toBeUndefined();
	});

	it("rejects forgotten sources during a model await and excludes forgotten derived context immediately", async () => {
		const entered = latch();
		const release = latch();
		const { life, memories, store } = await setup(async (request) => {
			if (request.task === "diary") {
				entered.release();
				await release.promise;
			}
			return response(request.task === "diary_derivatives" ? {} : PAYLOAD);
		});
		const memory = memories.create(scope, { kind: "event", domain: "relationship", content: "用户说起灯塔" }, start);
		const pending = life.generateDiary(scope, persona);
		await entered.promise;
		memories.mutate(scope, memory.id, { expected_revision: 1, operation: "forget" }, start + 1);
		release.release();
		await expect(pending).rejects.toMatchObject({ code: "LIFE_SOURCE_CHANGED" });
		expect(store.getDiary(scope, date)).toBeUndefined();

		const other = await setup();
		const source = other.memories.create(
			scope,
			{ kind: "event", domain: "relationship", content: "用户说起灯塔" },
			start,
		);
		await other.life.generateDiary(scope, persona);
		other.memories.mutate(scope, source.id, { expected_revision: 1, operation: "forget" }, start + 1);
		const state = other.life.projection(scope, persona.roleplay!, start);
		expect(other.life.context(scope, persona.roleplay!, start, state)).not.toContain("用户说起灯塔");
		expect(() => other.life.getDiary(scope, date)).toThrowError(expect.objectContaining({ code: "LIFE_NOT_FOUND" }));
		other.life.invalidateForgotten(scope);
		expect(other.store.getDiary(scope, date)).toBeUndefined();
		expect(other.store.isDiaryDeleted(scope, date)).toBe(true);
	});

	it("preserves a committed diary through source pinning but never recalls archived or forgotten sources", async () => {
		const { life, memories, store } = await setup();
		const source = memories.create(scope, { kind: "event", domain: "relationship", content: "用户说起灯塔" }, start);
		const generated = await life.generateDiary(scope, persona);
		const pinned = memories.mutate(
			scope,
			source.id,
			{ expected_revision: source.revision, operation: "pin" },
			start + 1,
		);
		expect(life.getDiary(scope, date).revision).toBe(generated.diary!.revision);
		expect(life.listDiaries(scope).items.map((item) => item.date)).toContain(date);
		const state = life.projection(scope, persona.roleplay!, start);
		expect(life.context(scope, persona.roleplay!, start, state)).toContain("用户说起灯塔");
		const unrelated = memories.create(
			scope,
			{ kind: "event", domain: "user", content: "另一个无关的话题" },
			start + 2,
		);
		memories.mutate(scope, unrelated.id, { expected_revision: unrelated.revision, operation: "forget" }, start + 3);
		life.invalidateForgotten(scope);
		expect(store.isDiaryDeleted(scope, date)).toBe(false);
		const archived = memories.mutate(
			scope,
			source.id,
			{ expected_revision: pinned.revision, operation: "archive" },
			start + 4,
		);
		expect(life.getDiary(scope, date).date).toBe(date);
		expect(life.context(scope, persona.roleplay!, start, state)).not.toContain("用户说起灯塔");
		const restored = memories.mutate(
			scope,
			source.id,
			{ expected_revision: archived.revision, operation: "restore" },
			start + 5,
		);
		expect(life.context(scope, persona.roleplay!, start, state)).toContain("用户说起灯塔");
		memories.mutate(scope, source.id, { expected_revision: restored.revision, operation: "forget" }, start + 6);
		life.invalidateForgotten(scope);
		expect(() => life.getDiary(scope, date)).toThrowError(expect.objectContaining({ code: "LIFE_NOT_FOUND" }));
		expect(store.isDiaryDeleted(scope, date)).toBe(true);
	});

	it("carries historical diary dependencies at their current revisions after harmless source metadata changes", async () => {
		let nextDay = false;
		const quietBody =
			"今天没有太多可以逐一记下来的小事，但这不意味着心里必须空着。我想让那些尚未清楚的念头先安静待着，不必勉强拼出一段热闹的故事。对自己的感受多留一点耐心，也算一种认真。等到以后回头看时，也许会理解此刻这份平稳。我把这一页留给自己，不替任何没有依据的事情安排结局。";
		const { life, memories, setNow } = await setup(async (request) =>
			response(
				request.task === "diary_derivatives"
					? {}
					: nextDay
						? { summary: "给安静的感受多留一点耐心", body: quietBody, tags: ["平稳"] }
						: PAYLOAD,
			),
		);
		const source = memories.create(scope, { kind: "event", domain: "relationship", content: "用户说起灯塔" }, start);
		await life.generateDiary(scope, persona);
		const pinned = memories.mutate(
			scope,
			source.id,
			{ expected_revision: source.revision, operation: "pin" },
			start + 1,
		);
		for (let index = 0; index < 6; index++)
			memories.create(
				scope,
				{ kind: "fact", domain: "character", content: `其他历史线索${index}` },
				start + index + 2,
			);
		nextDay = true;
		setNow(start + 86_400_000);
		const today = (await life.generateDiary(scope, persona)).diary!;
		expect(today.source).toBe("model");
		expect(
			today.evidence.some((item) => item.memory_id === source.id && item.memory_revision === pinned.revision),
		).toBe(true);
		expect(today.evidence.some((item) => item.level === "confirmed")).toBe(false);
		memories.mutate(
			scope,
			source.id,
			{ expected_revision: pinned.revision, operation: "forget" },
			start + 86_400_001,
		);
		life.invalidateForgotten(scope);
		expect(life.listDiaries(scope).items).toEqual([]);
	});

	it("rejects settings and persona revisions changed during model work", async () => {
		for (const change of ["settings", "persona"] as const) {
			const entered = latch();
			const release = latch();
			const { life, store, setPersona } = await setup(async () => {
				entered.release();
				await release.promise;
				return response({ schedule: schedule() });
			});
			const pending = life.generatePlan(scope, persona);
			await entered.promise;
			if (change === "settings")
				store.saveSettings(scope, {
					expected_revision: 0,
					config: { ...DEFAULT_LIFE_CONFIG, daily_plan_item_count: 12 },
				});
			else setPersona({ ...persona, revision: "new-card" });
			release.release();
			await expect(pending).rejects.toMatchObject({ code: "LIFE_REVISION_MISMATCH" });
			expect(store.getPlan(scope, date)).toBeUndefined();
		}
	});

	it("corrects a malformed plan once with exact default and corrective budgets", async () => {
		const { life, calls } = await setup(async (request) =>
			response(request.task === "daily_plan" ? "not JSON" : { schedule: schedule() }),
		);
		const result = await life.generatePlan(scope, persona);
		expect(result.plan!.source).toBe("model");
		expect(result.plan!.items).toHaveLength(10);
		expect(calls.map((call) => [call.task, call.max_tokens])).toEqual([
			["daily_plan", 1500],
			["daily_plan_rewrite", 1600],
		]);
	});

	it("uses configured/source-eight labelled plan fallbacks and a fifteen-minute cooldown", async () => {
		const { life, calls, setNow } = await setup(
			async () => {
				throw new ExecutorError("MODEL_NOT_CONFIGURED", "No model configured");
			},
			{},
			false,
		);
		const first = await life.generatePlan(scope, persona);
		expect(first.plan).toMatchObject({
			source: "fallback_default",
			model_calls: 0,
			retry_after: start + 15 * 60_000,
		});
		expect(first.plan!.items.map((item) => item.time)).toEqual([
			"08:20",
			"09:10",
			"10:20",
			"12:15",
			"14:10",
			"16:40",
			"18:10",
			"21:40",
		]);
		await life.generatePlan(scope, persona);
		expect(calls).toHaveLength(1);
		setNow(start + 16 * 60_000);
		await life.generatePlan(scope, persona);
		expect(calls).toHaveLength(2);
		const configuredPersona = {
			...persona,
			roleplay: {
				...persona.roleplay!,
				routine: [{ start: "08:00", end: "10:00", activity: "遵守角色卡例行作息", location: "虚构灯塔" }],
			},
		};
		const configured = await setup(
			async () => {
				throw new Error("Unavailable");
			},
			{},
			false,
		);
		configured.setPersona(configuredPersona);
		expect((await configured.life.generatePlan(scope, configuredPersona)).plan).toMatchObject({
			source: "configured",
			items: [{ time: "08:00", end: "10:00", activity: "遵守角色卡例行作息", mood: "平稳", location: "虚构灯塔" }],
		});
	});

	it("advances math without a model and schedules only current local day after configured times", async () => {
		const { life, store, calls, setNow } = await setup(
			async () => {
				throw new ExecutorError("MODEL_NOT_CONFIGURED", "No model");
			},
			{},
			false,
		);
		setNow(Date.parse(`${date}T07:29:00Z`));
		life.register(scope, persona);
		expect(store.getSimulation(scope)?.revision).toBeGreaterThan(0);
		await life.tick();
		expect(calls).toHaveLength(0);
		setNow(Date.parse(`${date}T07:30:00Z`));
		await life.tick();
		expect(calls).toHaveLength(1);
		expect(store.getPlan(scope, date)?.source).toBe("fallback_default");
		setNow(Date.parse("2026-10-21T23:15:00Z"));
		await life.tick();
		expect(store.getDiary(scope, "2026-10-19")).toBeUndefined();
		expect(store.getDiary(scope, "2026-10-20")).toBeUndefined();
		expect(store.getDiary(scope, "2026-10-21")?.source).toBe("evidence");
		expect(store.getSimulation(scope)?.generated_day).toBe("2026-10-21");
	});

	it("keeps settings scope-local and disables passive injection immediately", async () => {
		const { life, calls } = await setup();
		const view = life.saveSettings(scope, persona, {
			expected_revision: 0,
			config: { ...DEFAULT_LIFE_CONFIG, inject_passive_states: false, daily_diary_length: "long" },
		});
		expect(view.state.inject).toBe(false);
		expect(life.context(scope, persona.roleplay!, start, view.state)).toBe("");
		expect(life.view(foreign, persona).settings.config.inject_passive_states).toBe(true);
		expect(calls).toHaveLength(0);
	});

	it("rejects detail by default and confines corrected events to the current segment", async () => {
		const denied = await setup();
		expect(() => denied.life.generateDetail(scope, persona)).toThrowError(
			expect.objectContaining({ code: "LIFE_DETAIL_DISABLED" }),
		);
		const { life, calls, setNow } = await setup(
			async (request) => {
				if (request.task.startsWith("daily_plan")) return response({ schedule: schedule() });
				if (request.task === "detail")
					return response({ summary: "不完整", today_events: [{ time: "05:00", event: "段外，不得入库" }] });
				return response({
					summary: "虚构的阅读准备与段末收整",
					location: "虚构灯塔",
					today_events: [
						{ time: "23:00", event: "模拟翻到开头" },
						{ time: "23:24", event: "模拟收整书页" },
						{ time: "05:00", event: "段外，不得入库" },
					],
					proactive_events: [{ event: "不得发送" }],
				});
			},
			{ enable_detail_enhancement: true },
		);
		await life.generatePlan(scope, persona);
		setNow(Date.parse(`${date}T22:57:00Z`));
		const result = await life.generateDetail(scope, persona);
		expect(result.detail!.segment).toBe("23:00");
		expect(result.detail!.today_events).toEqual([
			{ time: "23:00", event: "模拟翻到开头", level: "simulated" },
			{ time: "23:24", event: "模拟收整书页", level: "simulated" },
		]);
		expect(
			calls.filter((call) => call.task.startsWith("detail")).map((call) => [call.task, call.max_tokens]),
		).toEqual([
			["detail", 700],
			["detail_rewrite", 850],
		]);
		expect(result.detail).not.toHaveProperty("proactive_events");
	});

	it("aborts and awaits active work on shutdown with a durable cancelled job", async () => {
		const entered = latch();
		const { life, store } = await setup(async (request) => {
			entered.release();
			await new Promise<void>((_resolve, reject) => {
				request.signal.addEventListener("abort", () => reject(new ExecutorError("LIFE_CANCELLED", "Cancelled")), {
					once: true,
				});
			});
			return response({ schedule: schedule() });
		});
		const pending = life.generatePlan(scope, persona);
		const rejected = expect(pending).rejects.toMatchObject({ code: "LIFE_CANCELLED" });
		await entered.promise;
		await life.close();
		await rejected;
		expect(store.jobs(scope)[0]).toMatchObject({ status: "cancelled", model_calls: 1, finished_at: start });
		expect(store.getPlan(scope, date)).toBeUndefined();
	});

	it("initializes manual state from revision zero atomically without enrolling a scheduling scope", async () => {
		const { life, store, calls } = await setup();
		const added = life.addCondition(scope, persona, {
			expected_revision: 0,
			label: "想安静看书",
			duration_hours: 12,
		});
		const manual = added.state.conditions.find((item) => item.kind === "manual_state");
		expect(manual).toBeDefined();
		expect(manual!.end_at - manual!.start_at).toBe(12 * 60 * 60_000);
		const removed = life.removeCondition(scope, persona, manual!.id, {
			expected_revision: added.state.revision,
			operation: "remove",
		});
		expect(removed.state.conditions.some((item) => item.id === manual!.id)).toBe(false);
		expect(store.scopes()).toEqual([]);
		expect(calls).toEqual([]);
	});

	it("does not infer a completed real-world action from attributed role speech", async () => {
		const { life, memories, calls } = await setup(async () =>
			response({ summary: "今天去了海边", body: `今天去了海边，完成了想了很久的散步。${BODY}`, tags: ["海边"] }),
		);
		memories.insert(scope, {
			id: "literal-episode",
			kind: "episode",
			domain: "character",
			content: "角色说今天去了海边",
			key: null,
			status: "active",
			pinned: false,
			confidence: 1,
			importance: 0.5,
			durability: "normal",
			expires_at: null,
			created_at: start,
			sources: [
				{ speaker: "assistant", quote: "我今天去了海边", timestamp: start, session_id: "chat", run_id: "reply" },
			],
			supersedes: null,
		});
		const result = await life.generateDiary(scope, persona);
		expect(result.diary!.evidence[0]).toMatchObject({
			source: "角色回复（不证明现实完成）",
			text: "我今天去了海边",
			at: start,
		});
		expect(result.diary!.source).toBe("evidence");
		expect(result.diary!.body).toContain("角色回复（不证明现实完成）");
		expect(calls.map((call) => call.task)).toEqual(["diary", "diary_rewrite"]);
	});

	it("records actual failed-request usage without counting denied model invocations", async () => {
		const used = await setup(async () => {
			throw new ExecutorError("OUTPUT_LIMIT", "Safe failure", false, {
				usage: { input_tokens: 7, output_tokens: 11 },
			});
		});
		const fallback = await used.life.generatePlan(scope, persona);
		expect(fallback.plan).toMatchObject({
			source: "fallback_default",
			model_calls: 1,
			usage: { input_tokens: 7, output_tokens: 11 },
		});
		expect(used.store.jobs(scope)[0]).toMatchObject({
			model_calls: 1,
			usage: { input_tokens: 7, output_tokens: 11 },
		});
		expect(used.calls).toHaveLength(1);
		const denied = await setup(
			async () => {
				throw new ExecutorError("AUTH_REQUIRED", "Authorization required");
			},
			{},
			false,
		);
		expect((await denied.life.generatePlan(scope, persona)).plan!.model_calls).toBe(0);
	});

	it("reuses a labelled prior plan and applies the configured budget formula", async () => {
		let available = true;
		const previous = await setup(async () => {
			if (!available) throw new ExecutorError("MODEL_NOT_CONFIGURED", "No model");
			return response({ schedule: schedule() });
		});
		previous.setNow(start - 86_400_000);
		const yesterday = await previous.life.generatePlan(scope, persona);
		available = false;
		previous.setNow(start);
		const today = await previous.life.generatePlan(scope, persona);
		expect(today.plan!.source).toBe("fallback_previous");
		expect(today.plan!.items).toEqual(yesterday.plan!.items);
		const large = await setup(async () => response({ schedule: schedule() }), { daily_plan_item_count: 24 });
		await large.life.generatePlan(scope, persona);
		expect(large.calls.map((call) => call.max_tokens)).toEqual([3180, 3180]);
	});

	it("starts its first tick asynchronously and keeps model-free math state available", async () => {
		const entered = latch();
		const { life, calls, store } = await setup(async () => {
			entered.release();
			return response({ schedule: schedule() });
		});
		life.register(scope, persona);
		life.start();
		expect(calls).toEqual([]);
		expect(store.getSimulation(scope)).toBeDefined();
		await entered.promise;
		await life.tick();
		expect(store.getPlan(scope, date)).toBeDefined();
		expect(store.getDiary(scope, date)?.source).toBe("evidence");
	});

	it("uses a thirty-minute diary failure cooldown without retrying paid calls", async () => {
		const entered = latch();
		const release = latch();
		const { life, memories, store, calls, setNow } = await setup(async (request) => {
			if (request.task === "diary") {
				entered.release();
				await release.promise;
			}
			return response(request.task === "diary_derivatives" ? {} : PAYLOAD);
		});
		memories.create(scope, { kind: "event", domain: "character", content: "用户说起灯塔" }, start);
		const pending = life.generateDiary(scope, persona);
		await entered.promise;
		store.saveSettings(scope, {
			expected_revision: 0,
			config: { ...DEFAULT_LIFE_CONFIG, daily_diary_custom_direction: "只保留有据的细节" },
		});
		release.release();
		await expect(pending).rejects.toMatchObject({ code: "LIFE_REVISION_MISMATCH" });
		const cooling = await life.generateDiary(scope, persona);
		expect(cooling.diary).toBeUndefined();
		expect(cooling.warnings.join(" ")).toContain("cooldown");
		expect(calls).toHaveLength(1);
		setNow(start + 31 * 60_000);
		expect((await life.generateDiary(scope, persona)).diary!.source).toBe("model");
		expect(calls).toHaveLength(3);
	});

	it("cancels on the caller signal without committing even a fallback", async () => {
		const entered = latch();
		const release = latch();
		const { life, store } = await setup(async () => {
			entered.release();
			await release.promise;
			throw new Error("Provider failed after abort");
		});
		const controller = new AbortController();
		const pending = life.generatePlan(scope, persona, { signal: controller.signal });
		await entered.promise;
		controller.abort();
		release.release();
		await expect(pending).rejects.toMatchObject({ code: "LIFE_CANCELLED" });
		expect(store.getPlan(scope, date)).toBeUndefined();
		expect(store.jobs(scope)[0].status).toBe("cancelled");
	});

	it("applies chosen forms lengths creativity and the derivative share gate", async () => {
		for (const [length, range] of [
			["short", "60–130"],
			["standard", "110–240"],
			["long", "180–360"],
		] as const) {
			const { life, memories, calls } = await setup(
				async (request) =>
					response(request.task === "diary_derivatives" ? { share_seed: "用户说起灯塔" } : PAYLOAD),
				{
					daily_diary_form: "observation",
					daily_diary_length: length,
					daily_diary_creativity: "strict",
					daily_diary_custom_direction: "留下字词的回音",
					daily_diary_generate_share_seed: false,
				},
			);
			memories.create(scope, { kind: "event", domain: "character", content: "用户说起灯塔" }, start);
			const diary = (await life.generateDiary(scope, persona)).diary!;
			expect(diary.form).toBe("observation");
			expect(diary.share_seed).toBe("");
			expect(calls[0].prompt).toContain(range);
			expect(calls[0].prompt).toContain("严格写实");
			expect(calls[0].prompt).toContain("留下字词的回音");
		}
	});
});
