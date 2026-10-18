import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { envApiKeyAuth } from "../../ai/src/auth/helpers.ts";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { ModelRuntime } from "../../coding-agent/src/core/model-runtime.ts";
import { ExecutorError, errorPayload } from "../src/errors.ts";
import { ModelSettings } from "../src/model-settings.ts";
import { testModel } from "../src/model-test.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "dw-model-probe-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const authPath = join(directory, "auth.json");
	const credentials = AuthStorage.create(authPath);
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({
		provider: "probe-faux",
		models: [
			{ id: "plain", reasoning: false },
			{ id: "reasoner", reasoning: true },
		],
	});
	runtime.registerNativeProvider({ ...faux.provider, auth: { apiKey: envApiKeyAuth("Probe key", []) } });
	await runtime.getAvailable();
	return { directory, authPath, credentials, runtime, faux };
}

const request = { provider: "probe-faux", model: "plain", api_key: "temporary-key" };

describe("explicit model availability probes", () => {
	it("uses native providers once with literal transient credentials and leaves selection and files unchanged", async () => {
		const f = await setup();
		const settings = new ModelSettings(f.directory, f.directory, {}, async () => ({
			runtime: f.runtime,
			model: f.runtime.getModel("probe-faux", "plain")!,
		}));
		await settings.initialize();
		await settings.update({ provider: "probe-faux", model: "plain", revision: 0, api_key: "saved-key" });
		const selection = (await settings.view()).selection;
		const authBefore = await readFile(f.authPath, "utf8");
		const savedBefore = await readFile(join(f.directory, "runtime-model.json"), "utf8");
		const filesBefore = await readdir(f.directory);
		expect(f.faux.state.callCount).toBe(0);
		const literal = "!literal$NOT_AN_ENV";
		f.faux.setResponses([
			(context, options, _state, model) => {
				expect(model.id).toBe("reasoner");
				expect(context.messages).toHaveLength(1);
				expect(options).toMatchObject({ apiKey: literal, reasoning: "medium", maxRetries: 0 });
				expect(options?.maxTokens).toBeGreaterThan(0);
				expect(options?.maxTokens).toBeLessThanOrEqual(model.maxTokens);
				return fauxAssistantMessage("OK");
			},
		]);
		const result = await testModel(f.runtime, { ...request, model: "reasoner", api_key: literal });
		expect(result).toMatchObject({
			available: true,
			provider: request.provider,
			model: "reasoner",
			thinking_level: "medium",
		});
		expect(JSON.stringify(result)).not.toContain(literal);
		expect(f.faux.state.callCount).toBe(1);
		expect((await settings.view()).selection).toEqual(selection);
		expect(await readFile(f.authPath, "utf8")).toBe(authBefore);
		expect(await readFile(join(f.directory, "runtime-model.json"), "utf8")).toBe(savedBefore);
		expect(await readdir(f.directory)).toEqual(filesBefore);
	});

	it("resolves saved credentials, clamps only the omitted default and never runs returned tools", async () => {
		const f = await setup();
		await f.credentials.modify(request.provider, async () => ({ type: "api_key", key: "saved-key" }));
		f.faux.setResponses([
			(_context, options) => {
				expect(options).toMatchObject({ apiKey: "saved-key", maxRetries: 0 });
				return fauxAssistantMessage(fauxToolCall("must-not-execute", {}), { stopReason: "toolUse" });
			},
		]);
		await expect(testModel(f.runtime, { provider: request.provider, model: request.model })).resolves.toMatchObject({
			available: true,
			thinking_level: "off",
		});
		expect(f.faux.state.callCount).toBe(1);
		expect(f.faux.state.deferredFetchCount).toBe(0);
	});

	it("rejects malformed requests, unsupported levels, unknown and virtual models without inference", async () => {
		const f = await setup();
		for (const value of [
			null,
			{},
			{ ...request, provider: "" },
			{ ...request, model: "x".repeat(501) },
			{ ...request, thinking_level: "invalid" },
			{ ...request, custom: {} },
			...["", "has space", "new\nline", "tab\tkey", "bad\u007f", "x".repeat(8193)].map((api_key) => ({
				...request,
				api_key,
			})),
		])
			await expect(testModel(f.runtime, value)).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
		for (const value of [
			{ ...request, provider: "missing" },
			{ ...request, model: "missing" },
		])
			await expect(testModel(f.runtime, value)).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
		for (const value of [
			{ ...request, thinking_level: "high" },
			{ ...request, model: "reasoner", thinking_level: "xhigh" },
		])
			await expect(testModel(f.runtime, value)).rejects.toMatchObject({ code: "THINKING_LEVEL_UNSUPPORTED" });
		f.runtime.registerVirtualModel({
			provider: request.provider,
			id: "virtual",
			name: "Virtual",
			route: () => ({ model: f.runtime.getModel(request.provider, request.model)!, thinkingLevel: "off" }),
		});
		await expect(testModel(f.runtime, { ...request, model: "virtual" })).rejects.toMatchObject({
			code: "MODEL_UNAVAILABLE",
		});
		expect(f.faux.state.callCount).toBe(0);
	});

	it("distinguishes missing credentials and unsupported API-key overrides", async () => {
		const f = await setup();
		await expect(testModel(f.runtime, { provider: request.provider, model: request.model })).rejects.toMatchObject({
			code: "MODEL_AUTH_REQUIRED",
		});
		f.runtime.registerNativeProvider({ ...f.faux.provider, auth: {} });
		await expect(testModel(f.runtime, request)).rejects.toMatchObject({ code: "AUTH_UNSUPPORTED" });
		expect(f.faux.state.callCount).toBe(0);
	});

	it("sanitizes native authentication failures before any inference", async () => {
		const f = await setup();
		f.runtime.registerNativeProvider({
			...f.faux.provider,
			auth: {
				apiKey: {
					name: "Broken auth",
					resolve: async () => {
						throw new Error("temporary-key Authorization private-auth-body");
					},
				},
			},
		});
		const error = await testModel(f.runtime, request).catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "MODEL_TEST_FAILED" });
		expect(JSON.stringify(errorPayload(error))).not.toMatch(/temporary-key|Authorization|private-auth-body/);
		expect(f.faux.state.callCount).toBe(0);
	});

	it.each(["error", "aborted"] as const)(
		"does not mark native %s results available or reveal their bodies",
		async (stopReason) => {
			const f = await setup();
			f.faux.setResponses([
				fauxAssistantMessage("", { stopReason, errorMessage: "Authorization: Bearer temporary-key private-body" }),
			]);
			const error = await testModel(f.runtime, request).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(ExecutorError);
			expect(error).toMatchObject({ code: stopReason === "error" ? "MODEL_TEST_FAILED" : "MODEL_TEST_ABORTED" });
			expect(JSON.stringify(errorPayload(error))).not.toMatch(/temporary-key|Authorization|private-body/);
			expect(f.faux.state.callCount).toBe(1);
		},
	);

	it.each(["timeout", "cancel"] as const)(
		"cancels a native pending request on %s without waiting for the provider",
		async (mode) => {
			const f = await setup();
			vi.useFakeTimers();
			let release!: () => void;
			let started!: () => void;
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			const entered = new Promise<void>((resolve) => {
				started = resolve;
			});
			let nativeSignal: AbortSignal | undefined;
			f.faux.setResponses([
				async (_context, options) => {
					nativeSignal = options?.signal;
					started();
					await pending;
					return fauxAssistantMessage("OK");
				},
			]);
			const controller = new AbortController();
			const result = testModel(f.runtime, request, controller.signal).catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(0);
			await entered;
			if (mode === "timeout") await vi.advanceTimersByTimeAsync(20_000);
			else controller.abort(new Error("secret-abort-reason"));
			try {
				const error = await result;
				expect(error).toMatchObject({ code: mode === "timeout" ? "MODEL_TEST_TIMEOUT" : "MODEL_TEST_ABORTED" });
				expect(JSON.stringify(errorPayload(error))).not.toContain("secret-abort-reason");
				expect(nativeSignal?.aborted).toBe(true);
				expect(f.faux.state.callCount).toBe(1);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				release();
				await vi.advanceTimersByTimeAsync(0);
			}
		},
	);

	it("does not start native inference for an already cancelled request", async () => {
		const f = await setup();
		const controller = new AbortController();
		controller.abort("secret");
		await expect(testModel(f.runtime, request, controller.signal)).rejects.toMatchObject({
			code: "MODEL_TEST_ABORTED",
		});
		expect(f.faux.state.callCount).toBe(0);
	});

	it("sends one real native HTTP request, records token usage and never retries a throttled response", async () => {
		const f = await setup();
		const requests: { path?: string; authorization?: string; body: Record<string, unknown> }[] = [];
		let throttle = false;
		const server = createServer(async (incoming, outgoing) => {
			let body = "";
			for await (const chunk of incoming) body += String(chunk);
			requests.push({ path: incoming.url, authorization: incoming.headers.authorization, body: JSON.parse(body) });
			if (throttle) {
				outgoing.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0" });
				outgoing.end(JSON.stringify({ error: { message: "temporary-key Authorization private-provider-body" } }));
				return;
			}
			outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
			for (const part of [
				{ choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
				{
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
				},
			])
				outgoing.write(
					`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 1, model: "native", ...part })}\n\n`,
				);
			outgoing.end("data: [DONE]\n\n");
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		cleanups.push(
			() =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
					server.closeAllConnections();
				}),
		);
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing local API address");
		const modelsPath = join(f.directory, "models.json");
		const config = JSON.stringify({
			providers: {
				"probe-http": {
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${address.port}/v1`,
					models: [
						{
							id: "native",
							name: "Native",
							reasoning: true,
							input: ["text"],
							contextWindow: 32768,
							maxTokens: 4096,
						},
					],
				},
			},
		});
		await writeFile(modelsPath, config);
		const runtime = await ModelRuntime.create({ credentials: f.credentials, modelsPath, allowModelNetwork: false });
		const input = { provider: "probe-http", model: "native", thinking_level: "high", api_key: "temporary-key" };
		expect(requests).toHaveLength(0);
		await expect(testModel(runtime, input)).resolves.toMatchObject({
			available: true,
			thinking_level: "high",
			usage: { input_tokens: 7, output_tokens: 1 },
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer temporary-key" });
		expect(requests[0].body).toMatchObject({ model: "native", reasoning_effort: "high", stream: true });
		expect(requests[0].body.tools).toBeUndefined();
		expect(requests[0].body.max_tokens ?? requests[0].body.max_completion_tokens).toBe(1024);
		throttle = true;
		const error = await testModel(runtime, input).catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "MODEL_TEST_FAILED" });
		expect(JSON.stringify(errorPayload(error))).not.toMatch(/temporary-key|Authorization|private-provider-body/);
		expect(requests).toHaveLength(2);
		expect(await f.credentials.read("probe-http")).toBeUndefined();
		expect(await readFile(modelsPath, "utf8")).toBe(config);
	});
});
