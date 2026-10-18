import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { ModelThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { ModelsConfigSchema } from "../../coding-agent/src/core/model-config.ts";
import { ModelRuntime } from "../../coding-agent/src/core/model-runtime.ts";
import { isVirtualModel } from "../../coding-agent/src/core/virtual-models.ts";
import { writePrivateJson } from "./config-files.ts";
import {
	CustomModelSchema,
	customBaseUrl,
	isCustomProvider,
	prepareCustomModel,
	readModelsConfig,
} from "./custom-models.ts";
import { ExecutorError } from "./errors.ts";
import { testModel } from "./model-test.ts";
import type { RuntimeSelection } from "./session.ts";

const SelectionSchema = Type.Object({
	provider: Type.String({ minLength: 1, maxLength: 200 }),
	model: Type.String({ minLength: 1, maxLength: 500 }),
	revision: Type.Integer({ minimum: 0 }),
	thinking_level: Type.Optional(ModelThinkingLevelSchema),
});
const SavedSchema = Type.Intersect([SelectionSchema, Type.Object({ version: Type.Literal(1) })]);
export const ModelSettingsUpdateSchema = Type.Intersect([
	SelectionSchema,
	Type.Object({
		api_key: Type.Optional(Type.String({ minLength: 1, maxLength: 8192, pattern: "^[^\\u0000-\\u0020\\u007f]+$" })),
		custom: Type.Optional(CustomModelSchema),
	}),
]);
type Selection = Static<typeof SelectionSchema>;

/** One project default; sessions resolve it only at the start of a new execution. */
export class ModelSettings {
	private readonly file: string;
	private readonly authPath: string;
	private readonly modelsPath: string;
	private configVersion = 0;
	readonly defaultMaxOutputTokens: number;
	private readonly runtimeVersions = new WeakMap<ModelRuntime, number>();
	private readonly factory: () => Promise<RuntimeSelection>;
	private catalog!: RuntimeSelection;
	private selected: Selection | undefined;
	private source: "saved" | "environment" | "automatic" = "automatic";

	constructor(
		dataDir: string,
		agentDir: string,
		initial: { provider?: string; model?: string; maxOutputTokens?: number },
		factory?: () => Promise<RuntimeSelection>,
	) {
		this.file = join(dataDir, "runtime-model.json");
		this.authPath = join(agentDir, "auth.json");
		this.modelsPath = join(agentDir, "models.json");
		this.defaultMaxOutputTokens = initial.maxOutputTokens ?? 8192;
		if (!Number.isSafeInteger(this.defaultMaxOutputTokens) || this.defaultMaxOutputTokens < 1)
			throw new Error("Invalid default model output budget");
		if (Boolean(initial.provider) !== Boolean(initial.model))
			throw new Error("DW_PROVIDER and DW_MODEL must be configured together");
		if (initial.provider && initial.model) {
			this.selected = { provider: initial.provider, model: initial.model, revision: 0 };
			this.source = "environment";
		}
		this.factory =
			factory ??
			(async () => {
				const runtime = await ModelRuntime.create({
					authPath: this.authPath,
					modelsPath: this.modelsPath,
					allowModelNetwork: false,
				});
				const model =
					runtime.getAvailableSnapshot().find((item) => !isVirtualModel(item)) ??
					runtime.getModels().find((item) => !isVirtualModel(item));
				if (!model) throw new ExecutorError("MODEL_UNAVAILABLE", "Pi has no chat models in its local catalog");
				return { runtime, model };
			});
	}

	async initialize(): Promise<void> {
		try {
			const saved: unknown = JSON.parse(await readFile(this.file, "utf8"));
			if (!Check(SavedSchema, saved)) throw new Error("Invalid runtime-model.json");
			this.selected = {
				provider: saved.provider,
				model: saved.model,
				revision: saved.revision,
				...(saved.thinking_level !== undefined ? { thinking_level: saved.thinking_level } : {}),
			};
			this.source = "saved";
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		}
		this.catalog = await this.factory();
	}

	async refreshRuntime(runtime: ModelRuntime): Promise<void> {
		if ((this.runtimeVersions.get(runtime) ?? 0) !== this.configVersion) {
			const version = this.configVersion;
			await runtime.refresh({ allowNetwork: false });
			this.runtimeVersions.set(runtime, version);
		}
	}

	async resolve(runtime: ModelRuntime): Promise<Omit<RuntimeSelection, "runtime"> | undefined> {
		await this.refreshRuntime(runtime);
		if (!this.selected) return undefined;
		const model = runtime.getModel(this.selected.provider, this.selected.model);
		if (!model || isVirtualModel(model))
			throw new ExecutorError("MODEL_UNAVAILABLE", "Select an available physical chat model in model settings");
		if (
			this.selected.thinking_level !== undefined &&
			!getSupportedThinkingLevels(model).includes(this.selected.thinking_level)
		)
			throw new ExecutorError("INVALID_PAYLOAD", "Thinking level is not supported by the selected model");
		return { model, thinkingLevel: this.selected.thinking_level };
	}

	async createRuntime(): Promise<RuntimeSelection> {
		const version = this.configVersion;
		const selection = await this.factory();
		this.runtimeVersions.set(selection.runtime, version);
		// A removed model must not prevent the management UI from starting to repair configuration.
		const model = this.selected ? selection.runtime.getModel(this.selected.provider, this.selected.model) : undefined;
		return {
			...selection,
			model: model && !isVirtualModel(model) ? model : selection.model,
			thinkingLevel: model && !isVirtualModel(model) ? this.selected?.thinking_level : undefined,
		};
	}

	/** Internal catalog access; public resources are explicit credential-blind projections. */
	getCatalogRuntime(): ModelRuntime {
		return this.catalog.runtime;
	}

	defaultSelection() {
		return {
			...(this.selected ?? {
				provider: this.catalog.model.provider,
				model: this.catalog.model.id,
				revision: 0,
			}),
			max_output_tokens: this.defaultMaxOutputTokens,
		};
	}

	async readConfig() {
		return readModelsConfig(this.modelsPath);
	}

	async saveConfig(config: unknown, provider?: string, literalKey?: string, removeCredential = false): Promise<void> {
		if (!Check(ModelsConfigSchema, config))
			throw new ExecutorError("INVALID_PAYLOAD", "Invalid Pi model configuration");
		// Validate the complete merged config before any credentials or file content changes.
		await writePrivateJson(this.modelsPath, config);
		this.configVersion++;
		if (provider && literalKey !== undefined) await this.saveLiteralCredential(provider, literalKey);
		if (provider && removeCredential) await AuthStorage.create(this.authPath).delete(provider);
		await this.catalog.runtime.refresh({ allowNetwork: false });
	}

	private async saveLiteralCredential(provider: string, key: string): Promise<void> {
		const escaped = key.replaceAll("$", () => "$$").replace(/^!/, "$!");
		await AuthStorage.create(this.authPath).modify(provider, async () => ({ type: "api_key", key: escaped }));
	}

	async view() {
		const runtime = this.catalog.runtime;
		await runtime.getAvailable();
		const config = await readModelsConfig(this.modelsPath).catch(() => undefined);
		const providers = runtime
			.getProviders()
			.map((provider) => {
				const configured = config?.providers[provider.id];
				const custom = Boolean(configured && isCustomProvider(provider.id, configured));
				return {
					id: provider.id,
					name: provider.name ?? provider.id,
					custom,
					base_url: custom ? (customBaseUrl(configured?.baseUrl ?? "") ?? null) : null,
					api_key: Boolean(provider.auth.apiKey),
					oauth: Boolean(provider.auth.oauth),
					auth: {
						configured: runtime.getProviderAuthStatus(provider.id).configured,
						source: runtime.getProviderAuthStatus(provider.id).source ?? null,
					},
					models: runtime
						.getModels(provider.id)
						.filter((model) => !isVirtualModel(model))
						.map((model) => ({
							id: model.id,
							name: model.name,
							context_window: model.contextWindow,
							max_tokens: model.maxTokens,
							reasoning: model.reasoning,
							input: model.input,
							thinking_levels: getSupportedThinkingLevels(model),
						})),
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name));
		const effective = this.selected ?? {
			provider: this.catalog.model.provider,
			model: this.catalog.model.id,
			revision: 0,
		};
		return { selection: { ...effective, source: this.source }, providers };
	}

	async test(value: unknown, signal?: AbortSignal) {
		return testModel(this.catalog.runtime, value, signal);
	}

	async update(value: unknown) {
		if (!Check(ModelSettingsUpdateSchema, value))
			throw new ExecutorError("INVALID_PAYLOAD", "Invalid model settings");
		if (value.revision !== (this.selected?.revision ?? 0))
			throw new ExecutorError("CONFIG_REVISION_MISMATCH", "Model settings changed; refresh before saving", true);
		const runtime = this.catalog.runtime;
		const customConfig = value.custom
			? await prepareCustomModel(
					this.modelsPath,
					value.provider,
					value.model,
					value.custom,
					Boolean(runtime.getProvider(value.provider)),
				)
			: undefined;
		const model = runtime.getModel(value.provider, value.model);
		if (!customConfig && (!model || isVirtualModel(model)))
			throw new ExecutorError("MODEL_UNAVAILABLE", "Unknown physical chat model");
		if (!customConfig && value.api_key && !runtime.getProvider(value.provider)?.auth.apiKey)
			throw new ExecutorError("AUTH_UNSUPPORTED", "This provider requires its native authentication setup");
		if (value.thinking_level !== undefined) {
			const providerConfig = customConfig?.providers[value.provider];
			const definition = providerConfig?.models?.find((item) => item.id === value.model);
			const effectiveModel = definition
				? ({
						...(model ?? this.catalog.model),
						...definition,
						thinkingLevelMap: definition.thinkingLevelMap,
						...providerConfig?.modelOverrides?.[value.model],
					} as Model<Api>)
				: model!;
			if (!getSupportedThinkingLevels(effectiveModel).includes(value.thinking_level))
				throw new ExecutorError("INVALID_PAYLOAD", "Thinking level is not supported by the selected model");
		}
		let credentialSaved = false;
		let configSaved = false;
		try {
			if (customConfig) {
				await writePrivateJson(this.modelsPath, customConfig);
				configSaved = true;
				this.configVersion++;
				await runtime.refresh({ allowNetwork: false });
			}
			if (value.api_key) {
				// Pi supports commands and env templates. Management input is always literal.
				await this.saveLiteralCredential(value.provider, value.api_key);
				credentialSaved = true;
			}
			const selected: Selection = {
				provider: value.provider,
				model: value.model,
				revision: value.revision + 1,
				...(value.thinking_level !== undefined ? { thinking_level: value.thinking_level } : {}),
			};
			await writePrivateJson(this.file, { version: 1, ...selected });
			this.selected = selected;
			this.source = "saved";
		} catch {
			throw new ExecutorError("CONFIG_SAVE_FAILED", "Could not save model settings", true, {
				credential_saved: credentialSaved,
				config_saved: configSaved,
			});
		}
		return this.view();
	}
}
