import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
	AcknowledgementSchema,
	ApiEventSchema,
	CommandPayloadSchemas,
	EnvelopeSchema,
	SegmentSchema,
} from "../src/protocol.ts";
import { exportOpenApi } from "./export-openapi.ts";

/** All WebSocket messages: authenticated commands, ephemeral acknowledgements, and durable events. */
export function createProtocolSchema() {
	const commands = Object.entries(CommandPayloadSchemas).map(([name, payload]) =>
		Type.Object(
			{
				v: Type.Literal(1),
				type: Type.Literal(name),
				id: EnvelopeSchema.properties.id,
				payload,
			},
			{ additionalProperties: false },
		),
	);
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		title: "dw-agent WebSocket protocol v1",
		description:
			"One JSON object per WebSocket text message at /dw-agent/v1. HTTP handles business operations; WebSocket commands only authenticate and manage durable event subscriptions.",
		oneOf: [...commands, AcknowledgementSchema, ApiEventSchema],
		$defs: { ReplySegment: SegmentSchema },
	};
}

export function exportProtocolSchema(outputDirectory = new URL("../schemas/", import.meta.url)): void {
	mkdirSync(outputDirectory, { recursive: true });
	writeFileSync(new URL("protocol-v1.schema.json", outputDirectory), `${JSON.stringify(createProtocolSchema(), null, "\t")}\n`);
}

// Importing schema builders from tests or OpenAPI generation must not write generated artifacts.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	exportProtocolSchema();
	exportOpenApi();
}
