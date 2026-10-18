import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { deferred, fixture, tagged } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("host execution boundaries", () => {
	it("does not load or run agent extension commands during chat, including after a mode switch", async () => {
		let loaded = 0;
		let commands = 0;
		let hooks = 0;
		const f = await fixture({
			extensions: [
				(pi) => {
					loaded++;
					pi.registerCommand("custom", {
						handler: async () => {
							commands++;
						},
					});
					pi.on("agent_before_settle", () => {
						hooks++;
					});
				},
			],
		});
		cleanups.push(f.cleanup);
		const session = await f.open();
		f.faux.setResponses([fauxAssistantMessage(tagged("chat-one")), fauxAssistantMessage(tagged("chat-two"))]);
		await f.service.handle(
			"client",
			f.command("input.submit", { text: "/custom" }, { session_id: session.id, mode_revision: 0 }),
		);
		await session.waitForIdle();
		expect(loaded).toBe(0);
		await f.service.handle(
			"client",
			f.command("mode.set", { mode: "agent" }, { session_id: session.id, mode_revision: 0 }),
		);
		expect(loaded).toBe(1);
		await f.service.handle(
			"client",
			f.command("mode.set", { mode: "chat" }, { session_id: session.id, mode_revision: 1 }),
		);
		await f.service.handle(
			"client",
			f.command("input.submit", { text: "/custom" }, { session_id: session.id, mode_revision: 2 }),
		);
		await session.waitForIdle();
		expect(commands).toBe(0);
		expect(hooks).toBe(0);
		expect(f.faux.state.callCount).toBe(2);
	});

	it("suppresses extension continuation and settled hooks after a safe pause", async () => {
		const started = deferred();
		const release = deferred();
		let boundaryCalls = 0;
		let settledCalls = 0;
		const f = await fixture({
			extensions: [
				(pi) => {
					pi.registerTool({
						name: "hold",
						label: "hold",
						description: "hold",
						parameters: Type.Object({}),
						execute: async () => {
							started.resolve();
							await release.promise;
							return { content: [{ type: "text", text: "done" }], details: {} };
						},
					});
					pi.on("turn_end", () => {
						boundaryCalls++;
						return {
							entries: [
								{ type: "custom_message", customType: "extra", content: "extra request", display: false },
							],
							continue: true,
						};
					});
					pi.on("agent_before_settle", () => {
						settledCalls++;
						return { continue: true };
					});
					pi.on("agent_settled", () => {
						settledCalls++;
					});
					pi.on("agent_end", () => {
						settledCalls++;
					});
				},
			],
		});
		cleanups.push(f.cleanup);
		const session = await f.open("agent");
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(tagged("must stay unused")),
		]);
		await f.service.handle(
			"client",
			f.command("input.submit", { text: "pause" }, { session_id: session.id, mode_revision: 0 }),
		);
		await started.promise;
		await f.service.handle(
			"client",
			f.command("mode.set", { mode: "chat" }, { session_id: session.id, mode_revision: 0 }),
		);
		release.resolve();
		await session.waitForIdle();
		expect(boundaryCalls).toBe(0);
		expect(settledCalls).toBe(0);
		expect(f.faux.state.callCount).toBe(1);
	});

	it("waits for the one in-flight chat response before switching and rejects racing inputs", async () => {
		const called = deferred();
		const release = deferred();
		const f = await fixture();
		cleanups.push(f.cleanup);
		const session = await f.open();
		f.faux.setResponses([
			async () => {
				called.resolve();
				await release.promise;
				return fauxAssistantMessage(tagged("finished chat"));
			},
		]);
		await f.service.handle(
			"client",
			f.command("input.submit", { text: "chat" }, { session_id: session.id, mode_revision: 0 }),
		);
		await called.promise;
		await f.service.handle(
			"client",
			f.command("mode.set", { mode: "agent" }, { session_id: session.id, mode_revision: 0 }),
		);
		const [rejected] = await f.service.handle(
			"client",
			f.command("input.submit", { text: "racing" }, { session_id: session.id, mode_revision: 0 }),
		);
		expect(rejected.payload).toMatchObject({ error: { code: "MODE_TRANSITIONING" } });
		release.resolve();
		await session.waitForIdle();
		expect(session.snapshot()).toMatchObject({ mode: "agent", mode_revision: 1, paused_run_id: null });
		expect(f.faux.state.callCount).toBe(1);
	});

	it("blocks native tool hallucinations in chat without making a follow-up request", async () => {
		let effects = 0;
		const f = await fixture({
			extensions: [
				(pi) => {
					pi.registerTool({
						name: "effect",
						label: "effect",
						description: "effect",
						parameters: Type.Object({}),
						execute: async () => {
							effects++;
							return { content: [], details: {} };
						},
					});
				},
			],
		});
		cleanups.push(f.cleanup);
		const session = await f.open();
		f.faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" })]);
		await f.service.handle(
			"client",
			f.command("input.submit", { text: "chat only" }, { session_id: session.id, mode_revision: 0 }),
		);
		await session.waitForIdle();
		expect(effects).toBe(0);
		expect(f.faux.state.callCount).toBe(1);
	});
});
