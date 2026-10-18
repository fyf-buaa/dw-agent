import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
	addLifeCondition,
	advanceLife,
	lifeClock,
	projectLife,
	removeLifeCondition,
} from "../src/companion-life-state.ts";
import { CompanionLifeStore } from "../src/companion-life-store.ts";
import {
	DEFAULT_LIFE_CONFIG,
	type DiaryEntry,
	type LifeConfig,
	LifeConfigSchema,
	type LifeDetail,
	type LifePlan,
	type LifeSimulation,
	LifeSimulationSchema,
} from "../src/companion-life-types.ts";
import { DEFAULT_ROLEPLAY, type MemoryScope, type RoleplayConfig } from "../src/companion-types.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 17, 6);
const scope: MemoryScope = { persona_id: "fictional-guide", user_id: "reader" };
const roleplay: RoleplayConfig = { ...DEFAULT_ROLEPLAY, enabled: true, timezone: "UTC" };
const calm: LifeConfig = {
	...DEFAULT_LIFE_CONFIG,
	enable_health_state: false,
	enable_hunger_state: false,
	enable_cycle_state: false,
};
function initial(config = calm, now = NOW): LifeSimulation {
	return advanceLife(scope, roleplay, config, undefined, [], now, () => 0.999);
}
function view(simulation: LifeSimulation | undefined, now = NOW, config = calm) {
	return projectLife(roleplay, config, simulation, undefined, [], now);
}
function diary(date: string, tags: string[]): DiaryEntry {
	return {
		date,
		tags,
		revision: 1,
		generated_at: NOW - DAY,
		persona_revision: "card-1",
		form: "observation",
		source: "evidence",
		summary: "过去的虚构感受",
		body: "这是过去的虚构角色感受，不是用户的健康资料。",
		evidence: [],
		share_seed: "",
		dream_fragments: [],
		continuity_thread: { motif: "", status: "", next_hint: "" },
		long_term_events: [],
		model_calls: 0,
		usage: { input_tokens: 0, output_tokens: 0 },
		warnings: [],
	};
}
function plan(): LifePlan {
	return {
		date: "2026-10-17",
		revision: 1,
		generated_at: NOW,
		persona_revision: "card-1",
		source: "model",
		items: [
			{ time: "06:00", end: "07:00", activity: "在虚构花园整理笔记", mood: "平稳", location: "花园" },
			{ time: "07:00", end: "08:00", activity: "虚构早餐", mood: "轻快", location: "厨房" },
		],
		retry_after: null,
		model_calls: 1,
		usage: { input_tokens: 1, output_tokens: 1 },
		warnings: [],
	};
}
function detail(): LifeDetail {
	return {
		date: "2026-10-17",
		segment: "06:00",
		revision: 1,
		generated_at: NOW,
		persona_revision: "card-1",
		summary: "虚构花园里的纸页被风翻动",
		location: "树旁",
		today_events: [{ time: "06:10", event: "模拟整理纸页", level: "simulated" }],
		model_calls: 1,
		usage: { input_tokens: 1, output_tokens: 1 },
		warnings: [],
	};
}

describe("fictional life state mutation and read boundaries", () => {
	it("uses persona-local clock at midnight, date rollover and DST boundaries", () => {
		expect(lifeClock(Date.UTC(2026, 9, 17, 16), "Asia/Shanghai")).toMatchObject({
			day: "2026-10-18",
			minute: 0,
			hour: 0,
			year: 2026,
			month: 10,
			date: 18,
		});
		expect(lifeClock(Date.UTC(2026, 2, 8, 6, 59), "America/New_York")).toMatchObject({ hour: 1, minute: 119 });
		expect(lifeClock(Date.UTC(2026, 2, 8, 7), "America/New_York")).toMatchObject({ hour: 3, minute: 180 });
	});
	it("does not invent initialization or virtual weather observations during reads", () => {
		const rng = vi.spyOn(Math, "random").mockImplementation(() => {
			throw new Error("read-induced RNG");
		});
		try {
			const absent = view(undefined);
			expect(absent).toMatchObject({
				initialized: false,
				revision: 0,
				virtual: true,
				energy: 70,
				conditions: [],
				history: [],
			});
			expect(absent.note).toContain("未初始化");
			expect(absent.weather).toContain("未联网");
			expect(view(undefined, NOW, { ...calm, weather_context: "小雨" }).weather).toBe("虚构天气背景：小雨");
			expect(rng).not.toHaveBeenCalled();
		} finally {
			rng.mockRestore();
		}
	});
	it("keeps disabled registration uninitialized and permits today's first roll after enabling", () => {
		const random = vi.fn(() => 0.999);
		const disabled = { ...calm, enable_humanized_states: false };
		const registered = advanceLife(scope, roleplay, disabled, undefined, [], NOW, random);
		expect(registered.generated_day).toBeNull();
		expect(random).not.toHaveBeenCalled();
		expect(view(registered, NOW, disabled)).toMatchObject({ initialized: false, energy: 70, conditions: [] });
		const enabled = advanceLife(scope, roleplay, calm, registered, [], NOW, random);
		expect(enabled.generated_day).toBe("2026-10-17");
		expect(enabled.revision).toBe(registered.revision + 1);
		expect(view(enabled).energy).toBe(75);
	});
	it("does not consume daily randomness or revision numbers on timer-only advances or restored snapshots", () => {
		const state = initial();
		const snapshot = structuredClone(state);
		const random = vi.fn(() => {
			throw new Error("duplicate daily roll");
		});
		const unchanged = advanceLife(scope, roleplay, calm, state, [], NOW + 30_000, random);
		expect(unchanged).toBe(state);
		expect(advanceLife(scope, roleplay, calm, snapshot, [], NOW + 60_000, random)).toBe(snapshot);
		expect(state).toEqual(snapshot);
		expect(random).not.toHaveBeenCalled();
	});
	it("projects expired records without mutation, then persists each actual expiry only once", () => {
		const state = addLifeCondition(initial(), calm, { label: "有点累", duration_hours: 1 }, NOW);
		const manual = state.conditions.find((item) => item.kind === "manual_state")!;
		const frozen = structuredClone(state);
		expect(view(state, manual.end_at - 1).conditions.some((item) => item.id === manual.id)).toBe(true);
		expect(view(state, manual.end_at).conditions.some((item) => item.id === manual.id)).toBe(false);
		expect(state).toEqual(frozen);
		const advanced = advanceLife(scope, roleplay, calm, state, [], manual.end_at, () => 0.999);
		expect(
			advanced.history.filter((entry) => entry.kind === "condition_ended" && entry.condition_id === manual.id),
		).toHaveLength(1);
		expect(
			advanceLife(scope, roleplay, calm, structuredClone(advanced), [], manual.end_at + 1, () => 0.999).revision,
		).toBe(advanced.revision);
	});
	it("anchors a recovery tail at the original end, not the maintenance time after downtime", () => {
		const config = { ...calm, enable_health_state: true };
		const supplied = addLifeCondition(initial(config), config, { label: "头疼", duration_hours: 1 }, NOW);
		const target = supplied.conditions.find((item) => item.kind === "manual_state")!;
		target.kind = "health";
		target.phase = "mild_discomfort";
		target.transition_options = [{ to: "health_tail", base_weight: 1 }];
		const end = target.end_at;
		const advanced = advanceLife(scope, roleplay, config, supplied, [], end + 2 * HOUR, () => 0.5);
		const tail = advanced.conditions.find((item) => item.kind === "health_tail")!;
		expect(tail.start_at).toBe(end);
		expect(tail.end_at).toBeGreaterThan(end + 2 * HOUR);
		expect(
			advanced.history.filter((entry) => entry.kind === "transition" && entry.condition_id === tail.id),
		).toHaveLength(1);
		const afterDowntime = advanceLife(
			scope,
			roleplay,
			config,
			structuredClone(advanced),
			[],
			tail.end_at + HOUR,
			() => 0.999,
		);
		expect(afterDowntime.conditions.some((item) => item.kind === "health_tail")).toBe(false);
		expect(
			afterDowntime.history.find((entry) => entry.kind === "condition_ended" && entry.condition_id === tail.id)?.at,
		).toBe(tail.end_at);
	});
	it("does not briefly resurrect already-expired followups after a long outage", () => {
		const supplied = initial();
		const item = supplied.conditions.find((condition) => condition.kind === "sleep")!;
		item.energy_delta = -20;
		item.phase = "sleep_debt";
		item.transition_options = [{ to: "sleep_afterglow", base_weight: 1 }];
		const next = advanceLife(scope, roleplay, calm, supplied, [], NOW + 10 * DAY, () => 0.999);
		expect(next.conditions.every((condition) => condition.end_at > NOW + 10 * DAY)).toBe(true);
		const rebound = next.history.find(
			(entry) => entry.kind === "condition_started" && entry.condition_id?.startsWith("sleep_afterglow-"),
		)!;
		expect(rebound.at).toBe(item.end_at);
		expect(
			next.history.some((entry) => entry.kind === "condition_ended" && entry.condition_id === rebound.condition_id),
		).toBe(true);
		expect(next.history.filter((entry) => entry.kind === "day_generated").map((entry) => entry.label)).toEqual([
			"虚构状态：2026-10-17",
			"虚构状态：2026-10-27",
		]);
	});
	it("preserves active prior-day conditions while generating exactly once for the new local day", () => {
		const beforeMidnight = Date.UTC(2026, 9, 17, 23, 50);
		const supplied = addLifeCondition(
			initial(calm, beforeMidnight),
			calm,
			{ label: "安静地读书", duration_hours: 12 },
			beforeMidnight,
		);
		const manual = supplied.conditions.find((item) => item.kind === "manual_state")!;
		const rolled = advanceLife(scope, roleplay, calm, supplied, [], beforeMidnight + HOUR, () => 0.999);
		expect(rolled.conditions.find((item) => item.id === manual.id)).toEqual(manual);
		expect(rolled.history.filter((entry) => entry.kind === "day_generated")).toHaveLength(2);
		const repeated = advanceLife(
			scope,
			roleplay,
			calm,
			structuredClone(rolled),
			[],
			beforeMidnight + HOUR + 1000,
			() => {
				throw new Error("second daily roll");
			},
		);
		expect(repeated.revision).toBe(rolled.revision);
		expect(advanceLife(scope, roleplay, calm, rolled, [], beforeMidnight, () => 0)).toBe(rolled);
	});
	it("composes only active records, highest-intensity non-neutral mood, and bounded energy", () => {
		let state = addLifeCondition(initial(), calm, { label: "开心", duration_hours: 1 }, NOW);
		state = addLifeCondition(state, calm, { label: "累", duration_hours: 2 }, NOW);
		const manuals = state.conditions.filter((item) => item.kind === "manual_state");
		manuals[0]!.intensity = 90;
		manuals[0]!.energy_delta = 100;
		manuals[1]!.intensity = 70;
		manuals[1]!.energy_delta = 100;
		expect(view(state)).toMatchObject({ energy: 100, mood_bias: "轻快" });
		manuals[1]!.energy_delta = -100;
		expect(view(state, NOW + HOUR)).toMatchObject({ energy: 10, mood_bias: "疲惫" });
		expect(view(state, NOW + 2 * HOUR).mood_bias).toBe("平稳");
	});
	it("keeps injection independently configurable without hiding the management view", () => {
		const config = { ...calm, inject_passive_states: false };
		const state = addLifeCondition(initial(config), config, { label: "开心" }, NOW);
		expect(view(state, NOW, config)).toMatchObject({ inject: false, initialized: true });
		expect(view(state, NOW, config).conditions.some((item) => item.kind === "manual_state")).toBe(true);
		expect(view(state, NOW, { ...config, enable_humanized_states: false })).toMatchObject({
			energy: 70,
			conditions: [],
		});
	});
});

describe("meal-window generation", () => {
	const config = { ...calm, enable_hunger_state: true };
	it("attempts a missed roll once per window even after snapshot restoration", () => {
		const failed = advanceLife(scope, roleplay, config, initial(config), [], NOW + 2 * HOUR, () => 0.999);
		expect(failed.hunger.attempted).toEqual(["breakfast"]);
		const random = vi.fn(() => 0);
		const same = advanceLife(scope, roleplay, config, structuredClone(failed), [], NOW + 2 * HOUR + 1000, random);
		expect(same.revision).toBe(failed.revision);
		expect(random).not.toHaveBeenCalled();
		expect(same.hunger.generated).toEqual([]);
	});
	it("enforces four-hour spacing and at most two timed hunger states per local day", () => {
		const breakfast = advanceLife(scope, roleplay, config, initial(config), [], NOW + 2 * HOUR, () => 0);
		expect(breakfast.hunger.generated.map((item) => item.window)).toEqual(["breakfast"]);
		const tooSoon = advanceLife(scope, roleplay, config, breakfast, [], NOW + 5 * HOUR, () => 0);
		expect(tooSoon.hunger.generated).toHaveLength(1);
		expect(tooSoon.hunger.attempted).not.toContain("lunch");
		const lunch = advanceLife(scope, roleplay, config, tooSoon, [], NOW + 6 * HOUR, () => 0);
		expect(lunch.hunger.generated.map((item) => item.window)).toEqual(["breakfast", "lunch"]);
		const dinner = advanceLife(scope, roleplay, config, lunch, [], NOW + 12 * HOUR, () => 0);
		expect(dinner.hunger.generated).toHaveLength(2);
		const tomorrow = advanceLife(scope, roleplay, config, dinner, [], NOW + DAY, () => 0.999);
		expect(tomorrow.hunger).toEqual({ day: "2026-10-18", attempted: [], generated: [] });
	});
	it("honors inclusive meal endpoints and does not generate outside a window", () => {
		const endpoint = advanceLife(scope, roleplay, config, initial(config), [], Date.UTC(2026, 9, 17, 9, 30), () => 0);
		expect(endpoint.hunger.generated[0]?.window).toBe("breakfast");
		const outside = advanceLife(scope, roleplay, config, initial(config), [], Date.UTC(2026, 9, 17, 9, 31), () => 0);
		expect(outside.hunger.attempted).toEqual([]);
	});
	it("does not apply disabled hunger flags to active stale records or spend RNG on a read", () => {
		const state = advanceLife(scope, roleplay, config, initial(config), [], NOW + 2 * HOUR, () => 0);
		expect(view(state, NOW + 2 * HOUR, calm).conditions.some((item) => item.kind === "hunger")).toBe(false);
		const next = advanceLife(scope, roleplay, calm, state, [], NOW + 2 * HOUR, () => 0.999);
		expect(next.conditions.some((item) => item.kind === "hunger")).toBe(false);
	});
});

describe("source-driven diary, dream and cycle evolution", () => {
	it("carries only the three latest past diary tags, with virtual health causes and night influence", () => {
		const config = { ...calm, enable_health_state: true };
		const diaries = [
			diary("2026-10-13", ["低能量"]),
			diary("2026-10-14", ["失眠"]),
			diary("2026-10-15", ["生病"]),
			diary("2026-10-16", ["好梦"]),
			diary("2026-10-17", ["低能量"]),
		];
		const state = advanceLife(scope, roleplay, config, undefined, diaries, Date.UTC(2026, 9, 17, 2), () => 0);
		expect(state.conditions.some((item) => item.title === "睡眠延续")).toBe(true);
		expect(state.conditions.some((item) => item.title === "健康延续")).toBe(true);
		expect(state.conditions.some((item) => item.title === "梦境余温")).toBe(true);
		expect(state.conditions.some((item) => item.title === "能量延续")).toBe(false);
		expect(state.conditions.find((item) => item.kind === "health")?.cause).toContain("睡");
		expect(state.conditions.some((item) => item.phase === "late_night_awake")).toBe(true);
		expect(state.conditions.some((item) => item.kind === "dream_aftertaste")).toBe(true);
		expect(Check(LifeSimulationSchema, state)).toBe(true);
	});
	it("uses fictional weather only as a configured cause and never applies gender heuristics", () => {
		const config = { ...DEFAULT_LIFE_CONFIG, weather_context: "冷风，小雨，8°C" };
		const robot: RoleplayConfig = { ...roleplay, identity: "没有身体的男性机器人" };
		const state = advanceLife(scope, robot, config, undefined, [], NOW, () => 0);
		expect(state.conditions.some((item) => item.kind === "health")).toBe(true);
		expect(state.conditions.some((item) => item.kind === "body_cycle")).toBe(true);
		const off = advanceLife(
			scope,
			robot,
			{ ...config, enable_cycle_state: false, enable_health_state: false },
			state,
			[],
			NOW + 1,
			() => 0.999,
		);
		expect(off.conditions.some((item) => ["health", "body_cycle", "cycle_discomfort"].includes(item.kind))).toBe(
			false,
		);
	});
	it("preserves legacy episode spacing through phase transitions and avoids daily duplicate cycles", () => {
		const config = { ...calm, enable_cycle_state: true };
		const first = advanceLife(scope, roleplay, config, undefined, [], NOW, () => 0);
		const pre = first.conditions.find((item) => item.kind === "body_cycle")!;
		expect(pre.phase).toBe("pre");
		const second = advanceLife(scope, roleplay, config, first, [], pre.end_at, () => 0);
		expect(second.conditions.filter((item) => item.kind === "body_cycle")).toHaveLength(1);
		expect(second.conditions.find((item) => item.kind === "body_cycle")?.phase).toBe("period");
		expect(second.cycle.last_start_at).toBe(first.cycle.last_start_at);
		expect(second.cycle.next_expected_at).toBe(first.cycle.next_expected_at);
		const later = advanceLife(scope, roleplay, config, second, [], NOW + 10 * DAY, () => 0);
		expect(later.conditions.some((item) => item.kind === "body_cycle")).toBe(false);
		expect(later.cycle.next_expected_at).toBeGreaterThan(NOW + 18 * DAY);
	});
	it("anchors six phases across multiple complete cycles, restart and repeated identical offsets", () => {
		const config = {
			...calm,
			enable_cycle_state: true,
			enable_advanced_cycle_strategy: true,
			advanced_cycle_start_offset: 12,
		};
		const start = initial(config);
		expect(view(start, NOW, config).cycle).toMatchObject({ phase: "pre_ovulation", day: 12 });
		const anchor = start.cycle.anchor_at;
		const later = advanceLife(scope, roleplay, config, structuredClone(start), [], NOW + 2 * DAY, () => 0.999);
		expect(later.cycle.anchor_at).toBe(anchor);
		expect(view(later, NOW + 2 * DAY, config).cycle).toMatchObject({ phase: "ovulation", day: 14 });
		const longLater = advanceLife(scope, roleplay, config, structuredClone(later), [], NOW + 58 * DAY, () => 0.999);
		expect(longLater.cycle.anchor_at).toBe(anchor);
		expect(view(longLater, NOW + 58 * DAY, config).cycle).toMatchObject({ phase: "ovulation", day: 14 });
		const current = longLater.conditions.find((item) => item.kind === "body_cycle")!;
		expect(current.start_at).toBeLessThanOrEqual(NOW + 58 * DAY);
		expect(current.end_at).toBeGreaterThan(NOW + 58 * DAY);
		expect(current.start_at).toBeGreaterThan(NOW + 28 * DAY);
		expect(advanceLife(scope, roleplay, config, longLater, [], NOW + 58 * DAY + 1, () => 0.999)).toBe(longLater);
	});
	it("applies changed offsets once, clears their signature at zero, and allows reapplication", () => {
		const base = {
			...calm,
			enable_cycle_state: true,
			enable_advanced_cycle_strategy: true,
			advanced_cycle_start_offset: 12,
		};
		const start = initial(base);
		const changed = { ...base, advanced_cycle_start_offset: 5 };
		const reset = advanceLife(scope, roleplay, changed, start, [], NOW + HOUR, () => 0.999);
		expect(view(reset, NOW + HOUR, changed).cycle.day).toBe(5);
		const resetAnchor = reset.cycle.anchor_at;
		const cleared = advanceLife(
			scope,
			roleplay,
			{ ...changed, advanced_cycle_start_offset: 0 },
			reset,
			[],
			NOW + 2 * HOUR,
			() => 0.999,
		);
		expect(cleared.cycle.offset_signature).toBe("");
		expect(cleared.cycle.anchor_at).toBe(resetAnchor);
		const reapplied = advanceLife(scope, roleplay, changed, cleared, [], NOW + DAY, () => 0.999);
		expect(view(reapplied, NOW + DAY, changed).cycle.day).toBe(5);
		expect(reapplied.cycle.anchor_at).not.toBe(resetAnchor);
	});
	it("uses configured advanced energy without generic scaling, and linked energy when requested", () => {
		const config = {
			...calm,
			enable_cycle_state: true,
			enable_advanced_cycle_strategy: true,
			advanced_cycle_menstrual_energy: -30,
			humanized_state_intensity: 100,
		};
		const manual = initial(config);
		expect(manual.conditions.find((item) => item.kind === "body_cycle")?.energy_delta).toBe(-30);
		const linkedConfig = { ...config, advanced_cycle_link_intensity: true };
		const linked = advanceLife(scope, roleplay, linkedConfig, manual, [], NOW, () => 0.999);
		expect(linked.conditions.find((item) => item.kind === "body_cycle")?.energy_delta).toBe(-24);
		expect(linked.cycle.anchor_at).toBe(manual.cycle.anchor_at);
	});
	it.each([
		["menstrual", "月经期", 1],
		["follicular", "卵泡期", 6],
		["pre_ovulation", "排卵前期", 11],
		["ovulation", "排卵期", 14],
		["luteal", "黄体期", 15],
		["pms", "PMS 期", 23],
	] as const)(
		"persists bounded %s labels without narrowing or truncating configured prompts",
		async (phase, fallback, offset) => {
			const root = await mkdtemp(join(tmpdir(), "dw-life-phase-label-"));
			const path = join(root, "life.sqlite");
			let store: CompanionLifeStore | undefined;
			try {
				store = await CompanionLifeStore.open(path);
				const cases = [
					{ prompt: "", label: fallback },
					{ prompt: " \n\t ", label: fallback },
					{ prompt: "精神平稳，想慢慢整理笔记", label: "精神平稳，想慢慢整理笔记" },
					{ prompt: "  精神平稳，\n\t想慢慢整理笔记  ", label: "精神平稳， 想慢慢整理笔记" },
					{ prompt: "境".repeat(200), label: "境".repeat(200) },
					{ prompt: "长".repeat(201), label: "长".repeat(200) },
					{ prompt: "界".repeat(4000), label: "界".repeat(200) },
				];
				for (const [index, { prompt, label }] of cases.entries()) {
					const target = { ...scope, user_id: `${scope.user_id}-${index}` };
					const config: LifeConfig = {
						...calm,
						enable_cycle_state: true,
						enable_advanced_cycle_strategy: true,
						advanced_cycle_start_offset: offset,
						advanced_cycle_link_intensity: false,
						humanized_state_intensity: 100,
						[`advanced_cycle_${phase}_prompt`]: prompt,
						[`advanced_cycle_${phase}_mood`]: "安静",
						[`advanced_cycle_${phase}_energy`]: -17,
					};
					expect(Check(LifeConfigSchema, config)).toBe(true);
					const before = initial({ ...config, [`advanced_cycle_${phase}_prompt`]: "先前的阶段描述" });
					const prior = before.conditions.find((item) => item.kind === "body_cycle")!;
					store.putSimulation(target, before, 0);
					store.saveSettings(target, { expected_revision: 0, config });
					const saved = store.getSettings(target).config;
					expect(saved[`advanced_cycle_${phase}_prompt`]).toBe(prompt);
					const next = advanceLife(
						scope,
						roleplay,
						saved,
						store.getSimulation(target),
						[],
						NOW + 60_000,
						() => 0.999,
					);
					for (const state of [initial(saved), next]) {
						expect(Check(LifeSimulationSchema, state)).toBe(true);
						expect(state.conditions.filter((item) => item.kind === "body_cycle")).toHaveLength(1);
						const cycle = state.conditions.find((item) => item.kind === "body_cycle")!;
						expect(cycle).toMatchObject({
							phase,
							label,
							mood: "安静",
							energy_delta: -17,
							intensity: 100,
							start_at: prior.start_at,
							end_at: prior.end_at,
						});
						expect(cycle.label.length).toBeGreaterThan(0);
						expect(cycle.label.length).toBeLessThanOrEqual(200);
						expect(view(state, state.updated_at, saved)).toMatchObject({
							energy: 58,
							mood_bias: "安静",
							cycle: { phase, day: offset },
						});
					}
					expect(next.conditions.find((item) => item.kind === "body_cycle")?.id).toBe(prior.id);
					expect(next.cycle).toEqual(before.cycle);
					expect(next.revision).toBe(before.revision + 1);
					store.putSimulation(target, next, before.revision);
					expect(store.getSimulation(target)).toEqual(next);
				}
				store.close();
				store = await CompanionLifeStore.open(path);
				for (const [index, { prompt, label }] of cases.entries()) {
					const target = { ...scope, user_id: `${scope.user_id}-${index}` };
					expect(store.getSettings(target).config[`advanced_cycle_${phase}_prompt`]).toBe(prompt);
					const restored = store.getSimulation(target)!;
					expect(Check(LifeSimulationSchema, restored)).toBe(true);
					expect(restored.conditions.find((item) => item.kind === "body_cycle")).toMatchObject({ phase, label });
				}
			} finally {
				store?.close();
				await rm(root, { recursive: true, force: true });
			}
		},
	);
	it("makes optional discomfort a persisted once-daily roll and removes it when disabled", () => {
		const config = {
			...calm,
			enable_cycle_state: true,
			enable_advanced_cycle_strategy: true,
			advanced_cycle_discomfort_simulation: true,
			advanced_cycle_discomfort_chance: 100,
		};
		const state = advanceLife(scope, roleplay, config, undefined, [], NOW, () => 0);
		expect(state.conditions.filter((item) => item.kind === "cycle_discomfort")).toHaveLength(1);
		expect(state.cycle.last_discomfort_day).toBe("2026-10-17");
		const next = advanceLife(scope, roleplay, config, structuredClone(state), [], NOW + HOUR, () => 0);
		expect(next.conditions.filter((item) => item.kind === "cycle_discomfort")).toHaveLength(1);
		const off = advanceLife(
			scope,
			roleplay,
			{ ...config, advanced_cycle_discomfort_simulation: false },
			next,
			[],
			NOW + HOUR + 1,
			() => 0,
		);
		expect(off.conditions.some((item) => item.kind === "cycle_discomfort")).toBe(false);
		const failedConfig = { ...config, advanced_cycle_discomfort_chance: 0 };
		const failed = initial(failedConfig);
		expect(failed.cycle.last_discomfort_day).toBe("2026-10-17");
		const toggled = advanceLife(scope, roleplay, config, failed, [], NOW + HOUR, () => 0);
		expect(toggled.conditions.some((item) => item.kind === "cycle_discomfort")).toBe(false);
	});
});

describe("activity projection and manual CAS payloads", () => {
	it("prioritizes configured overnight routine over generated details, then uses current detail/plan only", () => {
		const config = { ...calm, enable_detail_enhancement: true };
		const state = initial(config);
		const cards = {
			...roleplay,
			routine: [{ start: "23:00", end: "07:00", activity: "角色设定优先", location: "房间" }],
		};
		expect(projectLife(cards, config, state, plan(), [detail()], NOW).activity).toMatchObject({
			label: "角色设定优先",
			location: "房间",
			virtual: true,
		});
		expect(projectLife(roleplay, config, state, plan(), [detail()], NOW).activity).toMatchObject({
			label: detail().summary,
			location: "树旁",
			source: "simulated fictional detail",
		});
		expect(projectLife(roleplay, config, state, plan(), [detail()], NOW + HOUR).activity.label).toBe("虚构早餐");
		expect(projectLife(roleplay, config, state, plan(), [detail()], NOW + DAY).activity.source).toBe(
			"configured fictional clock",
		);
		expect(
			projectLife(roleplay, { ...config, enable_daily_plan: false }, state, plan(), [detail()], NOW).activity.label,
		).not.toBe(detail().summary);
	});
	it("returns detached views so consumers cannot change persisted conditions or history", () => {
		const state = initial();
		const before = structuredClone(state);
		const projection = view(state);
		projection.conditions[0]!.label = "consumer mutation";
		projection.history[0]!.label = "consumer mutation";
		expect(state).toEqual(before);
	});
	it("infers manual mood/energy, defaults to twelve hours and increments CAS revision exactly once", () => {
		const before = initial();
		const next = addLifeCondition(before, calm, { label: "  有点累了  " }, NOW);
		const added = next.conditions.find((item) => item.kind === "manual_state")!;
		expect(added).toMatchObject({ label: "有点累了", intensity: 60, mood: "疲惫", energy_delta: -10 });
		expect(added.end_at - added.start_at).toBe(12 * HOUR);
		expect(next.revision).toBe(before.revision + 1);
		expect(Check(LifeSimulationSchema, next)).toBe(true);
		expect(before.conditions.some((item) => item.kind === "manual_state")).toBe(false);
		const removed = removeLifeCondition(next, added.id, NOW);
		expect(removed.revision).toBe(next.revision + 1);
		expect(removed.conditions.some((item) => item.id === added.id)).toBe(false);
		expect(removed.history.at(-1)?.kind).toBe("manual_removed");
		expect(() => removeLifeCondition(removed, added.id, NOW)).toThrow("not found");
	});
	it("rejects credentials, disabled inferred states, invalid duration and backward manual mutations", () => {
		const state = initial();
		for (const label of ["Bearer abcdefghijklmnop", "api_key=private-value", "sk-abcdefghijklmno", "\n\t"])
			expect(() => addLifeCondition(state, calm, { label }, NOW)).toThrow();
		for (const duration_hours of [0, 73, 1.5, Number.NaN])
			expect(() => addLifeCondition(state, calm, { label: "开心", duration_hours }, NOW)).toThrow("duration");
		expect(() => addLifeCondition(state, calm, { label: "饿了" }, NOW)).toThrow("hunger");
		expect(() => addLifeCondition(state, calm, { label: "头痛" }, NOW)).toThrow("health");
		expect(() => addLifeCondition(state, calm, { label: "开心" }, NOW - 1)).toThrow("before");
		const maximum = addLifeCondition(state, calm, { label: "开心", duration_hours: 72 }, NOW);
		expect(maximum.conditions.at(-1)!.end_at).toBe(NOW + 72 * HOUR);
	});
	it("bounds transition history while retaining schema-valid revisions and independently removable IDs", () => {
		let state = initial();
		for (let index = 0; index < 110; index++) {
			state = addLifeCondition(state, calm, { label: `安静 ${index}` }, NOW);
			const id = state.conditions.at(-1)!.id;
			state = removeLifeCondition(state, id, NOW);
		}
		expect(state.history).toHaveLength(100);
		expect(new Set(state.history.map((entry) => entry.id)).size).toBe(100);
		expect(Check(LifeSimulationSchema, state)).toBe(true);
	});
});
