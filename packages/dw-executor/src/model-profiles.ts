import { createHash, randomUUID } from "node:crypto";
import { type Api, getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { ModelsJsonProvider } from "../../coding-agent/src/core/model-config.ts";
import type { ModelRuntime } from "../../coding-agent/src/core/model-runtime.ts";
import { isVirtualModel } from "../../coding-agent/src/core/virtual-models.ts";
import type { ApiStore, Stored } from "./api-store.ts";
import { customBaseUrl } from "./custom-models.ts";
import { ExecutorError } from "./errors.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { RuntimeSelection } from "./session.ts";

const positiveInteger = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const builtinProviderIds = new Set(builtinProviders().map((provider) => provider.id));
const roleSchema = Type.Object(
	{
		provider: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		model: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
		thinking_level: Type.Optional(Type.Union([ModelThinkingLevelSchema, Type.Null()])),
		max_output_tokens: Type.Optional(positiveInteger),
	},
	{ additionalProperties: false },
);
const profileSchema = Type.Object(
	{
		id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$" })),
		name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		expected_revision: Type.Optional(positiveInteger),
		chat: Type.Optional(roleSchema),
		agent: Type.Optional(roleSchema),
		life: Type.Optional(roleSchema),
	},
	{ additionalProperties: false },
);
const credentialSchema = Type.String({ minLength: 1, maxLength: 8192, pattern: "^[^\\u0000-\\u0020\\u007f]+$" });
const providerSchema = Type.Object(
	{
		expected_revision: Type.Union([positiveInteger, Type.Null()]),
		name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		base_url: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
		api: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		api_key: Type.Optional(credentialSchema),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		compat: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		authHeader: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
const modelSchema = Type.Object(
	{
		expected_revision: Type.Union([positiveInteger, Type.Null()]),
		name: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
		context_window: Type.Optional(positiveInteger),
		max_tokens: Type.Optional(positiveInteger),
		reasoning: Type.Optional(Type.Boolean()),
		input: Type.Optional(
			Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), { minItems: 1, uniqueItems: true }),
		),
		api: Type.Optional(Type.String({ minLength: 1 })),
		base_url: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
		thinkingLevelMap: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		inputLimits: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		cost: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		promptCache: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		samplingParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		samplingParamsByThinkingLevel: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		compat: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

export type ModelRole = "chat" | "agent" | "life";
export interface ModelRoleSelection {
	provider: string;
	model: string;
	thinking_level?: ModelThinkingLevel;
	max_output_tokens: number;
}
export interface ModelProfile {
	name: string;
	chat: ModelRoleSelection;
	agent: ModelRoleSelection;
	life: ModelRoleSelection;
}
export interface ModelBudget {
	declared_max_tokens: number;
	configured_max_tokens: number;
	effective_max_tokens: number;
}
export interface FrozenModelSelection extends ModelBudget {
	model: Model<Api>;
	thinkingLevel?: ModelThinkingLevel;
	maxOutputTokens: number;
}
export type ProfileView = Omit<ModelProfile, ModelRole> &
	Record<
		ModelRole,
		ModelRoleSelection & {
			declared_max_tokens: number | null;
			configured_max_tokens: number;
			effective_max_tokens: number | null;
			context_window: number | null;
			available: boolean;
		}
	>;
export interface ProviderData {
	name: string;
	custom: boolean;
	base_url: string | null;
	api: string | null;
	api_key: boolean;
	oauth: boolean;
	auth: { configured: boolean; source: string | null };
}
export interface ModelData {
	provider: string;
	id: string;
	name: string;
	context_window: number;
	max_tokens: number;
	reasoning: boolean;
	input: Model<Api>["input"];
	thinking_levels: ModelThinkingLevel[];
}
interface ListQuery {
	cursor?: string;
	limit?: number;
}
const roles: ModelRole[] = ["chat", "agent", "life"];

/** Durable independent role selections; Pi remains the sole provider execution implementation. */
export class ModelProfiles {
	private queue: Promise<unknown> = Promise.resolve();
	private readonly store: ApiStore;
	private readonly settings: ModelSettings;

	constructor(store: ApiStore, settings: ModelSettings) {
		this.store = store;
		this.settings = settings;
	}

	async initialize(): Promise<void> {
		this.syncDefault();
		await this.refreshCatalog();
	}

	private syncDefault(): void {
		const legacy = this.settings.defaultSelection();
		const existing = this.store.get<ModelProfile>("model_profile", "default");
		const marker = this.store.get<{ tracking: boolean; fingerprint: string }>("model_profile_migration", "default");
		if (existing && !marker?.data.tracking) return;
		const fingerprint = JSON.stringify(legacy);
		if (existing && marker?.data.fingerprint === fingerprint) return;
		const { revision: _revision, ...selection } = legacy;
		this.store.transaction(() => {
			this.store.put<ModelProfile>(
				"model_profile",
				"default",
				{
					name: "Default",
					chat: { ...selection },
					agent: { ...selection },
					life: { ...selection },
				},
				existing?.revision ?? null,
			);
			this.store.put(
				"model_profile_migration",
				"default",
				{ tracking: true, fingerprint },
				marker?.revision ?? null,
			);
		});
	}

	private view(record: Stored<ModelProfile>): Stored<ProfileView> {
		const runtime = this.settings.getCatalogRuntime();
		const roleView = (selection: ModelRoleSelection) => {
			const model = runtime.getModel(selection.provider, selection.model);
			const available = Boolean(model && !isVirtualModel(model));
			return {
				...selection,
				declared_max_tokens: available ? model!.maxTokens : null,
				configured_max_tokens: selection.max_output_tokens,
				effective_max_tokens: available
					? this.budget(model!, selection.max_output_tokens).effective_max_tokens
					: null,
				context_window: available ? model!.contextWindow : null,
				available,
			};
		};
		return {
			...record,
			data: {
				name: record.data.name,
				chat: roleView(record.data.chat),
				agent: roleView(record.data.agent),
				life: roleView(record.data.life),
			},
		};
	}

	profiles(query?: ListQuery) {
		this.syncDefault();
		const result = this.store.list<ModelProfile>("model_profile", query);
		return { ...result, items: result.items.map((item) => this.view(item)) };
	}

	get(id: string): Stored<ProfileView> {
		this.syncDefault();
		return this.view(this.store.require<ModelProfile>("model_profile", id));
	}

	private mergeRole(base: ModelRoleSelection, patch: Static<typeof roleSchema> | undefined): ModelRoleSelection {
		const { thinking_level, ...rest } = patch ?? {};
		const result: ModelRoleSelection = { ...base, ...rest };
		if (thinking_level === null) delete result.thinking_level;
		else if (thinking_level !== undefined) result.thinking_level = thinking_level;
		const model = this.settings.getCatalogRuntime().getModel(result.provider, result.model);
		if (!model || isVirtualModel(model))
			throw new ExecutorError("MODEL_UNAVAILABLE", "Unknown physical model in profile");
		if (result.thinking_level !== undefined && !getSupportedThinkingLevels(model).includes(result.thinking_level))
			throw new ExecutorError("INVALID_PAYLOAD", "Thinking level is not supported by the selected model");
		this.budget(model, result.max_output_tokens);
		return result;
	}

	create(value: unknown): Stored<ProfileView> {
		if (!Check(profileSchema, value) || value.expected_revision !== undefined)
			throw new ExecutorError("INVALID_PAYLOAD", "Invalid model profile creation");
		this.syncDefault();
		const id = value.id ?? randomUUID();
		const base = this.store.require<ModelProfile>("model_profile", "default").data;
		const data: ModelProfile = {
			name: value.name ?? id,
			chat: this.mergeRole(base.chat, value.chat),
			agent: this.mergeRole(base.agent, value.agent),
			life: this.mergeRole(base.life, value.life),
		};
		return this.view(this.store.put("model_profile", id, data, null));
	}

	update(id: string, value: unknown): Stored<ProfileView> {
		if (!Check(profileSchema, value) || value.id !== undefined || value.expected_revision === undefined)
			throw new ExecutorError("INVALID_PAYLOAD", "Model profile update requires expected_revision");
		this.syncDefault();
		const previous = this.store.require<ModelProfile>("model_profile", id);
		const data: ModelProfile = {
			name: value.name ?? previous.data.name,
			chat: this.mergeRole(previous.data.chat, value.chat),
			agent: this.mergeRole(previous.data.agent, value.agent),
			life: this.mergeRole(previous.data.life, value.life),
		};
		return this.store.transaction(() => {
			const record = this.store.put("model_profile", id, data, value.expected_revision!);
			if (id === "default") {
				const marker = this.store.require<{ tracking: boolean; fingerprint: string }>(
					"model_profile_migration",
					id,
				);
				this.store.put("model_profile_migration", id, { ...marker.data, tracking: false }, marker.revision);
			}
			return this.view(record);
		});
	}

	remove(id: string, revision: number): void {
		if (id === "default") throw new ExecutorError("CONFIG_IN_USE", "The default model profile cannot be deleted");
		for (const kind of ["session", "task"]) {
			if (this.store.all<{ model_profile_id?: string }>(kind).some((item) => item.data.model_profile_id === id))
				throw new ExecutorError("CONFIG_IN_USE", "A session or task references this model profile");
		}
		this.store.remove("model_profile", id, revision);
	}

	private budget(model: Model<Api>, configured: number): ModelBudget {
		if (
			!Number.isSafeInteger(configured) ||
			configured < 1 ||
			!Number.isFinite(model.maxTokens) ||
			model.maxTokens < 1 ||
			!Number.isFinite(model.contextWindow) ||
			model.contextWindow < 2
		)
			throw new ExecutorError("INVALID_PAYLOAD", "Model output and context budgets must be positive and finite");
		return {
			declared_max_tokens: model.maxTokens,
			configured_max_tokens: configured,
			effective_max_tokens: Math.floor(Math.min(configured, model.maxTokens, model.contextWindow - 1)),
		};
	}

	async resolve(
		runtime: ModelRuntime,
		profileId = "default",
		role: ModelRole = "chat",
		snapshot?: Stored<ModelProfile>,
	): Promise<Omit<RuntimeSelection, "runtime"> & ModelBudget & { maxOutputTokens: number }> {
		this.syncDefault();
		await this.settings.refreshRuntime(runtime);
		if (snapshot && snapshot.id !== profileId)
			throw new ExecutorError("INVALID_PAYLOAD", "Frozen model profile does not match the requested profile");
		const selection = (snapshot ?? this.store.require<ModelProfile>("model_profile", profileId)).data[role];
		const model = runtime.getModel(selection.provider, selection.model);
		if (!model || isVirtualModel(model))
			throw new ExecutorError("MODEL_UNAVAILABLE", "The configured profile model is unavailable");
		if (
			selection.thinking_level !== undefined &&
			!getSupportedThinkingLevels(model).includes(selection.thinking_level)
		)
			throw new ExecutorError("INVALID_PAYLOAD", "Thinking level is no longer supported by the profile model");
		const budget = this.budget(model, selection.max_output_tokens);
		return {
			model,
			thinkingLevel: selection.thinking_level,
			maxOutputTokens: budget.effective_max_tokens,
			...budget,
		};
	}

	/** Private task snapshot. Callers must never project this descriptor onto public task data. */
	capture(profileId = "default", role: ModelRole = "agent"): FrozenModelSelection {
		this.syncDefault();
		const selection = this.store.require<ModelProfile>("model_profile", profileId).data[role];
		const model = this.settings.getCatalogRuntime().getModel(selection.provider, selection.model);
		if (!model || isVirtualModel(model))
			throw new ExecutorError("MODEL_UNAVAILABLE", "The configured profile model is unavailable");
		if (
			selection.thinking_level !== undefined &&
			!getSupportedThinkingLevels(model).includes(selection.thinking_level)
		)
			throw new ExecutorError("INVALID_PAYLOAD", "Thinking level is not supported by the profile model");
		const budget = this.budget(model, selection.max_output_tokens);
		return {
			// Native models contain optional undefined properties; private storage accepts finite JSON only.
			model: JSON.parse(JSON.stringify(model)) as Model<Api>,
			...(selection.thinking_level !== undefined ? { thinkingLevel: selection.thinking_level } : {}),
			maxOutputTokens: budget.effective_max_tokens,
			...budget,
		};
	}

	async createRuntime(
		profileId = "default",
		role: ModelRole = "chat",
		snapshot?: Stored<ModelProfile>,
		frozen?: FrozenModelSelection,
	): Promise<RuntimeSelection & ModelBudget & { maxOutputTokens: number }> {
		const selection = await this.settings.createRuntime();
		if (frozen) {
			const expected = snapshot?.data[role];
			if (expected && (frozen.model.provider !== expected.provider || frozen.model.id !== expected.model))
				throw new ExecutorError("INVALID_PAYLOAD", "Frozen model descriptor does not match its profile");
			return { runtime: selection.runtime, ...frozen };
		}
		return { ...selection, ...(await this.resolve(selection.runtime, profileId, role, snapshot)) };
	}

	private catalogRecord<T>(kind: string, id: string, data: T): Stored<T> {
		const existing = this.store.get<T>(kind, id);
		return existing && JSON.stringify(existing.data) === JSON.stringify(data)
			? existing
			: this.store.put(kind, id, data, existing?.revision ?? null);
	}

	private async refreshCatalog(): Promise<void> {
		const catalog = await this.settings.view();
		const config = await this.settings.readConfig();
		this.store.transaction(() => {
			const providerIds = new Set<string>();
			const modelIds = new Set<string>();
			for (const provider of catalog.providers) {
				providerIds.add(provider.id);
				const configured = config.providers[provider.id];
				this.catalogRecord<ProviderData>("model_provider", provider.id, {
					name: configured?.name ?? provider.name,
					custom: Boolean(configured && !builtinProviderIds.has(provider.id)),
					base_url: customBaseUrl(configured?.baseUrl ?? "") ?? null,
					api: configured?.api ?? this.settings.getCatalogRuntime().getModels(provider.id)[0]?.api ?? null,
					api_key: provider.api_key,
					oauth: provider.oauth,
					auth: provider.auth,
				});
				for (const model of provider.models) {
					const id = createHash("sha256")
						.update(JSON.stringify([provider.id, model.id]))
						.digest("hex");
					modelIds.add(id);
					this.catalogRecord<ModelData>("model_catalog", id, { provider: provider.id, ...model });
				}
			}
			// A custom provider may be configured before its first model is added.
			for (const [id, provider] of Object.entries(config.providers)) {
				if (providerIds.has(id)) continue;
				providerIds.add(id);
				this.catalogRecord<ProviderData>("model_provider", id, {
					name: provider.name ?? id,
					custom: true,
					base_url: customBaseUrl(provider.baseUrl ?? "") ?? null,
					api: provider.api ?? null,
					api_key: true,
					oauth: Boolean(provider.oauth),
					auth: { configured: Boolean(provider.apiKey), source: provider.apiKey ? "config" : null },
				});
			}
			for (const item of this.store.all("model_provider"))
				if (!providerIds.has(item.id)) this.store.remove("model_provider", item.id, item.revision);
			for (const item of this.store.all("model_catalog"))
				if (!modelIds.has(item.id)) this.store.remove("model_catalog", item.id, item.revision);
		});
	}

	async providers() {
		return this.enqueue(async () => {
			await this.refreshCatalog();
			return { items: this.store.all<ProviderData>("model_provider"), next_cursor: null };
		});
	}

	async models() {
		return this.enqueue(async () => {
			await this.refreshCatalog();
			return { items: this.store.all<ModelData>("model_catalog"), next_cursor: null };
		});
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.catch(() => undefined);
		return result;
	}

	saveProvider(id: string, value: unknown): Promise<Stored<ProviderData>> {
		return this.enqueue(async () => {
			if (
				!Check(providerSchema, value) ||
				!/^[A-Za-z0-9_-]{1,100}$/.test(id) ||
				["__proto__", "prototype", "constructor"].includes(id)
			)
				throw new ExecutorError("INVALID_PAYLOAD", "Invalid provider configuration");
			await this.refreshCatalog();
			const previous = this.store.get<ProviderData>("model_provider", id);
			if ((previous?.revision ?? null) !== value.expected_revision)
				throw new ExecutorError("CONFIG_REVISION_MISMATCH", "Provider changed; refresh before saving", true);
			const config = await this.settings.readConfig();
			const { expected_revision: _revision, api_key, base_url, ...patch } = value;
			if (patch.headers) {
				// Header credentials supplied by management are literal, never Pi shell/env expressions.
				patch.headers = Object.fromEntries(
					Object.entries(patch.headers).map(([name, content]) => [
						name,
						content.replaceAll("$", () => "$$").replace(/^!/, "$!"),
					]),
				);
			}
			const baseUrl = base_url === undefined ? undefined : customBaseUrl(base_url);
			if (base_url !== undefined && !baseUrl)
				throw new ExecutorError(
					"INVALID_PAYLOAD",
					"Base URL must be HTTP(S), without credentials, query or fragment",
				);
			if (!previous && !baseUrl) throw new ExecutorError("INVALID_PAYLOAD", "A new provider requires a base URL");
			if (api_key !== undefined && previous && !previous.data.api_key)
				throw new ExecutorError("AUTH_UNSUPPORTED", "This provider requires its native authentication setup");
			const provider = {
				...(!previous ? { api: "openai-completions" } : {}),
				...config.providers[id],
				...patch,
				...(baseUrl ? { baseUrl } : {}),
			};
			// Explicit management credentials replace Pi config-level auth, not its command language.
			if (api_key !== undefined) delete provider.apiKey;
			const hasConfigPatch =
				Object.keys(patch).length > 0 || baseUrl !== undefined || Object.hasOwn(config.providers, id);
			await this.settings.saveConfig(
				{ ...config, providers: hasConfigPatch ? { ...config.providers, [id]: provider } : config.providers },
				id,
				api_key,
			);
			await this.refreshCatalog();
			const current = this.store.require<ProviderData>("model_provider", id);
			return current.revision === previous?.revision
				? this.store.put("model_provider", id, current.data, current.revision)
				: current;
		});
	}

	saveModel(provider: string, id: string, value: unknown): Promise<Stored<ModelData>> {
		return this.enqueue(async () => {
			if (
				!Check(modelSchema, value) ||
				!id ||
				id.length > 500 ||
				["__proto__", "prototype", "constructor"].includes(provider)
			)
				throw new ExecutorError("INVALID_PAYLOAD", "Invalid model configuration");
			await this.refreshCatalog();
			this.store.require<ProviderData>("model_provider", provider);
			const key = createHash("sha256")
				.update(JSON.stringify([provider, id]))
				.digest("hex");
			const previous = this.store.get<ModelData>("model_catalog", key);
			if ((previous?.revision ?? null) !== value.expected_revision)
				throw new ExecutorError("CONFIG_REVISION_MISMATCH", "Model changed; refresh before saving", true);
			const config = await this.settings.readConfig();
			const providerConfig: ModelsJsonProvider = config.providers[provider] ?? {};
			const existing = providerConfig.models?.find((model) => model.id === id);
			const { expected_revision: _revision, context_window, max_tokens, base_url, ...patch } = value;
			if (patch.headers) {
				patch.headers = Object.fromEntries(
					Object.entries(patch.headers).map(([name, content]) => [
						name,
						content.replaceAll("$", () => "$$").replace(/^!/, "$!"),
					]),
				);
			}
			const baseUrl = base_url === undefined ? undefined : customBaseUrl(base_url);
			if (base_url !== undefined && !baseUrl) throw new ExecutorError("INVALID_PAYLOAD", "Invalid model base URL");
			const contextWindow = context_window ?? existing?.contextWindow ?? previous?.data.context_window ?? 131072;
			const maxTokens = max_tokens ?? existing?.maxTokens ?? previous?.data.max_tokens ?? 8192;
			if (maxTokens >= contextWindow)
				throw new ExecutorError("INVALID_PAYLOAD", "Maximum output must be smaller than the context window");
			// Native edits use overrides so unmentioned native cost, thinking and compatibility survive.
			let updatedProvider: unknown;
			if (previous && !existing && patch.api === undefined && baseUrl === undefined) {
				updatedProvider = {
					...providerConfig,
					modelOverrides: {
						...providerConfig.modelOverrides,
						[id]: { ...providerConfig.modelOverrides?.[id], ...patch, contextWindow, maxTokens },
					},
				};
			} else {
				const native = this.settings.getCatalogRuntime().getModel(provider, id);
				const definition = {
					...(native
						? {
								name: native.name,
								reasoning: native.reasoning,
								input: native.input,
								cost: native.cost,
								thinkingLevelMap: native.thinkingLevelMap,
								inputLimits: native.inputLimits,
								promptCache: native.promptCache,
								samplingParams: native.samplingParams,
								samplingParamsByThinkingLevel: native.samplingParamsByThinkingLevel,
								compat: native.compat,
							}
						: {}),
					...existing,
					id,
					contextWindow,
					maxTokens,
					...patch,
					...(baseUrl ? { baseUrl } : {}),
				};
				const models = [...(providerConfig.models ?? []).filter((model) => model.id !== id), definition];
				const overrides = providerConfig.modelOverrides?.[id];
				updatedProvider = {
					...providerConfig,
					models,
					...(overrides
						? {
								modelOverrides: {
									...providerConfig.modelOverrides,
									[id]: { ...overrides, ...patch, contextWindow, maxTokens },
								},
							}
						: {}),
				};
			}
			await this.settings.saveConfig({ ...config, providers: { ...config.providers, [provider]: updatedProvider } });
			await this.refreshCatalog();
			const current = this.store.require<ModelData>("model_catalog", key);
			return current.revision === previous?.revision
				? this.store.put("model_catalog", key, current.data, current.revision)
				: current;
		});
	}

	deleteProvider(id: string, revision: number): Promise<void> {
		return this.enqueue(async () => {
			await this.refreshCatalog();
			const previous = this.store.require<ProviderData>("model_provider", id);
			if (previous.revision !== revision)
				throw new ExecutorError("CONFIG_REVISION_MISMATCH", "Provider changed", true);
			if (!previous.data.custom) throw new ExecutorError("PROVIDER_CONFLICT", "Native providers cannot be deleted");
			this.assertUnused(id);
			const config = await this.settings.readConfig();
			delete config.providers[id];
			await this.settings.saveConfig(config, id, undefined, true);
			await this.refreshCatalog();
		});
	}

	deleteModel(provider: string, id: string, revision: number): Promise<void> {
		return this.enqueue(async () => {
			await this.refreshCatalog();
			const key = createHash("sha256")
				.update(JSON.stringify([provider, id]))
				.digest("hex");
			const previous = this.store.require<ModelData>("model_catalog", key);
			if (previous.revision !== revision) throw new ExecutorError("CONFIG_REVISION_MISMATCH", "Model changed", true);
			this.assertUnused(provider, id);
			const config = await this.settings.readConfig();
			const entry = config.providers[provider];
			if (
				!entry?.models?.some((model) => model.id === id) ||
				!this.store.require<ProviderData>("model_provider", provider).data.custom
			)
				throw new ExecutorError("MODEL_CONFLICT", "Only configured custom models can be deleted");
			entry.models = entry.models.filter((model) => model.id !== id);
			if (entry.modelOverrides) delete entry.modelOverrides[id];
			await this.settings.saveConfig(config);
			await this.refreshCatalog();
		});
	}

	private assertUnused(provider: string, model?: string): void {
		this.syncDefault();
		for (const profile of this.store.all<ModelProfile>("model_profile")) {
			if (
				roles.some(
					(role) =>
						profile.data[role].provider === provider &&
						(model === undefined || profile.data[role].model === model),
				)
			)
				throw new ExecutorError("CONFIG_IN_USE", "A model profile references this provider or model");
		}
	}

	async test(value: unknown, signal?: AbortSignal) {
		return this.settings.test(value, signal);
	}
}
