import { randomUUID } from "node:crypto";
import type { ApiListOptions, ApiStore, Stored } from "./api-store.ts";
import { ExecutorError } from "./errors.ts";

export interface JobScope {
	companion_scope?: string;
	session_id?: string;
}
export interface JobUsage {
	input_tokens: number;
	output_tokens: number;
}
export interface Job extends JobScope {
	kind: string;
	input: unknown;
	status: "queued" | "running" | "completed" | "failed" | "cancelled";
	cancel_requested: boolean;
	started_at: string | null;
	finished_at: string | null;
	usage: JobUsage;
	result?: unknown;
	error?: { code: string; message: string };
}
export type JobOperation = (signal: AbortSignal, reportUsage: (usage: JobUsage) => void) => Promise<unknown>;
interface Flight {
	controller: AbortController;
	promise: Promise<void>;
}
function usageOf(value: unknown): JobUsage | undefined {
	if (!value || typeof value !== "object" || !("usage" in value)) return undefined;
	const usage = value.usage;
	if (!usage || typeof usage !== "object" || !("input_tokens" in usage) || !("output_tokens" in usage))
		return undefined;
	if (
		typeof usage.input_tokens !== "number" ||
		typeof usage.output_tokens !== "number" ||
		!Number.isSafeInteger(usage.input_tokens) ||
		!Number.isSafeInteger(usage.output_tokens) ||
		usage.input_tokens < 0 ||
		usage.output_tokens < 0
	)
		return undefined;
	return { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
}

/** Owns operations independently of HTTP requests; never replays native work on restart. */
export class ApiJobs {
	private readonly store: ApiStore;
	private readonly flights = new Map<string, Flight>();
	private closed = false;
	private readonly failures: unknown[] = [];

	constructor(store: ApiStore) {
		this.store = store;
		for (const record of store.all<Job>("job")) {
			if (record.data.status !== "queued" && record.data.status !== "running") continue;
			this.update(record.id, {
				...record.data,
				status: "cancelled",
				finished_at: new Date().toISOString(),
				error: { code: "JOB_INTERRUPTED", message: "Execution interrupted before completion; it was not retried" },
			});
		}
	}

	create(kind: string, input: unknown, operation: JobOperation, scope: JobScope = {}): Stored<Job> {
		if (this.closed) throw new ExecutorError("SERVER_CLOSING", "Background jobs are closed", true);
		if (
			!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/u.test(kind) ||
			(scope.companion_scope !== undefined &&
				!/^[A-Za-z0-9_-]{1,100}:[A-Za-z0-9_-]{1,100}$/u.test(scope.companion_scope)) ||
			(scope.session_id !== undefined && !/^[A-Za-z0-9_-]{1,100}$/u.test(scope.session_id))
		)
			throw new ExecutorError("INVALID_PAYLOAD", "Invalid job kind or scope");
		const id = randomUUID();
		const record = this.store.transaction(() => {
			const queued = this.store.put<Job>(
				"job",
				id,
				{
					kind,
					input,
					...scope,
					status: "queued",
					cancel_requested: false,
					started_at: null,
					finished_at: null,
					usage: { input_tokens: 0, output_tokens: 0 },
				},
				null,
			);
			this.event(queued);
			return queued;
		});
		const controller = new AbortController();
		const promise = Promise.resolve()
			.then(async () => {
				if (controller.signal.aborted) {
					this.flights.delete(id);
					return;
				}
				this.update(id, { ...this.get(id).data, status: "running", started_at: new Date().toISOString() });
				const reportUsage = (usage: JobUsage): void => {
					const checked = usageOf({ usage });
					if (!checked)
						throw new ExecutorError("INVALID_PAYLOAD", "Job usage must be nonnegative safe integer token counts");
					const current = this.get(id).data;
					if (
						checked.input_tokens < current.usage.input_tokens ||
						checked.output_tokens < current.usage.output_tokens
					)
						return;
					if (
						checked.input_tokens !== current.usage.input_tokens ||
						checked.output_tokens !== current.usage.output_tokens
					)
						this.update(id, { ...current, usage: checked });
				};
				try {
					const result = await operation(controller.signal, reportUsage);
					const usage = usageOf(result);
					if (usage) reportUsage(usage);
					const current = this.get(id).data;
					if (current.status !== "cancelled")
						this.update(id, {
							...current,
							status: "completed",
							finished_at: new Date().toISOString(),
							...(result === undefined ? {} : { result }),
						});
				} catch (error) {
					const usage = error instanceof ExecutorError ? usageOf(error.details) : undefined;
					if (usage) reportUsage(usage);
					const current = this.get(id).data;
					if (current.status !== "cancelled")
						this.update(id, {
							...current,
							status: controller.signal.aborted ? "cancelled" : "failed",
							finished_at: new Date().toISOString(),
							error: {
								code: error instanceof ExecutorError ? error.code : "JOB_FAILED",
								message: "Background operation did not complete",
							},
						});
				} finally {
					this.flights.delete(id);
				}
			})
			.catch((error: unknown) => {
				this.flights.delete(id);
				this.failures.push(error);
			});
		this.flights.set(id, { controller, promise });
		return record;
	}

	get(id: string): Stored<Job> {
		return this.store.require<Job>("job", id);
	}
	list(query: ApiListOptions = {}) {
		return this.store.list<Job>("job", query);
	}
	cancel(id: string): Stored<Job> {
		const current = this.get(id);
		if ((current.data.status !== "queued" && current.data.status !== "running") || current.data.cancel_requested)
			return current;
		const cancelled = current.data.status === "queued";
		const updated = this.update(id, {
			...current.data,
			cancel_requested: true,
			...(cancelled
				? {
						status: "cancelled",
						finished_at: new Date().toISOString(),
						error: { code: "JOB_CANCELLED", message: "Cancelled before native execution began" },
					}
				: {}),
		});
		this.flights.get(id)?.controller.abort();
		return updated;
	}
	async close(): Promise<void> {
		this.closed = true;
		const flights = [...this.flights.entries()];
		for (const [id] of flights) this.cancel(id);
		await Promise.allSettled(flights.map(([, flight]) => flight.promise));
		if (this.failures.length) throw new AggregateError(this.failures, "Background job persistence failed");
	}
	private update(id: string, data: Job): Stored<Job> {
		return this.store.transaction(() => {
			const updated = this.store.put("job", id, data, this.get(id).revision);
			this.event(updated);
			return updated;
		});
	}
	private event(record: Stored<Job>): void {
		const scope = record.data;
		this.store.append(
			scope.companion_scope
				? `companion:${scope.companion_scope}`
				: scope.session_id
					? `session:${scope.session_id}`
					: "system",
			"job.changed",
			{
				job_id: record.id,
				revision: record.revision,
				status: scope.status,
				cancel_requested: scope.cancel_requested,
				usage: scope.usage,
			},
			scope.session_id ? { session_id: scope.session_id } : {},
		);
	}
}
