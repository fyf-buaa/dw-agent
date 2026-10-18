import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FileAuthStorageBackend } from "../../coding-agent/src/core/auth-storage.ts";
import type { InlineExtension } from "../../coding-agent/src/core/extensions/types.ts";
import {
	getMcpToolExposure,
	type McpServerConfig,
	mcpNamespace,
	validateMcpServerConfig,
} from "../../coding-agent/src/core/mcp-servers.ts";
import {
	addMcpServerConfig,
	loadMcpConfig,
	type McpServerEntry,
	removeMcpServerConfig,
} from "../../coding-agent/src/extensions/mcp/config.ts";
import {
	McpOAuthCredentialStore,
	type McpOAuthSettings,
	signInMcpServer,
} from "../../coding-agent/src/extensions/mcp/oauth.ts";
import { createMcpResourceToolDefinitions } from "../../coding-agent/src/extensions/mcp/resources.ts";
import { createDefaultTransport, McpServerConnection } from "../../coding-agent/src/extensions/mcp/runtime.ts";
import { createMcpToolDefinition, createMcpToolName } from "../../coding-agent/src/extensions/mcp/tools.ts";
import type { ApiStore } from "./api-store.ts";
import { ExecutorError } from "./errors.ts";
import { InstalledResourceCatalog, type InstalledResourceKind } from "./integration-resources.ts";

interface McpConfiguration {
	config: Record<string, unknown>;
	secret_fields: string[];
	fingerprint: string;
}
export interface McpAuthorization {
	status: "pending" | "succeeded" | "failed";
	authorization_url?: string;
	expires_at?: string;
	reconnect_required?: boolean;
	error?: { code: string; message: string };
}
interface AuthorizationFlow {
	controller: AbortController;
	view: McpAuthorization;
	done: Promise<void>;
	submit?: (url: string) => void;
	completion_requested?: boolean;
}
export interface IntegrationManagerOptions {
	agentDir: string;
	reload: () => Promise<void>;
	assertIdle?: () => void | Promise<void>;
	providerToken?: (provider: string) => Promise<string | undefined>;
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicConfig(config: McpServerConfig): Omit<McpConfiguration, "fingerprint"> {
	const result: Record<string, unknown> = {};
	for (const key of ["type", "enabled", "exposure", "toolExposure", "timeout", "description"] as const) {
		if (config[key] !== undefined) result[key] = config[key];
	}
	const secret_fields: string[] = [];
	if ("command" in config) {
		if (config.env) secret_fields.push(...Object.keys(config.env).map((name) => `env.${name}`));
		if (config.args?.length) secret_fields.push("args");
		result.command = config.command;
		if (config.cwd !== undefined) result.cwd = config.cwd;
	} else {
		if (config.headers) secret_fields.push(...Object.keys(config.headers).map((name) => `headers.${name}`));
		if (config.auth) result.auth = { provider: config.auth.provider };
		const url = new URL(config.url);
		if (url.search || url.hash || url.username || url.password) secret_fields.push("url");
		url.search = "";
		url.hash = "";
		url.username = "";
		url.password = "";
		result.url = url.href;
		if (config.oauth) {
			const oauth: Record<string, unknown> = {};
			for (const key of [
				"clientId",
				"callbackPort",
				"callbackUrl",
				"scope",
				"clientName",
				"clientRegistration",
			] as const) {
				if (config.oauth[key] !== undefined) oauth[key] = config.oauth[key];
			}
			if (config.oauth.clientSecret !== undefined) secret_fields.push("oauth.clientSecret");
			if (config.oauth.authServerMetadataUrl) {
				const metadata = new URL(config.oauth.authServerMetadataUrl);
				if (metadata.search || metadata.hash || metadata.username || metadata.password)
					secret_fields.push("oauth.authServerMetadataUrl");
				metadata.search = "";
				metadata.hash = "";
				metadata.username = "";
				metadata.password = "";
				oauth.authServerMetadataUrl = metadata.href;
			}
			result.oauth = oauth;
		}
	}
	return { config: result, secret_fields };
}

/** Admin-owned global integrations. Public metadata never contains native credentials. */
export class IntegrationManager {
	private readonly store: ApiStore;
	private readonly options: IntegrationManagerOptions;
	private readonly configPath: string;
	private readonly credentials: McpOAuthCredentialStore;
	private readonly catalog: InstalledResourceCatalog;
	private readonly entries = new Map<string, McpServerEntry>();
	private readonly connections = new Map<string, McpServerConnection>();
	private readonly authorizations = new Map<string, AuthorizationFlow>();
	private closed = false;
	private changing = false;
	private mutation: Promise<void> = Promise.resolve();

	constructor(store: ApiStore, options: IntegrationManagerOptions) {
		this.store = store;
		this.options = { ...options, agentDir: resolve(options.agentDir) };
		this.configPath = join(this.options.agentDir, "mcp.json");
		this.credentials = new McpOAuthCredentialStore(
			new FileAuthStorageBackend(join(this.options.agentDir, "mcp-auth.json")),
			this.options.agentDir,
		);
		this.catalog = new InstalledResourceCatalog(store, this.options.agentDir);
	}

	async initialize(): Promise<void> {
		mkdirSync(this.options.agentDir, { recursive: true, mode: 0o700 });
		for (const file of [this.configPath, join(this.options.agentDir, "mcp-auth.json")]) {
			if (existsSync(file)) chmodSync(file, 0o600);
		}
		const loaded = loadMcpConfig({
			agentDir: this.options.agentDir,
			cwd: this.options.agentDir,
			projectTrusted: false,
		});
		if (loaded.errors.length) {
			throw new ExecutorError("INTEGRATION_CONFIG_INVALID", "The global MCP configuration is invalid");
		}
		await this.catalog.discover();
		for (const entry of loaded.servers) {
			this.entries.set(entry.name, entry);
			this.record(entry);
			await this.connect(entry);
		}
		for (const record of this.store.all<McpConfiguration>("integration-mcp")) {
			if (!this.entries.has(record.id)) this.store.remove("integration-mcp", record.id, record.revision);
		}
	}

	private record(entry: McpServerEntry): void {
		const data = {
			...publicConfig(entry.config),
			fingerprint: createHash("sha256").update(JSON.stringify(entry.config)).digest("hex"),
		};
		const current = this.store.get<McpConfiguration>("integration-mcp", entry.name);
		if (current?.data.fingerprint !== data.fingerprint) {
			this.store.put("integration-mcp", entry.name, data, current?.revision ?? null);
		}
	}

	private async connect(entry: McpServerEntry): Promise<void> {
		if (entry.config.enabled === false) return;
		const connection = new McpServerConnection({
			entry,
			cwd: this.options.agentDir,
			createTransport: createDefaultTransport,
			credentials: this.credentials,
			providerToken: this.options.providerToken,
			onTools: () => {},
		});
		this.connections.set(entry.name, connection);
		// The native connection retains its actual failed/needs-auth state. A configured but offline
		// server must not prevent startup or make the API pretend it connected.
		await connection.getClient().catch(() => undefined);
	}

	private requireEntry(id: string): McpServerEntry {
		if (this.closed) throw new ExecutorError("INTEGRATIONS_CLOSED", "Integrations are shut down");
		const entry = this.entries.get(id);
		if (!entry) throw new ExecutorError("NOT_FOUND", "The MCP server was not found");
		return entry;
	}

	getMcp(id: string) {
		const entry = this.requireEntry(id);
		const record = this.store.require<McpConfiguration>("integration-mcp", id);
		const connection = this.connections.get(id);
		const { fingerprint: _fingerprint, ...configuration } = record.data;
		const supported =
			"url" in entry.config &&
			!entry.config.auth &&
			!Object.keys(entry.config.headers ?? {}).some((name) => name.toLowerCase() === "authorization");
		return {
			...record,
			data: {
				...configuration,
				status: entry.config.enabled === false ? "disabled" : (connection?.state ?? "closed"),
				tools: this.toolEntries().filter((item) => item.server === id),
				has_resources: connection?.hasResources ?? false,
				oauth: {
					supported,
					authenticated:
						supported &&
						connection?.state === "connected" &&
						"url" in entry.config &&
						Boolean(this.credentials.tokens(id, entry.config.url)),
					credentials_stored: "url" in entry.config && Boolean(this.credentials.tokens(id, entry.config.url)),
					remote_revocation_supported: false,
				},
				...(connection?.error
					? {
							error: {
								code: "MCP_CONNECTION_FAILED",
								message: "The native MCP connection failed; inspect trusted server configuration",
							},
						}
					: {}),
			},
		};
	}

	listMcp(query?: { cursor?: string; limit?: number }) {
		const page = this.store.list<McpConfiguration>("integration-mcp", query);
		return { ...page, items: page.items.map((item) => this.getMcp(item.id)) };
	}

	private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.mutation;
		let release = () => {};
		this.mutation = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		this.changing = true;
		try {
			if (this.closed) throw new ExecutorError("INTEGRATIONS_CLOSED", "Integrations are shut down");
			return await operation();
		} finally {
			this.changing = false;
			release();
		}
	}

	isChanging(): boolean {
		return this.changing;
	}

	private async assertIdle(): Promise<void> {
		if (this.options.assertIdle) await this.options.assertIdle();
		else await this.options.reload();
	}

	async saveMcp(id: string, value: unknown) {
		return this.exclusive(async () => {
			if (
				!object(value) ||
				!object(value.config) ||
				Object.keys(value).some((key) => key !== "expected_revision" && key !== "config")
			) {
				throw new ExecutorError("INVALID_REQUEST", "MCP settings require config and expected_revision");
			}
			const current = this.store.get<McpConfiguration>("integration-mcp", id);
			if (value.expected_revision !== (current?.revision ?? null)) {
				throw new ExecutorError("REVISION_CONFLICT", "The MCP server revision changed");
			}
			const raw = { ...value.config };
			const previous = this.entries.get(id)?.config;
			if (previous && (("url" in previous && "url" in raw) || ("command" in previous && "command" in raw))) {
				if ("command" in previous) {
					if (raw.args === undefined && previous.args) raw.args = previous.args;
					if (previous.env)
						raw.env = object(raw.env)
							? { ...previous.env, ...raw.env }
							: raw.env === null
								? undefined
								: previous.env;
				} else {
					if (previous.headers)
						raw.headers = object(raw.headers)
							? { ...previous.headers, ...raw.headers }
							: raw.headers === null
								? undefined
								: previous.headers;
					if (object(raw.oauth) && previous.oauth?.clientSecret && raw.oauth.clientSecret === undefined) {
						raw.oauth = { ...raw.oauth, clientSecret: previous.oauth.clientSecret };
					} else if (raw.oauth === undefined && previous.oauth) raw.oauth = previous.oauth;
					if (object(raw.oauth) && previous.oauth?.authServerMetadataUrl) {
						const redacted = publicConfig(previous).config.oauth;
						if (object(redacted) && raw.oauth.authServerMetadataUrl === redacted.authServerMetadataUrl) {
							raw.oauth = { ...raw.oauth, authServerMetadataUrl: previous.oauth.authServerMetadataUrl };
						}
					}
					if (raw.url === publicConfig(previous).config.url) raw.url = previous.url;
				}
			}
			const allowed = [
				"type",
				"command",
				"args",
				"env",
				"cwd",
				"url",
				"headers",
				"oauth",
				"auth",
				"enabled",
				"exposure",
				"toolExposure",
				"timeout",
				"description",
			];
			if (Object.keys(raw).some((key) => !allowed.includes(key)) || JSON.stringify(raw).length > 128 * 1024) {
				throw new ExecutorError(
					"INVALID_REQUEST",
					"MCP configuration contains unsupported fields or exceeds the size limit",
				);
			}
			const transportFields = "url" in raw ? ["command", "args", "env", "cwd"] : ["url", "headers", "oauth", "auth"];
			const oauthFields = [
				"clientId",
				"clientSecret",
				"callbackPort",
				"callbackUrl",
				"scope",
				"clientName",
				"clientRegistration",
				"authServerMetadataUrl",
			];
			if (
				transportFields.some((key) => raw[key] !== undefined) ||
				(object(raw.oauth) && Object.keys(raw.oauth).some((key) => !oauthFields.includes(key))) ||
				(object(raw.auth) && Object.keys(raw.auth).some((key) => key !== "provider"))
			) {
				throw new ExecutorError(
					"INVALID_REQUEST",
					"MCP configuration contains unsupported transport or authentication fields",
				);
			}
			for (const key of Object.keys(raw)) if (raw[key] === undefined) delete raw[key];
			const config = validateMcpServerConfig(id, raw);
			if (typeof config === "string")
				throw new ExecutorError("INVALID_REQUEST", "MCP configuration does not match the native schema");
			if (config.timeout !== undefined && !Number.isFinite(config.timeout))
				throw new ExecutorError("INVALID_REQUEST", "MCP timeout must be finite");
			if ([...this.entries.keys()].some((name) => name !== id && mcpNamespace(name) === mcpNamespace(id))) {
				throw new ExecutorError("INVALID_REQUEST", "The MCP server name conflicts with another tool namespace");
			}
			await this.assertIdle();
			await this.cancelAuthorization(id);
			if (previous && "url" in previous && (!("url" in config) || config.url !== previous.url)) {
				if (await this.removeCredentials(id, previous.url)) await this.connections.get(id)?.signOut();
			}
			this.persistConfig((path) => {
				addMcpServerConfig(path, id, config);
			});
			await this.connections.get(id)?.close();
			this.connections.delete(id);
			const entry: McpServerEntry = { name: id, config, source: this.configPath, scope: "global" };
			this.entries.set(id, entry);
			this.record(entry);
			await this.connect(entry);
			await this.options.reload();
			return this.getMcp(id);
		});
	}

	private persistConfig(change: (path: string) => void): void {
		const temporary = `${this.configPath}.${randomUUID()}.tmp`;
		try {
			// Native config editing preserves unrelated keys and indentation. Editing a same-directory
			// private copy first means failed writes never truncate the live configuration.
			writeFileSync(temporary, existsSync(this.configPath) ? readFileSync(this.configPath) : "{}\n", {
				mode: 0o600,
				flag: "wx",
			});
			change(temporary);
			renameSync(temporary, this.configPath);
		} finally {
			rmSync(temporary, { force: true });
		}
	}

	private async removeCredentials(id: string, url: string): Promise<boolean> {
		// A refresh that already reached the provider may rotate credentials. Revoke only after it
		// saves, under the native cross-process refresh lock, so logout cannot resurrect its tokens.
		return this.credentials.forServer(id, url).withRefreshLock(async () => this.credentials.remove(id, url));
	}

	async deleteMcp(id: string, revision: number): Promise<void> {
		await this.exclusive(async () => {
			const entry = this.requireEntry(id);
			if (this.store.require("integration-mcp", id).revision !== revision)
				throw new ExecutorError("REVISION_CONFLICT", "The MCP server revision changed");
			await this.assertIdle();
			await this.cancelAuthorization(id);
			if ("url" in entry.config) {
				// Keep the persisted entry and live native object when credential locking/removal fails.
				// If revocation succeeds but persistence fails, signOut truthfully exposes needs-auth.
				if (await this.removeCredentials(id, entry.config.url)) await this.connections.get(id)?.signOut();
			}
			this.persistConfig((path) => {
				removeMcpServerConfig(path, id);
			});
			await this.connections.get(id)?.close();
			this.connections.delete(id);
			this.entries.delete(id);
			this.store.remove("integration-mcp", id, revision);
			await this.options.reload();
		});
	}

	async reconnectMcp(id: string) {
		return this.exclusive(async () => {
			const entry = this.requireEntry(id);
			if (entry.config.enabled === false)
				throw new ExecutorError("MCP_DISABLED", "Enable the MCP server before reconnecting");
			await this.assertIdle();
			const connection = this.connections.get(id);
			if (connection && connection.state !== "closed") await connection.reconnect().catch(() => undefined);
			else {
				this.connections.delete(id);
				await this.connect(entry);
			}
			await this.options.reload();
			return this.getMcp(id);
		});
	}

	async beginMcpAuth(id: string, value: unknown): Promise<McpAuthorization> {
		return this.exclusive(async () => {
			if (!object(value) || Object.keys(value).length)
				throw new ExecutorError("INVALID_REQUEST", "Authorization takes an empty object");
			this.requireEntry(id);
			await this.assertIdle();
			const connection = this.connections.get(id);
			if (!connection?.oauthUrl)
				throw new ExecutorError("MCP_OAUTH_UNAVAILABLE", "This enabled server does not use native OAuth");
			const existing = this.authorizations.get(id);
			if (existing?.view.status === "pending") return { ...existing.view };
			let settings: McpOAuthSettings;
			try {
				settings = connection.oauthSettings();
			} catch {
				throw new ExecutorError("MCP_AUTHORIZATION_FAILED", "Native OAuth settings could not be resolved");
			}
			const controller = new AbortController();
			const expires_at = new Date(Date.now() + 5 * 60_000).toISOString();
			const timer = setTimeout(() => controller.abort(), 5 * 60_000);
			timer.unref();
			let ready = () => {};
			const prepared = new Promise<void>((resolve) => {
				ready = resolve;
			});
			const flow: AuthorizationFlow = {
				controller,
				view: { status: "pending", expires_at },
				done: Promise.resolve(),
			};
			this.authorizations.set(id, flow);
			flow.done = signInMcpServer({
				serverUrl: connection.oauthUrl,
				settings,
				challenge: connection.challenge,
				store: this.credentials.forServer(id, connection.oauthUrl),
				signal: controller.signal,
				prompt: {
					showAuthorizationUrl: (url) => {
						flow.view.authorization_url = url.href;
						ready();
					},
					promptForRedirectUrl: (signal) =>
						new Promise<string | undefined>((resolve) => {
							const cancel = () => {
								flow.submit = undefined;
								resolve(undefined);
							};
							if (signal.aborted) {
								cancel();
								return;
							}
							flow.submit = (url) => {
								signal.removeEventListener("abort", cancel);
								flow.submit = undefined;
								resolve(url);
							};
							signal.addEventListener("abort", cancel, { once: true });
						}),
				},
			})
				.then(
					() => {
						flow.view = { status: "succeeded" };
						if (!flow.completion_requested) {
							void this.exclusive(async () => {
								if (this.authorizations.get(id) !== flow || controller.signal.aborted) return;
								await this.assertIdle();
								await this.connections
									.get(id)
									?.reconnect()
									.catch(() => undefined);
								await this.options.reload();
								if (this.connections.get(id)?.state !== "connected") flow.view.reconnect_required = true;
							}).catch(() => {
								flow.view.reconnect_required = true;
							});
						}
					},
					() => {
						flow.view = {
							status: "failed",
							error: {
								code: "MCP_AUTHORIZATION_FAILED",
								message: "Native MCP authorization failed, was cancelled, or expired",
							},
						};
					},
				)
				.finally(() => {
					clearTimeout(timer);
					ready();
				});
			await prepared;
			return { ...flow.view };
		});
	}

	getMcpAuth(id: string): McpAuthorization {
		this.requireEntry(id);
		const flow = this.authorizations.get(id);
		if (!flow) throw new ExecutorError("NOT_FOUND", "No MCP authorization flow exists for this server");
		return { ...flow.view };
	}

	async completeMcpAuth(id: string, value: unknown): Promise<McpAuthorization> {
		return this.exclusive(async () => {
			this.requireEntry(id);
			if (
				!object(value) ||
				typeof value.redirect_url !== "string" ||
				value.redirect_url.length > 16_384 ||
				Object.keys(value).some((key) => key !== "redirect_url")
			)
				throw new ExecutorError("INVALID_REQUEST", "Provide the complete OAuth redirect_url");
			const flow = this.authorizations.get(id);
			if (!flow || flow.view.status !== "pending" || !flow.submit)
				throw new ExecutorError("MCP_AUTHORIZATION_NOT_PENDING", "No MCP authorization is awaiting a redirect URL");
			await this.assertIdle();
			// Native signInMcpServer validates redirect origin/path, random state, issuer and PKCE.
			flow.completion_requested = true;
			flow.submit(value.redirect_url);
			await flow.done;
			if (this.getMcpAuth(id).status === "succeeded") {
				await this.connections
					.get(id)
					?.reconnect()
					.catch(() => undefined);
				await this.options.reload();
				if (this.connections.get(id)?.state !== "connected") flow.view.reconnect_required = true;
			}
			return { ...flow.view };
		});
	}

	private async cancelAuthorization(id: string): Promise<void> {
		const flow = this.authorizations.get(id);
		if (!flow) return;
		flow.controller.abort();
		await flow.done;
		this.authorizations.delete(id);
	}

	async logoutMcp(id: string) {
		return this.exclusive(async () => {
			const entry = this.requireEntry(id);
			if (!("url" in entry.config))
				throw new ExecutorError("MCP_OAUTH_UNAVAILABLE", "A stdio MCP server has no OAuth credentials");
			await this.assertIdle();
			await this.cancelAuthorization(id);
			await this.connections.get(id)?.signOut();
			const removed = await this.removeCredentials(id, entry.config.url);
			await this.options.reload();
			return { authenticated: false, local_credentials_removed: removed, remote_revocation_supported: false };
		});
	}

	private toolEntries() {
		const names = [...this.connections.values()].flatMap((connection) =>
			connection.tools.map((tool) => createMcpToolName(connection.name, tool.name)),
		);
		return [...this.connections.values()].flatMap((connection) =>
			connection.tools.map((tool) => ({
				name: createMcpToolName(
					connection.name,
					tool.name,
					(name) => names.indexOf(name) !== names.lastIndexOf(name),
				),
				server: connection.name,
				tool: tool.name,
				...(tool.description !== undefined ? { description: tool.description } : {}),
				inputSchema: tool.inputSchema,
				exposure: getMcpToolExposure(connection.entry.config, tool.name),
				status: connection.state,
			})),
		);
	}

	private resourceTools() {
		const servers = () =>
			[...this.connections.values()].filter(
				(connection) =>
					connection.hasResources &&
					connection.entry.config.enabled !== false &&
					connection.entry.config.exposure !== "hidden",
			);
		const exposures = servers().map((connection) => connection.entry.config.exposure ?? "codemode");
		const exposure = (["direct", "codemode", "deferred"] as const).find((candidate) => exposures.includes(candidate));
		return exposure ? createMcpResourceToolDefinitions({ exposure, servers }) : [];
	}

	listTools() {
		return [
			...this.toolEntries(),
			...this.resourceTools().map((tool) => ({
				name: tool.name,
				server: "*",
				tool: tool.name,
				description: tool.description,
				inputSchema: tool.parameters,
				exposure: tool.exposure ?? "direct",
				status: [...this.connections.values()].some(
					(connection) => connection.hasResources && connection.state === "connected",
				)
					? "connected"
					: "disconnected",
			})),
		];
	}

	runtimeExtensions(): InlineExtension[] {
		return [
			(api) => {
				for (const item of this.toolEntries()) {
					const connection = this.connections.get(item.server);
					const tool = connection?.tools.find((tool) => tool.name === item.tool);
					if (!connection || !tool) continue;
					api.registerTool(
						createMcpToolDefinition({
							server: item.server,
							tool,
							name: item.name,
							exposure: item.exposure,
							namespace: { name: mcpNamespace(item.server), aliases: [item.server] },
							timeoutMs: connection.timeoutMs,
							getClient: async () => {
								const current = this.connections.get(item.server);
								if (
									!current ||
									current.entry.config.enabled === false ||
									getMcpToolExposure(current.entry.config, item.tool) === "hidden" ||
									!current.tools.some((tool) => tool.name === item.tool)
								)
									throw new ExecutorError("MCP_TOOL_UNAVAILABLE", "The MCP tool is no longer available");
								return current;
							},
							readableResources: () => connection.hasResources,
						}),
					);
				}
				for (const definition of this.resourceTools()) api.registerTool(definition);
			},
		];
	}

	resourceSettings(): { extensions: string[]; skills: string[] } {
		return this.catalog.settings();
	}

	listResources(kind: InstalledResourceKind) {
		return this.catalog.list(kind);
	}

	updateResource(kind: InstalledResourceKind, id: string, value: unknown) {
		return this.catalog.update(kind, id, value);
	}

	async reload(): Promise<{ reloaded: true }> {
		return this.exclusive(async () => {
			await this.assertIdle();
			await this.catalog.discover();
			await this.options.reload();
			return { reloaded: true };
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		// Abort OAuth first, allowing a pending authorization request to release the mutation lock.
		for (const flow of this.authorizations.values()) flow.controller.abort();
		await this.mutation;
		await Promise.all([...this.authorizations.keys()].map((id) => this.cancelAuthorization(id)));
		await Promise.all([...this.connections.values()].map((connection) => connection.close()));
		this.connections.clear();
	}
}
