import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, clampThinkingLevel } from "@earendil-works/pi-ai";
import { convertToLlm } from "../../coding-agent/src/core/messages.ts";
import { isVirtualModel } from "../../coding-agent/src/core/virtual-models.ts";
import { raceWithAbortSignal } from "../../coding-agent/src/utils/abort.ts";
import type { LifeCompletionRequest, LifeCompletionResult } from "./companion-life-types.ts";
import { sanitizeMemoryText } from "./companion-store.ts";
import type { ContextPolicy } from "./context-policy.ts";
import { ExecutorError } from "./errors.ts";
import type { ModelProfiles } from "./model-profiles.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { RuntimeSelection } from "./session.ts";

/** Background calls have their own runtime and queue; they never replace a chat request guard. */
export class LifeModelClient {
	private readonly models: ModelSettings;
	private readonly context: ContextPolicy;
	private selection: RuntimeSelection | undefined;
	private queue: Promise<void> = Promise.resolve();
	private profiles: ModelProfiles | undefined;
	private profileId = "default";
	private closed = false;

	constructor(models: ModelSettings, context: ContextPolicy) {
		this.models = models;
		this.context = context;
	}

	setProfiles(profiles: ModelProfiles, profileId = "default"): void {
		this.profiles = profiles;
		this.profileId = profileId;
	}

	complete(request: LifeCompletionRequest): Promise<LifeCompletionResult> {
		const work = this.queue.then(() => this.execute(request));
		this.queue = work.then(
			() => undefined,
			() => undefined,
		);
		return work;
	}

	private async execute(request: LifeCompletionRequest): Promise<LifeCompletionResult> {
		if (this.closed) throw new ExecutorError("SERVER_CLOSING", "Background model client is shutting down");
		const controller = new AbortController();
		const cancel = () => controller.abort();
		request.signal.addEventListener("abort", cancel, { once: true });
		if (request.signal.aborted) cancel();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, 60_000);
		timer.unref();
		let response: AssistantMessage | undefined;
		try {
			controller.signal.throwIfAborted();
			if (!this.selection) {
				const selection = await raceWithAbortSignal(
					this.profiles && !request.model
						? this.profiles.createRuntime(this.profileId, "life")
						: this.models.createRuntime(),
					controller.signal,
				);
				if (selection.runtime.requestGuard)
					throw new ExecutorError(
						"LIFE_RUNTIME_SHARED",
						"Background generation requires an independent model runtime",
					);
				this.selection = selection;
			}
			const { runtime } = this.selection;
			if (request.model) await raceWithAbortSignal(this.models.refreshRuntime(runtime), controller.signal);
			const selected = request.model
				? undefined
				: await raceWithAbortSignal(
						this.profiles ? this.profiles.resolve(runtime, this.profileId, "life") : this.models.resolve(runtime),
						controller.signal,
					);
			const model = request.model
				? runtime.getModel(request.model.provider, request.model.model)
				: (selected?.model ?? this.selection.model);
			if (!model || isVirtualModel(model))
				throw new ExecutorError("MODEL_UNAVAILABLE", "Select a physical model for background generation");
			const auth = await raceWithAbortSignal(
				runtime.getAuth(model, { signal: controller.signal }),
				controller.signal,
			);
			if (!auth)
				throw new ExecutorError(
					"MODEL_AUTH_REQUIRED",
					"Configure model credentials before generating life content",
				);
			const profileBudget = this.profiles
				? this.profiles.get(this.profileId).data.life.max_output_tokens
				: request.max_tokens;
			const maxTokens = Math.min(
				request.max_tokens,
				model.maxTokens || request.max_tokens,
				profileBudget,
				model.contextWindow - 1,
			);
			const thinking = request.model
				? clampThinkingLevel(model, "off")
				: (selected?.thinkingLevel ?? clampThinkingLevel(model, "off"));
			const started = Date.now();
			const messages: AgentMessage[] = [
				{ role: "system", content: sanitizeMemoryText(request.system), timestamp: started },
				{ role: "user", content: sanitizeMemoryText(request.prompt), timestamp: started },
			];
			const assembled = this.context.assemble(
				messages,
				model.contextWindow,
				maxTokens + (thinking === "off" ? 0 : 1024),
				0,
			);
			runtime.requestGuard = () => {
				controller.signal.throwIfAborted();
				request.on_request();
			};
			try {
				response = await raceWithAbortSignal(
					runtime.completeSimple(
						model,
						{ messages: convertToLlm(assembled.messages) },
						{
							apiKey: auth.auth.apiKey,
							headers: auth.auth.headers,
							env: auth.env,
							reasoning: thinking === "off" ? undefined : thinking,
							thinkingBudgets: { minimal: 1024, low: 1024, medium: 1024, high: 1024 },
							maxTokens,
							maxRetries: 0,
							timeoutMs: 60_000,
							signal: controller.signal,
						},
					),
					controller.signal,
				);
				controller.signal.throwIfAborted();
			} finally {
				runtime.requestGuard = undefined;
			}
			if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length")
				throw new ExecutorError("LIFE_MODEL_FAILED", "Background model output did not complete");
			let text = "";
			for (const part of response.content) if (part.type === "text") text += part.text;
			return {
				text,
				provider: model.provider,
				model: model.id,
				usage: {
					input_tokens: response.usage.input + response.usage.cacheRead + response.usage.cacheWrite,
					output_tokens: response.usage.output,
				},
			};
		} catch (error) {
			if (timedOut) throw new ExecutorError("LIFE_MODEL_TIMEOUT", "Background generation timed out", true);
			if (controller.signal.aborted)
				throw new ExecutorError("LIFE_MODEL_ABORTED", "Background generation was cancelled");
			if (error instanceof ExecutorError) {
				if (response)
					throw new ExecutorError(error.code, error.message, error.retryable, {
						usage: {
							input_tokens: response.usage.input + response.usage.cacheRead + response.usage.cacheWrite,
							output_tokens: response.usage.output,
						},
					});
				throw error;
			}
			throw new ExecutorError(
				"LIFE_MODEL_FAILED",
				"The model provider could not complete background generation",
				true,
			);
		} finally {
			clearTimeout(timer);
			request.signal.removeEventListener("abort", cancel);
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.queue;
	}
}
