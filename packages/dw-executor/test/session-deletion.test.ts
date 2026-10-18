import { existsSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import type { Stored } from "../src/api-store.ts";
import { DEFAULT_ROLEPLAY } from "../src/companion-types.ts";
import { apiFixture, type EventPage, events, type Page, socketClient } from "./api-helpers.ts";
import { deferred, tagged } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("durable session deletion", () => {
	it("deletes only the selected journals, preserves tombstones and retains unrelated resources through restart", async () => {
		const f = await apiFixture(cleanups, true);
		const personaResponse = await f.post("/api/personas", {
			id: "role",
			system_prompt: "Keep evidence separate.",
			roleplay: {
				...structuredClone(DEFAULT_ROLEPLAY),
				enabled: true,
				name: "Mira",
				identity: "Librarian",
				timezone: "UTC",
			},
		});
		expect(personaResponse.status).toBe(201);
		const persona = await personaResponse.json();
		const memoryResponse = await f.post("/api/companions/role/alice/memories", {
			kind: "fact",
			domain: "user",
			content: "Alice keeps a purple telescope.",
			pinned: true,
		});
		expect(memoryResponse.status).toBe(201);
		const memory = (await memoryResponse.json()) as Stored<unknown>;
		const profile = await f.read<Stored<unknown>>("/api/model-profiles/default");
		const workspace = await f.read<Stored<unknown>>("/api/workspaces/fixture");
		const idle = await f.createSession({ persona_id: "role", user_id: "alice" }, "delete-session");
		const populated = await f.createSession({ persona_id: "role", user_id: "alice" });
		const kept = await f.createSession({ persona_id: "role", user_id: "alice", title: "Retain me" }, "keep-session");
		f.faux.setResponses([fauxAssistantMessage(tagged("Durable conversation."))]);
		const run = (await (
			await f.post(`/api/sessions/${populated.id}/messages`, { text: "Delete only this conversation." })
		).json()) as Stored<{ status: string }>;
		await f.settle(`/api/runs/${run.id}`);
		const retainedMemory = await f.read(`/api/companions/role/alice/memories/${memory.id}`);
		const peer = await socketClient(f.socketUrl, cleanups);
		for (const session of [idle, populated]) await peer.subscribe(`session:${session.id}`);
		const removedFiles: string[] = [];
		const deletedHeads = new Map<string, number>();
		for (const session of [idle, populated]) {
			const current = await f.read<Stored<unknown>>(`/api/sessions/${session.id}`);
			const native = f.service.api.store.require<{ file: string }>("runtime_session", session.id);
			removedFiles.push(native.data.file);
			deletedHeads.set(session.id, (await f.read<EventPage>(`/api/sessions/${session.id}/events`)).latest_seq);
			const response = await f.request(`/api/sessions/${session.id}?expected_revision=${current.revision}`, {
				method: "DELETE",
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ id: session.id, deleted: true });
			await peer.wait(
				(event) => event.type === "session.deleted" && "session_id" in event && event.session_id === session.id,
			);
			for (const suffix of ["", "/messages"])
				expect((await f.request(`/api/sessions/${session.id}${suffix}`)).status).toBe(404);
			expect(
				(await f.request(`/api/sessions/${session.id}?expected_revision=${current.revision}`, { method: "DELETE" }))
					.status,
			).toBe(404);
		}
		expect(removedFiles.every((file) => !existsSync(file))).toBe(true);
		expect(events(peer.messages).filter((event) => event.type === "session.deleted")).toHaveLength(2);
		expect(peer.socket.readyState).toBe(1);
		await peer.close();
		await f.restart();
		expect((await f.read<Page<unknown>>("/api/sessions")).items.map((item) => item.id)).toEqual([kept.id]);
		for (const session of [idle, populated]) {
			expect((await f.request(`/api/sessions/${session.id}`)).status).toBe(404);
			const head = deletedHeads.get(session.id)!;
			const stale = await f.request(`/api/events?stream_id=session:${session.id}&after_seq=0`);
			expect(stale.status).toBe(410);
			expect(await stale.json()).toMatchObject({ error: { code: "CURSOR_EXPIRED" } });
			const page = await f.read<EventPage>(`/api/events?stream_id=session:${session.id}&after_seq=${head}`);
			expect(page.items.at(-1)).toMatchObject({
				type: "session.deleted",
				session_id: session.id,
				data: { id: session.id },
			});
			const replay = await socketClient(f.socketUrl, cleanups);
			expect(await replay.subscribe(`session:${session.id}`, page.latest_seq - 1)).toMatchObject({
				type: "subscription.accepted",
			});
			await replay.wait((event) => event.type === "session.deleted");
		}
		expect(await f.read(`/api/personas/role`)).toEqual(persona);
		expect(await f.read(`/api/companions/role/alice/memories/${memory.id}`)).toEqual(retainedMemory);
		expect(await f.read("/api/model-profiles/default")).toEqual(profile);
		expect(await f.read("/api/workspaces/fixture")).toEqual(workspace);
		expect(
			await (
				await f.post(
					"/api/sessions",
					{ workspace_id: "fixture", persona_id: "role", user_id: "alice", title: "Retain me" },
					"keep-session",
				)
			).json(),
		).toMatchObject({ id: kept.id });
		expect(
			(
				await f.post(
					"/api/sessions",
					{ workspace_id: "fixture", persona_id: "role", user_id: "alice" },
					"delete-session",
				)
			).status,
		).toBe(404);
		expect(f.faux.state.callCount).toBe(1);
	});

	it("uses resource revisions rather than read side effects and rejects stale deletes without changing data", async () => {
		const f = await apiFixture(cleanups);
		const session = await f.createSession();
		await f.read(`/api/sessions/${session.id}`);
		await f.read(`/api/sessions/${session.id}/events`);
		const changed = (await (
			await f.patch(`/api/sessions/${session.id}`, { expected_revision: session.revision, title: "Retained title" })
		).json()) as Stored<unknown>;
		expect(
			(await f.request(`/api/sessions/${session.id}?expected_revision=${session.revision}`, { method: "DELETE" }))
				.status,
		).toBe(409);
		expect(await f.read(`/api/sessions/${session.id}`)).toEqual(changed);
		expect(
			(await f.request(`/api/sessions/${session.id}?expected_revision=${changed.revision}`, { method: "DELETE" }))
				.status,
		).toBe(200);
		expect(f.faux.state.callCount).toBe(0);
	});

	it("does not implicitly cancel busy work; explicit cancellation permits deletion", async () => {
		const f = await apiFixture(cleanups);
		const session = await f.createSession();
		const entered = deferred();
		const release = deferred();
		cleanups.push(async () => {
			release.resolve();
		});
		f.faux.setResponses([
			async (_context, options) => {
				entered.resolve();
				options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
				await release.promise;
				return fauxAssistantMessage(tagged("Must not survive cancellation."));
			},
		]);
		const run = (await (
			await f.post(`/api/sessions/${session.id}/messages`, { text: "Wait for cancellation." })
		).json()) as Stored<{ status: string }>;
		await entered.promise;
		const current = await f.read<Stored<unknown>>(`/api/sessions/${session.id}`);
		expect(
			(await f.request(`/api/sessions/${session.id}?expected_revision=${current.revision}`, { method: "DELETE" }))
				.status,
		).toBe(409);
		expect((await f.read<Stored<{ status: string }>>(`/api/runs/${run.id}`)).data.status).toBe("running");
		expect((await f.post(`/api/runs/${run.id}/cancel`, {}, "cancel-once")).status).toBe(202);
		await f.settle(`/api/runs/${run.id}`, "cancelled");
		const cancelledEvents = await f.read<EventPage>(`/api/sessions/${session.id}/events`);
		expect(cancelledEvents.items.filter((event) => event.type === "run.cancelled")).toHaveLength(1);
		const idle = await f.read<Stored<unknown>>(`/api/sessions/${session.id}`);
		expect(
			(await f.request(`/api/sessions/${session.id}?expected_revision=${idle.revision}`, { method: "DELETE" }))
				.status,
		).toBe(200);
		const deleted = await f.read<EventPage>(
			`/api/sessions/${session.id}/events?after_seq=${cancelledEvents.latest_seq}`,
		);
		expect(deleted.items).toHaveLength(1);
		expect(deleted.items[0].type).toBe("session.deleted");
	});
});
