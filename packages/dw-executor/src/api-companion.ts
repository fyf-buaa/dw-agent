import { Check } from "typebox/value";
import type { ApiJobs, Job } from "./api-jobs.ts";
import type { ApiStore, Stored } from "./api-store.ts";
import type { DiaryListOptions, LifeActionResult, LifeJobKind, LifeView } from "./companion-life-types.ts";
import { LifeGenerateSchema } from "./companion-life-types.ts";
import { CompanionIdentifierSchema, type MemoryListOptions, type MemoryScope } from "./companion-types.ts";
import { ExecutorError } from "./errors.ts";
import type { ExecutorService } from "./service.ts";

export interface CompanionSchedule extends MemoryScope {
	enabled: boolean;
}
export type MemoryQuery = Omit<MemoryListOptions, "cursor"> & { cursor?: string };
export type DiaryQuery = Omit<DiaryListOptions, "cursor"> & { cursor?: string };
interface NativeGeneration {
	promise: Promise<LifeActionResult>;
	resolve: (result: LifeActionResult) => void;
	reject: (error: unknown) => void;
}
const EPOCH = "1970-01-01T00:00:00.000Z";
function scopeId(scope: MemoryScope): string {
	if (!Check(CompanionIdentifierSchema, scope.persona_id) || !Check(CompanionIdentifierSchema, scope.user_id))
		throw new ExecutorError("INVALID_PAYLOAD", "Invalid companion scope");
	return `${scope.persona_id}:${scope.user_id}`;
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ExecutorError("INVALID_PAYLOAD", "Expected an object");
	return value as Record<string, unknown>;
}
function resource<T>(id: string, revision: number, data: T, at = 0, created = at): Stored<T> {
	return {
		id,
		revision,
		created_at: created ? new Date(created).toISOString() : EPOCH,
		updated_at: at ? new Date(at).toISOString() : EPOCH,
		data,
	};
}
function offset(cursor: string | undefined, query: string): number {
	if (cursor === undefined) return 0;
	try {
		if (!/^[A-Za-z0-9_-]{1,4096}$/u.test(cursor)) throw new Error();
		const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		const parsed = object(value);
		if (
			parsed.query !== query ||
			typeof parsed.offset !== "number" ||
			!Number.isSafeInteger(parsed.offset) ||
			parsed.offset < 0 ||
			Object.keys(parsed).length !== 2
		)
			throw new Error();
		return parsed.offset;
	} catch {
		throw new ExecutorError("INVALID_CURSOR", "Cursor does not belong to this companion query");
	}
}
function cursor(next: number | null, query: string): string | null {
	return next === null ? null : Buffer.from(JSON.stringify({ query, offset: next })).toString("base64url");
}

/** Canonical resources over the existing memory/life algorithms, without copying forgotten bodies. */
export class CompanionApi {
	private readonly store: ApiStore;
	private readonly service: ExecutorService;
	private readonly jobs: ApiJobs;
	private unsubscribe: (() => void) | undefined;
	private queue: Promise<void> = Promise.resolve();
	private readonly generations = new Map<string, NativeGeneration>();
	private unsubscribeJobs: (() => void) | undefined;

	constructor(store: ApiStore, service: ExecutorService, jobs: ApiJobs) {
		this.store = store;
		this.service = service;
		this.jobs = jobs;
	}
	async initialize(): Promise<void> {
		if (this.unsubscribe) return;
		this.unsubscribe = this.service.subscribeCompanionChanges((change) => {
			this.store.append(`companion:${scopeId(change.scope)}`, change.kind, change.data);
		});
		this.unsubscribeJobs = this.store.subscribe((event) => {
			if (
				event.type !== "job.changed" ||
				typeof event.data.job_id !== "string" ||
				!["completed", "failed", "cancelled"].includes(String(event.data.status))
			)
				return;
			const generation = this.generations.get(event.data.job_id);
			if (event.data.status !== "completed")
				generation?.reject(new ExecutorError("LIFE_CANCELLED", "Generation did not complete"));
			this.generations.delete(event.data.job_id);
		});
		this.service.setCompanionJobScheduler((scope, kind, operation, target) => {
			const previous = this.store.all<Job>("job").findLast((job) => {
				if (job.data.kind !== kind || job.data.companion_scope !== scopeId(scope)) return false;
				const input = object(job.data.input);
				return input.date === target.date && input.segment === target.segment;
			});
			if (previous?.data.status === "cancelled")
				return Promise.reject(
					new ExecutorError(
						"LIFE_CANCELLED",
						"Interrupted automatic work requires an explicit generation request",
					),
				);
			return this.queueGeneration(scope, kind, { kind, ...target }, operation).generation.promise;
		});
		for (const schedule of this.store.all<CompanionSchedule>("companion_schedule")) {
			const { persona_id, user_id, enabled } = schedule.data;
			await this.service.registerCompanionSchedule({ persona_id, user_id }, enabled);
		}
	}
	async close(): Promise<void> {
		await this.service.closeCompanionLife();
		this.service.setCompanionJobScheduler(undefined);
		for (const generation of this.generations.values())
			generation.reject(new ExecutorError("LIFE_CLOSED", "Companion API is closing"));
		this.generations.clear();
		this.unsubscribeJobs?.();
		this.unsubscribeJobs = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
	async getPersonas() {
		const list = await this.service.getPersonas();
		const items = await Promise.all(list.personas.map((persona) => this.getPersona(persona.id)));
		return {
			items,
			next_cursor: null,
			errors: list.errors,
			editable: list.editable,
			roleplay_defaults: list.roleplay_defaults,
		};
	}
	async getPersona(id: string) {
		const data = await this.service.getPersona(id);
		const previous = this.store.get<{ native_revision: string }>("persona_revision", id);
		const mapping =
			previous?.data.native_revision === data.persona.revision
				? previous
				: this.store.put(
						"persona_revision",
						id,
						{ native_revision: data.persona.revision },
						previous?.revision ?? null,
					);
		return { ...mapping, data };
	}
	createPersona(value: unknown) {
		return this.serialize(async () => {
			const input = object(value);
			if (
				typeof input.id !== "string" ||
				!Check(CompanionIdentifierSchema, input.id) ||
				Object.keys(input).some((key) => !["id", "system_prompt", "roleplay"].includes(key))
			)
				throw new ExecutorError("INVALID_PAYLOAD", "Invalid persona creation");
			const { id, ...fields } = input;
			const data = await this.service.savePersona(id, { ...fields, expected_revision: null });
			const previous = this.store.get<{ native_revision: string }>("persona_revision", id);
			const mapping = this.store.put(
				"persona_revision",
				id,
				{ native_revision: data.persona.revision },
				previous?.revision ?? null,
			);
			this.store.append("system", "persona.changed", { persona_id: id, revision: mapping.revision });
			return { ...mapping, data };
		});
	}
	savePersona(id: string, value: unknown) {
		return this.serialize(async () => {
			const input = object(value);
			if (Object.keys(input).some((key) => !["expected_revision", "system_prompt", "roleplay"].includes(key)))
				throw new ExecutorError("INVALID_PAYLOAD", "Invalid persona update");
			const current = await this.getPersona(id);
			if (input.expected_revision !== current.revision)
				throw new ExecutorError("REVISION_MISMATCH", "Persona changed; reload before saving");
			const data = await this.service.savePersona(id, {
				...input,
				expected_revision: current.data.persona.revision,
			});
			const mapping = this.store.put(
				"persona_revision",
				id,
				{ native_revision: data.persona.revision },
				current.revision,
			);
			this.store.append("system", "persona.changed", { persona_id: id, revision: mapping.revision });
			return { ...mapping, data };
		});
	}
	async getCompanion(scope: MemoryScope) {
		const id = scopeId(scope);
		const data = await this.service.getCompanion(scope);
		return resource(id, data.state.revision, data, data.state.updated_at);
	}
	async updateCompanionState(scope: MemoryScope, value: unknown) {
		const id = scopeId(scope);
		const data = await this.service.updateCompanionState(scope, value);
		return resource(id, data.state.revision, data, data.state.updated_at);
	}
	async getMemories(scope: MemoryScope, query: MemoryQuery = {}) {
		const id = scopeId(scope);
		const { cursor: token, ...filters } = query;
		const key = JSON.stringify([
			"memories",
			id,
			filters.status ?? "active",
			filters.kind ?? null,
			filters.query ?? "",
		]);
		const page = await this.service.getMemories(scope, { ...filters, cursor: offset(token, key) });
		return {
			items: page.items.map((item) => resource(item.id, item.revision, item, item.updated_at, item.created_at)),
			next_cursor: cursor(page.next_cursor, key),
			total: page.total,
		};
	}
	async getMemory(scope: MemoryScope, id: string) {
		scopeId(scope);
		const data = await this.service.getMemory(scope, id);
		return resource(data.id, data.revision, data, data.updated_at, data.created_at);
	}
	async createMemory(scope: MemoryScope, value: unknown) {
		scopeId(scope);
		const data = await this.service.createMemory(scope, value);
		return resource(data.id, data.revision, data, data.updated_at, data.created_at);
	}
	async updateMemory(scope: MemoryScope, id: string, value: unknown) {
		scopeId(scope);
		const data = await this.service.updateMemory(scope, id, value);
		return resource(data.id, data.revision, data, data.updated_at, data.created_at);
	}
	async previewRecall(scope: MemoryScope, query: string) {
		const id = scopeId(scope);
		return resource(id, 0, await this.service.previewRecall(scope, query));
	}
	async getLife(scope: MemoryScope) {
		return this.lifeResource(scope, await this.service.getLife(scope));
	}
	async saveLifeSettings(scope: MemoryScope, value: unknown) {
		const data = await this.service.saveLifeSettings(scope, value);
		return resource(`${scopeId(scope)}:settings`, data.settings.revision, data);
	}
	async advanceLife(scope: MemoryScope, value: unknown) {
		return this.lifeResource(scope, await this.service.advanceLife(scope, value));
	}
	async addLifeCondition(scope: MemoryScope, value: unknown) {
		return this.lifeResource(scope, await this.service.addLifeCondition(scope, value));
	}
	async removeLifeCondition(scope: MemoryScope, id: string, value: unknown) {
		return this.lifeResource(scope, await this.service.removeLifeCondition(scope, id, value));
	}
	async getPlan(scope: MemoryScope) {
		const life = await this.service.getLife(scope);
		return resource(
			`${scopeId(scope)}:plan:${life.state.date}`,
			life.plan?.revision ?? 0,
			life.plan,
			life.plan?.generated_at,
		);
	}
	async getDiaries(scope: MemoryScope, query: DiaryQuery = {}) {
		const id = scopeId(scope);
		const { cursor: token, ...options } = query;
		const key = JSON.stringify(["diaries", id]);
		const page = await this.service.getDiaries(scope, { ...options, cursor: offset(token, key) });
		return {
			items: page.items.map((item) => resource(`${id}:${item.date}`, item.revision, item, item.generated_at)),
			next_cursor: cursor(page.next_cursor, key),
		};
	}
	async getDiary(scope: MemoryScope, date: string) {
		const data = await this.service.getDiary(scope, date);
		return resource(`${scopeId(scope)}:${date}`, data.revision, data, data.generated_at);
	}
	async deleteDiary(scope: MemoryScope, date: string, value: unknown) {
		return this.lifeResource(scope, await this.service.deleteDiary(scope, date, value));
	}
	getSchedule(scope: MemoryScope): Stored<CompanionSchedule> {
		const id = scopeId(scope);
		return (
			this.store.get<CompanionSchedule>("companion_schedule", id) ?? resource(id, 0, { ...scope, enabled: false })
		);
	}
	saveSchedule(scope: MemoryScope, value: unknown) {
		return this.serialize(async () => {
			const id = scopeId(scope);
			const input = object(value);
			if (
				typeof input.enabled !== "boolean" ||
				Object.keys(input).some((key) => !["enabled", "expected_revision"].includes(key))
			)
				throw new ExecutorError("INVALID_PAYLOAD", "Invalid scheduling registration");
			const enabled = input.enabled;
			const current = this.getSchedule(scope);
			if (input.expected_revision !== current.revision)
				throw new ExecutorError("REVISION_MISMATCH", "Scheduling registration changed");
			await this.service.getLife(scope);
			if (current.revision && current.data.enabled === enabled) return current;
			const updated = this.store.transaction(() => {
				const record = this.store.put<CompanionSchedule>(
					"companion_schedule",
					id,
					{ ...scope, enabled },
					current.revision || null,
				);
				this.store.append(`companion:${id}`, "schedule.changed", { enabled, revision: record.revision });
				return record;
			});
			await this.service.registerCompanionSchedule(scope, enabled);
			return updated;
		});
	}
	removeSchedule(scope: MemoryScope, expectedRevision: number) {
		return this.serialize(async () => {
			const id = scopeId(scope);
			this.store.transaction(() => {
				this.store.remove("companion_schedule", id, expectedRevision);
				this.store.append(`companion:${id}`, "schedule.removed", { revision: expectedRevision });
			});
			await this.service.removeCompanionSchedule(scope);
		});
	}
	createJob(scope: MemoryScope, value: unknown) {
		scopeId(scope);
		const input = object(value);
		const { kind, ...options } = input;
		if ((kind !== "plan" && kind !== "diary" && kind !== "detail") || !Check(LifeGenerateSchema, options))
			throw new ExecutorError("INVALID_PAYLOAD", "Invalid companion generation job");
		return this.queueGeneration(scope, kind, input, (signal) =>
			this.service.generateLifeContent(scope, kind, options, signal),
		).job;
	}
	private queueGeneration(
		scope: MemoryScope,
		kind: LifeJobKind,
		input: Record<string, unknown>,
		operation: (signal: AbortSignal) => Promise<LifeActionResult>,
	) {
		const id = scopeId(scope);
		const active = this.store
			.all<Job>("job")
			.find(
				(job) =>
					job.data.companion_scope === id &&
					job.data.kind === kind &&
					(job.data.status === "queued" || job.data.status === "running"),
			);
		if (active) {
			const previous = object(active.data.input);
			if (
				(previous.force ?? false) !== (input.force ?? false) ||
				previous.expected_revision !== input.expected_revision
			)
				throw new ExecutorError("JOB_BUSY", "This generation target already has an active job");
			const generation = this.generations.get(active.id);
			if (!generation)
				throw new ExecutorError("JOB_INTERRUPTED", "The active generation is no longer owned by this process");
			return { job: active, generation };
		}
		let resolve!: NativeGeneration["resolve"];
		let reject!: NativeGeneration["reject"];
		const promise = new Promise<LifeActionResult>((done, fail) => {
			resolve = done;
			reject = fail;
		});
		void promise.catch(() => undefined);
		const generation: NativeGeneration = { promise, resolve, reject };
		const job = this.jobs.create(
			kind,
			input,
			async (signal, reportUsage) => {
				let nativeId: string | undefined;
				const unsubscribe = this.service.subscribeCompanionChanges((change) => {
					if (
						change.scope.persona_id !== scope.persona_id ||
						change.scope.user_id !== scope.user_id ||
						change.kind !== "life.jobs.changed" ||
						change.data.kind !== kind ||
						typeof change.data.id !== "string"
					)
						return;
					if (nativeId !== undefined && nativeId !== change.data.id) return;
					nativeId = change.data.id;
					const usage = change.data.usage;
					if (
						usage &&
						typeof usage === "object" &&
						"input_tokens" in usage &&
						"output_tokens" in usage &&
						typeof usage.input_tokens === "number" &&
						typeof usage.output_tokens === "number"
					)
						reportUsage({ input_tokens: usage.input_tokens, output_tokens: usage.output_tokens });
				});
				try {
					const result = await operation(signal);
					const native = result.view.jobs.find((job) => job.id === nativeId);
					if (native) reportUsage(native.usage);
					generation.resolve(result);
					return {
						kind,
						scope,
						warnings: result.warnings,
						...(result.plan ? { plan: { date: result.plan.date, revision: result.plan.revision } } : {}),
						...(result.diary ? { diary: { date: result.diary.date, revision: result.diary.revision } } : {}),
						...(result.detail
							? {
									detail: {
										date: result.detail.date,
										segment: result.detail.segment,
										revision: result.detail.revision,
									},
								}
							: {}),
					};
				} catch (error) {
					generation.reject(error);
					throw error;
				} finally {
					unsubscribe();
				}
			},
			{ companion_scope: id },
		);
		this.generations.set(job.id, generation);
		return { job, generation };
	}
	private lifeResource(scope: MemoryScope, data: LifeView) {
		return resource(`${scopeId(scope)}:life`, data.state.revision, data);
	}
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const pending = this.queue.then(operation);
		this.queue = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	}
}
