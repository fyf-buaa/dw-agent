import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { ProportionalContextPolicy } from "../src/context-policy.ts";

describe("proportional context window", () => {
	it("trims complete user/tool blocks and keeps the archive and effective persona intact", () => {
		const messages: AgentMessage[] = [{ role: "system", content: "shared-persona and pinned task", timestamp: 0 }];
		for (let index = 0; index < 10; index++) {
			messages.push(
				{ role: "user", content: `input-${index} ${"字".repeat(100)}`, timestamp: index },
				fauxAssistantMessage(fauxToolCall("read", { path: "test" }, { id: `call-${index}` }), {
					stopReason: "toolUse",
				}),
				{
					role: "toolResult",
					toolCallId: `call-${index}`,
					toolName: "read",
					content: [{ type: "text", text: "result" }],
					isError: false,
					timestamp: index,
				},
			);
		}
		const policy = new ProportionalContextPolicy({ safetyReserve: 0 });
		const result = policy.assemble(messages, 1800, 100, 0);
		expect(result.removedBlocks).toBeGreaterThan(0);
		expect(result.messages[0]).toMatchObject({ role: "system", content: "shared-persona and pinned task" });
		expect(messages).toHaveLength(31);
		expect(JSON.stringify(result.messages)).toContain("input-9");
		const calls = new Set(
			result.messages.flatMap((message) =>
				message.role === "assistant"
					? message.content.filter((part) => part.type === "toolCall").map((part) => part.id)
					: [],
			),
		);
		for (const message of result.messages)
			if (message.role === "toolResult") expect(calls.has(message.toolCallId)).toBe(true);
		const next = policy.assemble(messages, 1800, 100, result.cutoff);
		expect(next.cutoff).toBe(result.cutoff);
		expect(next.removedBlocks).toBe(0);
	});

	it("rejects irreducible current input without dropping it", () => {
		const policy = new ProportionalContextPolicy({ safetyReserve: 0 });
		expect(() => policy.assemble([{ role: "user", content: "字".repeat(5000), timestamp: 0 }], 1000, 100, 0)).toThrow(
			"current input",
		);
	});

	it("validates thresholds and leaves small contexts intact", () => {
		expect(() => new ProportionalContextPolicy({ highWatermark: 0.5, lowWatermark: 0.7 })).toThrow();
		const policy = new ProportionalContextPolicy({ safetyReserve: 0 });
		expect(policy.assemble([{ role: "user", content: "hello", timestamp: 0 }], 1000, 100, 0).removedBlocks).toBe(0);
	});
});
