import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { envApiKeyAuth } from "../../ai/src/auth/helpers.ts";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { ModelRuntime } from "../../coding-agent/src/core/model-runtime.ts";
import { resolveConfigValue } from "../../coding-agent/src/core/resolve-config-value.ts";
import { ApiStore } from "../src/api-store.ts";
import { LifeModelClient } from "../src/companion-life-model.ts";
import { ProportionalContextPolicy } from "../src/context-policy.ts";
import { ModelProfiles } from "../src/model-profiles.ts";
import { ModelSettings } from "../src/model-settings.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(savedModel?: string) {
	const directory = await mkdtemp(join(tmpdir(), "dw-profiles-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	if (savedModel)
		await writeFile(
			join(directory, "runtime-model.json"),
			JSON.stringify({
				version: 1,
				provider: "profile-faux",
				model: savedModel,
				revision: 7,
				thinking_level: "low",
			}),
		);
	const faux = fauxProvider({
		provider: "profile-faux",
		models: [
			{ id: "alpha", contextWindow: 500000, maxTokens: 150000, reasoning: true },
			{ id: "beta", contextWindow: 400000, maxTokens: 80000, reasoning: true },
			{ id: "plain", contextWindow: 32768, maxTokens: 4096, reasoning: false },
		],
	});
	const factory = async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.create(join(directory, "auth.json")),
			modelsPath: join(directory, "models.json"),
			refreshOnCreate: false,
		});
		// Native registration starts a refresh without returning its promise. Join that exact
		// operation before the fixture owns this runtime; getAvailable is a separate pass.
		const refresh = vi.spyOn(runtime, "refresh");
		try {
			runtime.registerNativeProvider({ ...faux.provider, auth: { apiKey: envApiKeyAuth("Test key", []) } });
			const registration = refresh.mock.results[0];
			if (!registration || registration.type !== "return")
				throw new Error("Native provider registration did not start its refresh");
			await registration.value;
		} finally {
			refresh.mockRestore();
		}
		await runtime.getAvailable();
		return { runtime, model: runtime.getModel("profile-faux", "alpha")! };
	};
	const settings = new ModelSettings(
		directory,
		directory,
		{ provider: "profile-faux", model: "alpha", maxOutputTokens: 120000 },
		factory,
	);
	await settings.initialize();
	const store = new ApiStore(join(directory, "api.sqlite"));
	cleanups.push(() => store.close());
	const profiles = new ModelProfiles(store, settings);
	await profiles.initialize();
	return { directory, settings, store, profiles, faux, factory };
}

describe("independent model profiles", () => {
	it("migrates saved global selection, follows legacy updates until explicitly edited, and persists the cutover", async () => {
		const f = await setup("beta");
		const initial = f.profiles.get("default");
		for (const role of ["chat", "agent", "life"] as const)
			expect(initial.data[role]).toMatchObject({
				provider: "profile-faux",
				model: "beta",
				thinking_level: "low",
				max_output_tokens: 120000,
				declared_max_tokens: 80000,
				effective_max_tokens: 80000,
			});
		await f.settings.update({ provider: "profile-faux", model: "alpha", revision: 7, thinking_level: "high" });
		const followed = f.profiles.get("default");
		expect(followed.data.chat.model).toBe("alpha");
		const edited = f.profiles.update("default", {
			expected_revision: followed.revision,
			life: { model: "plain", thinking_level: null },
		});
		await f.settings.update({ provider: "profile-faux", model: "beta", revision: 8 });
		expect(f.profiles.get("default").data.chat.model).toBe("alpha");
		expect(f.profiles.get("default").data.life.model).toBe("plain");
		const reopened = new ModelSettings(f.directory, f.directory, {}, f.factory);
		await reopened.initialize();
		const restored = new ModelProfiles(f.store, reopened);
		await restored.initialize();
		expect(restored.get("default").revision).toBe(edited.revision);
		expect(restored.get("default").data.life).not.toHaveProperty("thinking_level");
		expect(f.faux.state.callCount).toBe(0);
	});

	it("resolves independent role choices and budgets above 65536 without changing another profile", async () => {
		const f = await setup();
		const profile = f.profiles.create({
			id: "independent",
			name: "Independent",
			chat: { model: "alpha", max_output_tokens: 100000 },
			agent: { model: "beta", max_output_tokens: 110000, thinking_level: "high" },
			life: { model: "plain", max_output_tokens: 2048 },
		});
		const chat = await f.profiles.createRuntime(profile.id, "chat");
		const agent = await f.profiles.resolve(chat.runtime, profile.id, "agent");
		const life = await f.profiles.resolve(chat.runtime, profile.id, "life");
		expect(chat).toMatchObject({
			model: { id: "alpha" },
			maxOutputTokens: 100000,
			declared_max_tokens: 150000,
			configured_max_tokens: 100000,
			effective_max_tokens: 100000,
		});
		expect(agent).toMatchObject({
			model: { id: "beta" },
			thinkingLevel: "high",
			maxOutputTokens: 80000,
			configured_max_tokens: 110000,
		});
		expect(life).toMatchObject({ model: { id: "plain" }, maxOutputTokens: 2048 });
		expect(f.profiles.get("default").data.agent.model).toBe("alpha");
	});

	it("rejects unsafe budgets, unsupported thinking, stale revisions and referenced deletions", async () => {
		const f = await setup();
		for (const max_output_tokens of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
			expect(() => f.profiles.create({ chat: { max_output_tokens } })).toThrowError();
		expect(() => f.profiles.create({ life: { model: "plain", thinking_level: "high" } })).toThrowError();
		const created = f.profiles.create({ id: "referenced" });
		const updated = f.profiles.update(created.id, {
			expected_revision: created.revision,
			chat: { max_output_tokens: 90000 },
		});
		expect(() =>
			f.profiles.update(created.id, { expected_revision: created.revision, name: "Stale" }),
		).toThrowError();
		f.store.put("session", "uses-profile", { model_profile_id: created.id }, null);
		expect(() => f.profiles.remove(created.id, updated.revision)).toThrowError();
		f.store.remove("session", "uses-profile", 1);
		f.profiles.remove(created.id, updated.revision);
		expect(() => f.profiles.get(created.id)).toThrowError();
		expect(() => f.profiles.remove("default", f.profiles.get("default").revision)).toThrowError();
	});

	it("freezes private model descriptors and budgets across profile and native model edits", async () => {
		const f = await setup();
		const profile = f.profiles.create({ id: "frozen", agent: { max_output_tokens: 100000, thinking_level: "low" } });
		const frozen = f.profiles.capture(profile.id, "agent");
		f.store.put("runtime_model_snapshot", "task-one", frozen, null);
		f.profiles.update(profile.id, {
			expected_revision: profile.revision,
			agent: { model: "beta", max_output_tokens: 2000, thinking_level: "high" },
		});
		const model = (await f.profiles.models()).items.find(
			(entry) => entry.data.provider === "profile-faux" && entry.data.id === "alpha",
		)!;
		await f.profiles.saveModel("profile-faux", "alpha", { expected_revision: model.revision, max_tokens: 90000 });
		const selection = await f.profiles.createRuntime(profile.id, "agent", profile, frozen);
		expect(selection).toMatchObject({
			model: { id: "alpha", maxTokens: 150000 },
			thinkingLevel: "low",
			maxOutputTokens: 100000,
		});
		expect(frozen.model.headers).toBeUndefined();
		await writeFile(
			join(f.directory, "runtime-model.json"),
			JSON.stringify({ version: 1, provider: "removed", model: "missing", revision: 2 }),
		);
		const restartedSettings = new ModelSettings(f.directory, f.directory, {}, f.factory);
		await restartedSettings.initialize();
		const restartedProfiles = new ModelProfiles(f.store, restartedSettings);
		await restartedProfiles.initialize();
		expect(restartedProfiles.get("default").data.chat.available).toBe(false);
		const resumed = await restartedProfiles.createRuntime(profile.id, "agent", profile, frozen);
		expect(resumed).toMatchObject({
			model: { id: "alpha", maxTokens: 150000 },
			thinkingLevel: "low",
			maxOutputTokens: 100000,
		});
	});

	it("creates real Pi providers/models, preserves unknown config and native options, and never returns literal credentials", async () => {
		const f = await setup();
		await writeFile(
			join(f.directory, "models.json"),
			JSON.stringify({
				future: { untouched: true },
				providers: {
					openai: {
						modelOverrides: { "gpt-4.1": { name: "Keep me", futureModel: true } },
						futureProvider: { keep: 1 },
					},
				},
			}),
		);
		const key = "!literal$DO_NOT_EXPAND";
		const provider = await f.profiles.saveProvider("custom-local", {
			expected_revision: null,
			base_url: "http://127.0.0.1:8912/v1",
			api_key: key,
			headers: { "X-Literal": key },
		});
		const added = await f.profiles.saveModel("custom-local", "model/with:a-long-id", {
			expected_revision: null,
			context_window: 2000000,
			max_tokens: 1000000,
			reasoning: true,
			input: ["text", "image"],
			samplingParams: { temperature: 0.7 },
			headers: { "X-Model-Literal": key },
		});
		expect(added.data).toMatchObject({
			provider: "custom-local",
			id: "model/with:a-long-id",
			max_tokens: 1000000,
			context_window: 2000000,
		});
		expect(added.id).toMatch(/^[a-f0-9]{64}$/);
		const edited = await f.profiles.saveModel("custom-local", added.data.id, {
			expected_revision: added.revision,
			name: "Edited",
		});
		expect(edited.data).toMatchObject({
			name: "Edited",
			max_tokens: 1000000,
			reasoning: true,
			input: ["text", "image"],
		});
		const config: unknown = JSON.parse(await readFile(join(f.directory, "models.json"), "utf8"));
		expect(config).toMatchObject({
			future: { untouched: true },
			providers: {
				openai: { futureProvider: { keep: 1 }, modelOverrides: { "gpt-4.1": { futureModel: true } } },
				"custom-local": { models: [{ samplingParams: { temperature: 0.7 } }] },
			},
		});
		const pi = await f.settings.readConfig();
		expect(resolveConfigValue(pi.providers["custom-local"].headers!["X-Literal"])).toBe(key);
		expect(resolveConfigValue(pi.providers["custom-local"].models![0].headers!["X-Model-Literal"])).toBe(key);
		expect(await AuthStorage.create(join(f.directory, "auth.json")).read("custom-local")).toMatchObject({ key });
		expect(JSON.stringify(await f.profiles.providers())).not.toContain(key);
		expect(JSON.stringify(await f.profiles.models())).not.toContain(key);
		await expect(
			f.profiles.saveProvider("custom-local", { expected_revision: null, api_key: "must-not-save" }),
		).rejects.toMatchObject({ code: "CONFIG_REVISION_MISMATCH" });
		await f.profiles.deleteModel("custom-local", edited.data.id, edited.revision);
		const currentProvider = (await f.profiles.providers()).items.find((entry) => entry.id === provider.id)!;
		await f.profiles.deleteProvider(provider.id, currentProvider.revision);
		expect((await f.profiles.providers()).items.some((entry) => entry.id === provider.id)).toBe(false);
		expect(await AuthStorage.create(join(f.directory, "auth.json")).read("custom-local")).toBeUndefined();
	});

	it("keeps previously valid underscore-prefixed custom providers selectable and editable", async () => {
		const f = await setup();
		await f.settings.update({
			provider: "_legacy",
			model: "saved",
			revision: 0,
			custom: { base_url: "http://127.0.0.1:8913/v1", context_window: 1000000, max_tokens: 100000 },
		});
		expect(f.profiles.get("default").data.chat).toMatchObject({ provider: "_legacy", model: "saved" });
		const provider = (await f.profiles.providers()).items.find((entry) => entry.id === "_legacy")!;
		const edited = await f.profiles.saveProvider(provider.id, {
			expected_revision: provider.revision,
			name: "Existing provider",
		});
		expect(edited.data.name).toBe("Existing provider");
		expect(f.profiles.get("default").data.chat.provider).toBe("_legacy");
	});

	it("uses the life role on a separate native runtime, with its configured thinking and effective budget", async () => {
		const f = await setup();
		await f.settings.update({ provider: "profile-faux", model: "alpha", revision: 0, api_key: "test-key" });
		f.profiles.create({ id: "background", life: { model: "beta", thinking_level: "low", max_output_tokens: 1234 } });
		const life = new LifeModelClient(f.settings, new ProportionalContextPolicy());
		life.setProfiles(f.profiles, "background");
		cleanups.push(() => life.close());
		let calls = 0;
		f.faux.setResponses([
			(_context, options, _state, model) => {
				expect(model.id).toBe("beta");
				expect(options).toMatchObject({ maxTokens: 1234, reasoning: "low", maxRetries: 0 });
				return fauxAssistantMessage("life output");
			},
			(_context, options, _state, model) => {
				expect(model.id).toBe("plain");
				expect(options?.maxTokens).toBe(1234);
				expect(options?.reasoning).toBeUndefined();
				return fauxAssistantMessage("explicit override");
			},
		]);
		const result = await life.complete({
			task: "daily_plan",
			scope: { persona_id: "default", user_id: "local" },
			persona: { id: "default", revision: "one", system_prompt: "Persona" },
			system: "System",
			prompt: "Plan",
			max_tokens: 4000,
			model: null,
			signal: new AbortController().signal,
			on_request: () => {
				calls++;
			},
		});
		expect(result).toMatchObject({ text: "life output", model: "beta" });
		expect(calls).toBe(1);
		const overridden = await life.complete({
			task: "daily_plan",
			scope: { persona_id: "default", user_id: "local" },
			persona: { id: "default", revision: "one", system_prompt: "Persona" },
			system: "System",
			prompt: "Plan",
			max_tokens: 4000,
			model: { provider: "profile-faux", model: "plain" },
			signal: new AbortController().signal,
			on_request: () => {
				calls++;
			},
		});
		expect(overridden).toMatchObject({ text: "explicit override", model: "plain" });
		expect(calls).toBe(2);
		expect(f.profiles.get("default").data.chat.model).toBe("alpha");
	});
});
