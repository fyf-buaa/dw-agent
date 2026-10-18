import { afterEach, describe, expect, it } from "vitest";
import { ApiJobs, type Job } from "../src/api-jobs.ts";
import { ApiStore } from "../src/api-store.ts";
import { ExecutorError } from "../src/errors.ts";
import { deferred } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function setup() {
	const store = new ApiStore(":memory:");
	const jobs = new ApiJobs(store);
	cleanups.push(
		() => store.close(),
		() => jobs.close(),
	);
	return { store, jobs };
}

describe("durable native background jobs", () => {
	it("persists queued admission before native execution and completes independently of readers", async () => {
		const { jobs, store } = setup();
		const entered = deferred();
		const release = deferred();
		let calls = 0;
		const job = jobs.create(
			"model.test",
			{ provider: "local", model: "test" },
			async (_signal, report) => {
				calls++;
				report({ input_tokens: 17, output_tokens: 4 });
				entered.resolve();
				await release.promise;
				return { available: true, usage: { input_tokens: 17, output_tokens: 9 } };
			},
			{ companion_scope: "guide:alice" },
		);
		expect(job.data.status).toBe("queued");
		expect(calls).toBe(0);
		await entered.promise;
		expect(jobs.get(job.id).data).toMatchObject({ status: "running", usage: { input_tokens: 17, output_tokens: 4 } });
		expect(jobs.list({ filter: { companion_scope: "guide:bob" } }).items).toEqual([]);
		expect(jobs.list({ filter: { companion_scope: "guide:alice" } }).items[0].id).toBe(job.id);
		const completed = deferred();
		const unsubscribe = store.subscribe((event) => {
			if (event.data.job_id === job.id && event.data.status === "completed") completed.resolve();
		});
		release.resolve();
		await completed.promise;
		unsubscribe();
		expect(jobs.get(job.id).data).toMatchObject({
			status: "completed",
			usage: { input_tokens: 17, output_tokens: 9 },
			result: { available: true },
		});
		expect(calls).toBe(1);
	});

	it("acknowledges running cancellation before terminal exit and preserves actual failure usage", async () => {
		const { jobs } = setup();
		const entered = deferred();
		const release = deferred();
		let signal: AbortSignal | undefined;
		const job = jobs.create(
			"diary",
			{},
			async (nativeSignal, report) => {
				signal = nativeSignal;
				report({ input_tokens: 31, output_tokens: 2 });
				entered.resolve();
				await release.promise;
				throw new ExecutorError("LIFE_CANCELLED", "Cancelled", false, {
					usage: { input_tokens: 31, output_tokens: 7 },
				});
			},
			{ companion_scope: "guide:alice" },
		);
		await entered.promise;
		expect(jobs.cancel(job.id).data).toMatchObject({ status: "running", cancel_requested: true, finished_at: null });
		expect(signal?.aborted).toBe(true);
		release.resolve();
		await jobs.close();
		expect(jobs.get(job.id).data).toMatchObject({
			status: "cancelled",
			usage: { input_tokens: 31, output_tokens: 7 },
		});
	});

	it("cancels a queued operation without executing it and reports committed success honestly", async () => {
		const { jobs } = setup();
		let calls = 0;
		const queued = jobs.create("plan", {}, async () => {
			calls++;
			return {};
		});
		expect(jobs.cancel(queued.id).data.status).toBe("cancelled");
		const entered = deferred();
		const release = deferred();
		const running = jobs.create("plan", {}, async () => {
			entered.resolve();
			await release.promise;
			return { committed: true };
		});
		await entered.promise;
		jobs.cancel(running.id);
		release.resolve();
		await jobs.close();
		expect(calls).toBe(0);
		expect(jobs.get(running.id).data).toMatchObject({
			status: "completed",
			cancel_requested: true,
			result: { committed: true },
		});
	});

	it("marks interrupted persisted jobs cancelled without launching hidden requests", async () => {
		const store = new ApiStore(":memory:");
		cleanups.push(() => store.close());
		store.put<Job>(
			"job",
			"interrupted",
			{
				kind: "model.test",
				input: { provider: "local" },
				status: "running",
				cancel_requested: false,
				started_at: new Date(0).toISOString(),
				finished_at: null,
				usage: { input_tokens: 51, output_tokens: 8 },
				companion_scope: "guide:alice",
			},
			null,
		);
		const jobs = new ApiJobs(store);
		cleanups.push(() => jobs.close());
		expect(jobs.get("interrupted").data).toMatchObject({
			status: "cancelled",
			error: { code: "JOB_INTERRUPTED" },
			usage: { input_tokens: 51, output_tokens: 8 },
			companion_scope: "guide:alice",
		});
		expect(jobs.get("interrupted").data.finished_at).not.toBeNull();
	});
});
