import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeContext } from "@earendil-works/pi-ai";
import { convertToLlm } from "../../coding-agent/src/core/messages.ts";
import { ExecutorError } from "./errors.ts";

export interface ContextResult {
	messages: AgentMessage[];
	cutoff: number;
	removedBlocks: number;
	estimatedTokens: number;
}

export interface ContextPolicy {
	assemble(messages: AgentMessage[], contextWindow: number, outputReserve: number, cutoff: number): ContextResult;
}

export class ProportionalContextPolicy implements ContextPolicy {
	readonly highWatermark: number;
	readonly lowWatermark: number;
	readonly pruneRatio: number;
	readonly safetyReserve: number;

	constructor(
		options: { highWatermark?: number; lowWatermark?: number; pruneRatio?: number; safetyReserve?: number } = {},
	) {
		this.highWatermark = options.highWatermark ?? 0.85;
		this.lowWatermark = options.lowWatermark ?? 0.7;
		this.pruneRatio = options.pruneRatio ?? 0.25;
		this.safetyReserve = options.safetyReserve ?? 2048;
		if (
			!(
				this.lowWatermark > 0 &&
				this.lowWatermark < this.highWatermark &&
				this.highWatermark < 1 &&
				this.pruneRatio > 0 &&
				this.pruneRatio <= 1 &&
				this.safetyReserve >= 0
			)
		)
			throw new Error("Invalid context policy thresholds");
	}

	assemble(messages: AgentMessage[], contextWindow: number, outputReserve: number, cutoff: number): ContextResult {
		const normalized = normalizeContext({ messages: convertToLlm(messages) }).messages;
		const system = normalized.filter((message) => message.role === "system");
		const blocks: AgentMessage[][] = [];
		for (const message of normalized) {
			if (message.role === "system") continue;
			if (message.role === "user" || blocks.length === 0) blocks.push([]);
			blocks[blocks.length - 1].push(message);
		}
		const budget = contextWindow - outputReserve - this.safetyReserve;
		if (budget <= 0)
			throw new ExecutorError("CONTEXT_TOO_LARGE", "Model window is smaller than the configured reserves");
		let nextCutoff = Math.min(cutoff, Math.max(0, blocks.length - 1));
		const estimate = () => {
			const retained = [...system, ...blocks.slice(nextCutoff).flat()];
			// UTF-8 sizing is deliberately conservative for Chinese and mixed tool output.
			return {
				messages: retained,
				tokens: retained.reduce(
					(sum, message) => sum + Math.ceil(Buffer.byteLength(JSON.stringify(message)) / 3) + 16,
					0,
				),
			};
		};
		let retained = estimate();
		if (retained.tokens > budget * this.highWatermark) {
			while (retained.tokens > budget * this.lowWatermark && nextCutoff < blocks.length - 1) {
				const eligible = blocks.length - 1 - nextCutoff;
				nextCutoff += Math.max(1, Math.ceil(eligible * this.pruneRatio));
				retained = estimate();
			}
		}
		if (retained.tokens > budget)
			throw new ExecutorError(
				"CONTEXT_TOO_LARGE",
				"The current input, task and persona do not fit the model window",
			);
		return {
			messages: retained.messages,
			cutoff: nextCutoff,
			removedBlocks: nextCutoff - cutoff,
			estimatedTokens: retained.tokens,
		};
	}
}
