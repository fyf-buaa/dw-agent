import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { type ApiEvent, ApiStore } from "../src/api-store.ts";
import { ExecutorError } from "../src/errors.ts";
import { MAX_MESSAGE_BYTES } from "../src/protocol.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "dw-api-store-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "api.sqlite");
	const store = new ApiStore(path);
	cleanups.push(() => store.close());
	return { directory, path, store };
}

describe("API durable store", () => {
	it("persists isolated snapshots and CAS revisions without modifying native journals", async () => {
		const { directory, path, store } = await setup();
		const journal = join(directory, "native.jsonl");
		await writeFile(journal, '{"original":true}\n');
		const input = { name: "original", nested: { flag: true } };
		const created = store.put("sessions", "first", input, null);
		input.nested.flag = false;
		created.data.nested.flag = false;
		expect(store.require<typeof input>("sessions", "first").data.nested.flag).toBe(true);
		expect(() => store.put("sessions", "first", input, null)).toThrowError(
			expect.objectContaining({ code: "REVISION_CONFLICT" }),
		);
		expect(() => store.put("sessions", "first", input, 2)).toThrowError(
			expect.objectContaining({ code: "REVISION_CONFLICT" }),
		);
		const updated = store.put("sessions", "first", { name: "updated" }, 1);
		expect(updated).toMatchObject({ revision: 2, created_at: created.created_at });
		store.put("tasks", "first", { session_id: "first" }, null);
		store.put("providers", "_legacy", { name: "Existing underscore provider" }, null);
		store.put("providers", "-legacy", { name: "Existing hyphen provider" }, null);
		store.close();
		const reopened = new ApiStore(path);
		cleanups.push(() => reopened.close());
		expect(reopened.require("sessions", "first")).toEqual(updated);
		expect(reopened.all("providers").map((record) => record.id)).toEqual(["_legacy", "-legacy"]);
		expect(reopened.all("tasks")).toHaveLength(1);
		expect(await readFile(journal, "utf8")).toBe('{"original":true}\n');
		if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(() => reopened.remove("sessions", "first", 1)).toThrowError(
			expect.objectContaining({ code: "REVISION_CONFLICT" }),
		);
		reopened.remove("sessions", "first", 2);
		expect(() => reopened.require("sessions", "first")).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
	});

	it("rolls back snapshots, resource bindings, events and sequences together and supports nested savepoints", async () => {
		const { store } = await setup();
		const received: ApiEvent[] = [];
		store.subscribe((event) => {
			received.push(event);
		});
		expect(() =>
			store.transaction(() => {
				store.put("sessions", "rollback", { title: "discard" }, null);
				store.append("session:rollback", "session.created", {});
				expect(received).toHaveLength(0);
				throw new Error("abort");
			}),
		).toThrow("abort");
		expect(store.get("sessions", "rollback")).toBeUndefined();
		expect(store.events("session:rollback", 0)).toEqual({ items: [], has_more: false, latest_seq: 0 });
		store.transaction(() => {
			store.append("system", "outer.before", {});
			expect(() =>
				store.transaction(() => {
					store.append("system", "inner.discard", {});
					throw new Error("inner");
				}),
			).toThrow("inner");
			store.put("sessions", "kept", { title: "committed" }, null);
			store.append("system", "outer.after", {});
			expect(received).toHaveLength(0);
		});
		expect(received.map((event) => [event.seq, event.type])).toEqual([
			[1, "outer.before"],
			[2, "outer.after"],
		]);
		expect(() => store.transaction(async () => undefined)).toThrowError(
			expect.objectContaining({ code: "INVALID_PAYLOAD" }),
		);
	});

	it("notifies after commit, isolates listeners, and preserves commit ordering under reentrant writes", async () => {
		const { store, path } = await setup();
		const observer = new ApiStore(path);
		cleanups.push(() => observer.close());
		const sequence: number[] = [];
		const committedHeads: number[] = [];
		const payloads: Record<string, unknown>[] = [];
		store.subscribe((event) => {
			committedHeads.push(observer.events("system", 0).latest_seq);
			if (event.seq === 1) store.append("system", "reentrant", {});
			event.data.corrupted = true;
			throw new Error("subscriber failed");
		});
		const unsubscribe = store.subscribe((event) => {
			sequence.push(event.seq);
			payloads.push(event.data);
		});
		store.transaction(() => {
			store.append("system", "first", {});
			store.append("system", "second", {});
		});
		expect(sequence).toEqual([1, 2, 3]);
		expect(committedHeads).toEqual([2, 3, 3]);
		expect(payloads).toEqual([{}, {}, {}]);
		unsubscribe();
		store.append("system", "fourth", {});
		expect(sequence).toEqual([1, 2, 3]);
	});

	it("bounds the complete UTF-8 event before commit without sequence gaps or notifications", async () => {
		const { store } = await setup();
		const baseline = store.append("system", "size.checked", { text: "" });
		const overhead = Buffer.byteLength(JSON.stringify(baseline), "utf8");
		const text = "x".repeat(MAX_MESSAGE_BYTES - overhead);
		const received: ApiEvent[] = [];
		store.subscribe((event) => {
			received.push(event);
		});
		const boundary = store.append("system", "size.checked", { text });
		expect(Buffer.byteLength(JSON.stringify(boundary), "utf8")).toBe(MAX_MESSAGE_BYTES);
		expect(() =>
			store.transaction(() => {
				store.put("messages", "too-large", { text: "must roll back" }, null);
				store.append("system", "size.checked", { text: `${text}界` });
			}),
		).toThrowError(expect.objectContaining({ code: "EVENT_TOO_LARGE" }));
		expect(store.get("messages", "too-large")).toBeUndefined();
		expect(received.map((event) => event.seq)).toEqual([2]);
		expect(store.events("system", 0).latest_seq).toBe(2);
		expect(store.append("system", "size.checked", { text: "next" }).seq).toBe(3);
		expect(received.map((event) => event.seq)).toEqual([2, 3]);
	});

	it("retains replay after resource deletion and restart with stream-scoped sequence validation", async () => {
		const { store, path } = await setup();
		store.put("sessions", "one", {}, null);
		store.append("session:one", "session.created", {}, { session_id: "one" });
		store.append("session:two", "session.created", {}, { session_id: "two" });
		store.transaction(() => {
			store.remove("sessions", "one", 1);
			store.append("session:one", "session.deleted", {}, { session_id: "one" });
		});
		store.close();
		const reopened = new ApiStore(path);
		cleanups.push(() => reopened.close());
		const first = reopened.events("session:one", 0, 1);
		expect(first).toMatchObject({ has_more: true, latest_seq: 2 });
		expect(first.items[0]).toMatchObject({ seq: 1, api_version: "1" });
		expect(reopened.events("session:one", 1).items.map((event) => event.type)).toEqual(["session.deleted"]);
		expect(reopened.events("session:two", 0).items).toHaveLength(1);
		expect(() => reopened.events("session:two", 2)).toThrowError(expect.objectContaining({ code: "INVALID_CURSOR" }));
	});

	it("erases event payloads transactionally while retaining monotonic heads and terminal tombstones", async () => {
		const { store, path } = await setup();
		store.append("session:forgotten", "message.created", { text: "private" });
		store.append("session:forgotten", "message.created", { text: "also private" });
		expect(() =>
			store.transaction(() => {
				store.purgeStream("session:forgotten");
				throw new Error("rollback purge");
			}),
		).toThrow("rollback purge");
		expect(store.events("session:forgotten", 0).items).toHaveLength(2);
		const notices: ApiEvent[] = [];
		store.subscribe((event) => {
			notices.push(event);
		});
		store.transaction(() => {
			store.append("session:forgotten", "message.created", { text: "unpublished private" });
			store.purgeStream("session:forgotten");
			store.append("session:forgotten", "session.deleted", { id: "forgotten" });
		});
		expect(notices.map((event) => [event.seq, event.type])).toEqual([[4, "session.deleted"]]);
		expect(() => store.events("session:forgotten", 0)).toThrowError(
			expect.objectContaining({ code: "CURSOR_EXPIRED", details: { earliest_seq: 4, latest_seq: 4 } }),
		);
		expect(store.events("session:forgotten", 3).items.map((event) => event.type)).toEqual(["session.deleted"]);
		store.close();
		const reopened = new ApiStore(path);
		cleanups.push(() => reopened.close());
		expect(reopened.events("session:forgotten", 3).items).toHaveLength(1);
		expect(reopened.append("session:forgotten", "tombstone.observed", {}).seq).toBe(5);
	});

	it("authenticates durable cursors and binds them to the exact kind, filter and database", async () => {
		const { store, path } = await setup();
		for (const [id, owner] of [
			["a", "alice"],
			["b", "bob"],
			["c", "alice"],
			["d", "alice"],
		])
			store.put("messages", id, { owner, enabled: true, count: 2 }, null);
		const page = store.list<{ owner: string }>("messages", {
			limit: 1,
			filter: { owner: "alice", enabled: "true", count: "2" },
		});
		expect(page.items.map((record) => record.id)).toEqual(["a"]);
		const cursor = page.next_cursor!;
		expect(() => store.list("messages", { cursor, filter: { owner: "bob" } })).toThrowError(
			expect.objectContaining({ code: "INVALID_CURSOR" }),
		);
		expect(() =>
			store.list("tasks", { cursor, filter: { owner: "alice", enabled: "true", count: "2" } }),
		).toThrowError(expect.objectContaining({ code: "INVALID_CURSOR" }));
		expect(() => store.list("messages", { cursor: `${cursor.slice(0, -2)}AA` })).toThrowError(
			expect.objectContaining({ code: "INVALID_CURSOR" }),
		);
		const other = new ApiStore(":memory:");
		cleanups.push(() => other.close());
		expect(() =>
			other.list("messages", { cursor, filter: { owner: "alice", enabled: "true", count: "2" } }),
		).toThrowError(expect.objectContaining({ code: "INVALID_CURSOR" }));
		store.close();
		const reopened = new ApiStore(path);
		cleanups.push(() => reopened.close());
		expect(
			reopened
				.list("messages", { cursor, limit: 5, filter: { count: "2", enabled: "true", owner: "alice" } })
				.items.map((record) => record.id),
		).toEqual(["c", "d"]);
	});

	it("deduplicates concurrent requests, scopes principals, binds fingerprints and replays persisted outcomes", async () => {
		const { store, path } = await setup();
		let calls = 0;
		let release: () => void = () => {
			throw new Error("not started");
		};
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const operation = async () => {
			calls++;
			await barrier;
			return store.put("sessions", "created", { title: "one" }, null);
		};
		const first = store.once("alice", "request", "POST /sessions body1", operation);
		const second = store.once("alice", "request", "POST /sessions body1", operation);
		expect(second).toBe(first);
		await expect(store.once("alice", "request", "POST /tasks body1", operation)).rejects.toMatchObject({
			code: "IDEMPOTENCY_CONFLICT",
		});
		release();
		const saved = await first;
		expect(calls).toBe(1);
		await expect(
			store.once("bob", "request", "POST /sessions body1", async () => "different principal"),
		).resolves.toBe("different principal");
		await expect(
			store.once("alice", "failed", "failure", async () => {
				throw new ExecutorError("BUSY", "Try later", true, { resource: "created" });
			}),
		).rejects.toMatchObject({ code: "BUSY" });
		await expect(
			store.once("alice", "unknown", "failure", async () => {
				throw new Error("private stack secret");
			}),
		).rejects.toThrow("private stack secret");
		store.close();
		const reopened = new ApiStore(path);
		cleanups.push(() => reopened.close());
		await expect(
			reopened.once("alice", "request", "POST /sessions body1", async () => {
				throw new Error("must not execute");
			}),
		).resolves.toEqual(saved);
		await expect(reopened.once("alice", "failed", "failure", async () => undefined)).rejects.toMatchObject({
			code: "BUSY",
			retryable: true,
			details: { resource: "created" },
		});
		await expect(reopened.once("alice", "unknown", "failure", async () => undefined)).rejects.toMatchObject({
			code: "INTERNAL_ERROR",
			message: "The executor could not complete the operation",
		});
	});

	it("retains interrupted resource bindings and never reexecutes unfinished work", async () => {
		const { store, path } = await setup();
		let release: () => void = () => {
			throw new Error("not started");
		};
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending = store.once("alice", "interrupted", "create", async () => {
			store.put("tasks", "recover-me", { status: "queued" }, null);
			await barrier;
			return "done";
		});
		const handled = pending.catch((error: unknown) => error);
		await Promise.resolve();
		const second = new ApiStore(path);
		cleanups.push(() => second.close());
		await expect(second.once("alice", "interrupted", "create", async () => "must not run")).rejects.toMatchObject({
			code: "IDEMPOTENCY_IN_PROGRESS",
		});
		store.close();
		const reopened = new ApiStore(path);
		cleanups.push(() => reopened.close());
		await expect(reopened.once("alice", "interrupted", "create", async () => "must not run")).rejects.toMatchObject({
			code: "IDEMPOTENCY_INTERRUPTED",
			details: { resources: [{ kind: "tasks", id: "recover-me" }] },
		});
		expect(reopened.require("tasks", "recover-me").data).toEqual({ status: "queued" });
		release();
		expect(await handled).toMatchObject({ code: "API_STORE_CLOSED" });
	});

	it("refuses unknown versions and malformed data without wiping existing storage", async () => {
		const { store, path } = await setup();
		store.put("sessions", "one", {}, null);
		store.close();
		const database = new DatabaseSync(path);
		database.exec("PRAGMA user_version=99");
		database.close();
		const before = await readFile(path);
		expect(() => new ApiStore(path)).toThrowError(expect.objectContaining({ code: "API_STORE_INVALID" }));
		expect(await readFile(path)).toEqual(before);
		const corrupt = new DatabaseSync(path);
		corrupt.exec("PRAGMA user_version=1; UPDATE api_resources SET data='not json'");
		corrupt.close();
		expect(() => new ApiStore(path)).toThrowError(expect.objectContaining({ code: "API_STORE_INVALID" }));
	});

	it("rejects invalid JSON, identities, revisions and filters without partial writes", async () => {
		const { store } = await setup();
		for (const data of [{ missing: undefined }, { number: Number.NaN }, { date: new Date() }, [undefined]])
			expect(() => store.put("sessions", "invalid", data, null)).toThrowError(
				expect.objectContaining({ code: "INVALID_PAYLOAD" }),
			);
		expect(() => store.put("sessions", "../escape", {}, null)).toThrowError(
			expect.objectContaining({ code: "INVALID_PAYLOAD" }),
		);
		expect(() => store.put("sessions", "id", {}, 0)).toThrowError(
			expect.objectContaining({ code: "INVALID_PAYLOAD" }),
		);
		expect(() => store.list("sessions", { limit: 0 })).toThrowError(
			expect.objectContaining({ code: "INVALID_PAYLOAD" }),
		);
		expect(store.all("sessions")).toEqual([]);
	});
});
