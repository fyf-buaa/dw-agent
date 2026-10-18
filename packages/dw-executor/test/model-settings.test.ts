import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { envApiKeyAuth } from "../../ai/src/auth/helpers.ts";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { ModelRuntime } from "../../coding-agent/src/core/model-runtime.ts";
import { ExecutorService } from "../src/service.ts";
import { deferred, fixture, tagged } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
	const base = await fixture();
	cleanups.push(base.cleanup);
	await base.service.close();
	const faux = fauxProvider({
		provider: "config-test",
		models: [
			{ id: "alpha", contextWindow: 131072, maxTokens: 8192, reasoning: true },
			{ id: "beta", contextWindow: 65536, maxTokens: 4096, reasoning: true },
			{ id: "plain", reasoning: false },
		],
	});
	const agentDir = join(base.directory, "pi");
	const options = {
		...base.settings,
		agentDir,
		runtimeFactory: async () => {
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.create(join(agentDir, "auth.json")),
				modelsPath: null,
				refreshOnCreate: false,
			});
			runtime.registerNativeProvider({ ...faux.provider, auth: { apiKey: envApiKeyAuth("Test key", []) } });
			await runtime.getAvailable();
			return { runtime, model: runtime.getModel("config-test", "alpha")! };
		},
	};
	const service = new ExecutorService(options);
	await service.initialize();
	cleanups.push(() => service.close());
	const save = (model: string, revision = 0, key?: string, thinkingLevel?: ModelThinkingLevel) =>
		service.updateModelSettings({
			provider: "config-test",
			model,
			revision,
			...(key ? { api_key: key } : {}),
			...(thinkingLevel !== undefined ? { thinking_level: thinkingLevel } : {}),
		});
	const open = async (mode = "chat") => {
		const [opened] = await service.handle(
			"client",
			base.command("session.open", { cwd: base.directory, persona_id: "default", mode }),
		);
		return service.getSession(opened.session_id!);
	};
	return { ...base, service, options, faux, save, open };
}

describe("runtime model settings", () => {
	it("uses Pi catalogs, stores literal credentials without exposing them and rejects stale or invalid updates", async () => {
		const f = await setup();
		const original = await f.service.getModelSettings();
		expect(original.providers.some((provider) => provider.id === "openai" && provider.models.length > 0)).toBe(true);
		expect(original.providers.find((provider) => provider.id === "config-test")?.auth.configured).toBe(false);
		const key = "!literal$NOT_AN_ENV";
		const saved = await f.save("beta", 0, key);
		expect(saved.selection).toMatchObject({ provider: "config-test", model: "beta", revision: 1, source: "saved" });
		expect(saved.providers.find((provider) => provider.id === "config-test")?.auth.configured).toBe(true);
		expect(JSON.stringify(saved)).not.toContain(key);
		expect(await AuthStorage.create(join(f.directory, "pi", "auth.json")).read("config-test")).toMatchObject({ key });
		expect(await readFile(join(f.directory, "runtime-model.json"), "utf8")).not.toContain("api_key");
		await expect(f.save("alpha", 0)).rejects.toMatchObject({ code: "CONFIG_REVISION_MISMATCH" });
		await expect(f.save("missing", 1, "should-not-be-saved")).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
		expect(await AuthStorage.create(join(f.directory, "pi", "auth.json")).read("config-test")).toMatchObject({ key });
		expect(f.faux.state.callCount).toBe(0);
	});

	it("lists native thinking levels and rejects unsupported levels without saving credentials or invoking a provider", async () => {
		const f = await setup();
		const catalog = await f.service.getModelSettings();
		expect(catalog.selection).not.toHaveProperty("thinking_level");
		const models = catalog.providers.find((provider) => provider.id === "config-test")!.models;
		expect(models.find((model) => model.id === "alpha")?.thinking_levels).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
		]);
		expect(models.find((model) => model.id === "plain")?.thinking_levels).toEqual(["off"]);
		for (const [model, thinking_level] of [
			["plain", "high"],
			["alpha", "xhigh"],
			["alpha", "max"],
			["alpha", "unknown"],
		])
			await expect(
				f.service.updateModelSettings({
					provider: "config-test",
					model,
					revision: 0,
					thinking_level,
					api_key: "must-not-save",
				}),
			).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
		expect(await AuthStorage.create(join(f.directory, "pi", "auth.json")).read("config-test")).toBeUndefined();
		await expect(readFile(join(f.directory, "runtime-model.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(f.faux.state.callCount).toBe(0);
		const saved = await f.save("plain", 0, "test-key", "off");
		expect(saved.selection.thinking_level).toBe("off");
		expect(f.faux.state.callCount).toBe(0);
	});

	it("passes explicit thinking to provider options at execution boundaries, restores it, and clears back to Pi defaults", async () => {
		const f = await setup();
		await f.save("alpha", 0, "test-key", "low");
		const session = await f.open();
		expect(session.snapshot().thinking_level).toBe("low");
		f.faux.setResponses([
			(_context, options) => {
				expect(options?.reasoning).toBe("low");
				return fauxAssistantMessage(tagged("低强度"));
			},
			(_context, options) => {
				expect(options?.reasoning).toBe("high");
				return fauxAssistantMessage(tagged("高强度"));
			},
			(_context, options) => {
				expect(options?.reasoning).toBe("medium");
				return fauxAssistantMessage(tagged("默认强度"));
			},
		]);
		for (let index = 0; index < 2; index++) {
			if (index) {
				await f.save("alpha", 1, undefined, "high");
				expect(session.snapshot().thinking_level).toBe("low");
				expect(f.faux.state.callCount).toBe(1);
			}
			await f.service.handle(
				"client",
				f.command("input.submit", { text: `消息 ${index}` }, { session_id: session.id, mode_revision: 0 }),
			);
			await session.waitForIdle();
			expect(session.eventsAfter(0).at(-1)?.type).toBe("run.completed");
		}
		expect(session.snapshot().thinking_level).toBe("high");
		expect(JSON.parse(await readFile(join(f.directory, "runtime-model.json"), "utf8"))).toMatchObject({
			thinking_level: "high",
		});
		await f.service.close();
		const reopened = new ExecutorService(f.options);
		cleanups.push(() => reopened.close());
		await reopened.initialize();
		expect((await reopened.getModelSettings()).selection.thinking_level).toBe("high");
		const restored = reopened.getSession(session.id);
		expect(restored.snapshot().thinking_level).toBe("high");
		await reopened.updateModelSettings({ provider: "config-test", model: "alpha", revision: 2 });
		expect((await reopened.getModelSettings()).selection).not.toHaveProperty("thinking_level");
		expect(restored.snapshot().thinking_level).toBe("high");
		await reopened.handle(
			"client",
			f.command("input.submit", { text: "默认" }, { session_id: restored.id, mode_revision: 0 }),
		);
		await restored.waitForIdle();
		expect(restored.snapshot().thinking_level).toBe("medium");
		expect(f.faux.state.callCount).toBe(3);
		await expect(readFile(join(f.directory, "pi", "settings.json"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("applies changes to the next execution on the same session and restores the saved choice after restart", async () => {
		const f = await setup();
		await f.save("alpha", 0, "test-key");
		const session = await f.open();
		f.faux.setResponses([
			fauxAssistantMessage(tagged("第一轮")),
			(context) => {
				expect(JSON.stringify(context)).toContain("第一轮");
				expect(JSON.stringify(context)).toContain("PERSONA_SENTINEL");
				return fauxAssistantMessage(tagged("第二轮"));
			},
		]);
		await f.service.handle(
			"client",
			f.command("input.submit", { text: "第一次" }, { session_id: session.id, mode_revision: 0 }),
		);
		await session.waitForIdle();
		await f.save("beta", 1);
		expect(session.snapshot().model).toBe("alpha");
		await f.service.handle(
			"client",
			f.command("input.submit", { text: "第二次" }, { session_id: session.id, mode_revision: 0 }),
		);
		await session.waitForIdle();
		expect(session.snapshot().model).toBe("beta");
		expect(f.faux.state.callCount).toBe(2);
		await f.service.close();
		const reopened = new ExecutorService({ ...f.options, provider: "config-test", model: "alpha" });
		cleanups.push(() => reopened.close());
		await reopened.initialize();
		expect((await reopened.getModelSettings()).selection).toMatchObject({
			model: "beta",
			revision: 2,
			source: "saved",
		});
		expect(reopened.getSession(session.id).snapshot().persona_revision).toBe("test-1");
		expect(f.faux.state.callCount).toBe(2);
	});

	it("keeps an active agent loop on its original model while updating the project default", async () => {
		const f = await setup();
		await f.save("alpha", 0, "test-key", "low");
		const session = await f.open("agent");
		const started = deferred();
		const release = deferred();
		f.faux.setResponses([
			async (_context, options) => {
				expect(options?.reasoning).toBe("low");
				started.resolve();
				await release.promise;
				return fauxAssistantMessage(fauxToolCall("read", { path: "missing-test-file" }), { stopReason: "toolUse" });
			},
			(_context, options) => {
				expect(options?.reasoning).toBe("low");
				expect(session.snapshot()).toMatchObject({ model: "alpha", thinking_level: "low" });
				return fauxAssistantMessage(tagged("完成"));
			},
		]);
		await f.service.handle(
			"client",
			f.command("input.submit", { text: "检查" }, { session_id: session.id, mode_revision: 0 }),
		);
		await started.promise;
		try {
			await f.save("beta", 1, undefined, "high");
		} finally {
			release.resolve();
		}
		await session.waitForIdle();
		expect(session.snapshot()).toMatchObject({ model: "alpha", thinking_level: "low" });
		expect(f.faux.state.callCount).toBe(2);
	});

	it("keeps model configuration reachable when a saved catalog entry disappears and never returns unknown saved fields", async () => {
		const f = await setup();
		await f.service.close();
		await writeFile(
			join(f.directory, "runtime-model.json"),
			JSON.stringify({ version: 1, provider: "gone", model: "removed", revision: 4, api_key: "must-not-leak" }),
		);
		const reopened = new ExecutorService(f.options);
		cleanups.push(() => reopened.close());
		await reopened.initialize();
		expect(JSON.stringify(await reopened.getModelSettings())).not.toContain("must-not-leak");
		await reopened.updateModelSettings({ provider: "config-test", model: "beta", revision: 4 });
		expect((await reopened.getModelSettings()).selection.model).toBe("beta");
	});

	it("uses the new model when explicitly resuming a paused task without repeating a completed tool", async () => {
		const f = await setup();
		await f.service.close();
		const service = new ExecutorService({ ...f.options, maxModelCalls: 1 });
		cleanups.push(() => service.close());
		await service.initialize();
		await service.updateModelSettings({
			provider: "config-test",
			model: "alpha",
			revision: 0,
			api_key: "test-key",
			thinking_level: "low",
		});
		const [opened] = await service.handle(
			"client",
			f.command("session.open", { cwd: f.directory, persona_id: "default", mode: "agent" }),
		);
		const session = service.getSession(opened.session_id!);
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "missing-test-file" }, { id: "finished-once" }), {
				stopReason: "toolUse",
			}),
			(context, options) => {
				expect(options?.reasoning).toBe("high");
				expect(JSON.stringify(context)).toContain("finished-once");
				expect(JSON.stringify(context)).toContain("original-task");
				return fauxAssistantMessage(tagged("完成"));
			},
		]);
		const [accepted] = await service.handle(
			"client",
			f.command("input.submit", { text: "original-task" }, { session_id: session.id, mode_revision: 0 }),
		);
		await session.waitForIdle();
		expect(session.snapshot().paused_run_id).toBe(accepted.run_id);
		await service.updateModelSettings({
			provider: "config-test",
			model: "beta",
			revision: 1,
			thinking_level: "high",
		});
		await service.handle(
			"client",
			f.command("run.resume", {}, { session_id: session.id, run_id: accepted.run_id, mode_revision: 0 }),
		);
		await session.waitForIdle();
		expect(session.snapshot()).toMatchObject({ model: "beta", thinking_level: "high", paused_run_id: null });
		expect(session.eventsAfter(0).filter((event) => event.type === "tool.started")).toHaveLength(1);
		expect(f.faux.state.callCount).toBe(2);
	});
});
