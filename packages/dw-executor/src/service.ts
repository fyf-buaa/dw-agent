import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { Check } from "typebox/value";
import { SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import { ApiRuntime } from "./api-runtime.ts";
import { CompanionLife, type LifeJobScheduler } from "./companion-life.ts";
import { LifeModelClient } from "./companion-life-model.ts";
import { CompanionLifeStore } from "./companion-life-store.ts";
import {
	type DiaryListOptions,
	LifeAdvanceSchema,
	LifeGenerateSchema,
	type LifeJobKind,
} from "./companion-life-types.ts";
import { CompanionRuntime } from "./companion-runtime.ts";
import { CompanionStore } from "./companion-store.ts";
import {
	CompanionIdentifierSchema,
	DEFAULT_ROLEPLAY,
	type MemoryListOptions,
	type MemoryScope,
} from "./companion-types.ts";
import { type ContextPolicy, ProportionalContextPolicy } from "./context-policy.ts";
import { ExecutorError } from "./errors.ts";
import { ModelSettings } from "./model-settings.ts";
import {
	FilePersonaProvider,
	type PersonaProvider,
	PersonaSchema,
	type PersonaSnapshot,
	PiToolProvider,
	type ToolProvider,
} from "./providers.ts";
import { type Envelope, parseEnvelope } from "./runtime-protocol.ts";
import {
	commandIdentity,
	type RuntimeSelection,
	SessionController,
	type SessionMetadata,
	type SessionOptions,
} from "./session.ts";

export interface ExecutorOptions {
	dataDir: string;
	agentDir?: string;
	provider?: string;
	model?: string;
	maxModelCalls?: number;
	maxOutputTokens?: number;
	/** Disable only automatic maintenance; explicit life generation remains available. */
	backgroundMaintenance?: boolean;
	personaProvider?: PersonaProvider;
	contextPolicy?: ContextPolicy;
	toolProvider?: ToolProvider;
	runtimeFactory?: (agentDir: string) => Promise<RuntimeSelection>;
}

export class ExecutorService {
	readonly dataDir: string;
	readonly agentDir: string;
	api!: ApiRuntime;
	private readonly sessions = new Map<string, SessionController>();
	private readonly pendingCreations = new Map<string, { manager: SessionManager; metadata: SessionMetadata }>();
	private readonly sessionInvalidations = new Set<(id: string, deleted: boolean) => void>();
	private readonly sessionDirectory: string;
	private readonly sessionOptions: SessionOptions;
	private readonly personas: PersonaProvider;
	private readonly modelSettings: ModelSettings;
	private companionStore!: CompanionStore;
	private companion!: CompanionRuntime;
	private lifeStore!: CompanionLifeStore;
	private life!: CompanionLife;
	private lifeModel!: LifeModelClient;
	private readonly backgroundMaintenance: boolean;
	private queue: Promise<void> = Promise.resolve();
	private closed = false;
	private closePromise: Promise<void> | undefined;
	private releaseLock: (() => Promise<void>) | undefined;

	constructor(options: ExecutorOptions) {
		this.dataDir = resolve(options.dataDir);
		this.sessionDirectory = join(resolve(options.dataDir), "sessions");
		this.personas = options.personaProvider ?? new FilePersonaProvider(join(options.dataDir, "personas"));
		const agentDir = resolve(options.agentDir ?? join(options.dataDir, "pi"));
		this.agentDir = agentDir;
		this.modelSettings = new ModelSettings(
			resolve(options.dataDir),
			agentDir,
			options,
			options.runtimeFactory ? () => options.runtimeFactory!(agentDir) : undefined,
		);
		const maxModelCalls = options.maxModelCalls ?? 32;
		const maxOutputTokens = options.maxOutputTokens ?? 8192;
		this.backgroundMaintenance = options.backgroundMaintenance ?? true;
		if (
			!Number.isSafeInteger(maxModelCalls) ||
			maxModelCalls < 1 ||
			!Number.isSafeInteger(maxOutputTokens) ||
			maxOutputTokens < 1
		)
			throw new Error("Invalid executor model budgets");
		this.sessionOptions = {
			agentDir,
			runtimeFactory: () => this.modelSettings.createRuntime(),
			selectModel: (runtime) => this.enqueue(() => this.modelSettings.resolve(runtime)),
			tools: options.toolProvider ?? new PiToolProvider(),
			context: options.contextPolicy ?? new ProportionalContextPolicy(),
			maxModelCalls,
			maxOutputTokens,
		};
	}

	async initialize(): Promise<void> {
		await mkdir(this.sessionDirectory, { recursive: true, mode: 0o700 });
		this.releaseLock = await lockfile.lock(resolve(this.sessionDirectory, ".."), { retries: 0, stale: 30000 });
		try {
			await mkdir(this.sessionOptions.agentDir, { recursive: true, mode: 0o700 });
			await this.modelSettings.initialize();
			this.companionStore = await CompanionStore.open(join(this.sessionDirectory, "..", "companion.sqlite"));
			this.lifeStore = await CompanionLifeStore.open(join(this.sessionDirectory, "..", "companion-life.sqlite"));
			this.lifeModel = new LifeModelClient(this.modelSettings, this.sessionOptions.context);
			this.life = new CompanionLife({
				store: this.lifeStore,
				memories: this.companionStore,
				loadPersona: (id) => this.personas.load(id),
				complete: (request) => this.lifeModel.complete(request),
			});
			this.companion = new CompanionRuntime(this.companionStore, this.life);
			this.sessionOptions.companion = this.companion;
			for (const name of (await readdir(this.sessionDirectory)).filter((file) => file.endsWith(".jsonl"))) {
				const file = join(this.sessionDirectory, name);
				await copyFile(file, `${file}.api-backup`, constants.COPYFILE_EXCL).catch((error: unknown) => {
					if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
				});
				const manager = SessionManager.open(join(this.sessionDirectory, name), this.sessionDirectory);
				const entry = manager
					.getEntries()
					.find((item) => item.type === "custom" && item.customType === "dw.session");
				if (!entry || entry.type !== "custom") throw new Error(`Missing executor metadata in session ${name}`);
				const metadata = entry.data as SessionMetadata;
				if (
					metadata.version !== 1 ||
					!Check(PersonaSchema, metadata.persona) ||
					!["chat", "agent"].includes(metadata.mode) ||
					typeof metadata.cwd !== "string" ||
					(metadata.user_id !== undefined && !Check(CompanionIdentifierSchema, metadata.user_id))
				)
					throw new Error(`Invalid executor metadata in session ${name}`);
				const controller = await SessionController.open(manager, metadata, this.sessionOptions);
				this.sessions.set(controller.id, controller);
			}
			this.api = new ApiRuntime(this, this.modelSettings);
			await this.api.initialize();
			this.lifeModel.setProfiles(this.api.models);
			if (this.backgroundMaintenance) this.life.start();
		} catch (error) {
			await this.api?.close();
			await Promise.allSettled([this.life?.close(), this.lifeModel?.close()]);
			await Promise.allSettled([...this.sessions.values()].map((session) => session.close()));
			this.sessions.clear();
			try {
				try {
					this.lifeStore?.close();
				} finally {
					this.companionStore?.close();
				}
			} finally {
				await this.releaseLock();
				this.releaseLock = undefined;
			}
			throw error;
		}
	}

	/** Private native execution support; HTTP and WS must use api resources. */
	nativeSessions(): SessionController[] {
		return [...this.sessions.values()];
	}

	nativeOptions(): SessionOptions {
		return { ...this.sessionOptions };
	}

	async loadPersona(id: string): Promise<PersonaSnapshot> {
		const persona = await this.personas.load(id);
		if (!Check(PersonaSchema, persona) || persona.id !== id)
			throw new ExecutorError("INVALID_PERSONA", "Persona provider returned an invalid snapshot");
		return persona;
	}

	async createNativeSession(
		metadata: SessionMetadata,
		options = this.sessionOptions,
		directory = this.sessionDirectory,
	): Promise<SessionController> {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const manager = SessionManager.create(metadata.cwd, directory);
		manager.appendCustomEntry("dw.session", metadata);
		manager.flush();
		try {
			const controller = await SessionController.open(manager, metadata, options);
			if (directory === this.sessionDirectory) this.sessions.set(controller.id, controller);
			return controller;
		} catch (error) {
			const file = manager.getSessionFile();
			if (file) await unlink(file);
			throw error;
		}
	}

	async openNativeSession(
		file: string,
		metadata: SessionMetadata,
		options: SessionOptions,
	): Promise<SessionController> {
		return SessionController.open(SessionManager.open(file, dirname(file)), metadata, options);
	}

	subscribeCompanionChanges(
		listener: (change: { scope: MemoryScope; kind: string; data: Record<string, unknown> }) => void,
	): () => void {
		const removeMemory = this.companionStore.subscribeChanges(listener);
		const removeLife = this.life.subscribeChanges(listener);
		return () => {
			removeMemory();
			removeLife();
		};
	}

	setCompanionJobScheduler(handler: LifeJobScheduler | undefined): void {
		this.life.setJobScheduler(handler);
	}

	closeCompanionLife(): Promise<void> {
		return this.life.close();
	}

	async registerCompanionSchedule(scope: MemoryScope, enabled: boolean): Promise<void> {
		this.validateMemoryScope(scope);
		this.life.setSchedule(scope, await this.personas.load(scope.persona_id), enabled);
	}

	async removeCompanionSchedule(scope: MemoryScope): Promise<void> {
		this.validateMemoryScope(scope);
		this.life.removeSchedule(scope);
	}
	getSession(id: string): SessionController {
		const session = this.sessions.get(id);
		if (!session) throw new ExecutorError("SESSION_NOT_FOUND", "Unknown session ID");
		return session;
	}

	listSessions(): Record<string, unknown>[] {
		return [...this.sessions.values()].map((session) => {
			const input = session
				.eventsAfter(0)
				.findLast((event) => event.type === "command.accepted" && event.payload.operation === "input.submit");
			return {
				...session.snapshot(),
				cwd: session.metadata.cwd,
				preview: typeof input?.payload.input === "string" ? input.payload.input.slice(0, 100) : "",
			};
		});
	}

	subscribeSessionInvalidation(listener: (id: string, deleted: boolean) => void): () => void {
		this.sessionInvalidations.add(listener);
		return () => this.sessionInvalidations.delete(listener);
	}

	deleteSession(id: string, expectedSeq: number): Promise<{ session_id: string; deleted: true }> {
		return this.enqueue(async () => {
			if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !Number.isSafeInteger(expectedSeq) || expectedSeq < 0)
				throw new ExecutorError("INVALID_PAYLOAD", "Invalid session ID or expected_seq");
			const session = this.getSession(id);
			session.assertDeletable(expectedSeq);
			const file = session.manager.getSessionFile();
			try {
				// Resolve only the manager-owned path, never a path derived from the requested ID.
				if (
					!file ||
					dirname(resolve(file)) !== resolve(this.sessionDirectory) ||
					!(await lstat(file)).isFile() ||
					dirname(await realpath(file)) !== (await realpath(this.sessionDirectory))
				)
					throw new Error("Session file is outside its owned directory");
			} catch {
				throw new ExecutorError("SESSION_DELETE_FAILED", "Session deletion could not complete", true);
			}
			session.assertDeletable(expectedSeq);
			try {
				// Admission remains locked, but no active model request can be waiting on this queue.
				await session.close();
				await unlink(file);
			} catch {
				try {
					this.sessions.set(id, await session.recoverAfterDeleteFailure());
				} catch {
					throw new ExecutorError(
						"SESSION_DELETE_FAILED",
						"Session deletion and recovery could not complete",
						true,
					);
				} finally {
					this.invalidateSession(id, false);
				}
				throw new ExecutorError("SESSION_DELETE_FAILED", "Session deletion could not complete", true);
			}
			session.markDeleted();
			this.sessions.delete(id);
			this.invalidateSession(id, true);
			return { session_id: id, deleted: true };
		});
	}

	private invalidateSession(id: string, deleted: boolean): void {
		for (const listener of this.sessionInvalidations) {
			try {
				listener(id, deleted);
			} catch {
				// Transport failures must not change the committed filesystem outcome.
			}
		}
	}

	/** Admission is serialized; model and tool executions run independently outside this queue. */
	handle(clientId: string, command: Envelope): Promise<Envelope[]> {
		return this.enqueue(() => this.dispatch(clientId, command));
	}

	getModelSettings() {
		return this.enqueue(() => this.modelSettings.view());
	}

	updateModelSettings(value: unknown) {
		return this.enqueue(() => this.modelSettings.update(value));
	}

	testModelSettings(value: unknown, signal?: AbortSignal) {
		if (this.closed) throw new ExecutorError("SERVER_CLOSING", "Executor is shutting down", true);
		return this.modelSettings.test(value, signal);
	}

	getPersonas() {
		return this.enqueue(async () => {
			if (!(this.personas instanceof FilePersonaProvider))
				return { personas: [], errors: [], editable: false, roleplay_defaults: DEFAULT_ROLEPLAY };
			return { ...(await this.personas.list()), editable: true, roleplay_defaults: DEFAULT_ROLEPLAY };
		});
	}

	getPersona(id: string) {
		return this.enqueue(async () => {
			if (!(this.personas instanceof FilePersonaProvider))
				throw new ExecutorError(
					"PERSONA_MANAGEMENT_UNAVAILABLE",
					"This persona provider does not support file management",
				);
			return { ...(await this.personas.describe(id)), editable: true, roleplay_defaults: DEFAULT_ROLEPLAY };
		});
	}

	savePersona(id: string, value: unknown) {
		return this.enqueue(async () => {
			if (!(this.personas instanceof FilePersonaProvider))
				throw new ExecutorError(
					"PERSONA_MANAGEMENT_UNAVAILABLE",
					"This persona provider does not support file management",
				);
			return { ...(await this.personas.save(id, value)), editable: true, roleplay_defaults: DEFAULT_ROLEPLAY };
		});
	}

	getCompanion(scope: MemoryScope) {
		return this.enqueue(async () => {
			this.validateMemoryScope(scope);
			const persona = await this.personas.load(scope.persona_id);
			return { ...this.companion.profile(scope, persona.roleplay), config: persona.roleplay ?? DEFAULT_ROLEPLAY };
		});
	}

	updateCompanionState(scope: MemoryScope, value: unknown) {
		return this.enqueue(async () => {
			this.validateMemoryScope(scope);
			const persona = await this.personas.load(scope.persona_id);
			return this.companion.updateState(scope, persona.roleplay, value);
		});
	}

	getMemories(scope: MemoryScope, options: MemoryListOptions = {}) {
		return this.enqueue(async () => {
			this.validateMemoryScope(scope);
			return this.companionStore.list(scope, options);
		});
	}

	getMemory(scope: MemoryScope, id: string) {
		return this.enqueue(async () => {
			this.validateMemoryScope(scope);
			const memory = this.companionStore.get(scope, id);
			if (!memory) throw new ExecutorError("MEMORY_NOT_FOUND", "Memory was not found in this role and user scope");
			return memory;
		});
	}

	createMemory(scope: MemoryScope, value: unknown) {
		return this.enqueue(async () => {
			this.validateMemoryScope(scope);
			return this.companionStore.create(scope, value);
		});
	}

	updateMemory(scope: MemoryScope, id: string, value: unknown) {
		return this.enqueue(async () => {
			this.validateMemoryScope(scope);
			const memory = this.companionStore.mutate(scope, id, value);
			if (memory.status === "forgotten") {
				try {
					this.life.invalidateForgotten(scope);
				} catch {
					throw new ExecutorError(
						"LIFE_STORE_INVALID",
						"Memory was forgotten; affected diary cleanup could not complete",
						false,
						{ memory_forgotten: true },
					);
				}
			}
			return memory;
		});
	}

	previewRecall(scope: MemoryScope, query: string) {
		return this.enqueue(async () => {
			this.validateMemoryScope(scope);
			if (query.length > 2000) throw new ExecutorError("INVALID_PAYLOAD", "Recall query is too long");
			return {
				core: this.companionStore.pinned(scope),
				items: this.companionStore.search(scope, query, 6),
			};
		});
	}

	getLife(scope: MemoryScope) {
		return this.withLife(scope, (persona) => this.life.view(scope, persona));
	}

	saveLifeSettings(scope: MemoryScope, value: unknown) {
		return this.withLife(scope, (persona) => this.life.saveSettings(scope, persona, value));
	}

	advanceLife(scope: MemoryScope, value: unknown) {
		if (!Check(LifeAdvanceSchema, value))
			throw new ExecutorError("INVALID_PAYLOAD", "State advancement accepts an empty object");
		return this.withLife(scope, (persona) => this.life.advance(scope, persona));
	}

	addLifeCondition(scope: MemoryScope, value: unknown) {
		return this.withLife(scope, (persona) => this.life.addCondition(scope, persona, value));
	}

	removeLifeCondition(scope: MemoryScope, id: string, value: unknown) {
		return this.withLife(scope, (persona) => this.life.removeCondition(scope, persona, id, value));
	}

	getDiaries(scope: MemoryScope, options: DiaryListOptions = {}) {
		return this.enqueue(async () => {
			this.validateMemoryScope(scope);
			return this.life.listDiaries(scope, options);
		});
	}

	getDiary(scope: MemoryScope, date: string) {
		return this.enqueue(async () => {
			this.validateMemoryScope(scope);
			return this.life.getDiary(scope, date);
		});
	}

	deleteDiary(scope: MemoryScope, date: string, value: unknown) {
		return this.withLife(scope, (persona) => this.life.deleteDiary(scope, persona, date, value));
	}

	async generateLifeContent(scope: MemoryScope, kind: LifeJobKind, value: unknown, signal?: AbortSignal) {
		if (!Check(LifeGenerateSchema, value))
			throw new ExecutorError("INVALID_PAYLOAD", "Invalid life generation options");
		const persona = await this.withLife(scope, (persona) => persona);
		const options = { ...value, signal };
		// Admission is finished before model work, so background calls cannot block chat or management.
		switch (kind) {
			case "plan":
				return this.life.generatePlan(scope, persona, options);
			case "diary":
				return this.life.generateDiary(scope, persona, options);
			case "detail":
				return this.life.generateDetail(scope, persona, options);
		}
	}

	private withLife<T>(scope: MemoryScope, operation: (persona: PersonaSnapshot) => T | Promise<T>): Promise<T> {
		return this.enqueue(async () => {
			this.validateMemoryScope(scope);
			return operation(await this.personas.load(scope.persona_id));
		});
	}

	private validateMemoryScope(scope: MemoryScope): void {
		if (!Check(CompanionIdentifierSchema, scope.persona_id) || !Check(CompanionIdentifierSchema, scope.user_id))
			throw new ExecutorError(
				"INVALID_PAYLOAD",
				"Role and user IDs must use 1–100 letters, digits, underscores or hyphens",
			);
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const work = this.queue.then(() => {
			if (this.closed) throw new ExecutorError("SERVER_CLOSING", "Executor is shutting down", true);
			return operation();
		});
		this.queue = work.then(
			() => undefined,
			() => undefined,
		);
		return work;
	}

	private async dispatch(clientId: string, command: Envelope): Promise<Envelope[]> {
		if (this.closed) throw new ExecutorError("SERVER_CLOSING", "Executor is shutting down", true);
		parseEnvelope(command);
		const identity = commandIdentity(clientId, command);
		for (const existingSession of this.sessions.values()) {
			const response = existingSession.findCommand(identity);
			if (response)
				return command.type === "session.attach" ? existingSession.handle(command, identity) : [response];
		}
		if (command.type === "session.open") {
			for (const session of this.sessions.values()) {
				if (session.metadata.creation_key !== identity.key) continue;
				if (session.metadata.creation_fingerprint !== identity.fingerprint)
					throw new ExecutorError("ID_CONFLICT", "Command ID was already used for a different session");
				return [session.findCommand(identity) ?? session.opened(command, identity)];
			}
			const pending = this.pendingCreations.get(identity.key);
			if (pending && pending.metadata.creation_fingerprint !== identity.fingerprint)
				throw new ExecutorError("ID_CONFLICT", "Command ID was already used for a different session");
			const cwd = command.payload.cwd as string;
			if (!isAbsolute(cwd) || !(await stat(cwd).catch(() => undefined))?.isDirectory())
				throw new ExecutorError("INVALID_CWD", "cwd must be an existing absolute directory on the executor host");
			const persona = await this.personas.load(command.payload.persona_id as string);
			if (!Check(PersonaSchema, persona) || persona.id !== command.payload.persona_id)
				throw new ExecutorError("INVALID_PERSONA", "Persona provider returned an invalid snapshot");
			const metadata: SessionMetadata = {
				version: 1,
				persona,
				cwd: resolve(cwd),
				mode: (command.payload.mode as "chat" | "agent" | undefined) ?? "chat",
				user_id: (command.payload.user_id as string | undefined) ?? "local",
				creation_key: identity.key,
				creation_fingerprint: identity.fingerprint,
			};
			const manager = pending?.manager ?? SessionManager.create(metadata.cwd, this.sessionDirectory);
			const admittedMetadata = pending?.metadata ?? metadata;
			if (!pending) {
				manager.appendCustomEntry("dw.session", admittedMetadata);
				manager.flush();
				this.pendingCreations.set(identity.key, { manager, metadata: admittedMetadata });
			}
			const controller = await SessionController.open(manager, admittedMetadata, this.sessionOptions);
			this.sessions.set(controller.id, controller);
			this.pendingCreations.delete(identity.key);
			return [controller.opened(command, identity)];
		}
		if (!command.session_id) throw new ExecutorError("SESSION_REQUIRED", "Command requires session_id");
		const session = this.getSession(command.session_id);
		try {
			return await session.handle(command, identity);
		} catch (error) {
			if (error instanceof ExecutorError && error.code === "ID_CONFLICT") throw error;
			return [session.reject(command, identity, error)];
		}
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.closePromise = this.queue.then(async () => {
			try {
				await this.api?.close();
				const results = await Promise.allSettled([
					this.life?.close(),
					this.lifeModel?.close(),
					...[...this.sessions.values()].map((session) => session.close()),
				]);
				const failed = results.find((result) => result.status === "rejected");
				if (failed?.status === "rejected") throw failed.reason;
			} finally {
				try {
					try {
						this.lifeStore?.close();
					} finally {
						this.companionStore?.close();
					}
				} finally {
					await this.releaseLock?.();
					this.releaseLock = undefined;
				}
			}
		});
		return this.closePromise;
	}
}
