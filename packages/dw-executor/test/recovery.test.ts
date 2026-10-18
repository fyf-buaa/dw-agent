import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutorService } from "../src/service.ts";
import { deferred, fixture, tagged } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("process interruption recovery", () => {
	it("does not replay a tool whose external outcome is unknown", async () => {
		const started = deferred();
		const release = deferred();
		let executions = 0;
		const f = await fixture({
			maxModelCalls: 1,
			extensions: [
				(pi) => {
					pi.registerTool({
						name: "effect",
						label: "effect",
						description: "External side effect",
						parameters: Type.Object({}),
						execute: async () => {
							executions++;
							started.resolve();
							await release.promise;
							return { content: [{ type: "text", text: "effect finished" }], details: {} };
						},
					});
				},
			],
		});
		cleanups.push(f.cleanup);
		const session = await f.open("agent");
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("effect", {}, { id: "external-effect" }), { stopReason: "toolUse" }),
		]);
		const input = f.command(
			"input.submit",
			{ text: "perform external effect" },
			{ session_id: session.id, mode_revision: 0 },
		);
		const [accepted] = await f.service.handle("client", input);
		await started.promise;
		const recoveryDir = join(f.directory, "recovered");
		mkdirSync(join(recoveryDir, "sessions"), { recursive: true });
		copyFileSync(session.manager.getSessionFile()!, join(recoveryDir, "sessions", "snapshot.jsonl"));
		release.resolve();
		await session.waitForIdle();
		const recovered = new ExecutorService({ ...f.settings, dataDir: recoveryDir });
		cleanups.push(() => recovered.close());
		await recovered.initialize();
		const recoveredSession = recovered.getSession(session.id);
		expect(recoveredSession.snapshot().paused_run_id).toBe(accepted.run_id);
		expect(executions).toBe(1);
		expect(f.faux.state.callCount).toBe(1);
		expect(recoveredSession.manager.buildSessionContext().messages).toContainEqual(
			expect.objectContaining({ role: "toolResult", toolCallId: "external-effect", isError: true }),
		);
		expect((await recovered.handle("client", input))[0]).toEqual(accepted);
		f.faux.setResponses([
			(context) => {
				expect(JSON.stringify(context)).toContain("interrupted");
				expect(JSON.stringify(context)).toContain("interrupted_tool_calls");
				return fauxAssistantMessage(tagged("检查后继续。"));
			},
		]);
		await recovered.handle(
			"client",
			f.command("run.resume", {}, { session_id: session.id, run_id: accepted.run_id, mode_revision: 0 }),
		);
		await recoveredSession.waitForIdle();
		expect(executions).toBe(1);
		expect(f.faux.state.callCount).toBe(2);
	});

	it("marks interrupted chat failed and keeps its request ID consumed", async () => {
		const called = deferred();
		const release = deferred();
		const f = await fixture();
		cleanups.push(f.cleanup);
		const session = await f.open();
		f.faux.setResponses([
			async () => {
				called.resolve();
				await release.promise;
				return fauxAssistantMessage(tagged("original completed"));
			},
		]);
		const input = f.command("input.submit", { text: "original chat" }, { session_id: session.id, mode_revision: 0 });
		const [accepted] = await f.service.handle("client", input);
		await called.promise;
		const recoveryDir = join(f.directory, "recovered");
		mkdirSync(join(recoveryDir, "sessions"), { recursive: true });
		copyFileSync(session.manager.getSessionFile()!, join(recoveryDir, "sessions", "snapshot.jsonl"));
		release.resolve();
		await session.waitForIdle();
		const recovered = new ExecutorService({ ...f.settings, dataDir: recoveryDir });
		cleanups.push(() => recovered.close());
		await recovered.initialize();
		const recoveredSession = recovered.getSession(session.id);
		expect(recoveredSession.eventsAfter(0).at(-1)).toMatchObject({
			type: "run.failed",
			payload: { error: { code: "INTERRUPTED" } },
		});
		expect((await recovered.handle("client", input))[0]).toEqual(accepted);
		expect(f.faux.state.callCount).toBe(1);
	});
});
