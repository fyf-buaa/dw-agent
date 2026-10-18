import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InlineExtension } from "../../coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import { CompanionRuntime } from "../src/companion-runtime.ts";
import { CompanionStore } from "../src/companion-store.ts";
import { DEFAULT_ROLEPLAY, type RoleplayConfig } from "../src/companion-types.ts";
import { ProportionalContextPolicy } from "../src/context-policy.ts";
import { type Envelope, EnvelopeSchema, type Mode, parseEnvelope } from "../src/runtime-protocol.ts";
import { commandIdentity, SessionController, type SessionMetadata, type SessionOptions } from "../src/session.ts";
import { fixture, tagged } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(extensions: InlineExtension[] = [], maxModelCalls = 8) {
	const f = await fixture();
	const store = await CompanionStore.open(join(f.directory, "session-companion.sqlite"));
	const companion = new CompanionRuntime(store);
	const controllers = new Set<SessionController>();
	const agentDir = join(f.directory, "session-agent");
	mkdirSync(agentDir, { recursive: true });
	const options: SessionOptions = {
		agentDir,
		runtimeFactory: f.settings.runtimeFactory!,
		tools: { extensions: () => extensions },
		context: new ProportionalContextPolicy(),
		maxModelCalls,
		maxOutputTokens: 8192,
		companion,
	};
	const open = async (scope: { persona_id?: string; user_id?: string; config?: RoleplayConfig; mode?: Mode } = {}) => {
		const metadata: SessionMetadata = {
			version: 1,
			persona: {
				id: scope.persona_id ?? "default",
				revision: "frozen-1",
				system_prompt: "PERSONA_SENTINEL: preserve the original persona and tool rules.",
				roleplay: scope.config ?? { ...structuredClone(DEFAULT_ROLEPLAY), enabled: true, name: "Mira" },
			},
			...(scope.user_id === undefined ? {} : { user_id: scope.user_id }),
			cwd: f.directory,
			mode: scope.mode ?? "chat",
			creation_key: `creation-${controllers.size}`,
			creation_fingerprint: "test",
		};
		const manager = SessionManager.create(f.directory, join(f.directory, "direct-sessions"));
		manager.appendCustomEntry("dw.session", metadata);
		const controller = await SessionController.open(manager, metadata, options);
		controllers.add(controller);
		return controller;
	};
	const close = async (controller: SessionController) => {
		controllers.delete(controller);
		await controller.close();
	};
	const reopen = async (controller: SessionController) => {
		const file = controller.manager.getSessionFile()!;
		await close(controller);
		const recovered = await SessionController.open(SessionManager.open(file), controller.metadata, options);
		controllers.add(recovered);
		return recovered;
	};
	const send = async (
		controller: SessionController,
		type: string,
		payload: Record<string, unknown>,
		runId?: string,
	) => {
		const command = f.command(type, payload, {
			session_id: controller.id,
			mode_revision: controller.snapshot().mode_revision as number,
			...(runId ? { run_id: runId } : {}),
		});
		return controller.handle(command, commandIdentity("companion-test", command));
	};
	const submit = async (controller: SessionController, input: string) => {
		const [accepted] = await send(controller, "input.submit", { text: input });
		await controller.waitForIdle();
		return accepted;
	};
	cleanups.push(async () => {
		for (const controller of controllers) await controller.close();
		store.close();
		await f.cleanup();
	});
	return { ...f, store, companion, options, open, reopen, send, submit };
}

const affect = (quote: string, delta = 2) => ({
	affect: {
		valence_delta: 0.1,
		arousal_delta: 0.1,
		affinity_delta: delta,
		evidence_quote: quote,
		reason: "A kind exchange",
	},
});
const control = (value: unknown) => `<companion>${JSON.stringify(value)}</companion>`;
const scope = { persona_id: "default", user_id: "local" };
const lastRunEvent = (session: SessionController) =>
	session.eventsAfter(0).findLast((event) => event.type.startsWith("run."));

describe("companion session boundary", () => {
	it("accepts explicit stable user scope and exposes the resolved local default", async () => {
		const f = await setup();
		const session = await f.open();
		expect(session.snapshot().user_id).toBe("local");
		const explicit = await f.open({ user_id: "owner_2" });
		expect(explicit.snapshot().user_id).toBe("owner_2");
		const command: Envelope = {
			v: 1,
			id: "open",
			type: "session.open",
			payload: { persona_id: "default", user_id: "owner_2", cwd: f.directory },
		};
		expect(parseEnvelope(command).payload.user_id).toBe("owner_2");
		expect(() => parseEnvelope({ ...command, payload: { ...command.payload, user_id: "../other" } })).toThrow();
	});

	it("retains original user-source time when a reply completes later and its memory commit recovers", async () => {
		const f = await setup();
		let session = await f.open();
		const input = "Tomorrow I plan to visit the garden.";
		let receivedAt = 0;
		const clock = vi.spyOn(Date, "now");
		const commit = vi.spyOn(f.companion, "commit").mockImplementationOnce(() => {
			throw new Error("temporary storage failure");
		});
		f.faux.setResponses([
			(context) => {
				const accepted = session.manager.getEntries().findLast((entry) => {
					if (entry.type !== "custom" || entry.customType !== "dw.event") return false;
					const data = entry.data;
					if (!data || typeof data !== "object" || !("event" in data) || !Check(EnvelopeSchema, data.event))
						return false;
					return data.event.type === "command.accepted" && data.event.payload.operation === "input.submit";
				});
				if (!accepted) throw new Error("Missing input journal entry");
				receivedAt = Date.parse(accepted.timestamp);
				expect(getCurrentSystemPrompt(context.messages)).toContain(new Date(receivedAt).toISOString());
				clock.mockReturnValue(receivedAt + 2 * 86_400_000);
				return fauxAssistantMessage(
					`${tagged("A fictional garden visit is a plan, not a completed event.")}${control({
						memories: [
							{
								kind: "commitment",
								domain: "user",
								content: "The user plans a garden visit tomorrow.",
								confidence: 1,
								importance: 0.8,
								durability: "short",
								evidence: { speaker: "user", quote: input },
							},
						],
					})}`,
				);
			},
		]);
		await f.submit(session, input);
		clock.mockRestore();
		commit.mockRestore();
		expect(lastRunEvent(session)?.type).toBe("run.completed");
		session = await f.reopen(session);
		const pending = f.store.list(scope, { status: "pending" }).items[0];
		expect(pending).toMatchObject({
			created_at: receivedAt + 2 * 86_400_000,
			sources: [{ speaker: "user", timestamp: receivedAt, quote: input }],
		});
		const episode = f.store.list(scope, { kind: "episode" }).items[0];
		expect(episode.sources).toEqual([
			expect.objectContaining({ speaker: "user", timestamp: receivedAt }),
			expect.objectContaining({ speaker: "assistant", timestamp: receivedAt + 2 * 86_400_000 }),
		]);
		expect(f.faux.state.callCount).toBe(1);
	});

	it("makes one chat call, projects bounded memory ephemerally, and shares only the exact scope", async () => {
		const f = await setup();
		const memory = f.store.create(scope, {
			kind: "fact",
			domain: "user",
			content: "Violet telescope belongs to the local observer.",
		});
		f.companion.prepare(scope, { ...DEFAULT_ROLEPLAY, enabled: true }, "violet telescope");
		expect(f.store.get(scope, memory.id)?.recall_count).toBe(0);
		const first = await f.open();
		f.faux.setResponses([
			(context) => {
				const system = getCurrentSystemPrompt(context.messages);
				expect(system).toContain("PERSONA_SENTINEL");
				expect(system).toContain("Violet telescope belongs");
				expect(context.messages.filter((message) => message.role === "system")).toHaveLength(1);
				return fauxAssistantMessage(tagged("I remember your violet telescope."));
			},
		]);
		await f.submit(first, "violet telescope");
		expect(f.faux.state.callCount).toBe(1);
		expect(lastRunEvent(first)?.type).toBe("run.completed");
		expect(f.store.get(scope, memory.id)?.recall_count).toBe(1);
		const nativeSystem = first.manager.buildSessionContext().messages.filter((message) => message.role === "system");
		expect(JSON.stringify(nativeSystem)).not.toContain("Violet telescope belongs");
		const same = await f.open();
		const otherUser = await f.open({ user_id: "other" });
		const otherPersona = await f.open({ persona_id: "other" });
		for (const [session, expected] of [
			[same, true],
			[otherUser, false],
			[otherPersona, false],
		] as const) {
			f.faux.setResponses([
				(context) => {
					expect(getCurrentSystemPrompt(context.messages).includes("Violet telescope belongs")).toBe(expected);
					return fauxAssistantMessage(tagged("A scoped answer."));
				},
			]);
			await f.submit(session, "violet telescope");
		}
		expect(f.store.list(scope, { kind: "episode" }).total).toBe(2);
	});

	it("keeps quoted tags visible but strips true metadata from later requests and journals only sanitized metadata", async () => {
		const f = await setup();
		const session = await f.open();
		const literal = 'A quoted <companion>{"private":"literal"}</companion> and </speech> remain speech.';
		const metadata = affect("thank you");
		f.faux.setResponses([fauxAssistantMessage(tagged(literal) + control(metadata))]);
		await f.submit(session, "thank you");
		expect(f.store.getState(scope)?.affinity).toBe(2);
		expect(lastRunEvent(session)?.payload.result).toMatchObject({ speech: literal });
		f.faux.setResponses([
			(context) => {
				const assistant = context.messages.filter((message) => message.role === "assistant");
				expect(JSON.stringify(assistant)).toContain("literal");
				expect(JSON.stringify(assistant)).not.toContain("evidence_quote");
				return fauxAssistantMessage(
					tagged("Safe visible reply.") +
						control({ affect: { ...metadata.affect, reason: "password=super-secret" } }),
				);
			},
		]);
		await f.submit(session, "thank you");
		const records = session.manager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "dw.companion");
		expect(records).toHaveLength(2);
		expect(JSON.stringify(records)).not.toContain("super-secret");
		expect(JSON.stringify(records)).not.toContain(literal);
		expect(lastRunEvent(session)?.type).toBe("run.completed");
	});

	it("warns on invalid control JSON and rejects invented evidence without losing speech", async () => {
		const f = await setup();
		const session = await f.open();
		const invented = {
			...affect("not in the actual user message"),
			memories: [
				{
					kind: "fact",
					domain: "user",
					content: "Invented private biography",
					confidence: 1,
					importance: 1,
					durability: "durable",
					evidence: { speaker: "user", quote: "not in the actual user message" },
				},
			],
		};
		for (const suffix of [
			"<companion>{not JSON}</companion>",
			'<companion>{"affect":"unterminated',
			control(invented),
		]) {
			f.faux.setResponses([fauxAssistantMessage(tagged("Valid speech survives.") + suffix)]);
			await f.submit(session, "ordinary greeting");
			expect(lastRunEvent(session)).toMatchObject({
				type: "run.completed",
				payload: { result: { speech: "Valid speech survives." } },
			});
		}
		expect(f.store.getState(scope)?.affinity).toBe(0);
		expect(f.store.list(scope, { status: "pending" }).total).toBe(0);
		expect(
			session
				.eventsAfter(0)
				.some((event) => event.type === "reply.warning" && event.payload.code === "INVALID_COMPANION_METADATA"),
		).toBe(true);
	});

	it("retains strict disabled grammar and never harvests a failed, cancelled or paused run", async () => {
		const f = await setup(
			[
				(pi) => {
					pi.registerTool({
						name: "boundary",
						label: "boundary",
						description: "A safe tool boundary",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
					});
				},
			],
			1,
		);
		const disabled = await f.open({ config: { ...DEFAULT_ROLEPLAY, enabled: false } });
		f.faux.setResponses([fauxAssistantMessage(tagged("visible") + control(affect("hello")))]);
		await f.submit(disabled, "hello");
		expect(lastRunEvent(disabled)?.type).toBe("run.failed");
		const session = await f.open();
		for (const response of [
			fauxAssistantMessage(tagged("visible") + control(affect("hello")), {
				stopReason: "error",
				errorMessage: "provider failed",
			}),
			fauxAssistantMessage(`${tagged("visible")}broken visible grammar`),
		]) {
			f.faux.setResponses([response]);
			await f.submit(session, "hello");
			expect(lastRunEvent(session)?.type).toBe("run.failed");
		}
		const agent = await f.open({ mode: "agent" });
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("boundary", {}, { id: "safe-boundary" }), { stopReason: "toolUse" }),
		]);
		const accepted = await f.submit(agent, "hello");
		expect(lastRunEvent(agent)?.type).toBe("run.paused");
		await f.send(agent, "run.cancel", {}, accepted.run_id);
		expect(lastRunEvent(agent)?.type).toBe("run.cancelled");
		for (const controller of [session, agent]) {
			const runId = lastRunEvent(controller)!.run_id!;
			controller.manager.appendCustomEntry("dw.companion", {
				run_id: runId,
				occurred_at: Date.now(),
				metadata: affect("hello"),
			});
			controller.manager.flush();
			await f.reopen(controller);
			expect(f.store.hasProcessed(scope, runId)).toBe(false);
		}
		expect(f.store.getState(scope)).toBeUndefined();
		expect(f.store.list(scope, { status: "all" }).total).toBe(0);
	});

	it("stores attributed model proposals only as pending owner-review entries", async () => {
		const f = await setup();
		const session = await f.open();
		const input = "I grow violet orchids.";
		f.faux.setResponses([
			fauxAssistantMessage(
				tagged("I will remember your orchids.") +
					control({
						memories: [
							{
								kind: "fact",
								domain: "user",
								content: "The user grows violet orchids.",
								confidence: 0.9,
								importance: 0.7,
								durability: "durable",
								evidence: { speaker: "user", quote: input },
							},
						],
					}),
			),
		]);
		await f.submit(session, input);
		const proposed = f.store.list(scope, { kind: "fact", status: "pending" }).items;
		expect(proposed).toHaveLength(1);
		expect(proposed[0].sources[0]).toMatchObject({ speaker: "user", quote: input, session_id: session.id });
		expect(f.store.list(scope, { kind: "fact", status: "active" }).total).toBe(0);
	});

	it("replays completed journals after a SQLite commit failure without duplicate affinity or resurrection after forget", async () => {
		const f = await setup();
		let session = await f.open();
		const commit = vi.spyOn(f.companion, "commit").mockImplementationOnce(() => {
			throw new Error("simulated SQLite interruption");
		});
		f.faux.setResponses([fauxAssistantMessage(tagged("Welcome back.") + control(affect("thank you")))]);
		const accepted = await f.submit(session, "thank you");
		expect(lastRunEvent(session)?.type).toBe("run.completed");
		expect(f.store.hasProcessed(scope, accepted.run_id!)).toBe(false);
		expect(session.eventsAfter(0).some((event) => event.type === "run.failed")).toBe(false);
		commit.mockRestore();
		session = await f.reopen(session);
		expect(f.store.hasProcessed(scope, accepted.run_id!)).toBe(true);
		expect(f.store.getState(scope)?.affinity).toBe(2);
		const episode = f.store.list(scope, { kind: "episode" }).items[0];
		expect(episode).toBeDefined();
		f.store.mutate(scope, episode.id, { expected_revision: episode.revision, operation: "forget" });
		session = await f.reopen(session);
		expect(f.store.getState(scope)?.affinity).toBe(2);
		expect(f.store.list(scope, { kind: "episode" }).total).toBe(0);
		expect(f.faux.state.callCount).toBe(1);
	});

	it("preserves native tools, frozen persona and companion state across idle mode switches", async () => {
		let executions = 0;
		const f = await setup([
			(pi) => {
				pi.registerTool({
					name: "calculate",
					label: "calculate",
					description: "Return a value",
					parameters: Type.Object({}),
					execute: async () => {
						executions++;
						return { content: [{ type: "text", text: "TOOL_VALUE_42" }], details: {} };
					},
				});
			},
		]);
		const session = await f.open({ config: { ...DEFAULT_ROLEPLAY, enabled: true, memory_enabled: false } });
		await f.send(session, "mode.set", { mode: "agent" });
		f.faux.setResponses([
			(context) => {
				expect(getCurrentSystemPrompt(context.messages)).toContain("PERSONA_SENTINEL");
				expect(JSON.stringify(context)).toContain("calculate");
				return fauxAssistantMessage(fauxToolCall("calculate", {}, { id: "calculation" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				expect(JSON.stringify(context)).toContain("TOOL_VALUE_42");
				return fauxAssistantMessage(tagged("The result is 42.") + control(affect("thank you")));
			},
		]);
		await f.submit(session, "thank you; calculate");
		expect(executions).toBe(1);
		expect(f.store.getState(scope)?.affinity).toBe(2);
		expect(f.store.list(scope, { status: "all" }).total).toBe(0);
		await f.send(session, "mode.set", { mode: "chat" });
		f.faux.setResponses([fauxAssistantMessage(tagged("Still the same companion."))]);
		await f.submit(session, "hello again");
		expect(f.faux.state.callCount).toBe(3);
		expect(session.snapshot()).toMatchObject({
			mode: "chat",
			mode_revision: 2,
			persona_revision: "frozen-1",
			user_id: "local",
		});
	});
});
