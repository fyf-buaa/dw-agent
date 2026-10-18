import { createHash, randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
	CompanionIdentifierSchema,
	type CompanionState,
	ImportantDateSchema,
	MemoryCreateSchema,
	MemoryDomainSchema,
	MemoryDurabilitySchema,
	type MemoryEvidence,
	type MemoryInsert,
	MemoryKindSchema,
	type MemoryListOptions,
	MemoryMutationSchema,
	type MemoryRecord,
	type MemoryScope,
	type MemoryStatus,
	MemoryStatusSchema,
	memoryContextCost,
	type RankedMemory,
	type RelationshipEvent,
	RelationshipStages,
} from "./companion-types.ts";
import { ExecutorError } from "./errors.ts";

const APP_ID = 0x4457434d;
const DAY = 86_400_000;
const REDACTED = "[REDACTED]";
const credentialPatterns = [
	/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/gi,
	/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
	/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16})\b/g,
	/\b(?:https?|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^\s/@]+:[^\s/@]+@[^\s<>"']+/gi,
	/(?:set-cookie|cookie)\s*:\s*[^\r\n]+/gi,
	/(?:["']?(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|auth[ _-]?token|token|password|passwd|secret|cookie|authorization|密钥|令牌|密码|口令|凭据|授权码)["']?\s*(?::|=|是|为|is\b)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*')/gi,
	/(?:["']?(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|auth[ _-]?token|token|password|passwd|secret|cookie|authorization|密钥|令牌|密码|口令|凭据|授权码)["']?\s*(?::|=|是|为|is\b)\s*)["']?[^\s,"';}\]\n]+["']?/gi,
	/\bhttps?:\/\/[^\s<>"']*[?&](?:api[_-]?key|token|password|secret|access_token)=[^\s<>"']+/gi,
];

/** Deterministic credential redaction, not a general PII detector. Raw native history is separate. */
export function sanitizeMemoryText(text: string): string {
	let safe = text;
	for (const pattern of credentialPatterns) safe = safe.replace(pattern, REDACTED);
	return safe;
}

const NullableTime = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);
const EvidenceSchema = Type.Object({
	session_id: Type.Union([Type.String(), Type.Null()]),
	run_id: Type.Union([Type.String(), Type.Null()]),
	speaker: Type.Enum(["user", "assistant", "manual"]),
	quote: Type.String({ maxLength: 8000 }),
	timestamp: Type.Integer({ minimum: 0 }),
});
const InsertSchema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 300 }),
	kind: MemoryKindSchema,
	domain: MemoryDomainSchema,
	content: Type.String({ minLength: 1, maxLength: 8000 }),
	key: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
	status: MemoryStatusSchema,
	pinned: Type.Boolean(),
	confidence: Type.Number({ minimum: 0, maximum: 1 }),
	importance: Type.Number({ minimum: 0, maximum: 1 }),
	durability: MemoryDurabilitySchema,
	expires_at: NullableTime,
	created_at: Type.Integer({ minimum: 0 }),
	sources: Type.Array(EvidenceSchema, { maxItems: 20 }),
	supersedes: Type.Union([Type.String(), Type.Null()]),
});
const RecordSchema = Type.Object({
	...InsertSchema.properties,
	content: Type.String({ maxLength: 8000 }),
	persona_id: CompanionIdentifierSchema,
	user_id: CompanionIdentifierSchema,
	updated_at: Type.Integer({ minimum: 0 }),
	revision: Type.Integer({ minimum: 1 }),
	recall_count: Type.Integer({ minimum: 0 }),
	last_recalled_at: NullableTime,
});
const StateSchema = Type.Object({
	revision: Type.Integer({ minimum: 1 }),
	affinity: Type.Integer({ minimum: -100, maximum: 100 }),
	stage: Type.Enum(RelationshipStages),
	valence: Type.Number({ minimum: -1, maximum: 1 }),
	arousal: Type.Number({ minimum: 0, maximum: 1 }),
	user_name: Type.String({ maxLength: 100 }),
	address: Type.String({ maxLength: 100 }),
	relationship_background: Type.String({ maxLength: 4000 }),
	important_dates: Type.Array(ImportantDateSchema, { maxItems: 32 }),
	last_interaction_at: NullableTime,
	updated_at: Type.Integer({ minimum: 0 }),
	affinity_day: Type.String(),
	affinity_daily_change: Type.Integer({ minimum: 0, maximum: 12 }),
});
const EventSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	run_id: Type.Union([Type.String(), Type.Null()]),
	delta: Type.Integer({ minimum: -200, maximum: 200 }),
	reason: Type.String({ maxLength: 500 }),
	evidence_quote: Type.String({ maxLength: 8000 }),
	timestamp: Type.Integer({ minimum: 0 }),
});
const scopeSchema = Type.Object({ persona_id: CompanionIdentifierSchema, user_id: CompanionIdentifierSchema });
const AffinityDaySchema = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const stopWords: Record<string, true> = {
	the: true,
	and: true,
	for: true,
	that: true,
	this: true,
	with: true,
	what: true,
	when: true,
	where: true,
	which: true,
	who: true,
	how: true,
	you: true,
	your: true,
	are: true,
	was: true,
	were: true,
	have: true,
	has: true,
	had: true,
	can: true,
	could: true,
	would: true,
	should: true,
	please: true,
	hello: true,
	about: true,
	from: true,
	into: true,
	some: true,
	there: true,
	their: true,
	// biome-ignore lint/suspicious/noThenProperty: Boolean stop-word data, not a Promise-like method.
	then: true,
	them: true,
	我的: true,
	你的: true,
	我们: true,
	你们: true,
	他们: true,
	什么: true,
	怎么: true,
	如何: true,
	你好: true,
	请问: true,
	一个: true,
	这个: true,
	那个: true,
	可以: true,
	记得: true,
	是否: true,
	is: true,
	it: true,
	of: true,
	to: true,
	in: true,
	on: true,
	at: true,
	as: true,
	be: true,
	or: true,
	an: true,
	me: true,
	my: true,
	we: true,
	us: true,
	do: true,
	so: true,
	redacted: true,
};
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

function normalized(text: string): string {
	return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}
function fingerprint(input: Pick<MemoryInsert, "kind" | "domain" | "content">): string {
	return createHash("sha256")
		.update(`${input.kind}\0${input.domain}\0${normalized(input.content)}`)
		.digest("hex");
}
function tokens(text: string): string[] {
	const result = new Set<string>();
	const normalizedText = normalized(text);
	for (const part of segmenter.segment(normalizedText)) {
		if (!part.isWordLike || Object.hasOwn(stopWords, part.segment)) continue;
		if (/^[\p{L}\p{N}_]+$/u.test(part.segment) && part.segment.length >= 2) result.add(part.segment);
	}
	for (const match of normalizedText.matchAll(/\p{Script=Han}{2,}/gu)) {
		const chars = [...match[0]];
		for (let i = 0; i < chars.length - 1; i++) {
			const word = chars[i] + chars[i + 1];
			if (!Object.hasOwn(stopWords, word)) result.add(word);
		}
	}
	return [...result];
}
function fail(code: string, message: string): never {
	throw new ExecutorError(code, message);
}
function sensitive(text: string): void {
	if (sanitizeMemoryText(text) !== text)
		fail("SENSITIVE_MEMORY_CONTENT", "Credentials cannot be stored in companion memory");
}
function checkScope(scope: MemoryScope): void {
	if (!Check(scopeSchema, scope)) fail("INVALID_PAYLOAD", "Invalid companion scope");
}
function mergeSources(left: MemoryEvidence[], right: MemoryEvidence[]): MemoryEvidence[] {
	const result = [...left];
	for (const source of right) {
		if (
			!result.some(
				(old) => old.run_id === source.run_id && old.speaker === source.speaker && old.quote === source.quote,
			)
		)
			result.push(source);
	}
	return result.slice(-20);
}
function parseJson(text: unknown): unknown {
	if (typeof text !== "string") return fail("COMPANION_STORE_INVALID", "Companion storage is invalid");
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return fail("COMPANION_STORE_INVALID", "Companion storage is invalid");
	}
}

type Row = Record<string, string | number | bigint | Uint8Array | null>;

const SCHEMA = `
CREATE TABLE memories (
 persona TEXT NOT NULL, user_id TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 kind TEXT NOT NULL, domain TEXT NOT NULL, fact_key TEXT, status TEXT NOT NULL, pinned INTEGER NOT NULL,
 expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL,
 UNIQUE(persona,user_id,id)
);
CREATE INDEX memory_scope_status ON memories(persona,user_id,status,updated_at DESC);
CREATE INDEX memory_fingerprint ON memories(persona,user_id,fingerprint);
CREATE INDEX memory_fact_key ON memories(persona,user_id,domain,fact_key,status);
CREATE VIRTUAL TABLE memory_fts USING fts5(tokens, tokenize='unicode61');
CREATE TABLE states (persona TEXT NOT NULL,user_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(persona,user_id));
CREATE TABLE affinity_days (persona TEXT NOT NULL,user_id TEXT NOT NULL,day TEXT NOT NULL,amount INTEGER NOT NULL,PRIMARY KEY(persona,user_id,day));
CREATE TABLE processed_runs (persona TEXT NOT NULL,user_id TEXT NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(persona,user_id,run_id));
CREATE TABLE relationship_events (persona TEXT NOT NULL,user_id TEXT NOT NULL,id TEXT NOT NULL,timestamp INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(persona,user_id,id));
CREATE INDEX relationship_order ON relationship_events(persona,user_id,timestamp DESC);
CREATE TABLE memory_sources (persona TEXT NOT NULL,user_id TEXT NOT NULL,memory_id TEXT NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(persona,user_id,memory_id,run_id));
CREATE TABLE blocked_sources (persona TEXT NOT NULL,user_id TEXT NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(persona,user_id,run_id));
`;

export interface CompanionChange {
	scope: MemoryScope;
	kind: string;
	data: Record<string, unknown>;
}

/** Scope-local synchronous store. All writes compose into the runtime's single transaction. */
export class CompanionStore {
	private readonly database: DatabaseSync;
	private readonly statements = new Map<string, StatementSync>();
	private closed = false;
	private transactionDepth = 0;
	private readonly listeners = new Set<(change: CompanionChange) => void>();
	private pendingChanges: CompanionChange[] = [];

	subscribeChanges(listener: (change: CompanionChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(scope: MemoryScope, kind: string, data: Record<string, unknown>): void {
		const change = { scope: { ...scope }, kind, data };
		if (this.transactionDepth) this.pendingChanges.push(change);
		else this.publish([change]);
	}

	private publish(changes: CompanionChange[]): void {
		for (const change of changes)
			for (const listener of this.listeners) {
				try {
					listener(change);
				} catch {
					// A subscriber cannot roll back an already committed native change.
				}
			}
	}

	private constructor(database: DatabaseSync) {
		this.database = database;
	}

	static async open(path: string): Promise<CompanionStore> {
		let database: DatabaseSync | undefined;
		try {
			let exists = false;
			if (path !== ":memory:") {
				await mkdir(dirname(path), { recursive: true });
				try {
					await stat(path);
					exists = true;
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				}
			}
			database = new DatabaseSync(path, { timeout: 5000 });
			const store = new CompanionStore(database);
			if (exists) {
				if (
					store.one("PRAGMA application_id")?.application_id !== APP_ID ||
					store.one("PRAGMA user_version")?.user_version !== 1
				)
					fail("COMPANION_STORE_INVALID", "Unrecognized companion storage format");
				if (store.one("PRAGMA quick_check")?.quick_check !== "ok")
					fail("COMPANION_STORE_INVALID", "Companion storage is damaged");
				store.validateStoredData();
			} else {
				store.transaction(() => {
					database!.exec(SCHEMA);
					database!.exec("PRAGMA application_id = 1146569549; PRAGMA user_version = 1;");
				});
			}
			database.exec(
				"PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 1000; PRAGMA secure_delete = ON;",
			);
			return store;
		} catch {
			try {
				database?.close();
			} catch {
				/* Preserve the safe opening error. */
			}
			return fail("COMPANION_STORE_INVALID", "Companion storage could not be opened safely");
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.statements.clear();
		try {
			this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} finally {
			this.database.close();
		}
	}

	transaction<T>(operation: () => T): T {
		this.ensureOpen();
		const depth = this.transactionDepth++;
		const savepoint = `companion_${depth}`;
		const pendingStart = this.pendingChanges.length;
		try {
			this.database.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
			try {
				const result = operation();
				if (result instanceof Promise) fail("INVALID_PAYLOAD", "Companion transactions must be synchronous");
				this.database.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
				if (depth === 0) {
					const changes = this.pendingChanges;
					this.pendingChanges = [];
					this.publish(changes);
				}
				return result;
			} catch (error) {
				this.pendingChanges.length = pendingStart;
				this.database.exec(
					depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`,
				);
				throw error;
			}
		} catch (error) {
			if (error instanceof ExecutorError) throw error;
			return fail("COMPANION_STORE_INVALID", "Companion storage transaction failed");
		} finally {
			this.transactionDepth--;
		}
	}

	getState(scope: MemoryScope): CompanionState | undefined {
		checkScope(scope);
		const row = this.one("SELECT data FROM states WHERE persona=? AND user_id=?", scope.persona_id, scope.user_id);
		if (!row) return undefined;
		const value = parseJson(row.data);
		if (!Check(StateSchema, value)) return fail("COMPANION_STORE_INVALID", "Companion state is invalid");
		return value;
	}

	setState(scope: MemoryScope, state: CompanionState): void {
		checkScope(scope);
		if (!Check(StateSchema, state)) fail("INVALID_PAYLOAD", "Invalid companion state");
		sensitive(JSON.stringify(state));
		this.transaction(() => {
			const old = this.getState(scope);
			if (state.revision !== (old?.revision ?? 0) + 1)
				fail("MEMORY_REVISION_MISMATCH", "Companion state changed; refresh before saving");
			this.run(
				"INSERT INTO states(persona,user_id,data) VALUES(?,?,?) ON CONFLICT(persona,user_id) DO UPDATE SET data=excluded.data",
				scope.persona_id,
				scope.user_id,
				JSON.stringify(state),
			);
			this.changed(scope, "state.changed", { revision: state.revision });
		});
	}

	getDailyAffinity(scope: MemoryScope, day: string): number {
		checkScope(scope);
		if (!Check(AffinityDaySchema, day)) fail("INVALID_PAYLOAD", "Invalid affinity calendar day");
		const row = this.one(
			"SELECT amount FROM affinity_days WHERE persona=? AND user_id=? AND day=?",
			scope.persona_id,
			scope.user_id,
			day,
		);
		return Number(row?.amount ?? 0);
	}

	setDailyAffinity(scope: MemoryScope, day: string, amount: number): void {
		checkScope(scope);
		if (!Check(AffinityDaySchema, day) || !Number.isInteger(amount) || amount < 0 || amount > 12)
			fail("INVALID_PAYLOAD", "Invalid daily affinity budget");
		this.transaction(() => {
			if (amount < this.getDailyAffinity(scope, day))
				fail("INVALID_PAYLOAD", "Daily affinity budget cannot decrease");
			this.run(
				"INSERT INTO affinity_days(persona,user_id,day,amount) VALUES(?,?,?,?) ON CONFLICT(persona,user_id,day) DO UPDATE SET amount=excluded.amount",
				scope.persona_id,
				scope.user_id,
				day,
				amount,
			);
		});
	}

	hasProcessed(scope: MemoryScope, runId: string): boolean {
		checkScope(scope);
		return !!this.one(
			"SELECT 1 FROM processed_runs WHERE persona=? AND user_id=? AND run_id=?",
			scope.persona_id,
			scope.user_id,
			runId,
		);
	}

	markProcessed(scope: MemoryScope, runId: string): void {
		checkScope(scope);
		if (!runId) fail("INVALID_PAYLOAD", "Run ID is required");
		this.run(
			"INSERT OR IGNORE INTO processed_runs(persona,user_id,run_id) VALUES(?,?,?)",
			scope.persona_id,
			scope.user_id,
			runId,
		);
	}

	get(scope: MemoryScope, id: string): MemoryRecord | undefined {
		checkScope(scope);
		const row = this.one(
			"SELECT data FROM memories WHERE persona=? AND user_id=? AND id=?",
			scope.persona_id,
			scope.user_id,
			id,
		);
		return row ? this.record(row) : undefined;
	}

	insert(scope: MemoryScope, input: MemoryInsert): MemoryRecord {
		checkScope(scope);
		if (!Check(InsertSchema, input) || !input.content.trim() || (input.pinned && input.status !== "active"))
			fail("INVALID_PAYLOAD", "Invalid memory entry");
		const manual = input.sources.length > 0 && input.sources.every((source) => source.speaker === "manual");
		sensitive(input.key ?? "");
		if (manual || input.kind !== "episode") {
			sensitive(input.content);
			for (const source of input.sources) sensitive(source.quote);
		}
		const safe: MemoryInsert = {
			...input,
			content: sanitizeMemoryText(input.content).trim(),
			sources: input.sources.map((source) => ({ ...source, quote: sanitizeMemoryText(source.quote) })),
		};
		return this.transaction(() => {
			const existingId = this.get(scope, safe.id);
			if (existingId) return existingId;
			const hash = fingerprint(safe);
			const rows = this.all(
				"SELECT data FROM memories WHERE persona=? AND user_id=? AND fingerprint=? ORDER BY created_at DESC,rowid DESC",
				scope.persona_id,
				scope.user_id,
				hash,
			);
			const blocked =
				!manual &&
				safe.sources.some(
					(source) =>
						source.run_id !== null &&
						!!this.one(
							"SELECT 1 FROM blocked_sources WHERE persona=? AND user_id=? AND run_id=?",
							scope.persona_id,
							scope.user_id,
							source.run_id,
						),
				);
			const duplicate = rows
				.map((row) => this.record(row))
				.find((record) =>
					blocked
						? record.status === "forgotten"
						: !manual || (record.status !== "forgotten" && record.status !== "superseded"),
				);
			if (duplicate) {
				if (
					duplicate.status === "forgotten" ||
					duplicate.status === "archived" ||
					duplicate.status === "superseded"
				)
					return duplicate;
				const sources = mergeSources(duplicate.sources, safe.sources);
				const key = manual ? (safe.key ?? duplicate.key) : duplicate.key;
				const status = manual && duplicate.status === "pending" ? "active" : duplicate.status;
				const pinned = duplicate.pinned || (manual && safe.pinned);
				if (
					JSON.stringify(sources) === JSON.stringify(duplicate.sources) &&
					key === duplicate.key &&
					status === duplicate.status &&
					pinned === duplicate.pinned
				)
					return duplicate;
				const merged: MemoryRecord = {
					...duplicate,
					key,
					status,
					pinned,
					sources,
					updated_at: Math.max(duplicate.updated_at, safe.created_at),
					revision: duplicate.revision + 1,
				};
				if (merged.pinned) this.checkCore(scope, merged);
				this.save(merged, hash);
				return merged.status === "active" ? this.supersedeKey(scope, merged, safe.created_at) : merged;
			}
			const record: MemoryRecord = {
				...safe,
				...scope,
				updated_at: safe.created_at,
				revision: 1,
				recall_count: 0,
				last_recalled_at: null,
			};
			if (blocked || record.status === "forgotten") {
				record.status = "forgotten";
				record.content = "";
				record.key = null;
				record.sources = [];
				record.pinned = false;
			}
			if (record.pinned) this.checkCore(scope, record);
			this.save(record, hash);
			return record.status === "active" ? this.supersedeKey(scope, record, safe.created_at) : record;
		});
	}

	list(
		scope: MemoryScope,
		options: MemoryListOptions = {},
		now = Date.now(),
	): { items: MemoryRecord[]; total: number; next_cursor: number | null } {
		checkScope(scope);
		const limit = options.limit ?? 50;
		const cursor = options.cursor ?? 0;
		if (
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 100 ||
			!Number.isInteger(cursor) ||
			cursor < 0 ||
			(options.status !== undefined && options.status !== "all" && !Check(MemoryStatusSchema, options.status)) ||
			(options.kind !== undefined && !Check(MemoryKindSchema, options.kind)) ||
			(options.query !== undefined && (typeof options.query !== "string" || options.query.length > 4000))
		)
			fail("INVALID_PAYLOAD", "Invalid memory list options");
		const status = options.status ?? "active";
		const query = normalized(options.query ?? "");
		const params: (string | number)[] = [
			scope.persona_id,
			scope.user_id,
			status,
			status,
			options.kind ?? "",
			options.kind ?? "",
			query,
			query,
		];
		const where =
			"persona=? AND user_id=? AND (?='all' OR status=?) AND (?='' OR kind=?) AND (?='' OR instr(lower(json_extract(data,'$.content')),?)>0)";
		const total = Number(this.one(`SELECT count(*) AS count FROM memories WHERE ${where}`, ...params)?.count ?? 0);
		const items = this.all(
			`SELECT data FROM memories WHERE ${where} ORDER BY updated_at DESC,rowid DESC LIMIT ? OFFSET ?`,
			...params,
			limit,
			cursor,
		).map((row) => this.record(row));
		// Expired records remain manageable; only recall and pinned injection exclude expiry.
		void now;
		return { items, total, next_cursor: cursor + items.length < total ? cursor + items.length : null };
	}

	pinned(scope: MemoryScope, now = Date.now()): MemoryRecord[] {
		checkScope(scope);
		return this.all(
			"SELECT data FROM memories WHERE persona=? AND user_id=? AND status='active' AND pinned=1 AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at,id",
			scope.persona_id,
			scope.user_id,
			now,
		).map((row) => this.record(row));
	}

	search(scope: MemoryScope, query: string, limit = 6, now = Date.now()): RankedMemory[] {
		checkScope(scope);
		if (typeof query !== "string" || query.length > 16000 || !Number.isInteger(limit) || limit < 1 || limit > 100)
			fail("INVALID_PAYLOAD", "Invalid memory query");
		const queryTokens = tokens(sanitizeMemoryText(query)).slice(0, 64);
		if (queryTokens.length === 0) return [];
		const match = queryTokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
		// Candidate bounds and lexical ranks are scope-local; global BM25 corpus statistics would couple users.
		const candidates = this.all(
			`SELECT m.data, memory_fts.tokens AS search_tokens,
			 (SELECT count(*) FROM json_each(?) AS q
			  WHERE instr(' ' || memory_fts.tokens || ' ', ' ' || q.value || ' ') > 0) AS match_count
			 FROM memory_fts JOIN memories m ON m.rowid=memory_fts.rowid
			 WHERE memory_fts MATCH ? AND m.persona=? AND m.user_id=? AND m.status='active'
			  AND m.pinned=0 AND (m.expires_at IS NULL OR m.expires_at>?)
			 ORDER BY match_count DESC,m.updated_at DESC,m.id LIMIT 160`,
			JSON.stringify(queryTokens),
			match,
			scope.persona_id,
			scope.user_id,
			now,
		)
			.map((row) => {
				const item = this.record(row);
				if (typeof row.search_tokens !== "string")
					return fail("COMPANION_STORE_INVALID", "Invalid companion search tokens");
				const lexicalTokens = new Set(row.search_tokens.split(" "));
				const matches = Number(row.match_count);
				const age = Math.max(0, now - item.created_at) / DAY;
				const halfLife = item.durability === "durable" ? 365 : item.durability === "short" ? 7 : 60;
				const freshness = 0.5 ** (age / halfLife);
				const reinforcement =
					Math.min(1, Math.log1p(item.recall_count) / 5) *
					(item.last_recalled_at === null ? 0 : 0.5 ** (Math.max(0, now - item.last_recalled_at) / (30 * DAY)));
				const value = 0.45 * item.importance + 0.3 * freshness + 0.15 * reinforcement + 0.1 * item.confidence;
				return { item, lexicalTokens, value, matches };
			})
			.filter((entry) => entry.matches > 0)
			.sort(
				(a, b) =>
					b.matches - a.matches ||
					a.lexicalTokens.size - b.lexicalTokens.size ||
					b.item.updated_at - a.item.updated_at ||
					a.item.id.localeCompare(b.item.id),
			);
		const values = [...candidates].sort((a, b) => b.value - a.value);
		const valueRanks = new Map(values.map((entry, index) => [entry.item.id, index]));
		const pending = candidates.map((entry, rank) => ({
			...entry,
			score:
				1 / (60 + rank) +
				1 / (60 + (valueRanks.get(entry.item.id) ?? 0)) +
				(0.01 * entry.matches) / queryTokens.length +
				0.003 * entry.value,
		}));
		const selected: typeof pending = [];
		while (pending.length && selected.length < limit) {
			let bestIndex = -1;
			let bestScore = -Infinity;
			for (let i = 0; i < pending.length; i++) {
				const entry = pending[i];
				let similarity = 0;
				for (const other of selected) {
					let overlap = 0;
					for (const token of entry.lexicalTokens) if (other.lexicalTokens.has(token)) overlap++;
					similarity = Math.max(
						similarity,
						overlap / Math.max(1, entry.lexicalTokens.size + other.lexicalTokens.size - overlap),
					);
				}
				if (similarity >= 0.85) continue;
				const score = entry.score * (1 - 0.65 * similarity);
				if (score > bestScore) {
					bestScore = score;
					bestIndex = i;
				}
			}
			if (bestIndex < 0) break;
			const [best] = pending.splice(bestIndex, 1);
			best.score = bestScore;
			selected.push(best);
		}
		return selected.map(({ item, score, matches }) => ({
			item,
			score,
			reason: `lexical:${matches}; reciprocal-rank/age/importance/recall; diversity`,
		}));
	}

	markRecalled(scope: MemoryScope, ids: string[], now: number): void {
		checkScope(scope);
		this.transaction(() => {
			for (const id of new Set(ids)) {
				const result = this.statement(
					"UPDATE memories SET data=json_set(data,'$.recall_count',json_extract(data,'$.recall_count')+1,'$.last_recalled_at',?) WHERE persona=? AND user_id=? AND id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)",
				).run(now, scope.persona_id, scope.user_id, id, now);
				if (Number(result.changes)) this.changed(scope, "memory.changed", { id, recalled: true });
			}
		});
	}

	create(scope: MemoryScope, value: unknown, now = Date.now()): MemoryRecord {
		if (!Check(MemoryCreateSchema, value) || !value.content.trim() || (value.key !== undefined && !value.key.trim()))
			fail("INVALID_PAYLOAD", "Invalid manual memory");
		sensitive(JSON.stringify(value));
		return this.transaction(() => {
			const record = this.insert(scope, {
				id: randomUUID(),
				kind: value.kind,
				domain: value.domain,
				content: value.content.trim(),
				key: value.key?.trim() ?? null,
				status: "active",
				pinned: value.pinned ?? false,
				confidence: 1,
				importance: value.importance ?? 0.5,
				durability: value.durability ?? "normal",
				expires_at: value.expires_at ?? null,
				created_at: now,
				sources: [
					{ session_id: null, run_id: null, speaker: "manual", quote: value.content.trim(), timestamp: now },
				],
				supersedes: null,
			});
			if (record.status !== "active")
				fail("INVALID_PAYLOAD", "Restore the existing memory before creating this content again");
			let active = record;
			if ((value.pinned ?? false) && !active.pinned) {
				this.checkCore(scope, { ...active, pinned: true });
				active = { ...active, pinned: true, revision: active.revision + 1, updated_at: now };
				this.save(active);
			}
			return this.supersedeKey(scope, active, now);
		});
	}

	mutate(scope: MemoryScope, id: string, value: unknown, now = Date.now()): MemoryRecord {
		if (!Check(MemoryMutationSchema, value)) fail("INVALID_PAYLOAD", "Invalid memory mutation");
		return this.transaction(() => {
			const old = this.get(scope, id);
			if (!old) return fail("MEMORY_NOT_FOUND", "Memory was not found");
			if (old.revision !== value.expected_revision)
				fail("MEMORY_REVISION_MISMATCH", "Memory changed; refresh before saving");
			if (old.status === "forgotten") {
				if (value.operation === "forget") return old;
				return fail("INVALID_PAYLOAD", "Forgotten memory cannot be restored");
			}
			if (value.operation === "forget") return this.forget(scope, old, now);
			if (value.operation === "correct") {
				if (!value.content?.trim()) return fail("INVALID_PAYLOAD", "Correction content is required");
				sensitive(value.content);
				const content = value.content.trim();
				if (normalized(content) === normalized(old.content)) return old;
				const fresh: MemoryRecord = {
					...old,
					id: randomUUID(),
					content,
					status: "active",
					revision: 1,
					created_at: now,
					updated_at: now,
					supersedes: old.id,
					recall_count: 0,
					last_recalled_at: null,
					sources: mergeSources(old.sources, [
						{ session_id: null, run_id: null, speaker: "manual", quote: content, timestamp: now },
					]),
				};
				if (fresh.pinned) this.checkCore(scope, fresh, old.id);
				this.save({ ...old, status: "superseded", pinned: false, revision: old.revision + 1, updated_at: now });
				this.save(fresh, fingerprint(fresh));
				this.run(
					"INSERT OR IGNORE INTO memory_sources(persona,user_id,memory_id,run_id) SELECT persona,user_id,?,run_id FROM memory_sources WHERE persona=? AND user_id=? AND memory_id=?",
					fresh.id,
					scope.persona_id,
					scope.user_id,
					old.id,
				);
				return this.supersedeKey(scope, fresh, now);
			}
			const fresh = { ...old, revision: old.revision + 1, updated_at: now };
			switch (value.operation) {
				case "approve":
					if (old.status !== "pending") fail("INVALID_PAYLOAD", "Only pending memories can be approved");
					fresh.status = "active";
					break;
				case "archive":
					fresh.status = "archived";
					fresh.pinned = false;
					break;
				case "restore":
					if (old.status !== "archived") fail("INVALID_PAYLOAD", "Only archived memories can be restored");
					fresh.status = "active";
					break;
				case "pin":
					if (old.status !== "active") fail("INVALID_PAYLOAD", "Only active memories can be pinned");
					fresh.pinned = true;
					this.checkCore(scope, fresh);
					break;
				case "unpin":
					if (old.status !== "active") fail("INVALID_PAYLOAD", "Only active memories can be unpinned");
					fresh.pinned = false;
					break;
			}
			this.save(fresh);
			return fresh.status === "active" ? this.supersedeKey(scope, fresh, now) : fresh;
		});
	}

	counts(scope: MemoryScope): Record<MemoryStatus, number> {
		checkScope(scope);
		const result = { active: 0, pending: 0, superseded: 0, archived: 0, forgotten: 0 };
		for (const row of this.all(
			"SELECT status,count(*) AS count FROM memories WHERE persona=? AND user_id=? GROUP BY status",
			scope.persona_id,
			scope.user_id,
		)) {
			if (!Check(MemoryStatusSchema, row.status)) fail("COMPANION_STORE_INVALID", "Invalid memory status");
			result[row.status] = Number(row.count);
		}
		return result;
	}

	appendRelationshipEvent(scope: MemoryScope, event: RelationshipEvent): void {
		checkScope(scope);
		if (!Check(EventSchema, event)) fail("INVALID_PAYLOAD", "Invalid relationship event");
		sensitive(event.reason);
		sensitive(event.evidence_quote);
		this.transaction(() => {
			this.run(
				"INSERT OR IGNORE INTO relationship_events(persona,user_id,id,timestamp,data) VALUES(?,?,?,?,?)",
				scope.persona_id,
				scope.user_id,
				event.id,
				event.timestamp,
				JSON.stringify(event),
			);
			this.run(
				"DELETE FROM relationship_events WHERE persona=? AND user_id=? AND id NOT IN (SELECT id FROM relationship_events WHERE persona=? AND user_id=? ORDER BY timestamp DESC,rowid DESC LIMIT 500)",
				scope.persona_id,
				scope.user_id,
				scope.persona_id,
				scope.user_id,
			);
		});
	}

	ledger(scope: MemoryScope, limit = 50): RelationshipEvent[] {
		checkScope(scope);
		if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail("INVALID_PAYLOAD", "Invalid ledger limit");
		return this.all(
			"SELECT data FROM relationship_events WHERE persona=? AND user_id=? ORDER BY timestamp DESC,rowid DESC LIMIT ?",
			scope.persona_id,
			scope.user_id,
			limit,
		).map((row) => {
			const value = parseJson(row.data);
			if (!Check(EventSchema, value)) return fail("COMPANION_STORE_INVALID", "Invalid relationship ledger");
			return value;
		});
	}

	private supersedeKey(scope: MemoryScope, record: MemoryRecord, now: number): MemoryRecord {
		if (record.kind !== "fact" || !record.key) return record;
		let result = record;
		for (const row of this.all(
			"SELECT data FROM memories WHERE persona=? AND user_id=? AND kind='fact' AND domain=? AND fact_key=? AND status='active' AND id<>?",
			scope.persona_id,
			scope.user_id,
			record.domain,
			record.key,
			record.id,
		)) {
			const previous = this.record(row);
			if (normalized(previous.content) === normalized(record.content)) continue;
			this.save({
				...previous,
				status: "superseded",
				pinned: false,
				revision: previous.revision + 1,
				updated_at: now,
			});
			if (result.supersedes === null) result = { ...result, supersedes: previous.id };
		}
		if (result !== record) this.save(result);
		return result;
	}

	private forget(scope: MemoryScope, old: MemoryRecord, now: number): MemoryRecord {
		const related = new Map<string, MemoryRecord>([[old.id, old]]);
		const runs = this.all(
			"SELECT run_id FROM memory_sources WHERE persona=? AND user_id=? AND memory_id=?",
			scope.persona_id,
			scope.user_id,
			old.id,
		);
		for (const row of runs) {
			if (typeof row.run_id !== "string") fail("COMPANION_STORE_INVALID", "Invalid memory source");
			this.run(
				"INSERT OR IGNORE INTO blocked_sources(persona,user_id,run_id) VALUES(?,?,?)",
				scope.persona_id,
				scope.user_id,
				row.run_id,
			);
			for (const episode of this.all(
				"SELECT m.data FROM memories m JOIN memory_sources s ON m.persona=s.persona AND m.user_id=s.user_id AND m.id=s.memory_id WHERE m.persona=? AND m.user_id=? AND m.kind='episode' AND s.run_id=?",
				scope.persona_id,
				scope.user_id,
				row.run_id,
			)) {
				const record = this.record(episode);
				related.set(record.id, record);
			}
		}
		let result = old;
		for (const record of related.values()) {
			if (record.status === "forgotten") continue;
			const erased: MemoryRecord = {
				...record,
				content: "",
				key: null,
				sources: [],
				status: "forgotten",
				pinned: false,
				revision: record.revision + 1,
				updated_at: now,
			};
			this.save(erased);
			if (record.id === old.id) result = erased;
		}
		return result;
	}

	private checkCore(scope: MemoryScope, candidate: MemoryRecord, replacing?: string): void {
		const core = this.all(
			"SELECT data FROM memories WHERE persona=? AND user_id=? AND status='active' AND pinned=1 AND id<>? AND id<>?",
			scope.persona_id,
			scope.user_id,
			candidate.id,
			replacing ?? "",
		)
			.map((row) => this.record(row))
			.filter(
				(record) =>
					!(
						candidate.kind === "fact" &&
						candidate.key &&
						record.kind === "fact" &&
						record.domain === candidate.domain &&
						record.key === candidate.key
					),
			);
		if (
			core.length + 1 > 8 ||
			core.reduce((cost, item) => cost + memoryContextCost(item), 2 + memoryContextCost(candidate)) > 2048
		)
			fail("CORE_MEMORY_BUDGET_EXCEEDED", "Core memory exceeds eight entries or 2048 encoded characters");
	}

	private save(record: MemoryRecord, hash?: string): void {
		const previous = this.one(
			"SELECT rowid,fingerprint FROM memories WHERE persona=? AND user_id=? AND id=?",
			record.persona_id,
			record.user_id,
			record.id,
		);
		const storedHash =
			hash ?? (typeof previous?.fingerprint === "string" ? previous.fingerprint : fingerprint(record));
		this.run(
			"INSERT INTO memories(persona,user_id,id,fingerprint,kind,domain,fact_key,status,pinned,expires_at,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(persona,user_id,id) DO UPDATE SET fingerprint=excluded.fingerprint,kind=excluded.kind,domain=excluded.domain,fact_key=excluded.fact_key,status=excluded.status,pinned=excluded.pinned,expires_at=excluded.expires_at,updated_at=excluded.updated_at,data=excluded.data",
			record.persona_id,
			record.user_id,
			record.id,
			storedHash,
			record.kind,
			record.domain,
			record.key,
			record.status,
			Number(record.pinned),
			record.expires_at,
			record.created_at,
			record.updated_at,
			JSON.stringify(record),
		);
		const rowid =
			previous?.rowid ??
			this.one(
				"SELECT rowid FROM memories WHERE persona=? AND user_id=? AND id=?",
				record.persona_id,
				record.user_id,
				record.id,
			)?.rowid;
		if (typeof rowid !== "number" && typeof rowid !== "bigint")
			fail("COMPANION_STORE_INVALID", "Invalid memory identity");
		this.run("DELETE FROM memory_fts WHERE rowid=?", rowid);
		if (record.status === "active" && !record.pinned)
			this.run("INSERT INTO memory_fts(rowid,tokens) VALUES(?,?)", rowid, tokens(record.content).join(" "));
		if (record.status === "forgotten")
			this.run(
				"DELETE FROM memory_sources WHERE persona=? AND user_id=? AND memory_id=?",
				record.persona_id,
				record.user_id,
				record.id,
			);
		for (const source of record.sources)
			if (source.run_id !== null)
				this.run(
					"INSERT OR IGNORE INTO memory_sources(persona,user_id,memory_id,run_id) VALUES(?,?,?,?)",
					record.persona_id,
					record.user_id,
					record.id,
					source.run_id,
				);
		this.changed(record, "memory.changed", { id: record.id, revision: record.revision, status: record.status });
	}

	private record(row: Row): MemoryRecord {
		const value = parseJson(row.data);
		if (
			!Check(RecordSchema, value) ||
			(value.status === "forgotten"
				? value.content !== "" || value.sources.length !== 0 || value.pinned || value.key !== null
				: !value.content.trim()) ||
			(value.pinned && value.status !== "active")
		)
			return fail("COMPANION_STORE_INVALID", "Invalid stored memory");
		return value;
	}

	private validateStoredData(): void {
		const tables = this.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
		const allowed = new Set([
			"memories",
			"memory_fts",
			"memory_fts_data",
			"memory_fts_idx",
			"memory_fts_content",
			"memory_fts_docsize",
			"memory_fts_config",
			"states",
			"affinity_days",
			"processed_runs",
			"relationship_events",
			"memory_sources",
			"blocked_sources",
		]);
		if (
			tables.length !== allowed.size ||
			tables.some((row) => typeof row.name !== "string" || !allowed.has(row.name))
		)
			fail("COMPANION_STORE_INVALID", "Unrecognized companion tables");
		const expectedIndex = new Map<number | bigint, string>();
		for (const row of this.all("SELECT rowid,* FROM memories")) {
			const value = this.record(row);
			if (
				row.persona !== value.persona_id ||
				row.user_id !== value.user_id ||
				row.id !== value.id ||
				row.status !== value.status ||
				row.kind !== value.kind ||
				row.domain !== value.domain ||
				row.fact_key !== value.key ||
				row.pinned !== Number(value.pinned) ||
				row.expires_at !== value.expires_at ||
				row.created_at !== value.created_at ||
				row.updated_at !== value.updated_at ||
				typeof row.fingerprint !== "string"
			)
				fail("COMPANION_STORE_INVALID", "Inconsistent stored memory");
			sensitive(value.content);
			for (const source of value.sources) sensitive(source.quote);
			sensitive(value.key ?? "");
			if (typeof row.rowid !== "number" && typeof row.rowid !== "bigint")
				fail("COMPANION_STORE_INVALID", "Invalid stored memory identity");
			if (value.status === "active" && !value.pinned) expectedIndex.set(row.rowid, tokens(value.content).join(" "));
		}
		for (const row of this.all("SELECT rowid,tokens FROM memory_fts")) {
			if (
				(typeof row.rowid !== "number" && typeof row.rowid !== "bigint") ||
				expectedIndex.get(row.rowid) !== row.tokens
			)
				fail("COMPANION_STORE_INVALID", "Inconsistent companion search index");
			expectedIndex.delete(row.rowid);
		}
		if (expectedIndex.size !== 0) fail("COMPANION_STORE_INVALID", "Incomplete companion search index");
		for (const row of this.all("SELECT * FROM states")) {
			const value = parseJson(row.data);
			if (!Check(scopeSchema, { persona_id: row.persona, user_id: row.user_id }) || !Check(StateSchema, value))
				fail("COMPANION_STORE_INVALID", "Invalid stored companion state");
			sensitive(JSON.stringify(value));
		}
		for (const row of this.all("SELECT * FROM affinity_days")) {
			if (
				!Check(scopeSchema, { persona_id: row.persona, user_id: row.user_id }) ||
				!Check(AffinityDaySchema, row.day) ||
				typeof row.amount !== "number" ||
				!Number.isInteger(row.amount) ||
				row.amount < 0 ||
				row.amount > 12
			)
				fail("COMPANION_STORE_INVALID", "Invalid stored daily affinity budget");
		}
		for (const row of this.all("SELECT * FROM relationship_events")) {
			const value = parseJson(row.data);
			if (
				!Check(EventSchema, value) ||
				row.id !== value.id ||
				row.timestamp !== value.timestamp ||
				!Check(scopeSchema, { persona_id: row.persona, user_id: row.user_id })
			)
				fail("COMPANION_STORE_INVALID", "Invalid stored ledger");
			sensitive(value.reason);
			sensitive(value.evidence_quote);
		}
		for (const row of this.all(
			"SELECT * FROM processed_runs UNION ALL SELECT persona,user_id,run_id FROM blocked_sources",
		)) {
			if (
				!Check(scopeSchema, { persona_id: row.persona, user_id: row.user_id }) ||
				typeof row.run_id !== "string" ||
				!row.run_id
			)
				fail("COMPANION_STORE_INVALID", "Invalid stored run marker");
		}
		for (const row of this.all("SELECT * FROM memory_sources")) {
			if (
				!Check(scopeSchema, { persona_id: row.persona, user_id: row.user_id }) ||
				typeof row.run_id !== "string" ||
				!row.run_id ||
				typeof row.memory_id !== "string" ||
				!this.get({ persona_id: String(row.persona), user_id: String(row.user_id) }, row.memory_id)
			)
				fail("COMPANION_STORE_INVALID", "Invalid stored memory source");
		}
		this.run("INSERT INTO memory_fts(memory_fts) VALUES('integrity-check')");
	}

	private ensureOpen(): void {
		if (this.closed) fail("COMPANION_STORE_INVALID", "Companion storage is closed");
	}
	private statement(sql: string): StatementSync {
		this.ensureOpen();
		let statement = this.statements.get(sql);
		if (!statement) {
			try {
				statement = this.database.prepare(sql);
			} catch {
				return fail("COMPANION_STORE_INVALID", "Companion storage is invalid");
			}
			this.statements.set(sql, statement);
		}
		return statement;
	}
	private one(sql: string, ...params: (string | number | bigint | null)[]): Row | undefined {
		try {
			return this.statement(sql).get(...params) as Row | undefined;
		} catch (error) {
			if (error instanceof ExecutorError) throw error;
			return fail("COMPANION_STORE_INVALID", "Companion storage read failed");
		}
	}
	private all(sql: string, ...params: (string | number | bigint | null)[]): Row[] {
		try {
			return this.statement(sql).all(...params) as Row[];
		} catch (error) {
			if (error instanceof ExecutorError) throw error;
			return fail("COMPANION_STORE_INVALID", "Companion storage read failed");
		}
	}
	private run(sql: string, ...params: (string | number | bigint | null)[]): void {
		try {
			this.statement(sql).run(...params);
		} catch (error) {
			if (error instanceof ExecutorError) throw error;
			fail("COMPANION_STORE_INVALID", "Companion storage write failed");
		}
	}
}
