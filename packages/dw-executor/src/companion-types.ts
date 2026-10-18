import { type Static, Type } from "typebox";
import type { LifeStateView } from "./companion-life-types.ts";

export const CompanionIdentifierSchema = Type.String({ pattern: "^[A-Za-z0-9_-]{1,100}$" });
const ClockTimeSchema = Type.String({ pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" });
export const ImportantDateSchema = Type.Object({
	date: Type.String({ pattern: "^(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$" }),
	label: Type.String({ minLength: 1, maxLength: 200 }),
});
export const RoleplaySchema = Type.Object({
	enabled: Type.Boolean(),
	name: Type.String({ maxLength: 100 }),
	identity: Type.String({ maxLength: 2000 }),
	world: Type.String({ maxLength: 4000 }),
	backstory: Type.String({ maxLength: 4000 }),
	traits: Type.String({ maxLength: 2000 }),
	speech_style: Type.String({ maxLength: 2000 }),
	boundaries: Type.String({ maxLength: 2000 }),
	timezone: Type.String({ minLength: 1, maxLength: 100 }),
	wake_time: ClockTimeSchema,
	sleep_time: ClockTimeSchema,
	routine: Type.Array(
		Type.Object({
			start: ClockTimeSchema,
			end: ClockTimeSchema,
			activity: Type.String({ minLength: 1, maxLength: 200 }),
			location: Type.String({ maxLength: 100 }),
		}),
		{ maxItems: 24 },
	),
	important_dates: Type.Array(ImportantDateSchema, { maxItems: 32 }),
	goals: Type.Array(
		Type.Object({
			id: CompanionIdentifierSchema,
			text: Type.String({ minLength: 1, maxLength: 500 }),
			status: Type.Enum(["active", "paused", "done"]),
		}),
		{ maxItems: 24 },
	),
	memory_enabled: Type.Boolean(),
	memory_budget_chars: Type.Integer({ minimum: 4096, maximum: 16384 }),
});
export type RoleplayConfig = Static<typeof RoleplaySchema>;
export type ImportantDate = Static<typeof ImportantDateSchema>;
export const DEFAULT_ROLEPLAY: RoleplayConfig = {
	enabled: false,
	name: "",
	identity: "",
	world: "",
	backstory: "",
	traits: "",
	speech_style: "",
	boundaries: "",
	timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	wake_time: "07:30",
	sleep_time: "23:30",
	routine: [],
	important_dates: [],
	goals: [],
	memory_enabled: true,
	memory_budget_chars: 8192,
};

export interface MemoryScope {
	persona_id: string;
	user_id: string;
}
export const MemoryKindSchema = Type.Enum(["episode", "fact", "event", "commitment", "reflection"]);
export const MemoryDomainSchema = Type.Enum(["user", "character", "world", "relationship"]);
export const MemoryStatusSchema = Type.Enum(["active", "pending", "superseded", "archived", "forgotten"]);
export const MemoryDurabilitySchema = Type.Enum(["short", "normal", "durable"]);
export type MemoryKind = Static<typeof MemoryKindSchema>;
export type MemoryDomain = Static<typeof MemoryDomainSchema>;
export type MemoryStatus = Static<typeof MemoryStatusSchema>;
export type MemoryDurability = Static<typeof MemoryDurabilitySchema>;
export interface MemoryEvidence {
	session_id: string | null;
	run_id: string | null;
	speaker: "user" | "assistant" | "manual";
	quote: string;
	timestamp: number;
}
export interface MemoryRecord extends MemoryScope {
	id: string;
	kind: MemoryKind;
	domain: MemoryDomain;
	content: string;
	key: string | null;
	status: MemoryStatus;
	pinned: boolean;
	confidence: number;
	importance: number;
	durability: MemoryDurability;
	expires_at: number | null;
	created_at: number;
	updated_at: number;
	revision: number;
	sources: MemoryEvidence[];
	supersedes: string | null;
	recall_count: number;
	last_recalled_at: number | null;
}

export interface MemoryContextEntry
	extends Pick<MemoryRecord, "id" | "kind" | "domain" | "status" | "content" | "created_at" | "expires_at"> {
	source_time: { first: string; last: string; speakers: MemoryEvidence["speaker"][] };
}

/** Compact, timestamped evidence data shared by core budgeting and provider projection. */
export function memoryContextEntry(record: MemoryRecord): MemoryContextEntry {
	let first = record.created_at;
	let last = record.created_at;
	const speakers: MemoryEvidence["speaker"][] = [];
	for (const source of record.sources) {
		first = Math.min(first, source.timestamp);
		last = Math.max(last, source.timestamp);
		if (!speakers.includes(source.speaker)) speakers.push(source.speaker);
	}
	return {
		id: record.id,
		kind: record.kind,
		domain: record.domain,
		status: record.status,
		content: record.content,
		created_at: record.created_at,
		expires_at: record.expires_at,
		source_time: { first: new Date(first).toISOString(), last: new Date(last).toISOString(), speakers },
	};
}

export function memoryContextCost(record: MemoryRecord): number {
	return JSON.stringify(memoryContextEntry(record)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").length + 1;
}
export interface MemoryInsert {
	id: string;
	kind: MemoryKind;
	domain: MemoryDomain;
	content: string;
	key: string | null;
	status: MemoryStatus;
	pinned: boolean;
	confidence: number;
	importance: number;
	durability: MemoryDurability;
	expires_at: number | null;
	created_at: number;
	sources: MemoryEvidence[];
	supersedes: string | null;
}
export interface RankedMemory {
	item: MemoryRecord;
	score: number;
	reason: string;
}
export interface MemoryListOptions {
	query?: string;
	status?: MemoryStatus | "all";
	kind?: MemoryKind;
	limit?: number;
	cursor?: number;
}
export const MemoryCreateSchema = Type.Object({
	kind: Type.Enum(["fact", "event", "commitment", "reflection"]),
	domain: MemoryDomainSchema,
	content: Type.String({ minLength: 1, maxLength: 4000 }),
	key: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	pinned: Type.Optional(Type.Boolean()),
	importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	durability: Type.Optional(MemoryDurabilitySchema),
	expires_at: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
});
export const MemoryMutationSchema = Type.Object({
	expected_revision: Type.Integer({ minimum: 1 }),
	operation: Type.Enum(["approve", "archive", "restore", "forget", "pin", "unpin", "correct"]),
	content: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
});
export type MemoryMutation = Static<typeof MemoryMutationSchema>;

export const RelationshipStages = [
	"avoidant",
	"wary",
	"neutral",
	"familiar",
	"friendly",
	"close",
	"trusted",
	"bonded",
] as const;
export type RelationshipStage = (typeof RelationshipStages)[number];
export interface CompanionState {
	revision: number;
	affinity: number;
	stage: RelationshipStage;
	valence: number;
	arousal: number;
	user_name: string;
	address: string;
	relationship_background: string;
	important_dates: ImportantDate[];
	last_interaction_at: number | null;
	updated_at: number;
	affinity_day: string;
	affinity_daily_change: number;
}
export interface RelationshipEvent {
	id: string;
	run_id: string | null;
	delta: number;
	reason: string;
	evidence_quote: string;
	timestamp: number;
}
export const CompanionStateUpdateSchema = Type.Object({
	expected_revision: Type.Integer({ minimum: 0 }),
	affinity: Type.Optional(Type.Integer({ minimum: -100, maximum: 100 })),
	valence: Type.Optional(Type.Number({ minimum: -1, maximum: 1 })),
	arousal: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	user_name: Type.Optional(Type.String({ maxLength: 100 })),
	address: Type.Optional(Type.String({ maxLength: 100 })),
	relationship_background: Type.Optional(Type.String({ maxLength: 4000 })),
	important_dates: Type.Optional(Type.Array(ImportantDateSchema, { maxItems: 32 })),
});
export const CompanionDeltaSchema = Type.Object(
	{
		memories: Type.Optional(
			Type.Array(
				Type.Object({
					kind: Type.Enum(["fact", "event", "commitment", "reflection"]),
					domain: MemoryDomainSchema,
					content: Type.String({ minLength: 1, maxLength: 2000 }),
					key: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
					confidence: Type.Number({ minimum: 0, maximum: 1 }),
					importance: Type.Number({ minimum: 0, maximum: 1 }),
					durability: MemoryDurabilitySchema,
					expires_at: Type.Optional(Type.Integer({ minimum: 0 })),
					evidence: Type.Object({
						speaker: Type.Enum(["user", "assistant"]),
						quote: Type.String({ minLength: 1, maxLength: 1000 }),
					}),
				}),
				{ maxItems: 6 },
			),
		),
		affect: Type.Optional(
			Type.Object({
				valence_delta: Type.Number({ minimum: -0.3, maximum: 0.3 }),
				arousal_delta: Type.Number({ minimum: -0.3, maximum: 0.3 }),
				affinity_delta: Type.Integer({ minimum: -3, maximum: 3 }),
				evidence_quote: Type.String({ minLength: 1, maxLength: 1000 }),
				reason: Type.String({ minLength: 1, maxLength: 200 }),
			}),
		),
	},
	{ additionalProperties: false },
);
export type CompanionDelta = Static<typeof CompanionDeltaSchema>;
export interface CompanionFrame {
	scope: MemoryScope;
	enabled: boolean;
	context: string;
	memory_ids: string[];
}
export interface CompanionTurn {
	scope: MemoryScope;
	persona_revision: string;
	config: RoleplayConfig;
	session_id: string;
	run_id: string;
	input: string;
	input_at?: number;
	speech: string;
	occurred_at: number;
	metadata?: unknown;
}
export interface CompanionProfile {
	scope: MemoryScope;
	enabled: boolean;
	state: CompanionState;
	local_time: string;
	energy: number;
	activity: { label: string; location: string; virtual: true; source: string };
	important_dates: { date: string; label: string; days_until: number; subject: "character" | "user" }[];
	goals: RoleplayConfig["goals"];
	ledger: RelationshipEvent[];
	memory_counts: Record<MemoryStatus, number>;
	life_state?: LifeStateView;
}
