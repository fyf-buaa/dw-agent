import { existsSync, readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { PiToolProvider } from "../src/providers.ts";
import { ExecutorService } from "../src/service.ts";
import { deferred, fixture, tagged } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("shared Pi session", () => {
	it("runs the default Pi codemode extension through the real SDK tool registry", async () => {
		const f = await fixture({ toolProvider: new PiToolProvider() });
		cleanups.push(f.cleanup);
		const session = await f.open("agent");
		let toolResult: unknown;
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("codemode", { code: "text(1 + 1)" }, { id: "code-1" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				const result = context.messages.find(
					(message) => message.role === "toolResult" && message.toolCallId === "code-1",
				);
				toolResult = result;
				return fauxAssistantMessage(tagged("计算完成。"));
			},
		]);
		await f.service.handle(
			"client",
			f.command("input.submit", { text: "计算 1+1" }, { session_id: session.id, mode_revision: 0 }),
		);
		await session.waitForIdle();
		expect(toolResult, JSON.stringify(toolResult)).toMatchObject({ isError: false });
		expect(JSON.stringify(toolResult)).toContain("2");
		expect(session.eventsAfter(0).at(-1)).toMatchObject({
			type: "run.completed",
			payload: { result: { speech: "计算完成。" }, usage: { model_calls: 2 } },
		});
	});
	it("makes one chat request for multiple streamed segments, persists before delivery, and deduplicates input", async () => {
		const f = await fixture();
		cleanups.push(f.cleanup);
		const session = await f.open();
		f.faux.setResponses([fauxAssistantMessage(tagged("第一句。") + tagged("第二句。"))]);
		const persistedBeforeDelivery: boolean[] = [];
		session.subscribe((event) => {
			persistedBeforeDelivery.push(
				existsSync(session.manager.getSessionFile()!) &&
					readFileSync(session.manager.getSessionFile()!, "utf8").includes(event.id),
			);
		});
		const input = f.command("input.submit", { text: "/ordinary-text" }, { session_id: session.id, mode_revision: 0 });
		const [accepted] = await f.service.handle("client", input);
		await session.waitForIdle();
		expect(persistedBeforeDelivery.length).toBeGreaterThan(0);
		expect(persistedBeforeDelivery.every(Boolean)).toBe(true);
		expect(f.faux.state.callCount).toBe(1);
		expect(
			session
				.eventsAfter(0)
				.filter((event) => event.type === "reply.segment")
				.map((event) => event.payload.speech),
		).toEqual(["第一句。", "第二句。"]);
		expect(session.eventsAfter(0).at(-1)).toMatchObject({
			type: "run.completed",
			payload: {
				result: {
					speech: "第一句。第二句。",
					text: "（轻轻点头）第一句。（轻轻点头）第二句。",
					segments: [
						{
							index: 0,
							expression: { description: "轻轻点头", language: "zh-CN" },
							speech: "第一句。",
							text: "（轻轻点头）第一句。",
							task_refs: [],
						},
						{
							index: 1,
							expression: { description: "轻轻点头", language: "zh-CN" },
							speech: "第二句。",
							text: "（轻轻点头）第二句。",
							task_refs: [],
						},
					],
				},
				usage: { model_calls: 1 },
			},
		});
		const repeated = await f.service.handle("client", input);
		expect(repeated[0]).toEqual(accepted);
		expect(f.faux.state.callCount).toBe(1);
	});

	it("does not retry provider errors or repair malformed output", async () => {
		const f = await fixture();
		cleanups.push(f.cleanup);
		const session = await f.open();
		for (const response of [
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" }),
			fauxAssistantMessage(`${tagged("已确认。")}broken`),
		]) {
			f.faux.setResponses([response, fauxAssistantMessage(tagged("UNEXPECTED EXTRA CALL"))]);
			await f.service.handle(
				"client",
				f.command("input.submit", { text: "test" }, { session_id: session.id, mode_revision: 0 }),
			);
			await session.waitForIdle();
			expect(f.faux.getPendingResponseCount()).toBe(1);
			expect(session.eventsAfter(0).at(-1)?.type).toBe("run.failed");
		}
		expect(f.faux.state.callCount).toBe(2);
		expect(session.eventsAfter(0).at(-1)?.payload.partial).toBe(true);
	});

	it("pauses after the complete tool batch, chats on the same branch, and explicitly resumes", async () => {
		const started = deferred();
		const release = deferred();
		let executions = 0;
		const f = await fixture({
			extensions: [
				(pi) => {
					pi.registerTool({
						name: "hold",
						label: "hold",
						description: "Test safe boundary",
						parameters: Type.Object({}),
						execute: async () => {
							executions++;
							started.resolve();
							await release.promise;
							return { content: [{ type: "text", text: "TOOL_RESULT_SENTINEL" }], details: {} };
						},
					});
				},
			],
		});
		cleanups.push(f.cleanup);
		const session = await f.open("agent");
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("hold", {}, { id: "once" }), { stopReason: "toolUse" }),
			(context) => {
				expect(JSON.stringify(context)).toContain("PERSONA_SENTINEL");
				expect(JSON.stringify(context)).toContain("TOOL_RESULT_SENTINEL");
				return fauxAssistantMessage(tagged("聊天插入。"));
			},
			(context) => {
				const raw = JSON.stringify(context);
				expect(raw).toContain("聊天插入。");
				expect(raw).toContain("TOOL_RESULT_SENTINEL");
				expect(raw).toContain("ORIGINAL_TASK");
				expect(raw).toContain("last_tool_results");
				return fauxAssistantMessage(tagged("任务完成。"));
			},
		]);
		const [accepted] = await f.service.handle(
			"client",
			f.command("input.submit", { text: "ORIGINAL_TASK" }, { session_id: session.id, mode_revision: 0 }),
		);
		await started.promise;
		await f.service.handle(
			"client",
			f.command("mode.set", { mode: "chat" }, { session_id: session.id, mode_revision: 0 }),
		);
		expect(session.snapshot().target_mode).toBe("chat");
		expect(session.eventsAfter(0).some((event) => event.type === "mode.changed")).toBe(false);
		release.resolve();
		await session.waitForIdle();
		expect(f.faux.state.callCount).toBe(1);
		expect(session.snapshot()).toMatchObject({ mode: "chat", mode_revision: 1, paused_run_id: accepted.run_id });
		const timeline = session.eventsAfter(0).map((event) => event.type);
		expect(timeline.indexOf("tool.finished")).toBeLessThan(timeline.indexOf("run.paused"));
		expect(timeline.indexOf("run.paused")).toBeLessThan(timeline.indexOf("mode.changed"));
		await f.service.handle(
			"client",
			f.command("input.submit", { text: "先聊一句。" }, { session_id: session.id, mode_revision: 1 }),
		);
		await session.waitForIdle();
		await f.service.handle(
			"client",
			f.command("mode.set", { mode: "agent" }, { session_id: session.id, mode_revision: 1 }),
		);
		expect(f.faux.state.callCount).toBe(2);
		await f.service.handle(
			"client",
			f.command("run.resume", {}, { session_id: session.id, run_id: accepted.run_id, mode_revision: 2 }),
		);
		await session.waitForIdle();
		expect(executions).toBe(1);
		expect(f.faux.state.callCount).toBe(3);
		expect(session.eventsAfter(0).at(-1)).toMatchObject({
			type: "run.completed",
			run_id: accepted.run_id,
			payload: { result: { speech: "任务完成。" }, usage: { model_calls: 2 } },
		});
	});

	it("pauses at the model call budget and preserves idempotency across a restart", async () => {
		const f = await fixture({ maxModelCalls: 1 });
		cleanups.push(f.cleanup);
		const session = await f.open("agent");
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "missing-file" }), { stopReason: "toolUse" }),
		]);
		const input = f.command("input.submit", { text: "budget task" }, { session_id: session.id, mode_revision: 0 });
		const [accepted] = await f.service.handle("client", input);
		await session.waitForIdle();
		expect(session.eventsAfter(0).at(-1)).toMatchObject({
			type: "run.paused",
			payload: { checkpoint: { reason: "budget_exhausted" } },
		});
		await f.service.close();
		const reopened = new ExecutorService(f.settings);
		cleanups.push(() => reopened.close());
		await reopened.initialize();
		expect((await reopened.handle("client", input))[0]).toEqual(accepted);
		expect(f.faux.state.callCount).toBe(1);
		expect(reopened.getSession(session.id).snapshot().paused_run_id).toBe(accepted.run_id);
	});
});
