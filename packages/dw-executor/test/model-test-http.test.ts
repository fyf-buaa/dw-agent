import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import type { Job } from "../src/api-jobs.ts";
import type { Stored } from "../src/api-store.ts";
import { apiFixture, type EventPage, type Page } from "./api-helpers.ts";
import { deferred } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("model test HTTP jobs", () => {
	it("requires explicit authenticated idempotent POST and leaves sessions and profiles unchanged", async () => {
		const f = await apiFixture(cleanups);
		const session = await f.createSession();
		const before = await f.read<Stored<unknown>>("/api/model-profiles/default");
		const events = await f.read<EventPage>(`/api/sessions/${session.id}/events`);
		const body = { provider: "dw-test", model: "model" };
		expect((await f.post("/api/model-tests", body, "wrong-auth", "incorrect")).status).toBe(401);
		expect(
			(
				await f.request("/api/model-tests", {
					method: "POST",
					headers: { Origin: "https://untrusted.example", "Idempotency-Key": "origin" },
					body: JSON.stringify(body),
				})
			).status,
		).toBe(403);
		const read = await f.request("/api/model-tests");
		expect(read.status).toBe(405);
		expect(read.headers.get("allow")).toContain("POST");
		expect(f.faux.state.callCount).toBe(0);
		f.faux.setResponses([fauxAssistantMessage("OK")]);
		const response = await f.post("/api/model-tests", body, "test-once");
		expect(response.status).toBe(202);
		const job = (await response.json()) as Stored<Job>;
		expect(job.data.kind).toBe("model_test");
		const completed = await f.settle<Job>(`/api/jobs/${job.id}`);
		expect(completed.data.result).toMatchObject({
			available: true,
			provider: "dw-test",
			model: "model",
			thinking_level: "off",
		});
		expect(completed.data.usage.input_tokens).toBeGreaterThanOrEqual(0);
		expect(await (await f.post("/api/model-tests", body, "test-once")).json()).toMatchObject({ id: job.id });
		expect((await f.post("/api/model-tests", { ...body, model: "different" }, "test-once")).status).toBe(409);
		expect(f.faux.state.callCount).toBe(1);
		expect(await f.read("/api/model-profiles/default")).toEqual(before);
		expect(await f.read(`/api/sessions/${session.id}`)).toEqual(session);
		expect(await f.read(`/api/sessions/${session.id}/events`)).toEqual(events);
		expect((await f.read<Page<unknown>>("/api/sessions")).items).toHaveLength(1);
		await f.restart();
		expect((await f.read<Stored<Job>>(`/api/jobs/${job.id}`)).data).toEqual(completed.data);
		expect(await (await f.post("/api/model-tests", body, "test-once")).json()).toMatchObject({ id: job.id });
		expect(f.faux.state.callCount).toBe(1);
	});

	it("does not couple native job cancellation to HTTP transport lifetime", async () => {
		const f = await apiFixture(cleanups);
		const entered = deferred();
		const release = deferred();
		const aborted = deferred();
		cleanups.push(async () => {
			release.resolve();
		});
		f.faux.setResponses([
			async (_context, options) => {
				entered.resolve();
				const abort = () => {
					aborted.resolve();
					release.resolve();
				};
				if (options?.signal?.aborted) abort();
				else options?.signal?.addEventListener("abort", abort, { once: true });
				await release.promise;
				return fauxAssistantMessage("OK");
			},
		]);
		const controller = new AbortController();
		const response = await f.request("/api/model-tests", {
			method: "POST",
			headers: { "Idempotency-Key": "detached-model-test" },
			body: JSON.stringify({ provider: "dw-test", model: "model" }),
			signal: controller.signal,
		});
		expect(response.status).toBe(202);
		const job = (await response.json()) as Stored<Job>;
		await entered.promise;
		controller.abort();
		expect((await f.read<Stored<Job>>(`/api/jobs/${job.id}`)).data.status).toBe("running");
		expect((await f.post(`/api/jobs/${job.id}/cancel`, {}, "cancel-model-test")).status).toBe(202);
		await aborted.promise;
		const cancelled = await f.settle<Job>(`/api/jobs/${job.id}`, "cancelled");
		await f.restart();
		expect((await f.read<Stored<Job>>(`/api/jobs/${job.id}`)).data.usage).toEqual(cancelled.data.usage);
		expect((await f.read<Stored<Job>>(`/api/jobs/${job.id}`)).data.status).toBe("cancelled");
		expect(f.faux.state.callCount).toBe(1);
	});
});
