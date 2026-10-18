import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { ExecutorError } from "./errors.ts";

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const SOCKET_PATH = "/dw-agent/v1";

const Identifier = Type.String({ minLength: 1, maxLength: 1000 });
const Sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const StreamIdSchema = Type.String({
	maxLength: 308,
	pattern: "^(?:system|session:[A-Za-z0-9][A-Za-z0-9_.-]{0,299}|companion:[A-Za-z0-9_-]{1,100}:[A-Za-z0-9_-]{1,100})$",
});

/** Presentation descriptions contain neither enclosing nor nested parentheses or executable markup. */
export const ExpressionSchema = Type.Object(
	{
		description: Type.String({
			minLength: 1,
			maxLength: 1000,
			pattern: "^(?=[\\s\\S]*\\S)[^()（）<>`{}\\x00-\\x1f\\x7f]+$",
		}),
		language: Type.String({ minLength: 2, maxLength: 100, pattern: "^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$" }),
	},
	{ additionalProperties: false },
);
export const SegmentSchema = Type.Object(
	{
		message_id: Identifier,
		segment_id: Identifier,
		index: Sequence,
		expression: ExpressionSchema,
		speech: Type.String(),
		text: Type.String(),
		task_refs: Type.Array(Identifier, { uniqueItems: true }),
	},
	{ additionalProperties: false },
);
export type ReplySegment = Static<typeof SegmentSchema>;

export const ErrorSchema = Type.Object(
	{
		code: Identifier,
		message: Type.String(),
		retryable: Type.Boolean(),
		details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

export const CommandPayloadSchemas = {
	hello: Type.Object(
		{
			client_id: Identifier,
			token: Type.String({ minLength: 1, maxLength: 4096 }),
			versions: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, uniqueItems: true }),
		},
		{ additionalProperties: false },
	),
	subscribe: Type.Object({ stream_id: StreamIdSchema, after_seq: Sequence }, { additionalProperties: false }),
	unsubscribe: Type.Object({ stream_id: StreamIdSchema }, { additionalProperties: false }),
} as const;
export type CommandType = keyof typeof CommandPayloadSchemas;

/** Client requests deliberately have no session, run, event, or acknowledgement fields. */
export const EnvelopeSchema = Type.Object(
	{
		v: Type.Literal(1),
		type: Type.Union([Type.Literal("hello"), Type.Literal("subscribe"), Type.Literal("unsubscribe")]),
		id: Identifier,
		payload: Type.Record(Type.String(), Type.Unknown()),
	},
	{ additionalProperties: false },
);
export type Envelope = Static<typeof EnvelopeSchema>;

export const AcknowledgementPayloadSchemas = {
	"hello.accepted": Type.Object(
		{
			version: Type.Literal(1),
			capabilities: Type.Array(Type.String()),
			max_message_bytes: Type.Integer({ minimum: 1 }),
		},
		{ additionalProperties: false },
	),
	"subscription.accepted": Type.Object(
		{ stream_id: StreamIdSchema, after_seq: Sequence, latest_seq: Sequence },
		{ additionalProperties: false },
	),
	"subscription.removed": Type.Object({ stream_id: StreamIdSchema }, { additionalProperties: false }),
	"command.rejected": Type.Object({ error: ErrorSchema }, { additionalProperties: false }),
} as const;
export const AcknowledgementSchema = Type.Union([
	Type.Object(
		{
			v: Type.Literal(1),
			type: Type.Literal("hello.accepted"),
			reply_to: Identifier,
			payload: AcknowledgementPayloadSchemas["hello.accepted"],
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			v: Type.Literal(1),
			type: Type.Literal("subscription.accepted"),
			reply_to: Identifier,
			payload: AcknowledgementPayloadSchemas["subscription.accepted"],
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			v: Type.Literal(1),
			type: Type.Literal("subscription.removed"),
			reply_to: Identifier,
			payload: AcknowledgementPayloadSchemas["subscription.removed"],
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			v: Type.Literal(1),
			type: Type.Literal("command.rejected"),
			reply_to: Type.Optional(Identifier),
			payload: AcknowledgementPayloadSchemas["command.rejected"],
		},
		{ additionalProperties: false },
	),
]);
export type Acknowledgement = Static<typeof AcknowledgementSchema>;

/** Durable events use their own envelope, not the ephemeral command/acknowledgement wire. */
export const ApiEventSchema = Type.Object(
	{
		api_version: Type.Literal("1"),
		event_id: Identifier,
		stream_id: StreamIdSchema,
		seq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		type: Identifier,
		occurred_at: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$" }),
		session_id: Type.Optional(Identifier),
		run_id: Type.Optional(Identifier),
		task_id: Type.Optional(Identifier),
		data: Type.Record(Type.String(), Type.Unknown()),
	},
	{ additionalProperties: false },
);
export type ApiEvent = Static<typeof ApiEventSchema>;

export function parseEnvelope(value: unknown): Envelope {
	if (value && typeof value === "object" && "v" in value && value.v !== 1) {
		throw new ExecutorError("VERSION_MISMATCH", "Supported protocol version: 1");
	}
	if (value && typeof value === "object" && "type" in value && typeof value.type === "string") {
		if (!Object.hasOwn(CommandPayloadSchemas, value.type)) {
			throw new ExecutorError("UNKNOWN_COMMAND", "Unsupported command type");
		}
	}
	if (!Check(EnvelopeSchema, value)) throw new ExecutorError("INVALID_MESSAGE", "Invalid protocol envelope");
	const schema = CommandPayloadSchemas[value.type];
	if (!Check(schema, value.payload)) throw new ExecutorError("INVALID_PAYLOAD", `Invalid ${value.type} payload`);
	return value;
}
