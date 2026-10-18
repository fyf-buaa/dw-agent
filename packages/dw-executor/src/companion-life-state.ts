import type {
	DiaryEntry,
	LifeCondition,
	LifeConfig,
	LifeDetail,
	LifeEvolution,
	LifePlan,
	LifeSimulation,
	LifeStateView,
} from "./companion-life-types.ts";
import { sanitizeMemoryText } from "./companion-store.ts";
import type { MemoryScope, RoleplayConfig } from "./companion-types.ts";
import { ExecutorError } from "./errors.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
type Spec = readonly [label: string, mood: string, energy: number, hours: number];
type Kind = LifeCondition["kind"];
const PHASES = ["menstrual", "follicular", "pre_ovulation", "ovulation", "luteal", "pms"] as const;
type Phase = (typeof PHASES)[number];
const PHASE_NAMES: Record<Phase, string> = {
	menstrual: "月经期",
	follicular: "卵泡期",
	pre_ovulation: "排卵前期",
	ovulation: "排卵期",
	luteal: "黄体期",
	pms: "PMS 期",
};
const MEDIANS: Record<Phase, number> = {
	menstrual: -12,
	follicular: 0,
	pre_ovulation: 7.5,
	ovulation: 9,
	luteal: 4.5,
	pms: -7.5,
};
const SLEEP: readonly Spec[] = [
	["睡得很踏实", "平稳", 0, 8],
	["昨晚睡得很浅,半夜醒了好几次", "迟钝", -16, 10],
	["失眠了,翻来覆去很久才睡着", "敏感", -24, 14],
	["一晚上都在做梦,醒过来却记不清", "恍惚", -18, 12],
	["赖床赖得有点久,懵懵的", "迷糊", -14, 8],
	["闹钟没叫醒我,起来还有点懵", "慌乱", -17, 7],
];
const DREAM: readonly Spec[] = [
	["没有记住梦", "平稳", 0, 2],
	["梦里一直在找一件放错地方的小东西,醒来还残着一点没找完的感觉", "恍惚", -6, 5],
	["梦见走过一段很安静的路,路灯和风声都很近", "柔和", 4, 4],
	["梦里反复听见一句没听清的话,醒来后胸口还有点闷", "低落", -10, 7],
];
const HUNGER: readonly Spec[] = [
	["无饥饿感", "平稳", 0, 3],
	["饿,想吃东西", "粘人", -4, 2],
	["胃口不好", "低落", -8, 3],
	["想吃甜的", "柔软", 1, 2],
];
const LEGACY: readonly Spec[] = [
	["不处于生理期", "平稳", 0, 24],
	["生理期前,身体感受更敏锐,耐受度稍低", "敏感", -18, 24],
	["处于生理期,身体舒适度与能量偏低", "疲惫", -24, 72],
];
const MEALS = [
	{ id: "breakfast", from: 420, to: 570, spec: ["饿,想吃热的", "柔软", -4, 2] },
	{ id: "lunch", from: 660, to: 820, spec: ["饿,想吃东西", "走神", -6, 2] },
	{ id: "afternoon", from: 900, to: 1020, spec: ["想吃甜的", "柔软", 2, 2] },
	{ id: "dinner", from: 1050, to: 1200, spec: ["饿,想吃热的", "粘人", -5, 3] },
	{ id: "late_snack", from: 1290, to: 1410, spec: ["有点想吃东西", "松散", -3, 2] },
] as const;

export interface LifeClock {
	day: string;
	minute: number;
	hour: number;
	year: number;
	month: number;
	date: number;
	display: string;
}
export function lifeClock(now: number, timezone: string): LifeClock {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(now);
	const get = (kind: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === kind)?.value ?? "";
	const day = `${get("year")}-${get("month")}-${get("day")}`;
	return {
		day,
		minute: Number(get("hour")) * 60 + Number(get("minute")),
		hour: Number(get("hour")),
		year: Number(get("year")),
		month: Number(get("month")),
		date: Number(get("day")),
		display: `${day} ${get("hour")}:${get("minute")} (${timezone})`,
	};
}

function has(text: string, tokens: readonly string[]): boolean {
	return tokens.some((token) => text.includes(token));
}
function integer(random: () => number, low: number, high: number): number {
	return low + Math.floor(Math.max(0, Math.min(0.999999999999, random())) * (high - low + 1));
}
function choose<T>(values: readonly T[], random: () => number): T {
	return values[integer(random, 0, values.length - 1)]!;
}
function pick(pool: readonly Spec[], chance: number, intensity: number, random: () => number): Spec {
	return random() > chance * Math.max(0.2, intensity) ? pool[0]! : choose(pool.slice(1), random);
}
// Python's round uses ties-to-even; linked phase energies use that source convention.
function round(value: number): number {
	const floor = Math.floor(value);
	return value - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
}
function phaseDays(config: LifeConfig, phase: Phase): number {
	return config[`advanced_cycle_${phase}_days`];
}
function totalDays(config: LifeConfig): number {
	return PHASES.reduce((sum, phase) => sum + phaseDays(config, phase), 0);
}
function phaseSpec(config: LifeConfig, phase: Phase): Spec {
	const label = config[`advanced_cycle_${phase}_prompt`].replace(/\s+/g, " ").trim().slice(0, 200);
	return [
		label || PHASE_NAMES[phase],
		config[`advanced_cycle_${phase}_mood`],
		config.advanced_cycle_link_intensity
			? round((MEDIANS[phase] * config.humanized_state_intensity) / 50)
			: config[`advanced_cycle_${phase}_energy`],
		phaseDays(config, phase) * 24,
	];
}
function position(config: LifeConfig, anchor: number, now: number) {
	const total = totalDays(config);
	const elapsed = Math.max(0, Math.floor((now - anchor) / DAY));
	const cycleDay = elapsed % total;
	let cursor = 0;
	for (const phase of PHASES) {
		const days = phaseDays(config, phase);
		if (cycleDay < cursor + days)
			return {
				phase,
				day: cycleDay - cursor + 1,
				cycle_day: cycleDay + 1,
				start: anchor + (elapsed - cycleDay + cursor) * DAY,
				end: anchor + (elapsed - cycleDay + cursor + days) * DAY,
			};
		cursor += days;
	}
	throw new ExecutorError("LIFE_INVALID_CONDITION", "Invalid fictional cycle configuration");
}
function allowed(condition: LifeCondition, config: LifeConfig): boolean {
	if (condition.kind === "health" || condition.kind === "health_tail" || condition.kind === "recovery_afterglow")
		return config.enable_health_state;
	if (condition.kind === "hunger") return config.enable_hunger_state;
	if (condition.kind === "body_cycle") return config.enable_cycle_state;
	if (condition.kind === "cycle_discomfort")
		return (
			config.enable_cycle_state &&
			config.enable_advanced_cycle_strategy &&
			config.advanced_cycle_discomfort_simulation
		);
	return true;
}
function active(condition: LifeCondition, now: number): boolean {
	return condition.start_at <= now && now < condition.end_at;
}
function condition(
	simulation: LifeSimulation,
	kind: Kind,
	title: string,
	spec: Spec,
	start: number,
	intensity: number,
	extras: Partial<LifeCondition> = {},
): LifeCondition {
	const id = `${kind}-${start}-${simulation.revision}-${simulation.history.length}-${simulation.conditions.length}`;
	return {
		id,
		kind,
		title,
		label: spec[0],
		mood: spec[1],
		energy_delta: spec[2],
		intensity,
		start_at: start,
		end_at: start + spec[3] * HOUR,
		phase: "",
		cause: "",
		episode_key: null,
		transition_options: [],
		...extras,
	};
}
function event(
	simulation: LifeSimulation,
	kind: LifeEvolution["kind"],
	at: number,
	item: LifeCondition | null,
	from = "",
	to = "",
	label = item?.label ?? "",
): void {
	simulation.history.push({
		id: `e-${simulation.revision}-${at}-${simulation.history.length}-${item?.id ?? kind}`,
		at,
		kind,
		condition_id: item?.id ?? null,
		label: label.slice(0, 200),
		from_phase: from,
		to_phase: to,
		virtual: true,
	});
}
function append(simulation: LifeSimulation, item: LifeCondition): void {
	if (simulation.conditions.length >= 200) return;
	simulation.conditions.push(item);
	event(simulation, "condition_started", item.start_at, item, "", item.phase);
}
function options(kind: Kind, energy: number): LifeCondition["transition_options"] {
	if (kind === "health" && energy < 0)
		return [
			{ to: "recovery_afterglow", base_weight: 0.45 },
			{ to: "stable", base_weight: 0.4 },
			{ to: "health_tail", base_weight: 0.15 },
		];
	if (kind === "sleep" && energy <= -16)
		return [
			{ to: "sleep_afterglow", base_weight: 0.35 },
			{ to: "stable", base_weight: 0.5 },
			{ to: "sleep_tail", base_weight: 0.15 },
		];
	return [];
}
function weighted(values: readonly { to: string; base_weight: number }[], random: () => number): string {
	const total = values.reduce((sum, value) => sum + value.base_weight, 0);
	if (total <= 0) return "";
	let remaining = random() * total;
	for (const value of values) {
		remaining -= value.base_weight;
		if (remaining <= 0) return value.to;
	}
	return values.at(-1)?.to ?? "";
}
function followup(
	simulation: LifeSimulation,
	config: LifeConfig,
	prior: LifeCondition,
	random: () => number,
): LifeCondition | undefined {
	const weightedOptions = prior.transition_options.map((option) => {
		let weight = option.base_weight;
		if (option.to === "recovery_afterglow" && has(prior.cause, ["提醒", "用户"])) weight += 0.06;
		if (option.to === "health_tail") {
			if (prior.intensity >= 75) weight += 0.1;
			if (has(prior.cause, ["透支", "失眠"])) weight += 0.08;
			if (has(config.weather_context, ["降雨", "小雨", "中雨", "大雨", "冷", "风"])) weight += 0.05;
		}
		if (option.to === "sleep_tail") {
			if (prior.intensity >= 80) weight += 0.08;
			if (has(prior.cause, ["失眠", "睡"])) weight += 0.04;
		}
		return { to: option.to, base_weight: weight };
	});
	const target = weighted(weightedOptions, random);
	const start = prior.end_at; // Downtime must not renew a tail from the later maintenance time.
	let result: LifeCondition | undefined;
	if (target === "recovery_afterglow")
		result = condition(
			simulation,
			target,
			"恢复后的回弹",
			[prior.cause ? "不适正在缓解,状态明显回升" : "不适缓解后的轻度回升", "轻快", 10, 12],
			start,
			68,
			{ cause: "前序不适开始缓解", phase: "afterglow" },
		);
	if (target === "health_tail")
		result = condition(simulation, target, "恢复尾声", ["整体好转,但仍有轻微虚弱残留", "平缓", -4, 10], start, 48, {
			cause: "恢复中,体力尚未完全回满",
			phase: "tail",
		});
	if (target === "sleep_afterglow")
		result = condition(simulation, target, "补回来一点精神", ["睡意缓解后的轻度回升", "轻松", 8, 8], start, 60, {
			cause: "前序失眠或浅睡影响减弱",
			phase: "afterglow",
		});
	if (target === "sleep_tail")
		result = condition(simulation, target, "迟钝尾声", ["睡眠影响减弱,但反应仍略慢", "安静", -3, 6], start, 42, {
			cause: "睡眠债仍有轻微残留",
			phase: "tail",
		});
	if (target === "body_period")
		result = condition(
			simulation,
			"body_cycle",
			"周期",
			["处于生理期,身体舒适度与能量偏低", "疲惫", -18, 72],
			start,
			64,
			{
				phase: "period",
				cause: "周期阶段自然推进",
				episode_key: prior.episode_key,
				transition_options: [
					{ to: "body_recovery", base_weight: 0.65 },
					{ to: "stable", base_weight: 0.35 },
				],
			},
		);
	if (target === "body_recovery")
		result = condition(simulation, "body_cycle", "周期", ["生理期后,慢慢回到稳定状态", "松弛", -5, 24], start, 48, {
			phase: "recovery",
			cause: "周期阶段自然推进",
			episode_key: prior.episode_key,
			transition_options: [{ to: "stable", base_weight: 1 }],
		});
	if (result) {
		event(simulation, "transition", start, result, prior.phase, result.phase);
		if (result.kind === "body_cycle") {
			simulation.cycle.last_end_at = Math.max(simulation.cycle.last_end_at ?? 0, result.end_at);
			simulation.cycle.next_expected_at = Math.max(
				simulation.cycle.next_expected_at ?? (simulation.cycle.last_start_at ?? start) + 28 * DAY,
				result.end_at + 18 * DAY,
			);
		}
	}
	return result;
}
function expire(simulation: LifeSimulation, config: LifeConfig, now: number, random: () => number): void {
	const pending = simulation.conditions;
	simulation.conditions = [];
	for (const item of pending) {
		if (!allowed(item, config)) {
			event(simulation, "condition_ended", now, item, item.phase, "disabled");
			continue;
		}
		let current: LifeCondition | undefined = item;
		while (current && current.end_at <= now) {
			event(simulation, "condition_ended", current.end_at, current, current.phase);
			current =
				current.kind === "body_cycle" && config.enable_advanced_cycle_strategy
					? undefined
					: followup(simulation, config, current, random);
			if (current) event(simulation, "condition_started", current.start_at, current, "", current.phase);
		}
		if (current) simulation.conditions.push(current);
	}
}
function synchronizeCycle(simulation: LifeSimulation, config: LifeConfig, now: number): void {
	const strategy = config.enable_advanced_cycle_strategy ? "advanced" : "legacy";
	if (!config.enable_cycle_state || simulation.cycle.strategy !== strategy) {
		for (const item of simulation.conditions.filter(
			(item) => item.kind === "body_cycle" || item.kind === "cycle_discomfort",
		))
			event(simulation, "condition_ended", now, item, item.phase, "disabled");
		simulation.conditions = simulation.conditions.filter(
			(item) => item.kind !== "body_cycle" && item.kind !== "cycle_discomfort",
		);
		simulation.cycle = {
			strategy,
			last_start_at: null,
			last_end_at: null,
			next_expected_at: null,
			anchor_at: null,
			offset_signature: "",
			last_discomfort_day: null,
		};
	}
	if (!config.enable_cycle_state || !config.enable_advanced_cycle_strategy) return;
	const offset = config.advanced_cycle_start_offset;
	const signature = offset > 0 ? `${offset}:${PHASES.map((phase) => phaseDays(config, phase)).join(",")}` : "";
	if (signature && signature !== simulation.cycle.offset_signature) {
		for (const item of simulation.conditions.filter((item) => item.kind === "body_cycle"))
			event(simulation, "condition_ended", now, item, item.phase, "offset_changed");
		simulation.conditions = simulation.conditions.filter((item) => item.kind !== "body_cycle");
		simulation.cycle.anchor_at = Math.max(0, now - (offset - 1) * DAY);
	}
	simulation.cycle.offset_signature = signature;
	if (simulation.cycle.anchor_at === null) simulation.cycle.anchor_at = now;
	const pos = position(config, simulation.cycle.anchor_at, now);
	const spec = phaseSpec(config, pos.phase);
	const old = simulation.conditions.find((item) => item.kind === "body_cycle");
	if (!old || old.phase !== pos.phase || old.start_at !== pos.start || old.end_at !== pos.end) {
		if (old) event(simulation, "condition_ended", Math.min(old.end_at, now), old, old.phase);
		simulation.conditions = simulation.conditions.filter((item) => item.kind !== "body_cycle");
		const item = condition(
			simulation,
			"body_cycle",
			"周期",
			spec,
			pos.start,
			Math.max(35, config.humanized_state_intensity),
			{
				phase: pos.phase,
				end_at: pos.end,
				cause: signature ? "管理员设置的周期时间线" : "周期阶段自然推进",
				episode_key: `body-cycle-${simulation.cycle.anchor_at}`,
				transition_options: [
					{ to: `body_${PHASES[(PHASES.indexOf(pos.phase) + 1) % PHASES.length]}`, base_weight: 1 },
				],
			},
		);
		append(simulation, item);
		const fromPhase =
			old?.phase ??
			simulation.history.findLast(
				(entry) => entry.kind === "condition_ended" && entry.condition_id?.startsWith("body_cycle-"),
			)?.from_phase;
		if (fromPhase) event(simulation, "transition", pos.start, item, fromPhase, pos.phase);
	} else {
		old.label = spec[0];
		old.mood = spec[1];
		old.energy_delta = spec[2];
		old.intensity = Math.max(35, config.humanized_state_intensity);
	}
	const total = totalDays(config);
	const cycleStart =
		simulation.cycle.anchor_at +
		Math.floor(Math.max(0, now - simulation.cycle.anchor_at) / (total * DAY)) * total * DAY;
	simulation.cycle.last_start_at = cycleStart;
	simulation.cycle.last_end_at = pos.end;
	simulation.cycle.next_expected_at = cycleStart + total * DAY;
}

function healthSpec(
	sleep: string,
	tags: Set<string>,
	weather: string,
	intensity: number,
	random: () => number,
): { spec: Spec; cause: string } | undefined {
	const causes: string[] = [];
	if (sleep !== "睡眠平稳" && sleep !== "睡得很踏实" && random() < 0.7) causes.push("昨晚没睡踏实");
	if ((tags.has("失眠") || tags.has("低能量")) && random() < 0.45) causes.push("前一天状态就有点透支");
	if (has(weather, ["降雨", "小雨", "中雨", "大雨", "阴", "多云"]) && random() < 0.4)
		causes.push("空气有点潮,身上那股乏劲更明显");
	if (has(weather, ["风", "降温", "冷"]) && random() < 0.55) causes.push("吹了点风,身上容易发空");
	const match = /(-?\d+(?:\.\d+)?)\s*°c/i.exec(weather);
	if (match) {
		const temperature = Number(match[1]);
		if (temperature <= 10 && random() < 0.55) causes.push("天气偏冷,早上容易着凉");
		else if (temperature >= 30 && random() < 0.35) causes.push("天气闷热,整个人有点蔫");
	}
	if (!causes.length || random() > Math.min(0.42, 0.12 + causes.length * 0.1 * Math.max(0.5, intensity)))
		return undefined;
	const cause = [...new Set(causes.slice(0, 2))].join(",");
	const spec = choose<Spec>(
		[
			["喉咙有点发紧,今天想少说重话", "安静", -10, 24],
			["头有点沉,做事想放慢一点", "疲惫", -14, 18],
			["像有点发虚,反应会慢半拍", "疲惫", -18, 30],
		],
		random,
	);
	let label = spec[0];
	if (cause.includes("闷热") && label.includes("喉咙")) label = "有点发闷,只想把动作放轻一点";
	if (cause.includes("潮") && label.includes("头有点沉")) label = "身上有点沉,今天想把事情做轻一点";
	return { spec: [label, spec[1], spec[2], spec[3]], cause };
}
function dreamAftertaste(simulation: LifeSimulation, dream: Spec, now: number, random: () => number): void {
	const [label, mood, energy] = dream;
	if (label === "没有记住梦") return;
	const uneasy = has(label, ["不舒服", "追", "黑", "掉下去", "迷路", "醒来后有一点黏着感"]);
	const strength = uneasy ? 1.15 : Math.abs(energy) >= 10 ? 1.1 : Math.abs(energy) <= 2 ? 0.75 : 0.95;
	if (random() > Math.min(0.92, 0.45 + strength * 0.2)) return;
	let title = "梦后的朦胧残影";
	let spec: Spec = [
		"梦里的画面还没完全从脑子里退下去",
		mood === "平稳" ? "恍惚" : mood,
		-Math.max(1, round(2 * strength)),
		Math.max(2, round(4 * strength)),
	];
	let intensity = Math.min(82, Math.trunc(42 + 16 * strength));
	if (uneasy || label.includes("恐怖")) {
		title = "梦后的不安残留";
		spec = [
			"梦里的那点不安还没完全褪干净",
			["恍惚", "低落", "敏感"].includes(mood) ? "恍惚" : "敏感",
			-Math.max(2, round(4 * strength)),
			Math.max(2, round(6 * strength)),
		];
		intensity = Math.min(92, Math.trunc(50 + 20 * strength));
	} else if (has(label, ["发光", "柔", "亮色", "温暖", "春梦", "暧昧", "怀旧"])) {
		title = "梦后的余温";
		spec = [
			"梦里的余温还轻轻黏着一点",
			!["平稳", "中性"].includes(mood) ? "柔和" : "安静",
			Math.max(1, round(2 * strength)),
			Math.max(2, round(5 * strength)),
		];
		intensity = Math.min(88, Math.trunc(46 + 16 * strength));
	}
	append(
		simulation,
		condition(simulation, "dream_aftertaste", title, spec, now, intensity, {
			cause: `梦境余韵：${label.slice(0, 40)}`,
			phase: "dream_aftertaste",
		}),
	);
}
function daily(
	simulation: LifeSimulation,
	config: LifeConfig,
	diaries: readonly DiaryEntry[],
	now: number,
	local: LifeClock,
	random: () => number,
): void {
	const intensity = config.humanized_state_intensity / 100;
	const sleep = pick(SLEEP, 0.42, intensity, random);
	const dream = pick(DREAM, 0.55, intensity, random);
	const hunger = pick(HUNGER, 0.22, intensity, random);
	const add = (kind: Kind, title: string, spec: Spec, cause = "") => {
		if (spec[2] === 0 && kind !== "sleep" && kind !== "dream") return;
		if (kind === "hunger" && simulation.conditions.some((item) => item.kind === "hunger" && active(item, now)))
			return;
		const extras = {
			cause,
			phase:
				kind === "health" && spec[2] < 0
					? "mild_discomfort"
					: kind === "sleep" && spec[2] <= -16
						? "sleep_debt"
						: "",
			transition_options: options(kind, spec[2]),
		};
		append(
			simulation,
			condition(
				simulation,
				kind,
				title,
				[spec[0], spec[1], Math.trunc(spec[2] * Math.max(0.4, intensity)), spec[3]],
				now,
				integer(random, 35, 90),
				extras,
			),
		);
	};
	add("sleep", "睡眠", sleep);
	add("dream", "梦境", dream);
	if (config.enable_hunger_state) add("hunger", "饥饿", hunger);
	const legacyRestDays = simulation.cycle.next_expected_at === null ? 18 : 14;
	if (
		config.enable_cycle_state &&
		!config.enable_advanced_cycle_strategy &&
		!simulation.conditions.some((item) => item.kind === "body_cycle") &&
		(simulation.cycle.next_expected_at === null || now >= simulation.cycle.next_expected_at - 2 * DAY) &&
		(simulation.cycle.last_end_at === null || now >= simulation.cycle.last_end_at + legacyRestDays * DAY)
	) {
		const expected = simulation.cycle.next_expected_at;
		const chance =
			expected === null
				? 0.085 * Math.max(0.35, Math.min(1.2, intensity))
				: Math.min(0.65, 0.18 + Math.max(0, (now - expected) / DAY) * 0.12) *
					Math.max(0.35, Math.min(1.15, intensity));
		if (random() <= chance) {
			const pre = random() <= 0.45;
			const spec = LEGACY[pre ? 1 : 2]!;
			const item = condition(
				simulation,
				"body_cycle",
				"周期",
				[spec[0], spec[1], Math.trunc(spec[2] * Math.max(0.4, intensity)), spec[3]],
				now,
				integer(random, 35, 90),
				{
					phase: pre ? "pre" : "period",
					episode_key: `body-cycle-${local.day}`,
					transition_options: pre
						? [
								{ to: "body_period", base_weight: 0.72 },
								{ to: "stable", base_weight: 0.28 },
							]
						: [
								{ to: "body_recovery", base_weight: 0.65 },
								{ to: "stable", base_weight: 0.35 },
							],
				},
			);
			append(simulation, item);
			simulation.cycle.last_start_at = now;
			simulation.cycle.last_end_at = item.end_at;
			simulation.cycle.next_expected_at = now + integer(random, 25, 34) * DAY;
		}
	}
	const tags = new Set(
		[...diaries]
			.filter((diary) => diary.date < local.day)
			.sort((a, b) => b.date.localeCompare(a.date))
			.slice(0, 3)
			.flatMap((diary) => diary.tags),
	);
	if (config.enable_health_state) {
		const health = healthSpec(sleep[0], tags, config.weather_context, intensity, random);
		if (health) add("health", "健康", health.spec, health.cause);
	}
	if (tags.has("失眠") && random() < 0.35) add("sleep", "睡眠延续", ["昨晚的失眠感还没完全散掉", "迟钝", -12, 8]);
	if (config.enable_health_state && tags.has("生病") && random() < 0.4)
		add("health", "健康延续", ["身体像还在恢复,反应慢半拍", "疲惫", -14, 18], "前两天的不舒服还没完全退掉");
	if (tags.has("低能量") && random() < 0.35) add("sleep", "能量延续", ["昨天的低电量拖到今天早上", "安静", -10, 6]);
	if (tags.has("好梦") && random() < 0.3) add("dream", "梦境余温", ["梦里留下了一点柔和的亮色", "柔和", 4, 5]);
	dreamAftertaste(simulation, dream, now, random);
	if (local.hour < 5) {
		const spec = choose<Spec>(
			[
				["夜里还没完全安静下来,眼睛和脑子都慢半拍", "困倦", -14, 4],
				["这个点还醒着,困意和清醒混在一起", "恍惚", -12, 3],
				["已经很晚了,精神有点发飘,只想把声音放轻", "疲惫", -10, 5],
			],
			random,
		);
		append(
			simulation,
			condition(
				simulation,
				"sleep",
				"夜深未眠",
				[spec[0], spec[1], Math.trunc(spec[2] * Math.max(0.55, intensity)), spec[3]],
				now,
				integer(random, 45, 88),
				{
					phase: "late_night_awake",
					transition_options: [
						{ to: "sleep_afterglow", base_weight: 0.35 },
						{ to: "sleep_tail", base_weight: 0.2 },
						{ to: "stable", base_weight: 0.45 },
					],
				},
			),
		);
	}
	simulation.generated_day = local.day;
	event(simulation, "day_generated", now, null, "", "", `虚构状态：${local.day}`);
}
const DISCOMFORT: readonly { name: string; phases: readonly Phase[]; spec: Spec; weight: number }[] = [
	{ name: "痛经", phases: ["menstrual"], spec: ["今天有点痛经，小腹闷闷地不舒服", "疲惫", -14, 6], weight: 4 },
	{ name: "头痛", phases: ["menstrual", "pms"], spec: ["头有点闷痛，注意力不太集中", "迟钝", -10, 5], weight: 3 },
	{ name: "腰酸", phases: ["menstrual", "luteal"], spec: ["腰有点酸，不太想久坐", "疲惫", -8, 6], weight: 3 },
	{
		name: "乏力",
		phases: ["menstrual", "luteal", "pms"],
		spec: ["身上没什么力气，动作慢半拍", "困倦", -12, 8],
		weight: 4,
	},
	{ name: "情绪低落", phases: ["pms"], spec: ["情绪有点低，不太想说话", "低落", -6, 5], weight: 2 },
	{ name: "恶心", phases: ["menstrual", "pms"], spec: ["胃里有点泛恶心，不太想吃东西", "虚弱", -9, 4], weight: 1 },
];
function discomfort(
	simulation: LifeSimulation,
	config: LifeConfig,
	now: number,
	day: string,
	random: () => number,
): void {
	if (
		!config.enable_cycle_state ||
		!config.enable_advanced_cycle_strategy ||
		!config.advanced_cycle_discomfort_simulation ||
		config.humanized_state_intensity <= 0 ||
		simulation.cycle.anchor_at === null ||
		simulation.cycle.last_discomfort_day === day ||
		simulation.conditions.some((item) => item.kind === "cycle_discomfort" && active(item, now))
	)
		return;
	simulation.cycle.last_discomfort_day = day;
	if (config.advanced_cycle_discomfort_chance <= 0 || random() > config.advanced_cycle_discomfort_chance / 100) return;
	const phase = position(config, simulation.cycle.anchor_at, now).phase;
	const requested = new Set(
		config.advanced_cycle_discomfort_types
			.replaceAll("，", ",")
			.split(",")
			.map((name) => name.trim()),
	);
	const candidates = DISCOMFORT.filter((item) => requested.has(item.name) && item.phases.includes(phase));
	const name = weighted(
		candidates.map((item) => ({ to: item.name, base_weight: item.weight })),
		random,
	);
	const selected = candidates.find((item) => item.name === name);
	if (!selected) return;
	const spec = selected.spec;
	append(
		simulation,
		condition(
			simulation,
			"cycle_discomfort",
			"经期不适",
			[spec[0], spec[1], Math.trunc(spec[2] * Math.max(0.5, config.humanized_state_intensity / 50)), spec[3]],
			now,
			integer(random, 45, Math.max(46, Math.min(92, 40 + config.humanized_state_intensity))),
			{ cause: "生理周期阶段伴随不适", phase: name, episode_key: `cycle-discomfort-${day}` },
		),
	);
}
function meal(simulation: LifeSimulation, config: LifeConfig, now: number, minute: number, random: () => number): void {
	if (
		!config.enable_hunger_state ||
		simulation.conditions.some((item) => item.kind === "hunger" && active(item, now)) ||
		simulation.hunger.generated.length >= 2 ||
		simulation.hunger.generated.some((item) => now - item.at < 4 * HOUR)
	)
		return;
	const window = MEALS.find((item) => item.from <= minute && minute <= item.to);
	if (!window || simulation.hunger.attempted.includes(window.id)) return;
	simulation.hunger.attempted.push(window.id);
	const intensity = config.humanized_state_intensity / 100;
	const chance = (0.25 + 0.3 * intensity) * (["afternoon", "late_snack"].includes(window.id) ? 0.65 : 1);
	if (random() > chance) return;
	const spec = window.spec;
	append(
		simulation,
		condition(
			simulation,
			"hunger",
			"饭点",
			[spec[0], spec[1], Math.trunc(spec[2] * Math.max(0.55, intensity)), spec[3]],
			now,
			integer(random, 45, 82),
			{ phase: window.id, cause: "饭点自然波动" },
		),
	);
	simulation.hunger.generated.push({ window: window.id, at: now });
}
function finish(next: LifeSimulation, previous: LifeSimulation | undefined, now: number): LifeSimulation {
	next.history = next.history.slice(-100);
	if (
		previous &&
		JSON.stringify({ ...next, revision: 0, updated_at: 0 }) ===
			JSON.stringify({ ...previous, revision: 0, updated_at: 0 })
	)
		return previous;
	next.revision = (previous?.revision ?? 0) + 1;
	next.updated_at = now;
	return next;
}

/** Explicit math-only mutation boundary. Reads must use projectLife instead. */
export function advanceLife(
	_scope: MemoryScope,
	roleplay: RoleplayConfig,
	config: LifeConfig,
	previous: LifeSimulation | undefined,
	recentDiaries: readonly DiaryEntry[],
	now: number,
	random: () => number = Math.random,
): LifeSimulation {
	if (previous && now < previous.updated_at) return previous;
	const local = lifeClock(now, roleplay.timezone);
	const simulation: LifeSimulation = previous
		? structuredClone(previous)
		: {
				revision: 1,
				generated_day: null,
				updated_at: now,
				conditions: [],
				cycle: {
					strategy: config.enable_advanced_cycle_strategy ? "advanced" : "legacy",
					last_start_at: null,
					last_end_at: null,
					next_expected_at: null,
					anchor_at: null,
					offset_signature: "",
					last_discomfort_day: null,
				},
				hunger: { day: local.day, attempted: [], generated: [] },
				history: [],
			};
	if (!roleplay.enabled || !config.enable_humanized_states) return finish(simulation, previous, now);
	if (simulation.generated_day !== null && local.day < simulation.generated_day) return previous ?? simulation;
	if (simulation.hunger.day !== local.day) simulation.hunger = { day: local.day, attempted: [], generated: [] };
	synchronizeCycle(simulation, config, now);
	expire(simulation, config, now, random);
	if (simulation.generated_day !== local.day) daily(simulation, config, recentDiaries, now, local, random);
	discomfort(simulation, config, now, local.day, random);
	meal(simulation, config, now, local.minute, random);
	return finish(simulation, previous, now);
}

function clockMinute(value: string): number {
	const [hour, minute] = value.split(":").map(Number);
	return hour! * 60 + minute!;
}
function inRange(minute: number, start: number, end: number): boolean {
	return start < end ? start <= minute && minute < end : start > end && (minute >= start || minute < end);
}
function activity(
	roleplay: RoleplayConfig,
	config: LifeConfig,
	plan: LifePlan | undefined,
	details: readonly LifeDetail[],
	local: LifeClock,
): LifeStateView["activity"] {
	const routine = roleplay.routine.find((item) =>
		inRange(local.minute, clockMinute(item.start), clockMinute(item.end)),
	);
	if (routine)
		return {
			label: routine.activity,
			location: routine.location,
			virtual: true,
			source: "configured fictional routine",
		};
	if (config.enable_daily_plan && plan?.date === local.day) {
		const index = plan.items.findIndex(
			(item, index) =>
				local.minute >= clockMinute(item.time) &&
				local.minute < clockMinute(item.end ?? plan.items[index + 1]?.time ?? "24:00"),
		);
		const item = plan.items[index];
		if (item) {
			const detail = config.enable_detail_enhancement
				? details.find((entry) => entry.date === local.day && entry.segment === item.time)
				: undefined;
			return {
				label: detail?.summary ?? item.activity,
				location: detail?.location || item.location || "",
				virtual: true,
				source: detail ? "simulated fictional detail" : `fictional plan (${plan.source})`,
			};
		}
	}
	const sleeping = inRange(local.minute, clockMinute(roleplay.sleep_time), clockMinute(roleplay.wake_time));
	return {
		label: sleeping ? "sleeping (fictional)" : "unstructured time (fictional)",
		location: "",
		virtual: true,
		source: "configured fictional clock",
	};
}

/** Pure projection: no persistence, random rolls, model work, or input mutations. */
export function projectLife(
	roleplay: RoleplayConfig,
	config: LifeConfig,
	simulation: LifeSimulation | undefined,
	plan: LifePlan | undefined,
	details: readonly LifeDetail[],
	now: number,
): LifeStateView {
	const local = lifeClock(now, roleplay.timezone);
	const enabled = roleplay.enabled && config.enable_humanized_states;
	const initialized = simulation?.generated_day != null;
	const conditions = enabled
		? (simulation?.conditions ?? [])
				.filter((item) => active(item, now) && allowed(item, config))
				.map((item) => structuredClone(item))
		: [];
	const currentActivity = activity(roleplay, config, plan, details, local);
	const view: LifeStateView = {
		inject: config.inject_passive_states,
		date: local.day,
		initialized,
		revision: simulation?.revision ?? 0,
		virtual: true,
		sleep: "睡眠平稳",
		dream: "没有记住梦",
		health: config.enable_health_state ? "状态正常" : "健康/不适状态未开启",
		hunger: config.enable_hunger_state ? "无饥饿感" : "饥饿/胃口状态未开启",
		body_cycle: config.enable_cycle_state ? "不处于生理期" : "生理期模拟未开启",
		location: currentActivity.location,
		weather: config.weather_context ? `虚构天气背景：${config.weather_context}` : "天气背景未提供（未联网）",
		mood_bias: "平稳",
		energy: enabled && initialized ? 75 : 70,
		note: enabled
			? initialized
				? "角色虚构生活状态；不是用户的现实经历或健康信息。"
				: "尚未生成每日虚构状态；当前仅为未初始化基线。"
			: "拟人化状态未开启；显示基线，不代表已生成生活事件。",
		activity: currentActivity,
		conditions,
		history: structuredClone(simulation?.history ?? []),
		cycle: {
			strategy: config.enable_advanced_cycle_strategy ? "advanced" : "legacy",
			phase: "",
			day: null,
			total_days: config.enable_advanced_cycle_strategy ? totalDays(config) : 28,
			next_expected_at: config.enable_cycle_state ? (simulation?.cycle.next_expected_at ?? null) : null,
		},
	};
	if (!enabled || !initialized) return view;
	let moodIntensity = -1;
	for (const item of conditions) {
		if (
			item.kind === "sleep" ||
			item.kind === "dream" ||
			item.kind === "health" ||
			item.kind === "hunger" ||
			item.kind === "body_cycle"
		)
			view[item.kind] = item.label;
		view.energy += item.energy_delta;
		if (item.mood && item.mood !== "平稳" && item.mood !== "中性" && item.intensity > moodIntensity) {
			view.mood_bias = item.mood;
			moodIntensity = item.intensity;
		}
	}
	view.energy = Math.max(10, Math.min(100, view.energy));
	if (config.enable_cycle_state && config.enable_advanced_cycle_strategy && simulation?.cycle.anchor_at != null) {
		const pos = position(config, simulation.cycle.anchor_at, now);
		view.cycle.phase = pos.phase;
		view.cycle.day = pos.cycle_day;
		view.body_cycle = `${PHASE_NAMES[pos.phase]} 第${pos.day}天`;
	} else if (config.enable_cycle_state) {
		view.cycle.phase = conditions.find((item) => item.kind === "body_cycle")?.phase ?? "";
	}
	return view;
}

function invalid(message: string): never {
	throw new ExecutorError("LIFE_INVALID_CONDITION", message);
}
export function addLifeCondition(
	simulation: LifeSimulation,
	config: LifeConfig,
	input: { label: string; duration_hours?: number },
	now: number,
): LifeSimulation {
	if (now < simulation.updated_at) invalid("Cannot add a fictional state before its last update");
	if (typeof input.label !== "string" || sanitizeMemoryText(input.label) !== input.label)
		invalid("Fictional state must not contain credentials");
	const label = input.label.replace(/\s+/g, " ").trim();
	if (!label || label.length > 80) invalid("Fictional state label must contain 1–80 characters");
	const hours = input.duration_hours ?? 12;
	if (!Number.isInteger(hours) || hours < 1 || hours > 72)
		invalid("Fictional state duration must be an integer from 1 to 72 hours");
	if (!config.enable_humanized_states) invalid("Fictional body states are disabled");
	if (has(label, ["饿", "胃口", "嘴馋", "馋", "想吃", "吃点", "吃些"]) && !config.enable_hunger_state)
		invalid("Fictional hunger states are disabled");
	if (has(label, ["病", "难受", "不舒服", "发烧", "头疼", "头痛", "咳", "感冒"]) && !config.enable_health_state)
		invalid("Fictional health states are disabled");
	if (simulation.conditions.length >= 200) invalid("Too many active fictional conditions");
	const moodMap: readonly [readonly string[], string][] = [
		[["累", "疲惫", "困", "没电"], "疲惫"],
		[["烦", "乱", "躁", "闷"], "烦闷"],
		[["病", "难受", "不舒服", "头疼", "发烧"], "虚弱"],
		[["饿", "胃口", "嘴馋"], "黏人"],
		[["开心", "轻快", "高兴", "兴奋"], "轻快"],
		[["紧张", "慌", "忐忑"], "紧张"],
		[["安静", "困倦", "恍惚"], "安静"],
	];
	const mood = moodMap.find(([tokens]) => has(label, tokens))?.[1] ?? "平稳";
	const energy = has(label, ["开心", "轻快", "高兴", "兴奋"])
		? 6
		: has(label, ["病", "难受", "不舒服", "发烧", "头疼"])
			? -16
			: has(label, ["累", "疲惫", "困", "没电"])
				? -10
				: has(label, ["烦", "乱", "躁", "闷"])
					? -8
					: has(label, ["紧张", "慌"])
						? -4
						: 0;
	const next = structuredClone(simulation);
	const item = condition(next, "manual_state", "手动增添状态", [label, mood, energy, hours], now, 60, {
		cause: "由用户手动增添的虚构角色状态",
		phase: "manual",
	});
	next.conditions.push(item);
	event(next, "manual_added", now, item, "", "manual");
	return finish(next, simulation, now);
}
export function removeLifeCondition(simulation: LifeSimulation, id: string, now: number): LifeSimulation {
	if (now < simulation.updated_at) invalid("Cannot remove a fictional state before its last update");
	const item = simulation.conditions.find((condition) => condition.id === id);
	if (!item) throw new ExecutorError("LIFE_NOT_FOUND", "Fictional condition not found");
	const next = structuredClone(simulation);
	next.conditions = next.conditions.filter((condition) => condition.id !== id);
	event(next, "manual_removed", now, item, item.phase, "removed");
	return finish(next, simulation, now);
}
