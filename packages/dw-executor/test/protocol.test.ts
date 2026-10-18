import { Type } from "typebox";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createProtocolSchema } from "../scripts/export-schema.ts";
import {
	ExpectedRevisionSchema,
	HttpErrorSchema,
	PageSchema,
	PaginationQuerySchema,
	StoredSchema,
} from "../src/api-schemas.ts";
import {
	AcknowledgementSchema,
	ApiEventSchema,
	CommandPayloadSchemas,
	parseEnvelope,
	SegmentSchema,
	SOCKET_PATH,
} from "../src/protocol.ts";

describe("public subscription command contract", () => {
	it("accepts only hello, subscribe, and unsubscribe at the existing version/path", () => {
		expect(SOCKET_PATH).toBe("/dw-agent/v1");
		expect(Object.keys(CommandPayloadSchemas)).toEqual(["hello", "subscribe", "unsubscribe"]);
		const commands = [
			{ v: 1, id: "hello", type: "hello", payload: { client_id: "客户端👋", token: "secret", versions: [1] } },
			{ v: 1, id: "subscribe", type: "subscribe", payload: { stream_id: "session:session-1", after_seq: 0 } },
			{ v: 1, id: "unsubscribe", type: "unsubscribe", payload: { stream_id: "companion:persona_one:user-two" } },
		];
		for (const command of commands) expect(parseEnvelope(command)).toEqual(command);
	});

	it.each([
		"session.open",
		"session.attach",
		"history.get",
		"input.submit",
		"mode.set",
		"run.resume",
		"run.cancel",
		"toString",
	])("removes the old business command %s rather than aliasing it", (type) =>
		expect(() => parseEnvelope({ v: 1, id: "command", type, payload: {} })).toThrow("Unsupported"),
	);

	it("validates versions, payloads, and strictly reserved envelope fields", () => {
		const input = { v: 1, id: "command", type: "subscribe", payload: { stream_id: "system", after_seq: 0 } };
		expect(() => parseEnvelope({ ...input, v: 2 })).toThrow("version");
		expect(() => parseEnvelope({ ...input, payload: { stream_id: "system", after_seq: -1 } })).toThrow("payload");
		expect(() => parseEnvelope({ ...input, payload: { stream_id: "system", after_seq: 0.5 } })).toThrow("payload");
		expect(() =>
			parseEnvelope({ ...input, payload: { stream_id: "system", after_seq: Number.MAX_SAFE_INTEGER + 1 } }),
		).toThrow("payload");
		expect(() => parseEnvelope({ ...input, payload: { stream_id: "session:../bad", after_seq: 0 } })).toThrow(
			"payload",
		);
		expect(() =>
			parseEnvelope({ ...input, payload: { stream_id: "session:missing:component", after_seq: 0 } }),
		).toThrow("payload");
		for (const field of ["seq", "reply_to", "session_id", "run_id", "mode_revision", "ext"]) {
			expect(() => parseEnvelope({ ...input, [field]: 1 })).toThrow("envelope");
		}
		expect(() => parseEnvelope({ ...input, payload: { ...input.payload, text: "not a WS operation" } })).toThrow(
			"payload",
		);
		expect(() =>
			parseEnvelope({ v: 1, id: "hello", type: "hello", payload: { client_id: "a", token: "b", versions: [] } }),
		).toThrow("payload");
	});

	it("supports safe companion scopes at the store's component length boundary", () => {
		const stream = `companion:${"_".repeat(100)}:${"-".repeat(100)}`;
		expect(() =>
			parseEnvelope({ v: 1, id: "subscribe", type: "subscribe", payload: { stream_id: stream, after_seq: 0 } }),
		).not.toThrow();
		expect(() =>
			parseEnvelope({
				v: 1,
				id: "subscribe",
				type: "subscribe",
				payload: { stream_id: `${stream}x`, after_seq: 0 },
			}),
		).toThrow("payload");
	});
});

describe("server message contract", () => {
	const event = {
		api_version: "1",
		event_id: "event-1",
		stream_id: "session:session-1",
		seq: 1,
		type: "session.deleted",
		occurred_at: "2026-10-18T01:02:03.000Z",
		session_id: "session-1",
		data: { reason: "deleted" },
	};

	it("separates durable replayable events from ephemeral command acknowledgements", () => {
		expect(Check(ApiEventSchema, event)).toBe(true);
		expect(Check(ApiEventSchema, { ...event, seq: 0 })).toBe(false);
		expect(Check(ApiEventSchema, { ...event, occurred_at: "2026-10-18" })).toBe(false);
		expect(Check(ApiEventSchema, { ...event, v: 1, payload: event.data })).toBe(false);
		expect(Check(ApiEventSchema, { ...event, api_version: "2" })).toBe(false);
		const ack = {
			v: 1,
			type: "subscription.accepted",
			reply_to: "command",
			payload: { stream_id: "session:session-1", after_seq: 0, latest_seq: 1 },
		};
		expect(Check(AcknowledgementSchema, ack)).toBe(true);
		expect(Check(AcknowledgementSchema, { ...ack, id: "legacy" })).toBe(false);
		expect(Check(AcknowledgementSchema, { ...ack, reply_to: undefined })).toBe(false);
		const rejected = {
			v: 1,
			type: "command.rejected",
			payload: { error: { code: "INVALID_MESSAGE", message: "Malformed JSON", retryable: false } },
		};
		expect(Check(AcknowledgementSchema, rejected)).toBe(true);
		expect(Check(AcknowledgementSchema, { ...rejected, reply_to: "command" })).toBe(true);
		expect(Check(AcknowledgementSchema, event)).toBe(false);
	});

	it("exports a schema that validates actual commands, acknowledgements, and durable events", () => {
		const schema = createProtocolSchema();
		expect(Check(schema, event)).toBe(true);
		expect(
			Check(schema, { v: 1, id: "command", type: "subscribe", payload: { stream_id: "system", after_seq: 0 } }),
		).toBe(true);
		expect(
			Check(schema, { v: 1, type: "subscription.removed", reply_to: "command", payload: { stream_id: "system" } }),
		).toBe(true);
		expect(Check(schema, { v: 1, id: "command", type: "input.submit", payload: { text: "removed" } })).toBe(false);
		expect(Check(schema, { v: 1, id: "command", type: "subscribe", payload: { stream_id: "system" } })).toBe(false);
	});

	it("requires the full public segment and does not expose old renderer action fields", () => {
		const segment = {
			message_id: "message-1",
			segment_id: "message-1:segment_0",
			index: 0,
			expression: { description: "轻轻点头", language: "zh-CN" },
			speech: "你好。",
			text: "（轻轻点头）你好。",
			task_refs: ["task-1"],
		};
		expect(Check(SegmentSchema, segment)).toBe(true);
		expect(Check(SegmentSchema, { ...segment, actions: [] })).toBe(false);
		expect(Check(SegmentSchema, { ...segment, expression: { description: "微笑（点头）", language: "zh-CN" } })).toBe(
			false,
		);
		expect(Check(SegmentSchema, { ...segment, task_refs: ["task-1", "task-1"] })).toBe(false);
		expect(Check(SegmentSchema, { ...segment, message_id: undefined })).toBe(false);
	});
});

describe("shared HTTP resource schemas", () => {
	it("describes revisioned resources and opaque cursor pages without changing data shapes", () => {
		const resourceSchema = StoredSchema(Type.Object({ title: Type.String() }, { additionalProperties: false }));
		const resource = {
			id: "session.one",
			revision: 1,
			created_at: "2026-10-18T01:02:03Z",
			updated_at: "2026-10-18T01:02:03.000Z",
			data: { title: "中文👋" },
		};
		expect(Check(resourceSchema, resource)).toBe(true);
		expect(Check(resourceSchema, { ...resource, id: "_legacy" })).toBe(true);
		expect(Check(resourceSchema, { ...resource, id: "-legacy" })).toBe(true);
		expect(Check(resourceSchema, { ...resource, revision: 0 })).toBe(true);
		expect(Check(resourceSchema, { ...resource, revision: -1 })).toBe(false);
		expect(Check(resourceSchema, { ...resource, id: "../escape" })).toBe(false);
		expect(Check(PageSchema(resourceSchema), { items: [resource], next_cursor: null })).toBe(true);
		expect(Check(PageSchema(resourceSchema), { items: [resource], next_cursor: "opaque-cursor" })).toBe(true);
		expect(Check(PageSchema(resourceSchema), { items: [resource], next_cursor: 1 })).toBe(false);
		expect(Check(ExpectedRevisionSchema, { expected_revision: 1 })).toBe(true);
		expect(Check(ExpectedRevisionSchema, { expected_revision: 0 })).toBe(true);
		expect(Check(PaginationQuerySchema, { cursor: "c29tZS1jdXJzb3I", limit: 1000 })).toBe(true);
		expect(Check(PaginationQuerySchema, { cursor: "c29tZS1jdXJzb3I.c2lnbmF0dXJl", limit: 50 })).toBe(true);
		expect(Check(PaginationQuerySchema, { cursor: "1+bad/", limit: 1001 })).toBe(false);
	});

	it("puts request IDs in error responses, not resource request bodies", () => {
		const error = {
			error: { code: "REVISION_CONFLICT", message: "Changed", retryable: false },
			request_id: "request-1",
		};
		expect(Check(HttpErrorSchema, error)).toBe(true);
		expect(Check(HttpErrorSchema, error.error)).toBe(false);
	});
});
