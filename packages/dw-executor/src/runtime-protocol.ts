import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { CompanionIdentifierSchema } from "./companion-types.ts";
import { ExecutorError } from "./errors.ts";
import { SegmentSchema } from "./protocol.ts";

export const MAX_MESSAGE_BYTES = 1024 * 1024;

const Identifier = Type.String({ minLength: 1, maxLength: 200 });
export const ModeSchema = Type.Union([Type.Literal("chat"), Type.Literal("agent")]);
export type Mode = Static<typeof ModeSchema>;

export const EnvelopeSchema = Type.Object({
	v: Type.Literal(1),
	type: Identifier,
	id: Identifier,
	reply_to: Type.Optional(Identifier),
	session_id: Type.Optional(Identifier),
	run_id: Type.Optional(Identifier),
	mode_revision: Type.Optional(Type.Integer({ minimum: 0 })),
	seq: Type.Optional(Type.Integer({ minimum: 1 })),
	payload: Type.Record(Type.String(), Type.Unknown()),
	ext: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type Envelope = Static<typeof EnvelopeSchema>;

export const CommandPayloadSchemas = {
	hello: Type.Object({
		client_id: Identifier,
		token: Type.String({ minLength: 1, maxLength: 4096 }),
		versions: Type.Array(Type.Integer()),
		capabilities: Type.Optional(Type.Array(Type.String())),
	}),
	"session.open": Type.Object({
		persona_id: Identifier,
		user_id: Type.Optional(CompanionIdentifierSchema),
		cwd: Type.String({ minLength: 1, maxLength: 32768 }),
		mode: Type.Optional(ModeSchema),
	}),
	"session.attach": Type.Object({ after_seq: Type.Integer({ minimum: 0 }) }),
	"session.get": Type.Object({}),
	"history.get": Type.Object({
		cursor: Type.Optional(Type.Integer({ minimum: 0 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
	}),
	"input.submit": Type.Object({ text: Type.String({ minLength: 1, maxLength: 65536 }) }),
	"mode.set": Type.Object({ mode: ModeSchema }),
	"run.resume": Type.Object({}),
	"run.cancel": Type.Object({}),
} as const;
export type CommandType = keyof typeof CommandPayloadSchemas;

const ErrorSchema = Type.Object({
	code: Identifier,
	message: Type.String(),
	retryable: Type.Boolean(),
	details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
const UsageSchema = Type.Object({
	model_calls: Type.Integer({ minimum: 0 }),
	input_tokens: Type.Integer({ minimum: 0 }),
	output_tokens: Type.Integer({ minimum: 0 }),
});
const SnapshotSchema = Type.Object({
	session_id: Identifier,
	mode: ModeSchema,
	mode_revision: Type.Integer({ minimum: 0 }),
	persona_id: Identifier,
	persona_revision: Identifier,
	user_id: CompanionIdentifierSchema,
	active_run_id: Type.Union([Identifier, Type.Null()]),
	paused_run_id: Type.Union([Identifier, Type.Null()]),
	target_mode: Type.Union([ModeSchema, Type.Null()]),
	latest_seq: Type.Integer({ minimum: 0 }),
	provider: Type.Optional(Type.Union([Identifier, Type.Null()])),
	model: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()])),
});
export const EventPayloadSchemas = {
	"hello.accepted": Type.Object({
		version: Type.Literal(1),
		capabilities: Type.Array(Type.String()),
		max_message_bytes: Type.Integer({ minimum: 1 }),
	}),
	"command.accepted": Type.Object({ operation: Identifier }),
	"command.rejected": Type.Object({ error: ErrorSchema }),
	"session.opened": SnapshotSchema,
	"session.snapshot": SnapshotSchema,
	"history.page": Type.Object({
		items: Type.Array(EnvelopeSchema),
		next_cursor: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
	}),
	"mode.switching": Type.Object({
		from: ModeSchema,
		to: ModeSchema,
		waiting_for_run: Type.Union([Identifier, Type.Null()]),
	}),
	"mode.changed": Type.Object({ mode: ModeSchema }),
	"mode.failed": Type.Object({ mode: ModeSchema, error: ErrorSchema }),
	"run.started": Type.Object({ mode: ModeSchema }),
	"run.resumed": Type.Object({}),
	"run.paused": Type.Object({
		checkpoint: Type.Object({
			leaf_id: Type.Union([Identifier, Type.Null()]),
			completed_tool_calls: Type.Array(Identifier),
			reason: Identifier,
		}),
		usage: UsageSchema,
	}),
	"run.completed": Type.Object({
		result: Type.Object({ segments: Type.Array(SegmentSchema), text: Type.String(), speech: Type.String() }),
		usage: UsageSchema,
	}),
	"run.failed": Type.Object({ error: ErrorSchema, partial: Type.Boolean(), usage: Type.Optional(UsageSchema) }),
	"run.cancelled": Type.Object({ partial: Type.Boolean(), usage: Type.Optional(UsageSchema) }),
	"tool.started": Type.Object({
		tool_call_id: Identifier,
		tool_name: Identifier,
		parent_tool_call_id: Type.Optional(Identifier),
	}),
	"tool.finished": Type.Object({
		tool_call_id: Identifier,
		tool_name: Identifier,
		status: Type.Union([Type.Literal("error"), Type.Literal("completed")]),
		duration_ms: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
	}),
	"reply.segment": SegmentSchema,
	"reply.warning": Type.Object({ code: Identifier, message: Type.String(), segment_id: Type.Optional(Identifier) }),
	"context.trimmed": Type.Object({
		cutoff: Type.Integer({ minimum: 0 }),
		removed_blocks: Type.Integer({ minimum: 1 }),
		estimated_tokens: Type.Integer({ minimum: 0 }),
	}),
} as const;

export function parseEnvelope(value: unknown): Envelope {
	if (value && typeof value === "object" && "v" in value && value.v !== 1) {
		throw new ExecutorError("VERSION_MISMATCH", "Supported protocol version: 1");
	}
	if (!Check(EnvelopeSchema, value)) throw new ExecutorError("INVALID_MESSAGE", "Invalid protocol envelope");
	if (!(value.type in CommandPayloadSchemas) || !Object.hasOwn(CommandPayloadSchemas, value.type)) {
		throw new ExecutorError("UNKNOWN_COMMAND", "Unsupported command type");
	}
	const schema = CommandPayloadSchemas[value.type as CommandType];
	if (!Check(schema, value.payload)) throw new ExecutorError("INVALID_PAYLOAD", `Invalid ${value.type} payload`);
	if (value.seq !== undefined || value.reply_to !== undefined)
		throw new ExecutorError("INVALID_MESSAGE", "Client commands cannot contain server event fields");
	return value;
}
