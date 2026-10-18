import {
	type AssistantMessage,
	type AuthResult,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { ModelThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ModelRuntime } from "../../coding-agent/src/core/model-runtime.ts";
import { isVirtualModel } from "../../coding-agent/src/core/virtual-models.ts";
import { raceWithAbortSignal } from "../../coding-agent/src/utils/abort.ts";
import { ExecutorError } from "./errors.ts";

export const ModelTestSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1, maxLength: 200 }),
		model: Type.String({ minLength: 1, maxLength: 500 }),
		thinking_level: Type.Optional(ModelThinkingLevelSchema),
		api_key: Type.Optional(Type.String({ minLength: 1, maxLength: 8192, pattern: "^[^\\u0000-\\u0020\\u007f]+$" })),
	},
	{ additionalProperties: false },
);

export interface ModelTestResult {
	available: true;
	provider: string;
	model: string;
	thinking_level: ModelThinkingLevel;
	duration_ms: number;
	usage: { input_tokens: number; output_tokens: number };
}

/** Explicit, sessionless probe: no credential/config writes, tools, retries or agent loop. */
export async function testModel(runtime: ModelRuntime, value: unknown, signal?: AbortSignal): Promise<ModelTestResult> {
	if (!Check(ModelTestSchema, value)) throw new ExecutorError("INVALID_PAYLOAD", "Invalid model test request");
	const provider = runtime.getProvider(value.provider);
	const model = runtime.getModel(value.provider, value.model);
	if (!provider || !model || isVirtualModel(model))
		throw new ExecutorError("MODEL_UNAVAILABLE", "Unknown physical chat model");
	if (value.thinking_level !== undefined && !getSupportedThinkingLevels(model).includes(value.thinking_level))
		throw new ExecutorError("THINKING_LEVEL_UNSUPPORTED", "The model does not support this thinking level");
	if (value.api_key !== undefined && !provider.auth.apiKey)
		throw new ExecutorError("AUTH_UNSUPPORTED", "This provider requires its native authentication setup");

	// Match the SDK's medium default, clamped only when the caller did not specify a level.
	const thinkingLevel = value.thinking_level ?? clampThinkingLevel(model, "medium");
	const started = Date.now();
	const controller = new AbortController();
	let timedOut = false;
	const cancel = () => controller.abort();
	signal?.addEventListener("abort", cancel, { once: true });
	if (signal?.aborted) cancel();
	const timer = setTimeout(() => {
		if (controller.signal.aborted) return;
		timedOut = true;
		controller.abort();
	}, 20_000);
	const safeFailure = () => {
		if (timedOut) return new ExecutorError("MODEL_TEST_TIMEOUT", "The model test timed out", true);
		if (controller.signal.aborted) return new ExecutorError("MODEL_TEST_ABORTED", "The model test was cancelled");
		return new ExecutorError("MODEL_TEST_FAILED", "The provider could not complete the model test");
	};

	try {
		let auth: AuthResult | undefined;
		try {
			controller.signal.throwIfAborted();
			auth = await raceWithAbortSignal(
				runtime.getAuth(model, { apiKey: value.api_key, signal: controller.signal }),
				controller.signal,
			);
		} catch {
			// Native auth/provider errors may contain credentials, headers or response bodies.
			throw safeFailure();
		}
		if (!auth)
			throw new ExecutorError("MODEL_AUTH_REQUIRED", "Configure credentials for this provider before testing");

		let response: AssistantMessage;
		try {
			controller.signal.throwIfAborted();
			response = await raceWithAbortSignal(
				runtime.completeSimple(
					model,
					{ messages: [{ role: "user", content: "Reply with only OK.", timestamp: started }] },
					{
						apiKey: auth.auth.apiKey,
						headers: auth.auth.headers,
						env: auth.env,
						reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
						signal: controller.signal,
						timeoutMs: 20_000,
						maxRetries: 0,
						maxTokens: Math.min(
							model.maxTokens > 0 ? model.maxTokens : 1024,
							thinkingLevel === "off" ? 64 : 1024,
						),
						// Budget-based providers need at least 1024 thinking tokens. Native adapters
						// add this bounded budget to the answer ceiling where their API requires it.
						thinkingBudgets: { minimal: 1024, low: 1024, medium: 1024, high: 1024 },
					},
				),
				controller.signal,
			);
			controller.signal.throwIfAborted();
		} catch {
			throw safeFailure();
		}
		const usage = {
			input_tokens: response.usage.input + response.usage.cacheRead + response.usage.cacheWrite,
			output_tokens: response.usage.output,
		};
		if (response.stopReason === "error") {
			const error = safeFailure();
			throw new ExecutorError(error.code, error.message, error.retryable, { usage });
		}
		if (response.stopReason === "aborted")
			throw new ExecutorError("MODEL_TEST_ABORTED", "The model test was cancelled", false, { usage });
		return {
			available: true,
			provider: model.provider,
			model: model.id,
			thinking_level: thinkingLevel,
			duration_ms: Math.max(0, Date.now() - started),
			usage,
		};
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
	}
}
