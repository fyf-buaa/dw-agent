import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, openSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { ExecutorError, errorPayload } from "./errors.ts";
import { MAX_MESSAGE_BYTES } from "./protocol.ts";

export interface Stored<T> {
	id: string;
	revision: number;
	created_at: string;
	updated_at: string;
	data: T;
}

export interface ApiEvent {
	api_version: "1";
	event_id: string;
	stream_id: string;
	seq: number;
	type: string;
	occurred_at: string;
	session_id?: string;
	run_id?: string;
	task_id?: string;
	data: Record<string, unknown>;
}

export interface ApiListOptions {
	cursor?: string;
	limit?: number;
	filter?: Record<string, string>;
}
export interface ApiList<T> {
	items: Stored<T>[];
	next_cursor: string | null;
}
export interface ApiEventFields {
	session_id?: string;
	run_id?: string;
	task_id?: string;
}

type Row = Record<string, string | number | bigint | Uint8Array | null>;
const APP_ID = 0x44574150;
const activeOwners = new Set<string>();
const schema = `
CREATE TABLE api_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE api_resources (
 ordinal INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL,
 revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL,
 UNIQUE(kind,id)
);
CREATE INDEX api_resource_kind ON api_resources(kind,ordinal);
CREATE TABLE api_streams (
 stream_id TEXT PRIMARY KEY, latest_seq INTEGER NOT NULL, floor_seq INTEGER NOT NULL
);
CREATE TABLE api_events (
 stream_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL,
 PRIMARY KEY(stream_id,seq)
);
CREATE TABLE api_intents (
 principal TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','completed','failed','interrupted')),
 owner TEXT NOT NULL, pid INTEGER NOT NULL, result TEXT, resources TEXT NOT NULL DEFAULT '[]',
 PRIMARY KEY(principal,key)
);`;

function fail(code: string, message: string): never {
	throw new ExecutorError(code, message);
}
function text(value: unknown, max = 512): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
function identifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,299}$/u.test(value);
}
function validDate(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) &&
		Number.isFinite(Date.parse(value))
	);
}
function jsonValue(value: unknown, seen = new Set<object>(), depth = 0): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || depth > 100 || seen.has(value)) return false;
	if (
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) !== Object.prototype &&
		Object.getPrototypeOf(value) !== null
	)
		return false;
	seen.add(value);
	const valid = (Array.isArray(value) ? Array.from(value) : Object.values(value)).every((child) =>
		jsonValue(child, seen, depth + 1),
	);
	seen.delete(value);
	return valid;
}
function encode(value: unknown): string {
	if (!jsonValue(value)) fail("INVALID_PAYLOAD", "Data must be finite JSON without undefined values or cycles");
	return JSON.stringify(value);
}
function decode(value: unknown): unknown {
	if (typeof value !== "string") return fail("API_STORE_INVALID", "API storage contains invalid data");
	try {
		const parsed: unknown = JSON.parse(value);
		if (!jsonValue(parsed)) return fail("API_STORE_INVALID", "API storage contains invalid data");
		return parsed;
	} catch {
		return fail("API_STORE_INVALID", "API storage contains invalid data");
	}
}
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isThenable(value: unknown): boolean {
	return (
		value !== null &&
		(typeof value === "object" || typeof value === "function") &&
		"then" in value &&
		typeof value.then === "function"
	);
}
function positiveRevision(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function stream(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^(?:system|session:[A-Za-z0-9][A-Za-z0-9_.-]{0,299}|companion:[A-Za-z0-9_-]{1,100}:[A-Za-z0-9_-]{1,100})$/u.test(
			value,
		)
	);
}

/** SQLite snapshots and a separate durable event log; native session journals remain untouched. */
export class ApiStore {
	private readonly database: DatabaseSync;
	private readonly path: string;
	private readonly owner = randomUUID();
	private readonly cursorSecret: Buffer;
	private readonly listeners = new Set<(event: ApiEvent) => void>();
	private readonly inFlight = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
	private readonly intentContext = new AsyncLocalStorage<{ principal: string; key: string }>();
	private pendingEvents: ApiEvent[] = [];
	private delivering = false;
	private depth = 0;
	private closed = false;

	constructor(path: string) {
		let database: DatabaseSync | undefined;
		try {
			const exists = path !== ":memory:" && existsSync(path);
			if (exists && !lstatSync(path).isFile()) fail("API_STORE_INVALID", "API storage must be a regular file");
			if (!exists && path !== ":memory:") closeSync(openSync(path, "wx", 0o600));
			database = new DatabaseSync(path, { timeout: 5000 });
			this.database = database;
			this.path = path;
			if (exists) {
				if (
					this.one("PRAGMA application_id")?.application_id !== APP_ID ||
					this.one("PRAGMA user_version")?.user_version !== 1 ||
					this.one("PRAGMA quick_check")?.quick_check !== "ok"
				) {
					fail("API_STORE_INVALID", "Unrecognized or damaged API storage");
				}
			} else {
				database.exec("BEGIN IMMEDIATE");
				try {
					database.exec(schema);
					database.exec(`PRAGMA application_id = ${APP_ID}; PRAGMA user_version = 1;`);
					this.run("INSERT INTO api_meta(key,value) VALUES('cursor_secret',?)", randomBytes(32).toString("hex"));
					database.exec("COMMIT");
				} catch (error) {
					database.exec("ROLLBACK");
					throw error;
				}
			}
			const secret = this.one("SELECT value FROM api_meta WHERE key='cursor_secret'")?.value;
			if (typeof secret !== "string" || !/^[0-9a-f]{64}$/u.test(secret))
				fail("API_STORE_INVALID", "API cursor signing key is invalid");
			this.cursorSecret = Buffer.from(secret, "hex");
			this.validateStoredData();
			database.exec(
				"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;",
			);
			this.secureFiles();
			this.transaction(() => {
				for (const row of this.rows("SELECT principal,key,owner,pid FROM api_intents WHERE state='pending'")) {
					let alive = row.pid === process.pid && typeof row.owner === "string" && activeOwners.has(row.owner);
					if (row.pid !== process.pid && typeof row.pid === "number") {
						try {
							process.kill(row.pid, 0);
							alive = true;
						} catch (error) {
							alive = error instanceof Error && "code" in error && error.code === "EPERM";
						}
					}
					if (!alive)
						this.run(
							"UPDATE api_intents SET state='interrupted' WHERE principal=? AND key=?",
							row.principal,
							row.key,
						);
				}
			});
			activeOwners.add(this.owner);
		} catch {
			try {
				database?.close();
			} catch {
				/* Preserve the safe error below. */
			}
			fail("API_STORE_INVALID", "API storage could not be opened safely");
		}
	}

	get<T>(kind: string, id: string): Stored<T> | undefined {
		this.checkKey(kind, id);
		const row = this.one("SELECT * FROM api_resources WHERE kind=? AND id=?", kind, id);
		return row ? this.resource<T>(row) : undefined;
	}

	require<T>(kind: string, id: string): Stored<T> {
		return this.get<T>(kind, id) ?? fail("NOT_FOUND", "The requested resource does not exist");
	}

	all<T>(kind: string): Stored<T>[] {
		this.checkKey(kind);
		return this.rows("SELECT * FROM api_resources WHERE kind=? ORDER BY ordinal", kind).map((row) =>
			this.resource<T>(row),
		);
	}

	list<T>(kind: string, options: ApiListOptions = {}): ApiList<T> {
		this.checkKey(kind);
		if (!object(options) || Object.keys(options).some((key) => !["cursor", "limit", "filter"].includes(key)))
			fail("INVALID_PAYLOAD", "Invalid list options");
		const limit = options.limit ?? 50;
		if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
			fail("INVALID_PAYLOAD", "List limit must be between 1 and 1000");
		const filter = options.filter ?? {};
		if (
			!object(filter) ||
			Object.entries(filter).some(
				([key, value]) => !identifier(key) || typeof value !== "string" || value.length > 4000,
			)
		)
			fail("INVALID_PAYLOAD", "Invalid list filter");
		const entries = Object.entries(filter).sort(([left], [right]) => left.localeCompare(right));
		const query = createHash("sha256")
			.update(JSON.stringify([kind, entries]))
			.digest("hex");
		const after = options.cursor === undefined ? 0 : this.readCursor(options.cursor, query);
		const items: Stored<T>[] = [];
		let last = after;
		let more = false;
		for (const row of this.rows(
			"SELECT * FROM api_resources WHERE kind=? AND ordinal>? ORDER BY ordinal",
			kind,
			after,
		)) {
			const record = this.resource<T>(row);
			if (
				!entries.every(
					([key, value]) =>
						object(record.data) &&
						Object.hasOwn(record.data, key) &&
						record.data[key] !== null &&
						["string", "number", "boolean"].includes(typeof record.data[key]) &&
						String(record.data[key]) === value,
				)
			)
				continue;
			if (items.length === limit) {
				more = true;
				break;
			}
			items.push(record);
			last = Number(row.ordinal);
		}
		return { items, next_cursor: more ? this.makeCursor(query, last) : null };
	}

	put<T>(kind: string, id: string, data: T, expectedRevision: number | null): Stored<T> {
		this.checkKey(kind, id);
		if (expectedRevision !== null && !positiveRevision(expectedRevision))
			fail("INVALID_PAYLOAD", "Expected revision must be positive or null for creation");
		const serialized = encode(data);
		return this.transaction(() => {
			const old = this.get<T>(kind, id);
			if ((old?.revision ?? null) !== expectedRevision)
				fail("REVISION_CONFLICT", "The resource changed; refresh before saving");
			const now = new Date().toISOString();
			const revision = (old?.revision ?? 0) + 1;
			if (!positiveRevision(revision)) fail("REVISION_CONFLICT", "The resource revision cannot be advanced");
			this.run(
				"INSERT INTO api_resources(kind,id,revision,created_at,updated_at,data) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,data=excluded.data",
				kind,
				id,
				revision,
				old?.created_at ?? now,
				now,
				serialized,
			);
			if (!old) {
				const context = this.intentContext.getStore();
				if (context) {
					const intent = this.one(
						"SELECT resources FROM api_intents WHERE principal=? AND key=? AND owner=? AND state='pending'",
						context.principal,
						context.key,
						this.owner,
					);
					if (intent) {
						const resources = decode(intent.resources);
						if (!Array.isArray(resources)) fail("API_STORE_INVALID", "Invalid operation resource bindings");
						this.run(
							"UPDATE api_intents SET resources=? WHERE principal=? AND key=? AND owner=? AND state='pending'",
							encode([...resources, { kind, id }]),
							context.principal,
							context.key,
							this.owner,
						);
					}
				}
			}
			return this.require<T>(kind, id);
		});
	}

	remove(kind: string, id: string, expectedRevision: number): void {
		this.checkKey(kind, id);
		if (!positiveRevision(expectedRevision)) fail("INVALID_PAYLOAD", "Expected revision must be positive");
		this.transaction(() => {
			const old = this.require(kind, id);
			if (old.revision !== expectedRevision)
				fail("REVISION_CONFLICT", "The resource changed; refresh before deleting");
			this.run("DELETE FROM api_resources WHERE kind=? AND id=?", kind, id);
		});
	}

	transaction<T>(operation: () => T): T {
		this.ensureOpen();
		const depth = this.depth;
		const eventStart = this.pendingEvents.length;
		const savepoint = `api_${depth}`;
		this.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
		this.depth++;
		let result: T;
		try {
			result = operation();
			if (isThenable(result)) fail("INVALID_PAYLOAD", "API transactions must be synchronous");
			if (depth === 0) this.secureFiles();
			this.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
		} catch (error) {
			this.pendingEvents.length = eventStart;
			this.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
			throw error;
		} finally {
			this.depth--;
		}
		if (depth === 0) this.notify();
		return result;
	}

	append(streamId: string, type: string, data: Record<string, unknown>, fields: ApiEventFields = {}): ApiEvent {
		if (
			!stream(streamId) ||
			!identifier(type) ||
			!object(data) ||
			!object(fields) ||
			Object.entries(fields).some(
				([key, value]) => !["session_id", "run_id", "task_id"].includes(key) || !identifier(value),
			)
		)
			fail("INVALID_PAYLOAD", "Invalid event payload");
		encode(data);
		return this.transaction(() => {
			const seq =
				Number(this.one("SELECT latest_seq FROM api_streams WHERE stream_id=?", streamId)?.latest_seq ?? 0) + 1;
			if (!positiveRevision(seq)) fail("API_STORE_INVALID", "Event sequence exhausted");
			const event: ApiEvent = {
				api_version: "1",
				event_id: randomUUID(),
				stream_id: streamId,
				seq,
				type,
				occurred_at: new Date().toISOString(),
				...fields,
				data,
			};
			const serialized = encode(event);
			if (Buffer.byteLength(serialized, "utf8") > MAX_MESSAGE_BYTES)
				fail("EVENT_TOO_LARGE", "Event exceeds the replay message size limit");
			this.run(
				"INSERT INTO api_streams(stream_id,latest_seq,floor_seq) VALUES(?,?,0) ON CONFLICT(stream_id) DO UPDATE SET latest_seq=excluded.latest_seq",
				streamId,
				seq,
			);
			this.run(
				"INSERT INTO api_events(stream_id,seq,event_id,data) VALUES(?,?,?,?)",
				streamId,
				seq,
				event.event_id,
				serialized,
			);
			const persisted = decode(serialized) as unknown as ApiEvent;
			this.pendingEvents.push(persisted);
			return decode(serialized) as unknown as ApiEvent;
		});
	}

	events(
		streamId: string,
		afterSeq: number,
		limit = 100,
	): { items: ApiEvent[]; has_more: boolean; latest_seq: number } {
		if (
			!stream(streamId) ||
			!Number.isSafeInteger(afterSeq) ||
			afterSeq < 0 ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 1000
		)
			fail("INVALID_PAYLOAD", "Invalid event replay query");
		return this.transaction(() => {
			const head = this.one("SELECT latest_seq,floor_seq FROM api_streams WHERE stream_id=?", streamId);
			const latest = Number(head?.latest_seq ?? 0);
			const floor = Number(head?.floor_seq ?? 0);
			if (afterSeq < floor)
				throw new ExecutorError("CURSOR_EXPIRED", "The requested event history has been erased", false, {
					earliest_seq: floor + 1,
					latest_seq: latest,
				});
			if (afterSeq > latest) fail("INVALID_CURSOR", "Event cursor is ahead of this stream");
			const rows = this.rows(
				"SELECT * FROM api_events WHERE stream_id=? AND seq>? ORDER BY seq LIMIT ?",
				streamId,
				afterSeq,
				limit + 1,
			);
			return {
				items: rows.slice(0, limit).map((row) => this.event(row)),
				has_more: rows.length > limit,
				latest_seq: latest,
			};
		});
	}

	/** Erases payloads but never resets a stream's sequence; append a terminal event in the same transaction. */
	purgeStream(streamId: string): void {
		if (!stream(streamId)) fail("INVALID_PAYLOAD", "Invalid event stream");
		this.transaction(() => {
			this.run("DELETE FROM api_events WHERE stream_id=?", streamId);
			this.run("UPDATE api_streams SET floor_seq=latest_seq WHERE stream_id=?", streamId);
		});
	}

	subscribe(listener: (event: ApiEvent) => void): () => void {
		this.ensureOpen();
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	once<T>(principal: string, key: string, fingerprint: string, operation: () => Promise<T>): Promise<T> {
		try {
			this.ensureOpen();
			if (this.depth !== 0) fail("INVALID_PAYLOAD", "Idempotent operations cannot begin inside a transaction");
			if (!text(principal, 300) || !text(key, 200) || !text(fingerprint, 4096))
				fail("INVALID_PAYLOAD", "Invalid idempotency identity");
			const identity = JSON.stringify([principal, key]);
			const active = this.inFlight.get(identity);
			if (active) {
				if (active.fingerprint !== fingerprint)
					fail("IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to a different request");
				return active.promise as Promise<T>;
			}
			const prior = this.transaction(() => {
				const row = this.one("SELECT * FROM api_intents WHERE principal=? AND key=?", principal, key);
				if (row) return row;
				this.run(
					"INSERT INTO api_intents(principal,key,fingerprint,state,owner,pid) VALUES(?,?,?,'pending',?,?)",
					principal,
					key,
					fingerprint,
					this.owner,
					process.pid,
				);
				return undefined;
			});
			if (prior) {
				if (prior.fingerprint !== fingerprint)
					fail("IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to a different request");
				if (prior.state === "interrupted")
					throw new ExecutorError(
						"IDEMPOTENCY_INTERRUPTED",
						"The original operation was interrupted; inspect its resources before starting a new request",
						false,
						{ resources: decode(prior.resources) },
					);
				if (prior.state === "pending")
					fail("IDEMPOTENCY_IN_PROGRESS", "The original operation is still in progress");
				const saved = decode(prior.result);
				if (!object(saved)) fail("API_STORE_INVALID", "Invalid stored idempotency result");
				if (prior.state === "failed") {
					if (
						typeof saved.code !== "string" ||
						typeof saved.message !== "string" ||
						typeof saved.retryable !== "boolean"
					)
						fail("API_STORE_INVALID", "Invalid stored idempotency error");
					throw new ExecutorError(
						saved.code,
						saved.message,
						saved.retryable,
						object(saved.details) ? saved.details : undefined,
					);
				}
				return Promise.resolve((saved.defined === true ? saved.value : undefined) as T);
			}
			const promise = Promise.resolve()
				.then(() => {
					this.ensureOpen();
					return this.intentContext.run({ principal, key }, operation);
				})
				.then((result) => {
					const saved = encode(result === undefined ? { defined: false } : { defined: true, value: result });
					this.transaction(() => {
						this.run(
							"UPDATE api_intents SET state='completed',result=? WHERE principal=? AND key=? AND owner=? AND state='pending'",
							saved,
							principal,
							key,
							this.owner,
						);
					});
					return result;
				})
				.catch((error: unknown) => {
					if (!this.closed)
						this.transaction(() => {
							this.run(
								"UPDATE api_intents SET state='failed',result=? WHERE principal=? AND key=? AND owner=? AND state='pending'",
								encode(errorPayload(error)),
								principal,
								key,
								this.owner,
							);
						});
					throw error;
				})
				.finally(() => {
					this.inFlight.delete(identity);
				});
			this.inFlight.set(identity, { fingerprint, promise });
			return promise;
		} catch (error) {
			return Promise.reject(error);
		}
	}

	close(): void {
		if (this.closed) return;
		if (this.depth !== 0) fail("INVALID_PAYLOAD", "Cannot close API storage during a transaction");
		this.transaction(() => {
			this.run("UPDATE api_intents SET state='interrupted' WHERE owner=? AND state='pending'", this.owner);
		});
		this.closed = true;
		activeOwners.delete(this.owner);
		this.listeners.clear();
		try {
			this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} finally {
			this.database.close();
		}
	}

	private checkKey(kind: string, id?: string): void {
		this.ensureOpen();
		if (!identifier(kind) || (id !== undefined && !identifier(id)))
			fail("INVALID_PAYLOAD", "Invalid resource identity");
	}
	private ensureOpen(): void {
		if (this.closed) fail("API_STORE_CLOSED", "API storage is closed");
	}
	private exec(sql: string): void {
		this.ensureOpen();
		try {
			this.database.exec(sql);
		} catch {
			fail("API_STORE_INVALID", "API storage transaction failed");
		}
	}
	private rows(sql: string, ...args: SQLInputValue[]): Row[] {
		this.ensureOpen();
		try {
			return this.database.prepare(sql).all(...args);
		} catch {
			return fail("API_STORE_INVALID", "API storage query failed");
		}
	}
	private one(sql: string, ...args: SQLInputValue[]): Row | undefined {
		this.ensureOpen();
		try {
			return this.database.prepare(sql).get(...args);
		} catch {
			return fail("API_STORE_INVALID", "API storage query failed");
		}
	}
	private run(sql: string, ...args: SQLInputValue[]): void {
		this.ensureOpen();
		try {
			this.database.prepare(sql).run(...args);
		} catch {
			fail("API_STORE_INVALID", "API storage write failed");
		}
	}
	private resource<T>(row: Row): Stored<T> {
		if (
			!identifier(row.kind) ||
			!identifier(row.id) ||
			!positiveRevision(row.revision) ||
			!validDate(row.created_at) ||
			!validDate(row.updated_at) ||
			!positiveRevision(row.ordinal)
		)
			fail("API_STORE_INVALID", "Invalid stored resource");
		return {
			id: row.id,
			revision: row.revision,
			created_at: row.created_at,
			updated_at: row.updated_at,
			data: decode(row.data) as T,
		};
	}
	private event(row: Row): ApiEvent {
		const event = decode(row.data);
		if (
			!object(event) ||
			Object.keys(event).some(
				(key) =>
					![
						"api_version",
						"event_id",
						"stream_id",
						"seq",
						"type",
						"occurred_at",
						"session_id",
						"run_id",
						"task_id",
						"data",
					].includes(key),
			) ||
			event.api_version !== "1" ||
			!identifier(event.event_id) ||
			!stream(event.stream_id) ||
			!identifier(event.type) ||
			!positiveRevision(event.seq) ||
			!validDate(event.occurred_at) ||
			!object(event.data) ||
			event.stream_id !== row.stream_id ||
			event.seq !== row.seq ||
			event.event_id !== row.event_id ||
			["session_id", "run_id", "task_id"].some((key) => event[key] !== undefined && !identifier(event[key]))
		)
			fail("API_STORE_INVALID", "Invalid stored event");
		return event as unknown as ApiEvent;
	}
	private validateStoredData(): void {
		for (const row of this.rows("SELECT * FROM api_resources")) this.resource(row);
		const heads = new Map<string, { latest: number; next: number }>();
		for (const row of this.rows("SELECT * FROM api_streams")) {
			if (
				!stream(row.stream_id) ||
				!positiveRevision(row.latest_seq) ||
				typeof row.floor_seq !== "number" ||
				!Number.isSafeInteger(row.floor_seq) ||
				row.floor_seq < 0 ||
				row.floor_seq > row.latest_seq
			)
				fail("API_STORE_INVALID", "Invalid event stream head");
			heads.set(row.stream_id, { latest: row.latest_seq, next: row.floor_seq + 1 });
		}
		for (const row of this.rows("SELECT * FROM api_events ORDER BY stream_id,seq")) {
			const event = this.event(row);
			const head = heads.get(event.stream_id);
			if (!head || event.seq !== head.next || event.seq > head.latest)
				fail("API_STORE_INVALID", "API event history contains a sequence gap");
			head.next++;
		}
		for (const head of heads.values())
			if (head.next !== head.latest + 1) fail("API_STORE_INVALID", "API event history is incomplete");
		for (const row of this.rows("SELECT * FROM api_intents")) {
			if (
				!text(row.principal, 300) ||
				!text(row.key, 200) ||
				!text(row.fingerprint, 4096) ||
				!identifier(row.owner) ||
				!positiveRevision(row.pid) ||
				!["pending", "completed", "failed", "interrupted"].includes(String(row.state))
			)
				fail("API_STORE_INVALID", "Invalid stored idempotency intent");
			const bindings = decode(row.resources);
			if (
				!Array.isArray(bindings) ||
				bindings.some(
					(value) =>
						!object(value) || Object.keys(value).length !== 2 || !identifier(value.kind) || !identifier(value.id),
				)
			)
				fail("API_STORE_INVALID", "Invalid operation resource bindings");
			if (row.state === "completed" || row.state === "failed") {
				const value = decode(row.result);
				if (
					!object(value) ||
					(row.state === "completed"
						? typeof value.defined !== "boolean" || (value.defined && !Object.hasOwn(value, "value"))
						: typeof value.code !== "string" ||
							typeof value.message !== "string" ||
							typeof value.retryable !== "boolean")
				)
					fail("API_STORE_INVALID", "Invalid stored idempotency result");
			}
		}
	}
	private makeCursor(query: string, after: number): string {
		const body = Buffer.from(JSON.stringify({ v: 1, query, after })).toString("base64url");
		const signature = createHmac("sha256", this.cursorSecret).update(body).digest("base64url");
		return `${body}.${signature}`;
	}
	private readCursor(cursor: unknown, query: string): number {
		if (typeof cursor !== "string" || cursor.length > 1000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(cursor))
			return fail("INVALID_CURSOR", "Invalid list cursor");
		const [body, signature] = cursor.split(".");
		const expected = createHmac("sha256", this.cursorSecret).update(body).digest();
		const provided = Buffer.from(signature, "base64url");
		if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
			return fail("INVALID_CURSOR", "Invalid list cursor");
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
		} catch {
			return fail("INVALID_CURSOR", "Invalid list cursor");
		}
		if (
			!object(parsed) ||
			Object.keys(parsed).length !== 3 ||
			parsed.v !== 1 ||
			parsed.query !== query ||
			!positiveRevision(parsed.after)
		)
			return fail("INVALID_CURSOR", "Cursor belongs to a different query");
		return parsed.after;
	}
	private secureFiles(): void {
		if (this.path === ":memory:") return;
		for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
			try {
				chmodSync(path, 0o600);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
					fail("API_STORE_INVALID", "API storage permissions could not be secured");
			}
		}
	}
	private notify(): void {
		if (this.delivering) return;
		this.delivering = true;
		try {
			while (this.pendingEvents.length > 0) {
				const event = this.pendingEvents.shift()!;
				const head = this.one("SELECT floor_seq FROM api_streams WHERE stream_id=?", event.stream_id);
				if (Number(head?.floor_seq ?? 0) >= event.seq) continue;
				for (const listener of [...this.listeners]) {
					try {
						listener(decode(JSON.stringify(event)) as unknown as ApiEvent);
					} catch {
						/* A subscriber cannot roll back a committed mutation. */
					}
				}
			}
		} finally {
			this.delivering = false;
		}
	}
}
