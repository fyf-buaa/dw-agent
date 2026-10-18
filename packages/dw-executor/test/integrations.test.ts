import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../coding-agent/src/core/extensions/loader.ts";
import * as nativeMcpConfig from "../../coding-agent/src/extensions/mcp/config.ts";
import { McpOAuthCredentialStore } from "../../coding-agent/src/extensions/mcp/oauth.ts";
import { McpServerConnection } from "../../coding-agent/src/extensions/mcp/runtime.ts";
import { ApiStore } from "../src/api-store.ts";
import { ExecutorError } from "../src/errors.ts";
import { IntegrationManager } from "../src/integrations.ts";
import { localMcpFixture } from "./integration-fixture.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
	options: {
		prepare?: (agentDir: string) => void;
		providerToken?: (provider: string) => Promise<string | undefined>;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "dw-integration-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	options.prepare?.(agentDir);
	const store = new ApiStore(":memory:");
	cleanups.push(() => store.close());
	let busy = false;
	let reloads = 0;
	const manager = new IntegrationManager(store, {
		agentDir,
		providerToken: options.providerToken,
		assertIdle: () => {
			if (busy) throw new ExecutorError("RESOURCE_RELOAD_BUSY", "Runtime is busy");
		},
		reload: async () => {
			if (busy) throw new ExecutorError("RESOURCE_RELOAD_BUSY", "Runtime is busy");
			reloads++;
		},
	});
	cleanups.push(() => manager.close());
	await manager.initialize();
	return {
		root,
		agentDir,
		manager,
		store,
		setBusy: (value: boolean) => {
			busy = value;
		},
		get reloads() {
			return reloads;
		},
	};
}

async function server(oauth = false) {
	const fixture = await localMcpFixture(oauth);
	cleanups.push(() => fixture.close());
	return fixture;
}

describe("native integration management", () => {
	it("persists native HTTP MCP configuration, discovers capabilities, registers native adapters and reconnects", async () => {
		const native = await server();
		const f = await setup();
		const created = await f.manager.saveMcp("fixture", {
			expected_revision: null,
			config: { url: native.url, exposure: "direct", headers: { "X-Fixture-Secret": "private-header-value" } },
		});
		expect(created).toMatchObject({
			id: "fixture",
			revision: 1,
			data: { status: "connected", has_resources: true, secret_fields: ["headers.X-Fixture-Secret"] },
		});
		expect(created.data.tools).toMatchObject([
			{ name: "mcp__fixture__echo", inputSchema: { type: "object", required: ["text"] }, exposure: "direct" },
		]);
		expect(JSON.stringify(created)).not.toContain("private-header-value");
		expect(JSON.stringify(f.store.all("integration-mcp"))).not.toContain("private-header-value");
		expect(JSON.parse(readFileSync(join(f.agentDir, "mcp.json"), "utf8"))).toMatchObject({
			mcpServers: { fixture: { headers: { "X-Fixture-Secret": "private-header-value" } } },
		});
		const [inline] = f.manager.runtimeExtensions();
		if (typeof inline !== "function") throw new Error("Expected the native integration factory");
		const extension = await loadExtensionFromFactory(inline, f.agentDir, createEventBus(), createExtensionRuntime());
		expect([...extension.tools.keys()]).toEqual(
			expect.arrayContaining(["mcp__fixture__echo", "list_mcp_resources", "read_mcp_resource"]),
		);
		const echo = extension.tools.get("mcp__fixture__echo");
		const readResource = extension.tools.get("read_mcp_resource");
		if (!echo || !readResource) throw new Error("Native MCP adapters were not registered");
		// These native adapters consume only the first four execute arguments, not an agent context.
		const echoed: unknown = await Reflect.apply(echo.definition.execute, undefined, [
			"fixture-call",
			{ text: "through native adapter" },
			undefined,
			undefined,
		]);
		expect(echoed).toMatchObject({ content: [{ type: "text", text: "through native adapter" }] });
		const resource: unknown = await Reflect.apply(readResource.definition.execute, undefined, [
			"resource-call",
			{ server: "fixture", uri: "fixture://readme" },
			undefined,
			undefined,
		]);
		expect(JSON.stringify(resource)).toContain("local resource");
		expect(native.toolCalls).toMatchObject([{ name: "echo", arguments: { text: "through native adapter" } }]);
		expect(native.initializations).toBe(1);
		const reconnected = await f.manager.reconnectMcp("fixture");
		expect(reconnected.data.status).toBe("connected");
		expect(native.initializations).toBe(2);
		expect(f.manager.listMcp().items).toHaveLength(1);
		expect(f.manager.listTools()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "mcp__fixture__echo", server: "fixture", status: "connected" }),
			]),
		);
		const disabled = await f.manager.saveMcp("fixture", {
			expected_revision: 1,
			config: { url: native.url, enabled: false },
		});
		expect(disabled).toMatchObject({ revision: 2, data: { status: "disabled", tools: [] } });
		expect(JSON.parse(readFileSync(join(f.agentDir, "mcp.json"), "utf8"))).toMatchObject({
			mcpServers: { fixture: { enabled: false, headers: { "X-Fixture-Secret": "private-header-value" } } },
		});
		await expect(f.manager.reconnectMcp("fixture")).rejects.toMatchObject({ code: "MCP_DISABLED" });
		await f.manager.deleteMcp("fixture", 2);
		expect(f.manager.listMcp().items).toEqual([]);
		expect(JSON.parse(readFileSync(join(f.agentDir, "mcp.json"), "utf8")).mcpServers).toEqual({});
	});

	it("keeps actual native connection failures visible without leaking stderr or command-line secrets", async () => {
		const f = await setup();
		const failed = await f.manager.saveMcp("failure", {
			expected_revision: null,
			config: {
				command: process.execPath,
				args: ["-e", "process.stderr.write('private-stderr-value');process.exit(1)"],
				env: { SECRET: "private-env-value" },
				timeout: 1,
			},
		});
		expect(failed.data.status).toBe("failed");
		expect(failed.data.error?.code).toBe("MCP_CONNECTION_FAILED");
		expect(failed.data.secret_fields).toEqual(["env.SECRET", "args"]);
		expect(JSON.stringify(failed)).not.toContain("private-stderr-value");
		expect(JSON.stringify(failed)).not.toContain("private-env-value");
		expect(JSON.stringify(f.store.all("integration-mcp"))).not.toContain("private-stderr-value");
		const retried = await f.manager.reconnectMcp("failure");
		expect(retried.data.status).toBe("failed");
	});

	it("rejects stale revisions, invalid native schemas, cross-transport secrets and colliding namespaces", async () => {
		const f = await setup();
		await f.manager.saveMcp("my-server", {
			expected_revision: null,
			config: { command: "never-start", enabled: false },
		});
		await expect(
			f.manager.saveMcp("my-server", { expected_revision: null, config: { command: "other", enabled: false } }),
		).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
		await expect(f.manager.deleteMcp("my-server", 9)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
		for (const config of [
			{ url: "not-a-url" },
			{ command: "x", exposure: "unknown" },
			{ command: "x", timeout: Number.POSITIVE_INFINITY },
			{ url: "https://example.invalid/mcp", env: { TOKEN: "must-not-save" } },
			{ url: "https://example.invalid/mcp", oauth: { injectedSecret: "must-not-save" } },
		]) {
			await expect(f.manager.saveMcp("invalid", { expected_revision: null, config })).rejects.toMatchObject({
				code: "INVALID_REQUEST",
			});
		}
		await expect(
			f.manager.saveMcp("my_server", { expected_revision: null, config: { command: "x", enabled: false } }),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		expect(f.manager.listMcp().items).toHaveLength(1);
	});

	it("rejects busy runtime mutations before changing connections or configuration", async () => {
		const native = await server();
		const f = await setup();
		await f.manager.saveMcp("fixture", { expected_revision: null, config: { url: native.url } });
		const contents = readFileSync(join(f.agentDir, "mcp.json"), "utf8");
		const reloads = f.reloads;
		f.setBusy(true);
		for (const operation of [
			() => f.manager.saveMcp("fixture", { expected_revision: 1, config: { url: native.url, enabled: false } }),
			() => f.manager.reconnectMcp("fixture"),
			() => f.manager.deleteMcp("fixture", 1),
			() => f.manager.reload(),
		])
			await expect(operation()).rejects.toMatchObject({ code: "RESOURCE_RELOAD_BUSY" });
		expect(readFileSync(join(f.agentDir, "mcp.json"), "utf8")).toBe(contents);
		expect(f.manager.getMcp("fixture").data.status).toBe("connected");
		expect(native.initializations).toBe(1);
		expect(f.reloads).toBe(reloads);
		expect(f.manager.isChanging()).toBe(false);
	});

	it("resolves native provider credentials afresh for every request rather than retaining a copied token", async () => {
		const native = await server(true);
		let token = "fixture-access-secret";
		const providers: string[] = [];
		const f = await setup({
			providerToken: async (provider) => {
				providers.push(provider);
				return token;
			},
		});
		const created = await f.manager.saveMcp("provider", {
			expected_revision: null,
			config: { url: native.url, auth: { provider: "fixture-provider" } },
		});
		expect(created.data.status).toBe("connected");
		expect(created.data.oauth.supported).toBe(false);
		token = "rejected-provider-token";
		expect((await f.manager.reconnectMcp("provider")).data.status).toBe("needs-auth");
		token = "fixture-access-secret";
		expect((await f.manager.reconnectMcp("provider")).data.status).toBe("connected");
		expect(providers.length).toBeGreaterThanOrEqual(3);
		expect(providers.every((provider) => provider === "fixture-provider")).toBe(true);
		expect(JSON.stringify(f.manager.getMcp("provider"))).not.toContain(token);
	});

	it("does not publish a pending OAuth flow when native secret resolution throws, and can retry after recovery", async () => {
		const native = await server(true);
		const f = await setup();
		vi.stubEnv("DW_INTEGRATION_CLIENT_SECRET", undefined);
		await f.manager.saveMcp("oauth", {
			expected_revision: null,
			// biome-ignore lint/suspicious/noTemplateCurlyInString: native secret reference, not interpolation.
			config: { url: native.url, oauth: { clientSecret: "${DW_INTEGRATION_CLIENT_SECRET}" } },
		});
		await expect(f.manager.beginMcpAuth("oauth", {})).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_FAILED" });
		expect(() => f.manager.getMcpAuth("oauth")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
		vi.stubEnv("DW_INTEGRATION_CLIENT_SECRET", "fixture-client-secret");
		const retried = await f.manager.beginMcpAuth("oauth", {});
		expect(retried.status).toBe("pending");
		expect(retried.authorization_url).toBeTruthy();
		await f.manager.logoutMcp("oauth");
	});

	it("retains persisted configuration and a recoverable connection when native config writes or credential removal fail", async () => {
		const native = await server();
		const f = await setup();
		const connections = vi.spyOn(McpServerConnection.prototype, "getClient");
		await f.manager.saveMcp("fixture", { expected_revision: null, config: { url: native.url } });
		const before = readFileSync(join(f.agentDir, "mcp.json"), "utf8");
		vi.spyOn(McpOAuthCredentialStore.prototype, "remove").mockImplementationOnce(() => {
			throw new Error("credential backend unavailable");
		});
		await expect(f.manager.deleteMcp("fixture", 1)).rejects.toThrow("credential backend unavailable");
		expect(readFileSync(join(f.agentDir, "mcp.json"), "utf8")).toBe(before);
		expect(f.manager.getMcp("fixture").data.status).toBe("connected");
		vi.spyOn(nativeMcpConfig, "removeMcpServerConfig").mockImplementationOnce(() => {
			throw new Error("native write failed");
		});
		await expect(f.manager.deleteMcp("fixture", 1)).rejects.toThrow("native write failed");
		expect(readFileSync(join(f.agentDir, "mcp.json"), "utf8")).toBe(before);
		expect(f.manager.getMcp("fixture").revision).toBe(1);
		expect((await f.manager.reconnectMcp("fixture")).data.status).toBe("connected");
		const nativeConnection = connections.mock.contexts[0];
		if (!(nativeConnection instanceof McpServerConnection))
			throw new Error("The real native connection was not observed");
		await nativeConnection.close();
		expect(f.manager.getMcp("fixture").data.status).toBe("closed");
		expect((await f.manager.reconnectMcp("fixture")).data.status).toBe("connected");
		await f.manager.deleteMcp("fixture", 1);
		expect(f.manager.listMcp().items).toEqual([]);
	});

	it("lists only installed global resources, stages revisioned toggles and never executes or installs while discovering", async () => {
		const f = await setup({
			prepare: (agentDir) => {
				mkdirSync(join(agentDir, "extensions"));
				writeFileSync(
					join(agentDir, "extensions", "trusted.js"),
					"throw new Error('must-not-execute-during-discovery')",
				);
				const outside = join(agentDir, "..", "outside");
				mkdirSync(outside);
				writeFileSync(join(outside, "index.js"), "throw new Error('escaped-global-root')");
				symlinkSync(outside, join(agentDir, "extensions", "escape"), "junction");
				mkdirSync(join(agentDir, "skills", "trusted"), { recursive: true });
				writeFileSync(
					join(agentDir, "skills", "trusted", "SKILL.md"),
					"---\nname: trusted\ndescription: A local test skill\n---\nLocal guidance\n",
				);
				mkdirSync(join(agentDir, ".pi", "extensions"), { recursive: true });
				writeFileSync(
					join(agentDir, ".pi", "extensions", "untrusted.js"),
					"throw new Error('project-extension-executed')",
				);
				writeFileSync(
					join(agentDir, ".pi", "settings.json"),
					JSON.stringify({ packages: ["npm:project-must-not-install"] }),
				);
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({ packages: ["npm:missing-must-not-install@1.0.0"] }),
				);
			},
		});
		const extensions = f.manager.listResources("extensions").items;
		const skills = f.manager.listResources("skills").items;
		expect(extensions.map((item) => item.data.name)).toEqual(["trusted.js"]);
		expect(skills.some((item) => item.data.path.endsWith(join("trusted", "SKILL.md")))).toBe(true);
		expect(f.manager.resourceSettings().extensions).toEqual([extensions[0].data.path]);
		const changed = f.manager.updateResource("extensions", extensions[0].id, {
			expected_revision: 1,
			enabled: false,
		});
		expect(changed.revision).toBe(2);
		expect(f.manager.resourceSettings().extensions).toEqual([]);
		expect(f.reloads).toBe(0);
		expect(() =>
			f.manager.updateResource("extensions", extensions[0].id, { expected_revision: 1, enabled: true }),
		).toThrow();
		await expect(f.manager.reload()).resolves.toEqual({ reloaded: true });
		expect(f.manager.listResources("extensions").items[0].data.enabled).toBe(false);
		expect(f.reloads).toBe(1);
		expect(existsSync(join(f.agentDir, "npm", "node_modules", "missing-must-not-install"))).toBe(false);
	});

	it("performs native OAuth discovery, dynamic registration, state and PKCE verification, then local revocation", async () => {
		const native = await server(true);
		const f = await setup();
		const created = await f.manager.saveMcp("oauth", {
			expected_revision: null,
			config: { url: native.url, exposure: "direct" },
		});
		expect(created.data.status).toBe("needs-auth");
		expect(created.data.oauth).toMatchObject({
			supported: true,
			authenticated: false,
			remote_revocation_supported: false,
		});
		const first = await f.manager.beginMcpAuth("oauth", {});
		expect(first.status).toBe("pending");
		if (!first.authorization_url) throw new Error("Native OAuth did not produce an authorization URL");
		const authorization = new URL(first.authorization_url);
		expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorization.searchParams.get("state")).toBeTruthy();
		expect(new URL(authorization.searchParams.get("redirect_uri") ?? "").hostname).toBe("127.0.0.1");
		const wrong = new URL(await native.redirect(first.authorization_url));
		wrong.searchParams.set("state", "wrong-state");
		const rejected = await f.manager.completeMcpAuth("oauth", { redirect_url: wrong.href });
		expect(rejected.status).toBe("failed");
		expect(native.tokenRequests).toBe(0);
		const second = await f.manager.beginMcpAuth("oauth", {});
		if (!second.authorization_url) throw new Error("Native OAuth did not restart");
		expect(second.authorization_url).not.toBe(first.authorization_url);
		const redirect = await native.redirect(second.authorization_url);
		const completed = await f.manager.completeMcpAuth("oauth", { redirect_url: redirect });
		expect(completed).toEqual({ status: "succeeded" });
		expect(native.tokenRequests).toBe(1);
		expect(f.manager.getMcp("oauth").data).toMatchObject({ status: "connected", oauth: { authenticated: true } });
		expect(readFileSync(join(f.agentDir, "mcp-auth.json"), "utf8")).toContain("fixture-access-secret");
		const publicData = JSON.stringify([
			f.manager.getMcp("oauth"),
			f.manager.getMcpAuth("oauth"),
			f.manager.listTools(),
			f.store.all("integration-mcp"),
		]);
		expect(publicData).not.toContain("fixture-access-secret");
		expect(publicData).not.toContain("fixture-refresh-secret");
		await expect(f.manager.logoutMcp("oauth")).resolves.toEqual({
			authenticated: false,
			local_credentials_removed: true,
			remote_revocation_supported: false,
		});
		expect(f.manager.getMcp("oauth").data.status).toBe("needs-auth");
		expect(f.manager.getMcp("oauth").data.oauth.authenticated).toBe(false);
		expect(readFileSync(join(f.agentDir, "mcp-auth.json"), "utf8")).not.toContain("fixture-access-secret");
	});
});
