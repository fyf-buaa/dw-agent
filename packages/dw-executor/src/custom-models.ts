import { readFile } from "node:fs/promises";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { ModelsConfigSchema } from "../../coding-agent/src/core/model-config.ts";
import { stripJsonComments } from "../../coding-agent/src/utils/json.ts";
import { stripBom } from "../../coding-agent/src/utils/text.ts";
import { ExecutorError } from "./errors.ts";

export const CustomModelSchema = Type.Object({
	base_url: Type.String({ minLength: 1, maxLength: 2048 }),
	context_window: Type.Optional(Type.Integer({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER })),
	max_tokens: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
	reasoning: Type.Optional(Type.Boolean()),
	input: Type.Optional(
		Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), {
			minItems: 1,
			maxItems: 2,
			uniqueItems: true,
			contains: Type.Literal("text"),
		}),
	),
});
const builtinIds = new Set(builtinProviders().map((provider) => provider.id));

export function customBaseUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
			return undefined;
		return url.href.replace(/\/+$/, "");
	} catch {
		return undefined;
	}
}

export async function readModelsConfig(path: string): Promise<Static<typeof ModelsConfigSchema>> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { providers: {} };
		throw new ExecutorError("CONFIG_READ_FAILED", "Could not read Pi models.json");
	}
	try {
		const value: unknown = JSON.parse(stripJsonComments(stripBom(content)));
		if (Check(ModelsConfigSchema, value)) return value;
	} catch {
		// Never include raw config or parse errors: they may contain credentials.
	}
	throw new ExecutorError("CONFIG_INVALID", "Repair the invalid Pi models.json before saving custom models");
}

export function isCustomProvider(id: string, config: Static<typeof ModelsConfigSchema>["providers"][string]): boolean {
	return !builtinIds.has(id) && config.api === "openai-completions" && !config.oauth;
}

export async function prepareCustomModel(
	path: string,
	provider: string,
	model: string,
	custom: Static<typeof CustomModelSchema>,
	providerExists: boolean,
) {
	if (!/^[A-Za-z0-9_-]{1,100}$/.test(provider) || ["__proto__", "constructor", "prototype"].includes(provider))
		throw new ExecutorError("INVALID_PAYLOAD", "Provider ID must use 1–100 letters, digits, underscores or hyphens");
	const config = await readModelsConfig(path);
	const existing = Object.hasOwn(config.providers, provider) ? config.providers[provider] : undefined;
	if (builtinIds.has(provider) || (providerExists && !existing) || (existing && !isCustomProvider(provider, existing)))
		throw new ExecutorError(
			"PROVIDER_CONFLICT",
			"Choose a custom provider ID that does not replace a native provider",
		);
	const baseUrl = customBaseUrl(custom.base_url);
	if (!baseUrl)
		throw new ExecutorError("INVALID_PAYLOAD", "Base URL must be HTTP(S), without credentials, query or fragment");
	const previous = existing?.models?.find((item) => item.id === model);
	const contextWindow = custom.context_window ?? previous?.contextWindow ?? 131072;
	const maxTokens = custom.max_tokens ?? previous?.maxTokens ?? 8192;
	if (maxTokens >= contextWindow)
		throw new ExecutorError("INVALID_PAYLOAD", "Maximum output must be smaller than the context window");
	if ((previous?.api && previous.api !== "openai-completions") || previous?.baseUrl)
		throw new ExecutorError(
			"MODEL_CONFLICT",
			"This model has a native per-model endpoint or API override; edit it in Pi models.json",
		);
	const models = (existing?.models ?? []).filter((item) => item.id !== model);
	models.push({
		...previous,
		id: model,
		contextWindow,
		maxTokens,
		reasoning: custom.reasoning ?? previous?.reasoning ?? false,
		input: custom.input ?? previous?.input ?? ["text"],
	});
	return {
		...config,
		providers: {
			...config.providers,
			[provider]: { ...existing, api: "openai-completions", baseUrl, models },
		},
	};
}
