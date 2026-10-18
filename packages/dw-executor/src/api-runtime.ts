import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { createCodemodeExtension } from "../../coding-agent/src/extensions/codemode/index.ts";
import { createToolSearchExtension } from "../../coding-agent/src/extensions/tool-search/index.ts";
import { CompanionApi } from "./api-companion.ts";
import { ApiJobs } from "./api-jobs.ts";
import { type ApiListOptions, ApiStore, type Stored } from "./api-store.ts";
import { ExecutorError, errorPayload } from "./errors.ts";
import { ExecutionPolicies, type ExecutionProfile, type Workspace } from "./execution-policies.ts";
import { IntegrationManager } from "./integrations.ts";
import { type FrozenModelSelection, type ModelProfile, ModelProfiles } from "./model-profiles.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { ReplySegment } from "./protocol.ts";
import { PiToolProvider } from "./providers.ts";
import type { Envelope } from "./runtime-protocol.ts";
import type { ExecutorService } from "./service.ts";
import { commandIdentity, type SessionController, type SessionMetadata, type SessionOptions } from "./session.ts";

export interface SessionData {
	persona_id: string;
	user_id: string;
	persona_revision: string;
	title: string;
	workspace_id: string;
	execution_profile_id: string;
	model_profile_id: string;
	active_run_id: string | null;
}
export interface RunData {
	session_id: string;
	status: "queued" | "running" | "completed" | "failed" | "cancelled";
	input: string;
	message_id: string;
	result?: unknown;
	usage?: unknown;
	error?: unknown;
}
export interface TaskData {
	session_id: string;
	status: "queued" | "running" | "awaiting_approval" | "paused" | "completed" | "failed" | "cancelled";
	input: string;
	workspace_id: string;
	execution_profile_id: string;
	model_profile_id: string;
	pause_requested?: boolean;
	cancel_requested?: boolean;
	result?: unknown;
	usage?: unknown;
	error?: unknown;
}
interface MessageData {
	session_id: string;
	role: "user" | "assistant";
	text: string;
	speech?: string;
	segments?: ReplySegment[];
	run_id?: string;
	task_id?: string;
}
interface NativeRecord {
	file: string;
	metadata: SessionMetadata;
}
interface TaskSnapshot extends NativeRecord {
	workspace: Stored<Workspace>;
	profile: Stored<ExecutionProfile>;
	model_profile: Stored<ModelProfile>;
	frozen_model?: FrozenModelSelection;
	workspace_unavailable?: string;
}
interface ActiveTask {
	controller: SessionController;
	abort: AbortController;
	release: () => void;
	remove: () => void;
}
interface SceneData {
	session_id: string;
	version: 1;
	source_client_id: string;
	captured_at: string;
	expires_at: string;
	allowed_object_ids: string[];
	objects: Record<string, unknown>[];
}
const terminal: Record<string, true> = { completed: true, failed: true, cancelled: true };
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ExecutorError("INVALID_PAYLOAD", "Expected an object");
	return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 65536): string {
	if (typeof value !== "string" || !value.trim() || value.length > max)
		throw new ExecutorError("INVALID_PAYLOAD", `Invalid ${name}`);
	return value;
}
function revision(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1)
		throw new ExecutorError("INVALID_PAYLOAD", "expected_revision is required");
	return value as number;
}
function identifier(value: unknown, fallback?: string): string {
	const result = value === undefined ? fallback : value;
	if (typeof result !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(result))
		throw new ExecutorError("INVALID_PAYLOAD", "Invalid resource identifier");
	return result;
}
function fields(input: Record<string, unknown>, allowed: readonly string[]): void {
	for (const key of Object.keys(input))
		if (!allowed.includes(key)) throw new ExecutorError("INVALID_PAYLOAD", `Unknown field: ${key}`);
}
function utcTimestamp(value: unknown, name: string): number {
	const source = text(value, name, 40);
	const parsed = Date.parse(source);
	if (
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(source) ||
		!Number.isFinite(parsed) ||
		new Date(parsed).toISOString().slice(0, 19) !== source.slice(0, 19)
	)
		throw new ExecutorError("INVALID_PAYLOAD", `${name} must be an RFC3339 UTC timestamp`);
	return parsed;
}

/** Durable resource projection over private, independently owned native runtimes. */
export class ApiRuntime {
	readonly store: ApiStore;
	readonly models: ModelProfiles;
	readonly policy: ExecutionPolicies;
	readonly integrations: IntegrationManager;
	readonly jobs: ApiJobs;
	readonly companion: CompanionApi;
	private readonly service: ExecutorService;
	private readonly chats = new Map<string, SessionController>();
	private readonly tasks = new Map<string, ActiveTask>();
	private readonly subscriptions: (() => void)[] = [];
	private readonly pending = new Set<Promise<void>>();
	private readonly taskWork = new Map<string, Promise<void>>();
	private readonly preparing = new Map<string, AbortController>();
	private readonly deleting = new Set<string>();
	private closed = false;
	private closing: Promise<void> | undefined;

	constructor(service: ExecutorService, settings: ModelSettings) {
		this.service = service;
		this.store = new ApiStore(join(service.dataDir, "api.sqlite"));
		this.models = new ModelProfiles(this.store, settings);
		this.policy = new ExecutionPolicies(this.store, {
			defaultCwd: process.cwd(),
			agentDir: service.agentDir,
			protectedRoots: [service.dataDir],
		});
		this.jobs = new ApiJobs(this.store);
		this.companion = new CompanionApi(this.store, service, this.jobs);
		this.integrations = new IntegrationManager(this.store, {
			agentDir: service.agentDir,
			providerToken: async (provider) => (await settings.getCatalogRuntime().getAuth(provider))?.auth.apiKey,
			assertIdle: () => this.assertIdle(),
			reload: async () => {
				this.assertIdle();
				await Promise.all([...this.chats.values()].map((controller) => controller.reloadResources()));
			},
		});
	}

	async initialize(): Promise<void> {
		await this.models.initialize();
		await this.policy.initialize();
		await this.integrations.initialize();
		await this.companion.initialize();
		this.policy.setToolCatalog(() => this.integrations.listTools());
		const native = this.service.nativeSessions();
		for (const cleanup of this.store.all<{ files: string[] }>("deleted_session_files")) {
			for (const file of cleanup.data.files) {
				await native.find((controller) => controller.manager.getSessionFile() === file)?.close();
				await unlink(file).catch((error: unknown) => {
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				});
			}
			this.store.remove("deleted_session_files", cleanup.id, cleanup.revision);
		}
		for (const record of this.store.all<NativeRecord>("runtime_session")) {
			if (!this.store.get("session", record.id)) continue;
			let controller = native.find((entry) => entry.manager.getSessionFile() === record.data.file);
			if (!controller)
				controller = await this.service.openNativeSession(record.data.file, record.data.metadata, {
					...this.service.nativeOptions(),
					publicSessionId: record.id,
					toolNames: [],
				});
			this.bindChat(record.id, controller);
		}
		for (const controller of native) {
			if (
				this.store.get("migration", controller.id) ||
				this.store
					.all<NativeRecord>("runtime_session")
					.some((r) => r.data.file === controller.manager.getSessionFile())
			)
				continue;
			await this.importLegacy(controller);
		}
		for (const run of this.store.all<RunData>("run")) {
			if (run.data.status !== "queued" && run.data.status !== "running") continue;
			this.updateRun(run.id, {
				status: "failed",
				error: { code: "INTERRUPTED", message: "Run interrupted by restart", retryable: false },
			});
		}
		for (const task of this.store.all<TaskData>("task")) {
			if (["queued", "running", "awaiting_approval"].includes(task.data.status))
				this.updateTask(task.id, { status: "paused", pause_requested: false });
		}
		for (const session of this.store.all<SessionData>("session")) {
			if (session.data.active_run_id)
				this.store.put("session", session.id, { ...session.data, active_run_id: null }, session.revision);
		}
	}

	private assertOpen(sessionId?: string): void {
		if (this.closed) throw new ExecutorError("SERVER_CLOSING", "Executor is shutting down", true);
		if (sessionId && this.deleting.has(sessionId))
			throw new ExecutorError("SESSION_BUSY", "Session deletion is in progress", true);
		if (this.integrations.isChanging())
			throw new ExecutorError("RESOURCE_RELOAD_BUSY", "Integration configuration is changing", true);
	}
	private assertIdle(): void {
		if (
			this.pending.size ||
			this.tasks.size ||
			this.store.all<RunData>("run").some((run) => run.data.status === "running" || run.data.status === "queued")
		)
			throw new ExecutorError("RESOURCE_BUSY", "Wait for active runs and tasks before reloading", true);
	}
	private chatOptions(sessionId: string): SessionOptions {
		const profileId = () => this.getSession(sessionId).data.model_profile_id;
		return {
			...this.service.nativeOptions(),
			publicSessionId: sessionId,
			toolNames: [],
			runtimeFactory: () => this.models.createRuntime(profileId(), "chat"),
			selectModel: (runtime) => this.models.resolve(runtime, profileId(), "chat"),
			untrustedContext: () => this.context(sessionId),
		};
	}
	private bindChat(id: string, controller: SessionController): void {
		controller.configureApi(this.chatOptions(id));
		this.chats.set(id, controller);
		for (const event of controller.eventsAfter(
			this.store.get<{ seq: number }>("projection", controller.id)?.data.seq ?? 0,
		))
			this.project(id, event);
		this.subscriptions.push(controller.subscribe((event) => this.project(id, event)));
	}
	private context(sessionId: string): Record<string, unknown> | undefined {
		const scene = this.store.get<SceneData>("scene", sessionId);
		const summaries = this.store
			.all<TaskData>("task")
			.filter((entry) => entry.data.session_id === sessionId)
			.slice(-8)
			.map((entry) => {
				const result = entry.data.result;
				const summary =
					typeof result === "string"
						? result
						: result && typeof result === "object" && "text" in result && typeof result.text === "string"
							? result.text
							: undefined;
				return {
					task_id: entry.id,
					status: entry.data.status,
					input: entry.data.input.slice(0, 500),
					...(summary === undefined ? {} : { result: summary.slice(0, 2000) }),
				};
			});
		const validScene = scene && Date.parse(scene.data.expires_at) > Date.now() ? scene.data : undefined;
		return validScene || summaries.length ? { scene: validScene, task_summaries: summaries } : undefined;
	}

	async createSession(value: unknown): Promise<Stored<SessionData>> {
		this.assertOpen();
		const input = object(value);
		fields(input, ["persona_id", "user_id", "title", "workspace_id", "execution_profile_id", "model_profile_id"]);
		const persona = await this.service.loadPersona(identifier(input.persona_id, "default"));
		this.assertOpen();
		const workspaceId = identifier(input.workspace_id, "default");
		const executionId = identifier(input.execution_profile_id, "default");
		const modelId = identifier(input.model_profile_id, "default");
		const workspace = this.policy.getWorkspace(workspaceId);
		this.policy.getProfile(executionId);
		this.models.get(modelId);
		const id = randomUUID();
		const userId = identifier(input.user_id, "local");
		if (userId.length > 100) throw new ExecutorError("INVALID_PAYLOAD", "User ID exceeds 100 characters");
		const metadata: SessionMetadata = {
			version: 1,
			persona,
			user_id: userId,
			cwd: workspace.data.root,
			mode: "chat",
			creation_key: id,
			creation_fingerprint: id,
		};
		const data: SessionData = {
			persona_id: persona.id,
			persona_revision: persona.revision,
			user_id: metadata.user_id!,
			title: input.title === undefined ? "" : text(input.title, "title", 200),
			workspace_id: workspaceId,
			execution_profile_id: executionId,
			model_profile_id: modelId,
			active_run_id: null,
		};
		const operation = (async () => {
			const options = this.chatOptions(id);
			options.runtimeFactory = () => this.models.createRuntime(modelId, "chat");
			const controller = await this.service.createNativeSession(
				metadata,
				options,
				join(this.service.dataDir, "api-sessions"),
			);
			try {
				this.assertOpen();
				const resource = this.store.transaction(() => {
					const result = this.store.put<SessionData>("session", id, data, null);
					this.store.put<NativeRecord>(
						"runtime_session",
						id,
						{ file: controller.manager.getSessionFile()!, metadata },
						null,
					);
					this.store.put("migration", controller.id, { imported: true }, null);
					this.store.append(`session:${id}`, "session.created", { ...result }, { session_id: id });
					return result;
				});
				this.bindChat(id, controller);
				return resource;
			} catch (error) {
				await controller.close();
				await unlink(controller.manager.getSessionFile()!);
				throw error;
			}
		})();
		const pending = operation.then(
			() => undefined,
			() => undefined,
		);
		this.pending.add(pending);
		try {
			return await operation;
		} finally {
			this.pending.delete(pending);
		}
	}
	listSessions(query: ApiListOptions = {}) {
		return this.store.list<SessionData>("session", query);
	}
	getSession(id: string) {
		return this.store.require<SessionData>("session", id);
	}
	async patchSession(id: string, value: unknown) {
		this.assertOpen(id);
		const input = object(value);
		const current = this.getSession(id);
		if (
			Object.keys(input).some(
				(key) =>
					!["expected_revision", "title", "workspace_id", "execution_profile_id", "model_profile_id"].includes(
						key,
					),
			)
		)
			throw new ExecutorError("INVALID_PAYLOAD", "Session persona and user are immutable");
		const data = { ...current.data };
		if (input.title !== undefined) data.title = text(input.title, "title", 200);
		if (input.workspace_id !== undefined) {
			data.workspace_id = identifier(input.workspace_id);
			this.policy.getWorkspace(data.workspace_id);
		}
		if (input.execution_profile_id !== undefined) {
			data.execution_profile_id = identifier(input.execution_profile_id);
			this.policy.getProfile(data.execution_profile_id);
		}
		if (input.model_profile_id !== undefined) {
			data.model_profile_id = identifier(input.model_profile_id);
			this.models.get(data.model_profile_id);
		}
		return this.store.transaction(() => {
			const result = this.store.put("session", id, data, revision(input.expected_revision));
			this.store.append(`session:${id}`, "session.updated", { ...result }, { session_id: id });
			return result;
		});
	}
	async deleteSession(id: string, expectedRevision: number) {
		this.assertOpen(id);
		const current = this.getSession(id);
		if (current.revision !== expectedRevision)
			throw new ExecutorError("REVISION_MISMATCH", "Refresh the session before deleting", true);
		if (
			current.data.active_run_id ||
			this.store.all<TaskData>("task").some((t) => t.data.session_id === id && !terminal[t.data.status])
		)
			throw new ExecutorError("SESSION_BUSY", "Cancel or finish session tasks before deleting", true);
		this.deleting.add(id);
		const { promise: finished, resolve: finish } = Promise.withResolvers<void>();
		this.pending.add(finished);
		try {
			await Promise.all(
				this.store
					.all<TaskData>("task")
					.filter((task) => task.data.session_id === id)
					.map((task) => this.taskWork.get(task.id)),
			);
			const controller = this.chats.get(id);
			if (controller) await controller.close();
			const files = new Set<string>();
			const native = this.store.get<NativeRecord>("runtime_session", id);
			if (native) files.add(native.data.file);
			for (const task of this.store.all<TaskData>("task")) {
				if (task.data.session_id !== id) continue;
				const snapshot = this.store.get<TaskSnapshot>("runtime_task", task.id);
				if (snapshot?.data.file) files.add(snapshot.data.file);
			}
			this.store.transaction(() => {
				this.store.put(
					"deleted_session",
					id,
					{ persona_id: current.data.persona_id, user_id: current.data.user_id },
					null,
				);
				this.store.purgeStream(`session:${id}`);
				this.store.append(`session:${id}`, "session.deleted", { id }, { session_id: id });
				this.store.remove("session", id, expectedRevision);
				for (const task of this.store.all<TaskData>("task")) {
					if (task.data.session_id !== id) continue;
					const snapshot = this.store.get("runtime_task", task.id);
					if (snapshot) this.store.remove("runtime_task", task.id, snapshot.revision);
				}
				for (const kind of ["message", "segment", "scene", "presentation", "run", "task", "tool_call", "approvals"])
					for (const entry of this.store.all<{ session_id: string }>(kind))
						if (entry.data.session_id === id) this.store.remove(kind, entry.id, entry.revision);
				if (native) this.store.remove("runtime_session", id, native.revision);
				this.store.put("deleted_session_files", id, { files: [...files] }, null);
			});
			this.chats.delete(id);
			for (const file of files)
				await unlink(file).catch((error: unknown) => {
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				});
			const cleanup = this.store.require("deleted_session_files", id);
			this.store.remove("deleted_session_files", id, cleanup.revision);
			return { id, deleted: true };
		} finally {
			this.deleting.delete(id);
			this.pending.delete(finished);
			finish();
		}
	}
	listMessages(id: string, query: ApiListOptions = {}) {
		this.getSession(id);
		return this.store.list<MessageData>("message", { ...query, filter: { ...query.filter, session_id: id } });
	}
	async submitMessage(id: string, value: unknown): Promise<Stored<RunData>> {
		this.assertOpen(id);
		const body = object(value);
		fields(body, ["text"]);
		const input = text(body.text, "text");
		const session = this.getSession(id);
		if (session.data.active_run_id)
			throw new ExecutorError("SESSION_BUSY", "A foreground run is already executing", true);
		const controller = this.chats.get(id);
		if (!controller) throw new ExecutorError("RUNTIME_UNAVAILABLE", "Session runtime is unavailable");
		const runId = randomUUID();
		const messageId = randomUUID();
		const result = this.store.transaction(() => {
			const message = this.store.put<MessageData>(
				"message",
				messageId,
				{ session_id: id, role: "user", text: input, run_id: runId },
				null,
			);
			const run = this.store.put<RunData>(
				"run",
				runId,
				{ session_id: id, status: "queued", input, message_id: messageId },
				null,
			);
			this.store.put("session", id, { ...session.data, active_run_id: runId }, session.revision);
			this.store.append(`session:${id}`, "message.created", { ...message }, { session_id: id, run_id: runId });
			return run;
		});
		try {
			await this.command(controller, "input.submit", { text: input, run_id: runId });
		} catch (error) {
			this.updateRun(runId, { status: "failed", error: errorPayload(error) });
			throw error;
		}
		return this.getRun(result.id);
	}
	getRun(id: string) {
		return this.store.require<RunData>("run", id);
	}
	async cancelRun(id: string) {
		this.assertOpen();
		const run = this.getRun(id);
		if (terminal[run.data.status]) return run;
		const controller = this.chats.get(run.data.session_id)!;
		await this.command(controller, "run.cancel", {}, id);
		return this.getRun(id);
	}

	async createTask(sessionId: string, value: unknown): Promise<Stored<TaskData>> {
		this.assertOpen(sessionId);
		const session = this.getSession(sessionId);
		const input = object(value);
		fields(input, ["input", "workspace_id", "execution_profile_id", "model_profile_id"]);
		const workspaceId = identifier(input.workspace_id, session.data.workspace_id);
		const profileId = identifier(input.execution_profile_id, session.data.execution_profile_id);
		const modelId = identifier(input.model_profile_id, session.data.model_profile_id);
		const workspace = this.policy.getWorkspace(workspaceId);
		const profile = this.policy.getProfile(profileId);
		const modelProfile = this.models.get(modelId);
		const id = randomUUID();
		const chat = this.store.require<NativeRecord>("runtime_session", sessionId);
		const metadata = {
			...chat.data.metadata,
			cwd: workspace.data.root,
			mode: "agent" as const,
			creation_key: id,
			creation_fingerprint: id,
		};
		const resource = this.store.transaction(() => {
			const task = this.store.put<TaskData>(
				"task",
				id,
				{
					session_id: sessionId,
					status: "queued",
					input: text(input.input, "input"),
					workspace_id: workspaceId,
					execution_profile_id: profileId,
					model_profile_id: modelId,
				},
				null,
			);
			this.store.put<TaskSnapshot>(
				"runtime_task",
				id,
				{
					file: "",
					metadata,
					workspace,
					profile,
					model_profile: modelProfile,
					frozen_model: this.models.capture(modelId, "agent"),
				},
				null,
			);
			this.store.append(
				`session:${sessionId}`,
				"task.created",
				{ id: task.id, revision: task.revision, session_id: sessionId, status: task.data.status },
				{ session_id: sessionId, task_id: id },
			);
			return task;
		});
		this.launchTask(id, false);
		return resource;
	}
	listTasks(query: ApiListOptions = {}) {
		return this.store.list<TaskData>("task", query);
	}
	getTask(id: string) {
		return this.store.require<TaskData>("task", id);
	}
	async pauseTask(id: string) {
		this.assertOpen();
		const task = this.getTask(id);
		if (task.data.status === "paused") return task;
		if (terminal[task.data.status]) throw new ExecutorError("TASK_NOT_RUNNING", "Task already ended");
		if (task.data.status === "queued" && !this.preparing.has(id))
			return this.updateTask(id, { status: "paused", pause_requested: false });
		const result = this.updateTask(id, { pause_requested: true });
		this.tasks.get(id)?.controller.requestPause();
		return result;
	}
	async resumeTask(id: string) {
		if (this.getTask(id).data.status !== "paused")
			throw new ExecutorError("TASK_NOT_RESUMABLE", "Task is not paused");
		this.assertOpen();
		await this.taskWork.get(id);
		this.assertOpen();
		const task = this.getTask(id);
		if (task.data.status !== "paused") throw new ExecutorError("TASK_NOT_RESUMABLE", "Task is not paused");
		const snapshot = this.store.require<TaskSnapshot>("runtime_task", id);
		if (snapshot.data.workspace_unavailable)
			throw new ExecutorError("WORKSPACE_UNAVAILABLE", snapshot.data.workspace_unavailable);
		const result = this.updateTask(id, { status: "queued", pause_requested: false, cancel_requested: false });
		this.launchTask(id, true);
		return result;
	}
	async cancelTask(id: string) {
		this.assertOpen();
		const task = this.getTask(id);
		if (terminal[task.data.status]) return task;
		const active = this.tasks.get(id);
		if (active) {
			this.updateTask(id, { cancel_requested: true });
			await this.command(active.controller, "run.cancel", {}, id);
			active.abort.abort();
			return this.getTask(id);
		}
		this.preparing.get(id)?.abort();
		return this.updateTask(id, { status: "cancelled", cancel_requested: false });
	}
	toolCalls(id: string, query: ApiListOptions = {}) {
		this.getTask(id);
		return this.store.list<Record<string, unknown>>("tool_call", {
			...query,
			filter: { ...query.filter, task_id: id },
		});
	}

	private launchTask(id: string, resume: boolean): void {
		if (this.closed || this.preparing.has(id) || this.tasks.has(id)) return;
		const task = this.getTask(id);
		const snapshot = this.store.require<TaskSnapshot>("runtime_task", id);
		const running = [...this.preparing.keys()].filter(
			(activeId) => this.getTask(activeId).data.execution_profile_id === task.data.execution_profile_id,
		).length;
		if (running >= snapshot.data.profile.data.max_concurrent_tasks) return;
		const operation = this.executeTask(id, resume).catch((error: unknown) => {
			const task = this.getTask(id);
			if (!terminal[task.data.status] && task.data.status !== "paused")
				this.updateTask(id, { status: "failed", error: errorPayload(error) });
		});
		this.pending.add(operation);
		this.taskWork.set(id, operation);
		const settled = () => {
			this.preparing.delete(id);
			this.pending.delete(operation);
			this.taskWork.delete(id);
			if (!this.closed)
				for (const queued of this.store.all<TaskData>("task"))
					if (queued.data.status === "queued")
						this.launchTask(
							queued.id,
							Boolean(this.store.require<TaskSnapshot>("runtime_task", queued.id).data.file),
						);
		};
		void operation.then(settled, settled);
	}
	private async executeTask(id: string, resume: boolean): Promise<void> {
		const task = this.getTask(id);
		const snapshot = this.store.require<TaskSnapshot>("runtime_task", id);
		const abort = new AbortController();
		this.preparing.set(id, abort);
		const prepared = await this.policy.prepare(
			id,
			task.data.workspace_id,
			task.data.execution_profile_id,
			abort.signal,
			(state) => {
				if (!terminal[this.getTask(id).data.status]) this.updateTask(id, { status: state });
			},
			{ workspace: snapshot.data.workspace, profile: snapshot.data.profile, session_id: task.data.session_id },
		);
		let controller: SessionController | undefined;
		let remove: (() => void) | undefined;
		try {
			if (this.closed || terminal[this.getTask(id).data.status]) return;
			const modelSnapshot = snapshot.data.model_profile;
			const toolProvider = this.service.nativeOptions().tools;
			const trustedExtensions =
				prepared.profile.data.isolation !== "trusted_host"
					? []
					: toolProvider instanceof PiToolProvider
						? [createCodemodeExtension({ mode: "on" }), createToolSearchExtension()]
						: toolProvider.extensions();
			const options: SessionOptions = {
				...this.service.nativeOptions(),
				companion: undefined,
				runtimeFactory: () =>
					this.models.createRuntime(
						task.data.model_profile_id,
						"agent",
						modelSnapshot,
						snapshot.data.frozen_model,
					),
				selectModel: undefined,
				maxModelCalls: prepared.profile.data.max_model_calls,
				maxOutputTokens: modelSnapshot.data.agent.max_output_tokens,
				tools: {
					extensions: () => [
						...trustedExtensions,
						...(prepared.profile.data.isolation === "trusted_host" ? this.integrations.runtimeExtensions() : []),
						...prepared.extensions,
					],
				},
				resourceSettings:
					prepared.profile.data.isolation === "trusted_host"
						? () => this.integrations.resourceSettings()
						: undefined,
				untrustedContext: () => this.context(task.data.session_id),
				toolNames: prepared.tools,
				authorizeToolCall: prepared.authorizeToolCall,
				taskRefs: [id],
			};
			controller = snapshot.data.file
				? await this.service.openNativeSession(snapshot.data.file, snapshot.data.metadata, options)
				: await this.service.createNativeSession(
						snapshot.data.metadata,
						options,
						join(this.service.dataDir, "tasks"),
					);
			if (!snapshot.data.file)
				this.store.put(
					"runtime_task",
					id,
					{ ...snapshot.data, file: controller.manager.getSessionFile()! },
					snapshot.revision,
				);
			for (const event of controller.eventsAfter(
				this.store.get<{ seq: number }>("projection", controller.id)?.data.seq ?? 0,
			))
				this.project(task.data.session_id, event, id);
			remove = controller.subscribe((event) => this.project(task.data.session_id, event, id));
			const native = controller;
			const cancel = () => {
				void this.command(native, "run.cancel", {}, id).catch(() => undefined);
			};
			prepared.signal.addEventListener("abort", cancel, { once: true });
			this.tasks.set(id, { controller, abort, release: prepared.release, remove });
			if (prepared.signal.aborted) {
				this.updateTask(id, { status: "cancelled" });
				return;
			}
			if (this.getTask(id).data.pause_requested) {
				this.updateTask(id, { status: "paused", pause_requested: false });
				return;
			}
			if (resume && controller.eventsAfter(0).some((event) => event.run_id === id))
				await this.command(controller, "run.resume", {}, id);
			else await this.command(controller, "input.submit", { text: task.data.input, run_id: id });
			if (this.getTask(id).data.pause_requested) controller.requestPause();
			await controller.waitForIdle();
			prepared.signal.removeEventListener("abort", cancel);
		} finally {
			try {
				await controller?.close();
			} finally {
				remove?.();
				this.tasks.delete(id);
				this.preparing.delete(id);
				prepared.release();
			}
		}
	}

	async putScene(sessionId: string, value: unknown) {
		this.assertOpen(sessionId);
		this.getSession(sessionId);
		const input = object(value);
		fields(input, [
			"expected_revision",
			"version",
			"source_client_id",
			"captured_at",
			"expires_at",
			"allowed_object_ids",
			"objects",
		]);
		if (
			Buffer.byteLength(JSON.stringify(input)) > 32768 ||
			input.version !== 1 ||
			!Array.isArray(input.objects) ||
			input.objects.length > 100 ||
			!Array.isArray(input.allowed_object_ids) ||
			input.allowed_object_ids.length > 100
		)
			throw new ExecutorError(
				"INVALID_PAYLOAD",
				"Scene requires version 1, at most 100 allowlisted objects and 32 KiB",
			);
		const captured = utcTimestamp(input.captured_at, "captured_at");
		const expires = utcTimestamp(input.expires_at, "expires_at");
		if (
			!Number.isFinite(captured) ||
			!Number.isFinite(expires) ||
			captured > Date.now() + 30000 ||
			expires <= Date.now() ||
			expires <= captured ||
			expires - captured > 300000
		)
			throw new ExecutorError("INVALID_PAYLOAD", "Scene timestamps must be valid and expire within five minutes");
		const allowed = input.allowed_object_ids.map((entry) => identifier(entry));
		const seen = new Set<string>();
		const objects = input.objects.map((entry: unknown) => {
			const item = object(entry);
			const id = identifier(item.id);
			if (
				!allowed.includes(id) ||
				seen.has(id) ||
				Object.keys(item).some((key) => !["id", "label", "description", "position"].includes(key))
			)
				throw new ExecutorError("INVALID_PAYLOAD", "Scene object is not uniquely allowlisted");
			seen.add(id);
			if (item.label !== undefined) text(item.label, "label", 200);
			if (item.description !== undefined) text(item.description, "description", 2000);
			if (item.position !== undefined) {
				const position = object(item.position);
				if (
					Object.keys(position).length !== 3 ||
					![position.x, position.y, position.z].every((n) => typeof n === "number" && Number.isFinite(n))
				)
					throw new ExecutorError("INVALID_PAYLOAD", "Invalid position");
			}
			return item;
		});
		return this.store.transaction(() => {
			const result = this.store.put<SceneData>(
				"scene",
				sessionId,
				{
					session_id: sessionId,
					version: 1,
					source_client_id: identifier(input.source_client_id),
					captured_at: new Date(captured).toISOString(),
					expires_at: new Date(expires).toISOString(),
					allowed_object_ids: allowed,
					objects,
				},
				input.expected_revision === null ? null : revision(input.expected_revision),
			);
			this.store.append(`session:${sessionId}`, "scene.updated", { ...result }, { session_id: sessionId });
			return result;
		});
	}
	async presentation(sessionId: string, value: unknown) {
		this.assertOpen(sessionId);
		this.getSession(sessionId);
		const input = object(value);
		const segmentId = text(input.segment_id, "segment_id", 300);
		fields(input, ["segment_id", "status", "occurred_at", "error_code"]);
		const segment = this.store.get<{ session_id: string; segment: ReplySegment }>("segment", segmentId);
		if (!segment || segment.data.session_id !== sessionId)
			throw new ExecutorError("NOT_FOUND", "Segment does not belong to this session");
		if (!["started", "completed", "interrupted", "failed"].includes(String(input.status)))
			throw new ExecutorError("INVALID_PAYLOAD", "Invalid presentation status");
		const timestamp = utcTimestamp(input.occurred_at, "occurred_at");
		const current = this.store.get<Record<string, unknown>>("presentation", segmentId);
		if (current?.data.status === input.status) return current;
		if (current && current.data.status !== "started")
			throw new ExecutorError("INVALID_TRANSITION", "Presentation already ended");
		if (!current && input.status !== "started")
			throw new ExecutorError("INVALID_TRANSITION", "Presentation must start before it ends");
		if (current && timestamp < Date.parse(String(current.data.occurred_at)))
			throw new ExecutorError("INVALID_TRANSITION", "Presentation time cannot move backwards");
		if (input.error_code !== undefined) identifier(input.error_code);
		return this.store.transaction(() => {
			const result = this.store.put(
				"presentation",
				segmentId,
				{
					session_id: sessionId,
					segment_id: segmentId,
					status: input.status,
					occurred_at: new Date(timestamp).toISOString(),
					...(input.error_code === undefined ? {} : { error_code: input.error_code }),
				},
				current?.revision ?? null,
			);
			this.store.append(`session:${sessionId}`, "presentation.updated", { ...result }, { session_id: sessionId });
			return result;
		});
	}

	private async command(
		controller: SessionController,
		type: string,
		payload: Record<string, unknown>,
		runId?: string,
	): Promise<void> {
		const command: Envelope = {
			v: 1,
			id: randomUUID(),
			type,
			session_id: controller.id,
			mode_revision: controller.snapshot().mode_revision as number,
			...(runId ? { run_id: runId } : {}),
			payload,
		};
		await controller.handle(command, commandIdentity("api-runtime", command));
	}
	private updateRun(id: string, patch: Partial<RunData>) {
		return this.store.transaction(() => {
			const current = this.getRun(id);
			const result = this.store.put("run", id, { ...current.data, ...patch }, current.revision);
			if (patch.status && terminal[patch.status]) {
				const session = this.store.get<SessionData>("session", current.data.session_id);
				if (session?.data.active_run_id === id)
					this.store.put("session", session.id, { ...session.data, active_run_id: null }, session.revision);
			}
			this.store.append(
				`session:${current.data.session_id}`,
				result.data.status === "running" ? "run.started" : `run.${result.data.status}`,
				{
					id,
					revision: result.revision,
					session_id: result.data.session_id,
					status: result.data.status,
					...(result.data.usage === undefined ? {} : { usage: result.data.usage }),
				},
				{ session_id: current.data.session_id, run_id: id },
			);
			return result;
		});
	}
	private updateTask(id: string, patch: Partial<TaskData>) {
		return this.store.transaction(() => {
			const current = this.getTask(id);
			const result = this.store.put("task", id, { ...current.data, ...patch }, current.revision);
			this.store.append(
				`session:${current.data.session_id}`,
				`task.${result.data.status}`,
				{
					id,
					revision: result.revision,
					session_id: result.data.session_id,
					status: result.data.status,
					...(result.data.pause_requested === undefined ? {} : { pause_requested: result.data.pause_requested }),
					...(result.data.cancel_requested === undefined
						? {}
						: { cancel_requested: result.data.cancel_requested }),
					...(result.data.usage === undefined ? {} : { usage: result.data.usage }),
				},
				{ session_id: current.data.session_id, task_id: id },
			);
			return result;
		});
	}
	private project(sessionId: string, event: Envelope, taskId?: string): void {
		const projection = this.store.get<{ seq: number }>("projection", event.session_id!);
		if ((projection?.data.seq ?? 0) >= (event.seq ?? 0)) return;
		this.store.transaction(() => {
			const fields = {
				session_id: sessionId,
				...(taskId ? { task_id: taskId } : event.run_id ? { run_id: event.run_id } : {}),
			};
			const id = taskId ?? event.run_id;
			if (id && event.type === "reply.segment") {
				const segment = this.migrateSegment(event.payload, `${id}:assistant`);
				this.store.put(
					"segment",
					segment.segment_id,
					{ session_id: sessionId, segment },
					this.store.get("segment", segment.segment_id)?.revision ?? null,
				);
				const existing = this.store.get<MessageData>("message", segment.message_id);
				const segments = [...(existing?.data.segments ?? []), segment];
				const message = this.store.put<MessageData>(
					"message",
					segment.message_id,
					{
						session_id: sessionId,
						role: "assistant",
						text: segments.map((s) => s.text).join(""),
						speech: segments.map((s) => s.speech).join(""),
						segments,
						...(taskId ? { task_id: taskId } : { run_id: id }),
					},
					existing?.revision ?? null,
				);
				this.store.append(`session:${sessionId}`, "reply.segment", { ...segment }, fields);
				this.store.append(
					`session:${sessionId}`,
					"message.updated",
					{
						message_id: message.id,
						revision: message.revision,
						session_id: sessionId,
						status: "streaming",
						role: "assistant",
					},
					fields,
				);
			} else if (id && event.type.startsWith("tool.")) {
				const toolId = `${id}:${String(event.payload.tool_call_id)}`;
				const previous = this.store.get<Record<string, unknown>>("tool_call", toolId);
				const resource = this.store.put(
					"tool_call",
					toolId,
					{
						...previous?.data,
						...event.payload,
						session_id: sessionId,
						...(taskId ? { task_id: taskId } : { run_id: id }),
					},
					previous?.revision ?? null,
				);
				this.store.append(`session:${sessionId}`, event.type, { ...resource }, fields);
			} else if (
				id &&
				["run.started", "run.resumed", "run.paused", "run.completed", "run.failed", "run.cancelled"].includes(
					event.type,
				)
			) {
				const status =
					event.type === "run.started" || event.type === "run.resumed" ? "running" : event.type.slice(4);
				const message = this.store.get<MessageData>("message", `${id}:assistant`);
				const segments = message?.data.segments ?? [];
				const raw =
					event.payload.result && typeof event.payload.result === "object"
						? (event.payload.result as Record<string, unknown>)
						: undefined;
				const result =
					raw === undefined
						? undefined
						: {
								segments,
								text: message?.data.text ?? (typeof raw.speech === "string" ? raw.speech : ""),
								speech: message?.data.speech ?? (typeof raw.speech === "string" ? raw.speech : ""),
							};
				const patch = {
					...(result === undefined ? {} : { result }),
					...(event.payload.usage === undefined ? {} : { usage: event.payload.usage }),
					...(event.payload.error === undefined ? {} : { error: event.payload.error }),
				};
				if (taskId && this.store.get("task", taskId))
					this.updateTask(taskId, { ...patch, status: status as TaskData["status"], pause_requested: false });
				else if (this.store.get("run", id))
					this.updateRun(id, { ...patch, status: status === "paused" ? "failed" : (status as RunData["status"]) });
			} else if (event.type === "reply.warning" || event.type === "context.trimmed") {
				this.store.append(`session:${sessionId}`, event.type, event.payload, fields);
			}
			this.store.put("projection", event.session_id!, { seq: event.seq ?? 0 }, projection?.revision ?? null);
		});
	}
	private migrateSegment(payload: Record<string, unknown>, messageId: string): ReplySegment {
		if (typeof payload.message_id === "string" && payload.expression && typeof payload.expression === "object")
			return payload as unknown as ReplySegment;
		const speech = typeof payload.speech === "string" ? payload.speech : "";
		const description = "历史回复";
		return {
			message_id: messageId,
			segment_id: String(payload.segment_id),
			index: Number(payload.index),
			expression: { description, language: "zh-CN" },
			speech,
			text: `（${description}）${speech}`,
			task_refs: [],
		};
	}
	private async importLegacy(controller: SessionController): Promise<void> {
		const id = controller.id;
		const metadata = controller.metadata;
		const events = controller.eventsAfter(0);
		const hasAgentHistory = events.some(
			(event) => event.type === "command.accepted" && event.payload.mode === "agent",
		);
		let workspace = this.policy.getWorkspace("default");
		let workspaceUnavailable: string | undefined;
		if (metadata.cwd !== workspace.data.root) {
			try {
				const workspaceId = `legacy-${id}`;
				workspace =
					this.store.get<Workspace>("workspaces", workspaceId) ??
					(await this.policy.createWorkspace({
						id: workspaceId,
						name: `Imported session ${id}`,
						root: metadata.cwd,
					}));
			} catch (error) {
				if (
					!(error instanceof ExecutorError && ["INVALID_PAYLOAD", "VALIDATION_ERROR"].includes(error.code)) &&
					!(error instanceof Error && "code" in error && error.code === "ENOENT")
				)
					throw error;
				workspaceUnavailable =
					"The legacy working directory is unavailable or protected; create a task in a registered workspace";
			}
		}
		const calls = new Map<string, string[]>();
		for (const event of events) {
			if (event.type !== "tool.started" || !event.run_id || typeof event.payload.tool_call_id !== "string") continue;
			const ids = calls.get(event.run_id) ?? [];
			ids.push(event.payload.tool_call_id);
			calls.set(event.run_id, ids);
		}
		const native =
			hasAgentHistory || controller.snapshot().mode === "agent"
				? await this.service.createNativeSession(
						{ ...metadata, mode: "chat", creation_key: randomUUID() },
						this.service.nativeOptions(),
						join(this.service.dataDir, "api-sessions"),
					)
				: controller;
		let frozenModel: FrozenModelSelection | undefined;
		try {
			frozenModel = this.models.capture("default", "agent");
		} catch (error) {
			if (!(error instanceof ExecutorError && ["MODEL_UNAVAILABLE", "INVALID_PAYLOAD"].includes(error.code)))
				throw error;
		}
		this.store.transaction(() => {
			this.store.put<SessionData>(
				"session",
				id,
				{
					persona_id: metadata.persona.id,
					persona_revision: metadata.persona.revision,
					user_id: metadata.user_id ?? "local",
					title: "",
					workspace_id: workspace.id,
					execution_profile_id: "default",
					model_profile_id: "default",
					active_run_id: null,
				},
				null,
			);
			this.store.put<NativeRecord>(
				"runtime_session",
				id,
				{ file: native.manager.getSessionFile()!, metadata: native.metadata },
				null,
			);
			for (const event of events) {
				if (event.type !== "command.accepted" || event.payload.operation !== "input.submit" || !event.run_id)
					continue;
				const task = event.payload.mode === "agent";
				if (task) {
					this.store.put<TaskData>(
						"task",
						event.run_id,
						{
							session_id: id,
							status: "paused",
							input: String(event.payload.input),
							workspace_id: workspace.id,
							execution_profile_id: "default",
							model_profile_id: "default",
						},
						null,
					);
					this.policy.importToolCalls(event.run_id, calls.get(event.run_id) ?? []);
					this.store.put<TaskSnapshot>(
						"runtime_task",
						event.run_id,
						{
							file: controller.manager.getSessionFile()!,
							metadata: { ...metadata, cwd: workspace.data.root, mode: "agent" },
							workspace,
							profile: this.policy.getProfile("default"),
							model_profile: this.models.get("default"),
							...(workspaceUnavailable ? { workspace_unavailable: workspaceUnavailable } : {}),
							...(frozenModel ? { frozen_model: frozenModel } : {}),
						},
						null,
					);
				} else
					this.store.put<RunData>(
						"run",
						event.run_id,
						{
							session_id: id,
							status: "failed",
							input: String(event.payload.input),
							message_id: `${event.run_id}:user`,
						},
						null,
					);
				this.store.put<MessageData>(
					"message",
					`${event.run_id}:user`,
					{
						session_id: id,
						role: "user",
						text: String(event.payload.input),
						...(task ? { task_id: event.run_id } : { run_id: event.run_id }),
					},
					null,
				);
			}
			for (const event of events)
				this.project(id, event, event.run_id && this.store.get("task", event.run_id) ? event.run_id : undefined);
			if (workspaceUnavailable)
				for (const task of this.store.all<TaskData>("task"))
					if (task.data.session_id === id && task.data.status === "paused")
						this.updateTask(task.id, {
							error: { code: "WORKSPACE_UNAVAILABLE", message: workspaceUnavailable, retryable: false },
						});
			this.store.put("migration", id, { imported: true }, null);
			if (native.id !== id) this.store.put("migration", native.id, { imported: true }, null);
			this.store.append(
				`session:${id}`,
				"session.created",
				{ ...this.getSession(id), migrated: true },
				{ session_id: id },
			);
		});
		this.bindChat(id, native);
	}
	capabilities() {
		return {
			api_version: "1",
			socket_path: "/dw-agent/v1",
			input_types: ["text"],
			reply_format: "expression_speech",
			protocol: { versions: [1], socket_path: "/dw-agent/v1", commands: ["hello", "subscribe", "unsubscribe"] },
			http: { prefix: "/api", idempotency: true },
			events: { durable: true, replay: true, delivery: "at-least-once" },
			features: {
				chat: true,
				tasks: true,
				approvals: true,
				concurrent_chat_tasks: true,
				task_pause_resume: true,
				scene_context: true,
				presentation_feedback: true,
				companion: true,
				jobs: true,
				mcp: true,
				installed_resources: true,
				multisubscriber: true,
				model_profiles: true,
				execution_policies: true,
			},
			isolation: this.policy.capabilities(),
		};
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.closing = (async () => {
			try {
				for (const task of this.store.all<TaskData>("task"))
					if (task.data.status === "queued")
						this.updateTask(task.id, { status: "paused", pause_requested: false });
				for (const [id, abort] of this.preparing) if (!this.tasks.has(id)) abort.abort();
				const results = await Promise.allSettled([
					this.service.closeCompanionLife(),
					...[...this.tasks.values()].map((task) => task.controller.close()),
					...[...this.chats.values()].map((controller) => controller.close()),
				]);
				results.push(...(await Promise.allSettled([...this.pending])));
				results.push(
					...(await Promise.allSettled([
						Promise.resolve().then(() => this.companion.close()),
						Promise.resolve().then(() => this.jobs.close()),
						Promise.resolve().then(() => this.integrations.close()),
						Promise.resolve().then(() => this.policy.close()),
					])),
				);
				const failed = results.find((result) => result.status === "rejected");
				if (failed?.status === "rejected") throw failed.reason;
			} finally {
				for (const remove of this.subscriptions) remove();
				this.store.close();
			}
		})();
		return this.closing;
	}
}
