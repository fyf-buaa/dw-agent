import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import type { Stored } from "../src/api-store.ts";
import { WebSocketGateway } from "../src/gateway.ts";
import { ExecutorService } from "../src/service.ts";
import { fixture, tagged } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
	const base = await fixture();
	cleanups.push(base.cleanup);
	await base.service.close();
	const options = { ...base.settings, runtimeFactory: undefined };
	const service = new ExecutorService(options);
	await service.initialize();
	cleanups.push(() => service.close());
	const save = (revision = 0, model = "local-model", baseUrl = "http://127.0.0.1:8000/v1", key?: string) =>
		service.updateModelSettings({
			provider: "my-local",
			model,
			revision,
			custom: { base_url: baseUrl, context_window: 65536, max_tokens: 4096 },
			...(key ? { api_key: key } : {}),
		});
	return { ...base, options, service, save, modelsPath: join(base.directory, "pi", "models.json") };
}

describe("custom OpenAI-compatible models", () => {
	it("adds and edits models without replacing other Pi configuration, preserves literal credentials and restores after restart", async () => {
		const f = await setup();
		await writeFile(
			f.modelsPath,
			'{\n// Existing Pi configuration\n"providers":{"openai":{"modelOverrides":{"gpt-4.1":{"name":"Keep me"}}}}}',
		);
		const saved = await f.service.updateModelSettings({
			provider: "my-local",
			model: "local-model",
			revision: 0,
			api_key: "!literal$NOT_AN_ENV",
			custom: {
				base_url: "http://127.0.0.1:8000/v1",
				context_window: 65536,
				max_tokens: 4096,
				reasoning: true,
				input: ["text", "image"],
			},
		});
		expect(saved.selection).toMatchObject({ provider: "my-local", model: "local-model", revision: 1 });
		expect(saved.providers.find((item) => item.id === "my-local")).toMatchObject({
			custom: true,
			base_url: "http://127.0.0.1:8000/v1",
			auth: { configured: true },
			models: [
				{
					id: "local-model",
					context_window: 65536,
					max_tokens: 4096,
					reasoning: true,
					input: ["text", "image"],
					thinking_levels: ["off", "minimal", "low", "medium", "high"],
				},
			],
		});
		expect(JSON.stringify(saved)).not.toContain("!literal");
		expect(await readFile(f.modelsPath, "utf8")).not.toContain("apiKey");
		expect(await AuthStorage.create(join(f.directory, "pi", "auth.json")).read("my-local")).toMatchObject({
			key: "!literal$NOT_AN_ENV",
		});
		await f.save(1, "second-model", "https://compatible.example/v1/");
		const edited = await f.save(2, "local-model", "https://compatible.example/v2");
		expect(
			edited.providers
				.find((item) => item.id === "my-local")
				?.models.map((model) => model.id)
				.sort(),
		).toEqual(["local-model", "second-model"]);
		expect(JSON.parse(await readFile(f.modelsPath, "utf8")).providers.openai.modelOverrides["gpt-4.1"].name).toBe(
			"Keep me",
		);
		await f.service.close();
		const reopened = new ExecutorService(f.options);
		cleanups.push(() => reopened.close());
		await reopened.initialize();
		const restored = await reopened.getModelSettings();
		expect(restored.selection).toMatchObject({ provider: "my-local", model: "local-model", revision: 3 });
		expect(restored.providers.find((item) => item.id === "my-local")).toMatchObject({
			base_url: "https://compatible.example/v2",
			auth: { configured: true },
		});
		expect(restored.providers.find((item) => item.id === "my-local")?.models).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "local-model", reasoning: true, input: ["text", "image"] }),
				expect.objectContaining({ id: "second-model", reasoning: false, input: ["text"] }),
			]),
		);
		expect(JSON.parse(await readFile(f.modelsPath, "utf8")).providers["my-local"].models).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "local-model", reasoning: true, input: ["text", "image"] }),
			]),
		);
	});

	it("preserves custom output limits above 65536 after restart", async () => {
		const f = await setup();
		await f.service.updateModelSettings({
			provider: "my-local",
			model: "large-output",
			revision: 0,
			custom: { base_url: "http://127.0.0.1:8000/v1", context_window: 2000000, max_tokens: 1000000 },
		});
		await f.service.close();
		const reopened = new ExecutorService(f.options);
		cleanups.push(() => reopened.close());
		await reopened.initialize();
		const restored = await reopened.getModelSettings();
		expect(restored.providers.find((item) => item.id === "my-local")?.models).toEqual([
			expect.objectContaining({ id: "large-output", context_window: 2000000, max_tokens: 1000000 }),
		]);
	});

	it("rejects invalid modalities and unsupported thinking before persisting custom models or credentials", async () => {
		const f = await setup();
		for (const custom of [
			{ input: [] },
			{ input: ["image"] },
			{ input: ["text", "text"] },
			{ input: ["text", "audio"] },
			{ reasoning: "true" },
		])
			await expect(
				f.service.updateModelSettings({
					provider: "my-local",
					model: "invalid",
					revision: 0,
					api_key: "must-not-save",
					custom: { base_url: "http://127.0.0.1:8000/v1", ...custom },
				}),
			).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
		for (const custom of [{ reasoning: false }, { reasoning: true }])
			await expect(
				f.service.updateModelSettings({
					provider: "my-local",
					model: "invalid",
					revision: 0,
					thinking_level: custom.reasoning ? "xhigh" : "high",
					api_key: "must-not-save",
					custom: { base_url: "http://127.0.0.1:8000/v1", ...custom },
				}),
			).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
		await expect(readFile(f.modelsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await AuthStorage.create(join(f.directory, "pi", "auth.json")).read("my-local")).toBeUndefined();
		expect((await f.service.getModelSettings()).selection.revision).toBe(0);
	});

	it("rejects native IDs, unsafe URLs, stale writes and invalid config before changing credentials", async () => {
		const f = await setup();
		await f.save(0, "local-model", undefined, "original-key");
		for (const baseUrl of [
			"file:///tmp/model",
			"https://user:secret@example.com/v1",
			"https://example.com/v1?key=secret",
			"https://example.com/#secret",
		])
			await expect(f.save(1, "local-model", baseUrl, "must-not-save")).rejects.toMatchObject({
				code: "INVALID_PAYLOAD",
			});
		for (const provider of ["openai", "constructor", "__proto__"])
			await expect(
				f.service.updateModelSettings({
					provider,
					model: "foo",
					revision: 1,
					api_key: "must-not-save",
					custom: { base_url: "https://example.com/v1" },
				}),
			).rejects.toMatchObject({ code: provider === "openai" ? "PROVIDER_CONFLICT" : "INVALID_PAYLOAD" });
		await expect(f.save(0)).rejects.toMatchObject({ code: "CONFIG_REVISION_MISMATCH" });
		const before = await readFile(f.modelsPath, "utf8");
		await expect(
			f.service.updateModelSettings({
				provider: "my-local",
				model: "foo",
				revision: 1,
				custom: { base_url: "https://example.com/v1", context_window: 4096, max_tokens: 8192 },
			}),
		).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
		expect(await readFile(f.modelsPath, "utf8")).toBe(before);
		await writeFile(f.modelsPath, '{"providers": "secret-invalid-config"}');
		await expect(f.save(1, "local-model", undefined, "must-not-save")).rejects.toMatchObject({
			code: "CONFIG_INVALID",
		});
		expect(await readFile(f.modelsPath, "utf8")).toContain("secret-invalid-config");
		expect(await AuthStorage.create(join(f.directory, "pi", "auth.json")).read("my-local")).toMatchObject({
			key: "original-key",
		});
	});

	it("uses the native OpenAI streaming API and reloads changed endpoints on the same session, with one call per chat", async () => {
		const f = await setup();
		const requests: { url: string; authorization: string | undefined; body: Record<string, unknown> }[] = [];
		const server = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			requests.push({
				url: request.url!,
				authorization: request.headers.authorization,
				body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
			});
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			for (const part of [
				{
					choices: [
						{ index: 0, delta: { role: "assistant", content: tagged("兼容接口回复") }, finish_reason: null },
					],
				},
				{
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
				},
			])
				response.write(
					`data: ${JSON.stringify({ id: "chatcmpl-local", object: "chat.completion.chunk", created: 1, model: "local-model", ...part })}\n\n`,
				);
			response.end("data: [DONE]\n\n");
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		cleanups.push(
			() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
		);
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing fake API address");
		const origin = `http://127.0.0.1:${address.port}`;
		const token = "custom-model-test-token";
		const gateway = new WebSocketGateway({ service: f.service, token, port: 0 });
		const socketUrl = await gateway.start();
		cleanups.push(() => gateway.close());
		const apiOrigin = new URL(socketUrl.replace("ws:", "http:")).origin;
		let requestId = 0;
		const request = (path: string, method = "GET", value?: unknown) =>
			fetch(`${apiOrigin}/api${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					"X-Request-Id": `custom-${++requestId}`,
					...(method === "POST" ? { "Idempotency-Key": `custom-${requestId}` } : {}),
				},
				...(value === undefined ? {} : { body: JSON.stringify(value) }),
			});
		const providerResponse = await request("/providers/my-local", "PATCH", {
			expected_revision: null,
			base_url: `${origin}/first/v1`,
			api_key: "local-test-key",
		});
		expect(providerResponse.status).toBe(200);
		const provider = (await providerResponse.json()) as Stored<unknown>;
		expect(JSON.stringify(provider)).not.toContain("local-test-key");
		const modelResponse = await request("/providers/my-local/models/local-model", "PATCH", {
			expected_revision: null,
			context_window: 65536,
			max_tokens: 4096,
			reasoning: false,
			input: ["text"],
		});
		expect(modelResponse.status).toBe(200);
		let model = (await modelResponse.json()) as Stored<unknown>;
		let profile = (await (await request("/model-profiles/default")).json()) as Stored<unknown>;
		profile = (await (
			await request("/model-profiles/default", "PATCH", {
				expected_revision: profile.revision,
				chat: { provider: "my-local", model: "local-model", thinking_level: "off" },
			})
		).json()) as Stored<unknown>;
		const sessionResponse = await request("/sessions", "POST", { persona_id: "default" });
		expect(sessionResponse.status).toBe(201);
		const session = (await sessionResponse.json()) as Stored<unknown>;
		expect(requests).toHaveLength(0);
		for (let index = 0; index < 3; index++) {
			if (index) {
				if (index === 1)
					expect(
						(
							await request("/providers/my-local", "PATCH", {
								expected_revision: provider.revision,
								base_url: `${origin}/second/v1`,
							})
						).status,
					).toBe(200);
				const changed = await request("/providers/my-local/models/local-model", "PATCH", {
					expected_revision: model.revision,
					reasoning: index === 1,
					input: index === 1 ? ["text", "image"] : ["text"],
				});
				expect(changed.status).toBe(200);
				model = (await changed.json()) as Stored<unknown>;
				const selected = await request("/model-profiles/default", "PATCH", {
					expected_revision: profile.revision,
					chat: { thinking_level: index === 1 ? "high" : "off" },
				});
				expect(selected.status).toBe(200);
				profile = (await selected.json()) as Stored<unknown>;
			}
			expect(requests).toHaveLength(index);
			const accepted = await request(`/sessions/${session.id}/messages`, "POST", { text: `消息 ${index}` });
			expect(accepted.status).toBe(202);
			const run = (await accepted.json()) as Stored<unknown>;
			await vi.waitFor(
				async () => {
					const completed = (await (await request(`/runs/${run.id}`)).json()) as Stored<{ status: string }>;
					expect(completed.data.status).toBe("completed");
					expect(completed.data).toMatchObject({
						result: { speech: "兼容接口回复", text: expect.stringMatching(/^（.+）兼容接口回复$/) },
						usage: { model_calls: 1 },
					});
				},
				{ timeout: 5000 },
			);
		}
		expect(requests).toHaveLength(3);
		expect(requests.map((request) => request.url)).toEqual([
			"/first/v1/chat/completions",
			"/second/v1/chat/completions",
			"/second/v1/chat/completions",
		]);
		for (const request of requests) {
			expect(request.authorization).toBe("Bearer local-test-key");
			expect(request.body).toMatchObject({ model: "local-model", stream: true });
			expect(request.body.tools).toBeUndefined();
		}
		expect(requests[0].body.reasoning_effort).toBeUndefined();
		expect(requests[1].body.reasoning_effort).toBe("high");
		expect(requests[2].body.reasoning_effort).toBeUndefined();
		expect(JSON.stringify(requests[1].body.messages)).toContain("消息 0");
		expect(JSON.stringify(requests[1].body.messages)).toContain("PERSONA_SENTINEL");
	});
});
