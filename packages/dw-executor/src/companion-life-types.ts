import { type Static, Type } from "typebox";
import type { MemoryScope, RoleplayConfig } from "./companion-types.ts";
import type { PersonaSnapshot } from "./providers.ts";

export const LifeClockSchema = Type.String({ pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" });
export const LifeDaySchema = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
const Time = Type.Integer({ minimum: 0, maximum: 8640000000000000 });
const NullableTime = Type.Union([Time, Type.Null()]);
const Revision = Type.Integer({ minimum: 0 });
const Identifier = Type.String({ minLength: 1, maxLength: 200 });
export const LifeModelChoiceSchema = Type.Object(
	{ provider: Type.String({ minLength: 1, maxLength: 200 }), model: Type.String({ minLength: 1, maxLength: 500 }) },
	{ additionalProperties: false },
);
export type LifeModelChoice = Static<typeof LifeModelChoiceSchema>;

// Values follow private_companion V1 schema; model routes use Pi provider/model pairs.
export const LifeConfigSchema = Type.Object(
	{
		enable_daily_plan: Type.Boolean({ title: "启用每日拟人化日程", default: true }),
		daily_plan_time: Type.String({
			title: "每日生成日程时间",
			default: "07:30",
			maxLength: 200,
			pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$",
		}),
		daily_plan_item_count: Type.Integer({ title: "每日日程条目数", default: 10, minimum: 5, maximum: 24 }),
		schedule_persona_prompt: Type.String({ title: "日程专用角色设定", default: "", maxLength: 4000 }),
		schedule_worldview_prompt: Type.String({ title: "日程专用世界观/生活背景", default: "", maxLength: 4000 }),
		roleplay_user_profile_prompt: Type.String({ title: "角色设定：用户与关系补充", default: "", maxLength: 4000 }),
		daily_plan_prompt: Type.String({ title: "自定义每日日程提示词", default: "", maxLength: 12000 }),
		enable_daily_diary: Type.Boolean({ title: "启用每日 Bot 日记", default: true }),
		daily_diary_time: Type.String({
			title: "每日写日记时间",
			default: "23:10",
			maxLength: 200,
			pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$",
		}),
		daily_diary_form: Type.Enum(["auto", "scene", "fragments", "inner_voice", "observation"], {
			title: "日记写作形式",
			default: "auto",
		}),
		daily_diary_length: Type.Enum(["short", "standard", "long"], { title: "日记篇幅", default: "standard" }),
		daily_diary_creativity: Type.Enum(["strict", "balanced", "expressive"], {
			title: "日记写实程度",
			default: "balanced",
		}),
		daily_diary_custom_direction: Type.String({ title: "日记创作方向", default: "", maxLength: 1000 }),
		daily_diary_generate_share_seed: Type.Boolean({ title: "从日记提取自然分享素材", default: true }),
		max_diary_entries: Type.Integer({ title: "保留 Bot 日记数量", default: 14, minimum: 1, maximum: 60 }),
		enable_humanized_states: Type.Boolean({ title: "启用拟人化身体/梦境状态", default: true }),
		humanized_state_intensity: Type.Integer({ title: "拟人状态强度", default: 50, minimum: 0, maximum: 100 }),
		enable_health_state: Type.Boolean({ title: "启用健康/不适状态", default: true }),
		enable_hunger_state: Type.Boolean({ title: "启用饥饿/胃口状态", default: true }),
		enable_cycle_state: Type.Boolean({ title: "启用生理期模拟", default: true }),
		inject_passive_states: Type.Boolean({ title: "被动回复前注入拟人状态", default: true }),
		enable_detail_enhancement: Type.Boolean({ title: "启用日程细节强化模式", default: false }),
		detail_enhancement_lead_minutes: Type.Integer({
			title: "提前强化日程段（分钟）",
			default: 3,
			minimum: 0,
			maximum: 180,
		}),
		enable_advanced_cycle_strategy: Type.Boolean({ title: "启用六阶段周期策略", default: false }),
		advanced_cycle_link_intensity: Type.Boolean({ title: "精力变化跟随拟人状态强度", default: false }),
		advanced_cycle_start_offset: Type.Integer({ title: "手动设置当前周期日", default: 0, minimum: 0, maximum: 180 }),
		advanced_cycle_menstrual_days: Type.Integer({ title: "月经期持续天数", default: 5, minimum: 1, maximum: 30 }),
		advanced_cycle_menstrual_prompt: Type.String({
			title: "月经期状态描述",
			default: "处于月经期，身体更容易疲倦，情绪感受稍敏锐",
			maxLength: 4000,
		}),
		advanced_cycle_menstrual_mood: Type.String({ title: "月经期情绪底色", default: "疲惫", maxLength: 30 }),
		advanced_cycle_menstrual_energy: Type.Integer({
			title: "月经期精力变化",
			default: -12,
			minimum: -50,
			maximum: 30,
		}),
		advanced_cycle_follicular_days: Type.Integer({ title: "卵泡期持续天数", default: 5, minimum: 1, maximum: 30 }),
		advanced_cycle_follicular_prompt: Type.String({
			title: "卵泡期状态描述",
			default: "处于卵泡期，精力平稳回升，心情逐渐轻快",
			maxLength: 4000,
		}),
		advanced_cycle_follicular_mood: Type.String({ title: "卵泡期情绪底色", default: "轻快", maxLength: 30 }),
		advanced_cycle_follicular_energy: Type.Integer({
			title: "卵泡期精力变化",
			default: 0,
			minimum: -50,
			maximum: 30,
		}),
		advanced_cycle_pre_ovulation_days: Type.Integer({
			title: "排卵前期持续天数",
			default: 3,
			minimum: 1,
			maximum: 30,
		}),
		advanced_cycle_pre_ovulation_prompt: Type.String({
			title: "排卵前期状态描述",
			default: "处于排卵前期，身体逐渐轻盈，精力有所上升",
			maxLength: 4000,
		}),
		advanced_cycle_pre_ovulation_mood: Type.String({ title: "排卵前期情绪底色", default: "期待", maxLength: 30 }),
		advanced_cycle_pre_ovulation_energy: Type.Integer({
			title: "排卵前期精力变化",
			default: 8,
			minimum: -50,
			maximum: 30,
		}),
		advanced_cycle_ovulation_days: Type.Integer({ title: "排卵期持续天数", default: 1, minimum: 1, maximum: 30 }),
		advanced_cycle_ovulation_prompt: Type.String({
			title: "排卵期状态描述",
			default: "处于排卵期，精力较充足，社交意愿稍有增强",
			maxLength: 4000,
		}),
		advanced_cycle_ovulation_mood: Type.String({ title: "排卵期情绪底色", default: "明朗", maxLength: 30 }),
		advanced_cycle_ovulation_energy: Type.Integer({ title: "排卵期精力变化", default: 9, minimum: -50, maximum: 30 }),
		advanced_cycle_luteal_days: Type.Integer({ title: "黄体期持续天数", default: 8, minimum: 1, maximum: 30 }),
		advanced_cycle_luteal_prompt: Type.String({
			title: "黄体期状态描述",
			default: "处于黄体期，精力尚可，情绪整体平稳",
			maxLength: 4000,
		}),
		advanced_cycle_luteal_mood: Type.String({ title: "黄体期情绪底色", default: "平稳", maxLength: 30 }),
		advanced_cycle_luteal_energy: Type.Integer({ title: "黄体期精力变化", default: 5, minimum: -50, maximum: 30 }),
		advanced_cycle_pms_days: Type.Integer({ title: "PMS 期持续天数", default: 6, minimum: 1, maximum: 30 }),
		advanced_cycle_pms_prompt: Type.String({
			title: "PMS 期状态描述",
			default: "处于 PMS 期，精力有所下降，情绪波动稍明显",
			maxLength: 4000,
		}),
		advanced_cycle_pms_mood: Type.String({ title: "PMS 期情绪底色", default: "敏感", maxLength: 30 }),
		advanced_cycle_pms_energy: Type.Integer({ title: "PMS 期精力变化", default: -8, minimum: -50, maximum: 30 }),
		advanced_cycle_discomfort_simulation: Type.Boolean({ title: "生理期不适模拟", default: false }),
		advanced_cycle_discomfort_chance: Type.Integer({ title: "不适出现概率", default: 55, minimum: 0, maximum: 100 }),
		advanced_cycle_discomfort_types: Type.String({
			title: "可模拟的不适类型",
			default: "痛经,头痛,腰酸,乏力",
			maxLength: 200,
		}),
		weather_context: Type.String({ title: "虚构天气背景（不联网）", maxLength: 400, default: "" }),
		plan_model: Type.Union([LifeModelChoiceSchema, Type.Null()], {
			title: "日程模型（null 跟随项目模型）",
			default: null,
		}),
		diary_model: Type.Union([LifeModelChoiceSchema, Type.Null()], {
			title: "日记模型（null 跟随项目模型）",
			default: null,
		}),
		detail_model: Type.Union([LifeModelChoiceSchema, Type.Null()], {
			title: "细化模型（null 跟随项目模型）",
			default: null,
		}),
	},
	{ additionalProperties: false },
);
export type LifeConfig = Static<typeof LifeConfigSchema>;
export const DEFAULT_LIFE_CONFIG: LifeConfig = {
	enable_daily_plan: true,
	daily_plan_time: "07:30",
	daily_plan_item_count: 10,
	schedule_persona_prompt: "",
	schedule_worldview_prompt: "",
	roleplay_user_profile_prompt: "",
	daily_plan_prompt: "",
	enable_daily_diary: true,
	daily_diary_time: "23:10",
	daily_diary_form: "auto",
	daily_diary_length: "standard",
	daily_diary_creativity: "balanced",
	daily_diary_custom_direction: "",
	daily_diary_generate_share_seed: true,
	max_diary_entries: 14,
	enable_humanized_states: true,
	humanized_state_intensity: 50,
	enable_health_state: true,
	enable_hunger_state: true,
	enable_cycle_state: true,
	inject_passive_states: true,
	enable_detail_enhancement: false,
	detail_enhancement_lead_minutes: 3,
	enable_advanced_cycle_strategy: false,
	advanced_cycle_link_intensity: false,
	advanced_cycle_start_offset: 0,
	advanced_cycle_menstrual_days: 5,
	advanced_cycle_menstrual_prompt: "处于月经期，身体更容易疲倦，情绪感受稍敏锐",
	advanced_cycle_menstrual_mood: "疲惫",
	advanced_cycle_menstrual_energy: -12,
	advanced_cycle_follicular_days: 5,
	advanced_cycle_follicular_prompt: "处于卵泡期，精力平稳回升，心情逐渐轻快",
	advanced_cycle_follicular_mood: "轻快",
	advanced_cycle_follicular_energy: 0,
	advanced_cycle_pre_ovulation_days: 3,
	advanced_cycle_pre_ovulation_prompt: "处于排卵前期，身体逐渐轻盈，精力有所上升",
	advanced_cycle_pre_ovulation_mood: "期待",
	advanced_cycle_pre_ovulation_energy: 8,
	advanced_cycle_ovulation_days: 1,
	advanced_cycle_ovulation_prompt: "处于排卵期，精力较充足，社交意愿稍有增强",
	advanced_cycle_ovulation_mood: "明朗",
	advanced_cycle_ovulation_energy: 9,
	advanced_cycle_luteal_days: 8,
	advanced_cycle_luteal_prompt: "处于黄体期，精力尚可，情绪整体平稳",
	advanced_cycle_luteal_mood: "平稳",
	advanced_cycle_luteal_energy: 5,
	advanced_cycle_pms_days: 6,
	advanced_cycle_pms_prompt: "处于 PMS 期，精力有所下降，情绪波动稍明显",
	advanced_cycle_pms_mood: "敏感",
	advanced_cycle_pms_energy: -8,
	advanced_cycle_discomfort_simulation: false,
	advanced_cycle_discomfort_chance: 55,
	advanced_cycle_discomfort_types: "痛经,头痛,腰酸,乏力",
	weather_context: "",
	plan_model: null,
	diary_model: null,
	detail_model: null,
};
export interface LifeSettingGroup {
	id: string;
	title: string;
	fields: readonly (keyof LifeConfig)[];
}
export const LifeSettingGroups: readonly LifeSettingGroup[] = [
	{
		id: "schedule",
		title: "每日生活日程",
		fields: [
			"enable_daily_plan",
			"daily_plan_time",
			"daily_plan_item_count",
			"schedule_persona_prompt",
			"schedule_worldview_prompt",
			"roleplay_user_profile_prompt",
			"daily_plan_prompt",
		],
	},
	{
		id: "diary",
		title: "日记生成",
		fields: [
			"enable_daily_diary",
			"daily_diary_time",
			"daily_diary_form",
			"daily_diary_length",
			"daily_diary_creativity",
			"daily_diary_custom_direction",
			"daily_diary_generate_share_seed",
			"max_diary_entries",
		],
	},
	{
		id: "body",
		title: "生活状态",
		fields: [
			"enable_humanized_states",
			"humanized_state_intensity",
			"enable_health_state",
			"enable_hunger_state",
			"enable_cycle_state",
			"inject_passive_states",
		],
	},
	{
		id: "detail",
		title: "日程细化",
		fields: ["enable_detail_enhancement", "detail_enhancement_lead_minutes"],
	},
	{
		id: "cycle",
		title: "六阶段周期（默认关闭）",
		fields: [
			"enable_advanced_cycle_strategy",
			"advanced_cycle_link_intensity",
			"advanced_cycle_start_offset",
			"advanced_cycle_menstrual_days",
			"advanced_cycle_menstrual_prompt",
			"advanced_cycle_menstrual_mood",
			"advanced_cycle_menstrual_energy",
			"advanced_cycle_follicular_days",
			"advanced_cycle_follicular_prompt",
			"advanced_cycle_follicular_mood",
			"advanced_cycle_follicular_energy",
			"advanced_cycle_pre_ovulation_days",
			"advanced_cycle_pre_ovulation_prompt",
			"advanced_cycle_pre_ovulation_mood",
			"advanced_cycle_pre_ovulation_energy",
			"advanced_cycle_ovulation_days",
			"advanced_cycle_ovulation_prompt",
			"advanced_cycle_ovulation_mood",
			"advanced_cycle_ovulation_energy",
			"advanced_cycle_luteal_days",
			"advanced_cycle_luteal_prompt",
			"advanced_cycle_luteal_mood",
			"advanced_cycle_luteal_energy",
			"advanced_cycle_pms_days",
			"advanced_cycle_pms_prompt",
			"advanced_cycle_pms_mood",
			"advanced_cycle_pms_energy",
			"advanced_cycle_discomfort_simulation",
			"advanced_cycle_discomfort_chance",
			"advanced_cycle_discomfort_types",
		],
	},
	{
		id: "models",
		title: "模型与背景",
		fields: ["plan_model", "diary_model", "detail_model", "weather_context"],
	},
];
export const LifeSettingsUpdateSchema = Type.Object(
	{ expected_revision: Revision, config: LifeConfigSchema },
	{ additionalProperties: false },
);
export interface LifeSettingsRecord {
	revision: number;
	config: LifeConfig;
}

export const LifeConditionKindSchema = Type.Enum([
	"sleep",
	"dream",
	"hunger",
	"body_cycle",
	"health",
	"dream_aftertaste",
	"cycle_discomfort",
	"recovery_afterglow",
	"health_tail",
	"sleep_afterglow",
	"sleep_tail",
	"manual_state",
]);
export const LifeTransitionSchema = Type.Object({
	to: Type.String({ minLength: 1, maxLength: 40 }),
	base_weight: Type.Number({ minimum: 0, maximum: 10 }),
});
export const LifeConditionSchema = Type.Object({
	id: Identifier,
	kind: LifeConditionKindSchema,
	title: Type.String({ maxLength: 80 }),
	label: Type.String({ minLength: 1, maxLength: 200 }),
	mood: Type.String({ maxLength: 40 }),
	energy_delta: Type.Integer({ minimum: -100, maximum: 100 }),
	intensity: Type.Integer({ minimum: 0, maximum: 100 }),
	start_at: Time,
	end_at: Time,
	phase: Type.String({ maxLength: 40 }),
	cause: Type.String({ maxLength: 200 }),
	episode_key: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
	transition_options: Type.Array(LifeTransitionSchema, { maxItems: 8 }),
});
export type LifeCondition = Static<typeof LifeConditionSchema>;
export const LifeEvolutionSchema = Type.Object({
	id: Identifier,
	at: Time,
	kind: Type.Enum([
		"day_generated",
		"condition_started",
		"condition_ended",
		"transition",
		"manual_added",
		"manual_removed",
	]),
	condition_id: Type.Union([Identifier, Type.Null()]),
	label: Type.String({ maxLength: 200 }),
	from_phase: Type.String({ maxLength: 40 }),
	to_phase: Type.String({ maxLength: 40 }),
	virtual: Type.Literal(true),
});
export type LifeEvolution = Static<typeof LifeEvolutionSchema>;
export const LifeCycleSchema = Type.Object({
	strategy: Type.Enum(["legacy", "advanced"]),
	last_start_at: NullableTime,
	last_end_at: NullableTime,
	next_expected_at: NullableTime,
	anchor_at: NullableTime,
	offset_signature: Type.String({ maxLength: 500 }),
	last_discomfort_day: Type.Union([LifeDaySchema, Type.Null()]),
});
export const LifeSimulationSchema = Type.Object({
	revision: Type.Integer({ minimum: 1 }),
	generated_day: Type.Union([LifeDaySchema, Type.Null()]),
	updated_at: Time,
	conditions: Type.Array(LifeConditionSchema, { maxItems: 200 }),
	cycle: LifeCycleSchema,
	hunger: Type.Object({
		day: LifeDaySchema,
		attempted: Type.Array(Type.String({ maxLength: 40 }), { maxItems: 5 }),
		generated: Type.Array(Type.Object({ window: Type.String({ maxLength: 40 }), at: Time }), { maxItems: 5 }),
	}),
	history: Type.Array(LifeEvolutionSchema, { maxItems: 100 }),
});
export type LifeSimulation = Static<typeof LifeSimulationSchema>;
export const LifeConditionCreateSchema = Type.Object(
	{
		expected_revision: Revision,
		label: Type.String({ minLength: 1, maxLength: 80 }),
		duration_hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 72 })),
	},
	{ additionalProperties: false },
);
export const LifeConditionRemoveSchema = Type.Object(
	{ expected_revision: Revision, operation: Type.Literal("remove") },
	{ additionalProperties: false },
);

export const LifePlanItemSchema = Type.Object({
	time: LifeClockSchema,
	end: Type.Optional(LifeClockSchema),
	activity: Type.String({ minLength: 1, maxLength: 200 }),
	mood: Type.String({ maxLength: 40 }),
	location: Type.Optional(Type.String({ maxLength: 200 })),
});
export type LifePlanItem = Static<typeof LifePlanItemSchema>;
const Usage = Type.Object({ input_tokens: Type.Integer({ minimum: 0 }), output_tokens: Type.Integer({ minimum: 0 }) });
const Warnings = Type.Array(Type.String({ maxLength: 300 }), { maxItems: 16 });
export const LifePlanSchema = Type.Object({
	date: LifeDaySchema,
	revision: Type.Integer({ minimum: 1 }),
	generated_at: Time,
	persona_revision: Identifier,
	source: Type.Enum(["model", "configured", "fallback_previous", "fallback_default"]),
	items: Type.Array(LifePlanItemSchema, { minItems: 1, maxItems: 24 }),
	retry_after: NullableTime,
	model_calls: Type.Integer({ minimum: 0 }),
	usage: Usage,
	warnings: Warnings,
});
export type LifePlan = Static<typeof LifePlanSchema>;
export const LifeDetailSchema = Type.Object({
	date: LifeDaySchema,
	segment: Identifier,
	revision: Type.Integer({ minimum: 1 }),
	generated_at: Time,
	persona_revision: Identifier,
	summary: Type.String({ minLength: 1, maxLength: 300 }),
	location: Type.String({ maxLength: 200 }),
	today_events: Type.Array(
		Type.Object({
			time: LifeClockSchema,
			event: Type.String({ minLength: 1, maxLength: 200 }),
			level: Type.Literal("simulated"),
		}),
		{ maxItems: 12 },
	),
	model_calls: Type.Integer({ minimum: 0 }),
	usage: Usage,
	warnings: Warnings,
});
export type LifeDetail = Static<typeof LifeDetailSchema>;
export const LifeEvidenceSchema = Type.Object({
	level: Type.Enum(["confirmed", "simulated", "planned", "state"]),
	source: Type.String({ maxLength: 80 }),
	text: Type.String({ minLength: 1, maxLength: 180 }),
	at: Time,
	memory_id: Type.Union([Identifier, Type.Null()]),
	memory_revision: Type.Union([Revision, Type.Null()]),
	run_id: Type.Union([Identifier, Type.Null()]),
	session_id: Type.Union([Identifier, Type.Null()]),
});
export type LifeEvidence = Static<typeof LifeEvidenceSchema>;
export const DiaryPayloadSchema = Type.Object({
	summary: Type.String({ minLength: 1, maxLength: 160 }),
	body: Type.String({ minLength: 1, maxLength: 500 }),
	tags: Type.Array(Type.String({ minLength: 1, maxLength: 20 }), { maxItems: 6 }),
});
export const DiaryEntrySchema = Type.Object({
	...DiaryPayloadSchema.properties,
	date: LifeDaySchema,
	revision: Type.Integer({ minimum: 1 }),
	generated_at: Time,
	persona_revision: Identifier,
	form: Type.Enum(["scene", "fragments", "inner_voice", "observation"]),
	source: Type.Enum(["model", "evidence"]),
	evidence: Type.Array(LifeEvidenceSchema, { maxItems: 16 }),
	share_seed: Type.String({ maxLength: 120 }),
	dream_fragments: Type.Array(
		Type.Object({
			text: Type.String({ minLength: 1, maxLength: 180 }),
			weight: Type.Number({ minimum: 0, maximum: 1 }),
		}),
		{ maxItems: 6 },
	),
	continuity_thread: Type.Object({
		motif: Type.String({ maxLength: 80 }),
		status: Type.String({ maxLength: 20 }),
		next_hint: Type.String({ maxLength: 100 }),
	}),
	long_term_events: Type.Array(
		Type.Object({
			title: Type.String({ maxLength: 80 }),
			status: Type.String({ maxLength: 40 }),
			next_hint: Type.String({ maxLength: 100 }),
		}),
		{ maxItems: 2 },
	),
	model_calls: Type.Integer({ minimum: 0 }),
	usage: Usage,
	warnings: Warnings,
});
export type DiaryEntry = Static<typeof DiaryEntrySchema>;
export interface DiaryListItem {
	date: string;
	revision: number;
	generated_at: number;
	summary: string;
	form: DiaryEntry["form"];
	source: DiaryEntry["source"];
	evidence_count: number;
}
export interface DiaryList {
	items: DiaryListItem[];
	next_cursor: number | null;
}
export interface DiaryListOptions {
	limit?: number;
	cursor?: number;
}
export const LifeGenerateSchema = Type.Object(
	{ force: Type.Optional(Type.Boolean()), expected_revision: Type.Optional(Revision) },
	{ additionalProperties: false },
);
export const LifeAdvanceSchema = Type.Object({}, { additionalProperties: false });
export const LifeDiaryDeleteSchema = Type.Object(
	{ expected_revision: Revision, operation: Type.Literal("delete") },
	{ additionalProperties: false },
);
export type LifeJobKind = "plan" | "diary" | "detail";
export const LifeJobSchema = Type.Object({
	id: Identifier,
	kind: Type.Enum(["plan", "diary", "detail"]),
	date: LifeDaySchema,
	status: Type.Enum(["running", "completed", "failed", "cancelled"]),
	started_at: Time,
	finished_at: NullableTime,
	error: Type.Union([
		Type.Object({ code: Type.String({ maxLength: 100 }), message: Type.String({ maxLength: 300 }) }),
		Type.Null(),
	]),
	model_calls: Type.Integer({ minimum: 0 }),
	usage: Usage,
	warnings: Warnings,
});
export type LifeJob = Static<typeof LifeJobSchema>;
export interface LifeStateView {
	date: string;
	initialized: boolean;
	revision: number;
	virtual: true;
	inject: boolean;
	sleep: string;
	dream: string;
	health: string;
	hunger: string;
	body_cycle: string;
	location: string;
	weather: string;
	mood_bias: string;
	energy: number;
	note: string;
	activity: { label: string; location: string; virtual: true; source: string };
	conditions: LifeCondition[];
	history: LifeEvolution[];
	cycle: {
		strategy: "legacy" | "advanced";
		phase: string;
		day: number | null;
		total_days: number;
		next_expected_at: number | null;
	};
}
export interface LifeView {
	scope: MemoryScope;
	enabled: boolean;
	local_time: string;
	settings: LifeSettingsRecord;
	settings_schema: typeof LifeConfigSchema;
	setting_groups: readonly LifeSettingGroup[];
	state: LifeStateView;
	plan: LifePlan | null;
	details: LifeDetail[];
	jobs: LifeJob[];
	today_diary_revision: number;
	today_diary_deleted: boolean;
	today_diary_generated: boolean;
}
export interface LifeActionResult {
	view: LifeView;
	warnings: string[];
	diary?: DiaryEntry;
	plan?: LifePlan;
	detail?: LifeDetail;
}
export type LifeModelTask =
	| "daily_plan"
	| "daily_plan_rewrite"
	| "diary"
	| "diary_rewrite"
	| "diary_derivatives"
	| "detail"
	| "detail_rewrite";
export interface LifeCompletionRequest {
	task: LifeModelTask;
	scope: MemoryScope;
	persona: PersonaSnapshot;
	system: string;
	prompt: string;
	max_tokens: number;
	model: LifeModelChoice | null;
	signal: AbortSignal;
	on_request: () => void;
}
export interface LifeCompletionResult {
	text: string;
	provider: string;
	model: string;
	usage: { input_tokens: number; output_tokens: number };
}
export type LifeCompletion = (request: LifeCompletionRequest) => Promise<LifeCompletionResult>;
export interface LifeGenerationOptions {
	force?: boolean;
	expected_revision?: number;
	signal?: AbortSignal;
}
export interface LifeProjectionProvider {
	projection(scope: MemoryScope, roleplay: RoleplayConfig, now: number): LifeStateView;
	context(scope: MemoryScope, roleplay: RoleplayConfig, now: number, projection: LifeStateView): string;
}
