import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutorError } from "../src/errors.ts";
import { MAX_MESSAGE_BYTES } from "../src/runtime-protocol.ts";
import { ExecutorService } from "../src/service.ts";
import { deferred, fixture, tagged } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("durable command admission", () => {
	it("awaits extension shutdown before releasing its data directory", async () => {
		let shutdowns = 0;
		const f = await fixture({
			extensions: [
				(pi) => {
					pi.on("session_shutdown", async (event) => {
						if (event.reason === "quit") {
							await Promise.resolve();
							shutdowns++;
						}
					});
				},
			],
		});
		cleanups.push(f.cleanup);
		await f.open("agent");
		await f.service.close();
		expect(shutdowns).toBe(1);
	});
	it("rejects an ID conflict globally across sessions", async () => {
		const f = await fixture();
		cleanups.push(f.cleanup);
		const a = await f.open();
		const b = await f.open();
		f.faux.setResponses([fauxAssistantMessage(tagged("done"))]);
		const input = f.command("input.submit", { text: "one" }, { session_id: a.id, mode_revision: 0 });
		await f.service.handle("client", input);
		await a.waitForIdle();
		await expect(f.service.handle("client", { ...input, session_id: b.id })).rejects.toMatchObject({
			code: "ID_CONFLICT",
		});
		expect(f.faux.state.callCount).toBe(1);
	});

	it("rejects busy and stale inputs without consuming requests", async () => {
		const started = deferred();
		const release = deferred();
		const f = await fixture();
		cleanups.push(f.cleanup);
		const session = await f.open();
		f.faux.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage(tagged("done"));
			},
		]);
		await f.service.handle(
			"client",
			f.command("input.submit", { text: "one" }, { session_id: session.id, mode_revision: 0 }),
		);
		await started.promise;
		const busy = await f.service.handle(
			"client",
			f.command("input.submit", { text: "two" }, { session_id: session.id, mode_revision: 0 }),
		);
		expect(busy[0].payload).toMatchObject({ error: { code: "SESSION_BUSY" } });
		release.resolve();
		await session.waitForIdle();
		const stale = await f.service.handle(
			"client",
			f.command("input.submit", { text: "three" }, { session_id: session.id, mode_revision: 5 }),
		);
		expect(stale[0].payload).toMatchObject({ error: { code: "MODE_REVISION_MISMATCH" } });
		expect(f.faux.state.callCount).toBe(1);
	});

	it("returns context failures before any model request", async () => {
		const f = await fixture({
			contextPolicy: {
				assemble() {
					throw new ExecutorError("CONTEXT_TOO_LARGE", "Input does not fit");
				},
			},
		});
		cleanups.push(f.cleanup);
		const session = await f.open();
		await f.service.handle(
			"client",
			f.command("input.submit", { text: "too much" }, { session_id: session.id, mode_revision: 0 }),
		);
		await session.waitForIdle();
		expect(f.faux.state.callCount).toBe(0);
		expect(session.eventsAfter(0).at(-1)).toMatchObject({
			type: "run.failed",
			payload: { error: { code: "CONTEXT_TOO_LARGE" }, usage: { model_calls: 0 } },
		});
	});

	it("bounds history pages by bytes as well as item count", async () => {
		const f = await fixture();
		cleanups.push(f.cleanup);
		const session = await f.open();
		f.faux.setResponses(Array.from({ length: 17 }, () => fauxAssistantMessage(tagged("ok"))));
		for (let index = 0; index < 17; index++) {
			await f.service.handle(
				"client",
				f.command("input.submit", { text: "x".repeat(65536) }, { session_id: session.id, mode_revision: 0 }),
			);
			await session.waitForIdle();
		}
		const [page] = await f.service.handle(
			"client",
			f.command("history.get", { cursor: 0, limit: 200 }, { session_id: session.id }),
		);
		expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(MAX_MESSAGE_BYTES);
		expect(page.payload.next_cursor).not.toBeNull();
		expect((page.payload.items as unknown[]).length).toBeGreaterThan(0);
	});

	it("allows only one writer per data directory", async () => {
		const f = await fixture();
		cleanups.push(f.cleanup);
		const second = new ExecutorService(f.settings);
		cleanups.push(() => second.close());
		await expect(second.initialize()).rejects.toMatchObject({ code: "ELOCKED" });
	});
});
