import { once } from "node:events";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Stored } from "../src/api-store.ts";
import { AcknowledgementSchema, ApiEventSchema, SegmentSchema } from "../src/protocol.ts";
import { apiFixture, type EventPage, events, rootToken, socketClient } from "./api-helpers.ts";
import { tagged } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("resource event subscriptions", () => {
	it("multicasts live events, replays exact durable IDs and never repeats an HTTP effect", async () => {
		const f = await apiFixture(cleanups);
		const session = await f.createSession({}, "create-once");
		expect(await (await f.post("/api/sessions", { workspace_id: "fixture" }, "create-once")).json()).toEqual(session);
		const first = await socketClient(f.socketUrl, cleanups);
		const second = await socketClient(f.socketUrl, cleanups);
		for (const peer of [first, second])
			expect(await peer.subscribe(`session:${session.id}`)).toMatchObject({ type: "subscription.accepted" });
		f.faux.setResponses([fauxAssistantMessage(tagged("第一句。") + tagged("第二句。"))]);
		const response = await f.post(`/api/sessions/${session.id}/messages`, { text: "hello" }, "message-once");
		expect(response.status).toBe(202);
		const run = (await response.json()) as Stored<{ status: string }>;
		for (const peer of [first, second])
			await peer.wait((event) => "run_id" in event && event.run_id === run.id && event.type === "run.completed");
		await f.settle(`/api/runs/${run.id}`);
		const page = await f.read<EventPage>(`/api/sessions/${session.id}/events`);
		for (const peer of [first, second]) {
			expect(events(peer.messages).map((event) => event.event_id)).toEqual(
				page.items.map((event) => event.event_id),
			);
			for (const event of peer.messages)
				expect(Check("event_id" in event ? ApiEventSchema : AcknowledgementSchema, event)).toBe(true);
		}
		const segments = page.items.filter((event) => event.type === "reply.segment");
		expect(segments).toHaveLength(2);
		for (const segment of segments) expect(Check(SegmentSchema, segment.data)).toBe(true);
		expect(segments[0].data).toMatchObject({
			speech: "第一句。",
			text: expect.stringMatching(/^（.+）第一句。$/),
			expression: { language: "zh-CN" },
		});
		await first.close();
		const reconnected = await socketClient(f.socketUrl, cleanups);
		const after = page.items[0].seq;
		await reconnected.subscribe(`session:${session.id}`, after);
		await reconnected.wait((event) => "event_id" in event && event.event_id === page.items.at(-1)!.event_id);
		expect(events(reconnected.messages)).toEqual(page.items.filter((event) => event.seq > after));
		expect(events(reconnected.messages).map((event) => event.seq)).toEqual(
			page.items.slice(1).map((event) => event.seq),
		);
		const replay = await f.post(`/api/sessions/${session.id}/messages`, { text: "hello" }, "message-once");
		expect(await replay.json()).toMatchObject({ id: run.id });
		expect(f.faux.state.callCount).toBe(1);
		expect((await f.read<EventPage>(`/api/sessions/${session.id}/events`)).items).toEqual(page.items);
		expect(JSON.stringify(first.messages)).not.toContain(rootToken);
		const id = "unsubscribe";
		second.send({ v: 1, type: "unsubscribe", id, payload: { stream_id: `session:${session.id}` } });
		expect(await second.wait((event) => "reply_to" in event && event.reply_to === id)).toMatchObject({
			type: "subscription.removed",
		});
	});

	it("enforces scope on HTTP and subscriptions and immediately revokes connected subscribers", async () => {
		const f = await apiFixture(cleanups);
		const a = await f.createSession({ user_id: "alice" });
		const b = await f.createSession({ user_id: "bob" });
		const issuedResponse = await f.post("/api/tokens", {
			name: "Alice observer",
			permissions: ["read"],
			session_ids: [a.id],
			companion_scopes: ["default:alice"],
			expires_at: new Date(Date.now() + 3600000).toISOString(),
		});
		expect(issuedResponse.status).toBe(201);
		const issued = (await issuedResponse.json()) as { token: string; record: Stored<unknown> };
		const observer = await socketClient(f.socketUrl, cleanups, issued.token);
		expect(await observer.subscribe(`session:${a.id}`)).toMatchObject({ type: "subscription.accepted" });
		for (const stream of [`session:${b.id}`, "companion:default:bob", "system"])
			expect(await observer.subscribe(stream)).toMatchObject({
				type: "command.rejected",
				payload: { error: { code: "FORBIDDEN" } },
			});
		expect((await f.request(`/api/sessions/${b.id}`, {}, issued.token)).status).toBe(403);
		expect((await f.request(`/api/companions/default/bob`, {}, issued.token)).status).toBe(403);
		expect(await f.read("/api/sessions", issued.token)).toMatchObject({ items: [{ id: a.id }] });
		expect(
			(await f.post(`/api/sessions/${a.id}/messages`, { text: "not permitted" }, "denied", issued.token)).status,
		).toBe(403);
		const closed = once(observer.socket, "close");
		expect(
			(
				await f.request(`/api/tokens/${issued.record.id}?expected_revision=${issued.record.revision}`, {
					method: "DELETE",
				})
			).status,
		).toBe(200);
		await closed;
		expect(observer.socket.readyState).toBe(WebSocket.CLOSED);
		expect((await f.request(`/api/sessions/${a.id}`, {}, issued.token)).status).toBe(401);
		expect(f.faux.state.callCount).toBe(0);
		const invalid = await socketClient(f.socketUrl, cleanups, "incorrect");
		expect(invalid.hello).toMatchObject({ type: "command.rejected" });
	});
	it("reserves token administration for root even when a scoped principal has manage permission", async () => {
		const f = await apiFixture(cleanups);
		const expires_at = new Date(Date.now() + 3600000).toISOString();
		const issuedResponse = await f.post("/api/tokens", {
			name: "Scoped manager",
			permissions: ["read", "manage"],
			session_ids: [],
			companion_scopes: ["default:alice"],
			expires_at,
		});
		expect(issuedResponse.status).toBe(201);
		const issued = (await issuedResponse.json()) as { token: string; record: Stored<unknown> };
		const otherResponse = await f.post("/api/tokens", { name: "Other token", permissions: ["read"], expires_at });
		expect(otherResponse.status).toBe(201);
		const other = (await otherResponse.json()) as { token: string; record: Stored<unknown> };
		const before = await f.read("/api/tokens");
		expect((await f.request("/api/companions/default/alice", {}, issued.token)).status).toBe(200);
		expect((await f.request("/api/tokens", {}, issued.token)).status).toBe(403);
		for (const [index, fields] of [
			{ permissions: ["read", "chat", "execute", "approve", "manage"], session_ids: null, companion_scopes: null },
			{ permissions: ["read", "manage"] },
			{ permissions: ["read"], session_ids: [], companion_scopes: ["default:alice"] },
		].entries()) {
			const response = await f.post(
				"/api/tokens",
				{ name: "Escalation attempt", expires_at, ...fields },
				`escalation-${index}`,
				issued.token,
			);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
		}
		for (const record of [issued.record, other.record]) {
			expect(
				(
					await f.request(
						`/api/tokens/${record.id}?expected_revision=${record.revision}`,
						{ method: "DELETE" },
						issued.token,
					)
				).status,
			).toBe(403);
		}
		expect(await f.read("/api/tokens")).toEqual(before);
		expect((await f.request("/api/bootstrap", {}, issued.token)).status).toBe(200);
		expect((await f.request("/api/bootstrap", {}, other.token)).status).toBe(200);
		expect(f.faux.state.callCount).toBe(0);
	});
	it("merges replay and concurrent live changes without gaps or sequence duplication", async () => {
		const f = await apiFixture(cleanups);
		let session = await f.createSession();
		for (let index = 0; index < 110; index++) {
			const response = await f.patch(`/api/sessions/${session.id}`, {
				expected_revision: session.revision,
				title: `Replay ${index}`,
			});
			expect(response.status).toBe(200);
			session = (await response.json()) as typeof session;
		}
		const observer = await socketClient(f.socketUrl, cleanups);
		const [accepted, changed] = await Promise.all([
			observer.subscribe(`session:${session.id}`),
			f.patch(`/api/sessions/${session.id}`, {
				expected_revision: session.revision,
				title: "Concurrent live mutation",
			}),
		]);
		expect(accepted).toMatchObject({ type: "subscription.accepted" });
		expect(changed.status).toBe(200);
		const latest = (await changed.json()) as Stored<unknown>;
		await observer.wait(
			(event) => "data" in event && event.type === "session.updated" && event.data.revision === latest.revision,
		);
		const durable = await f.read<EventPage>(`/api/sessions/${session.id}/events?limit=200`);
		expect(events(observer.messages)).toEqual(durable.items);
		expect(events(observer.messages).map((event) => event.seq)).toEqual(
			Array.from({ length: durable.latest_seq }, (_, index) => index + 1),
		);
		expect(f.faux.state.callCount).toBe(0);
	}, 15000);
});
