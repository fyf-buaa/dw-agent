import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { type Static, type TSchema, Type } from "typebox";
import { Check } from "typebox/value";
import {
	DEFAULT_LIFE_CONFIG,
	type DiaryEntry,
	DiaryEntrySchema,
	type DiaryList,
	type DiaryListOptions,
	LifeConfigSchema,
	LifeDaySchema,
	type LifeDetail,
	LifeDetailSchema,
	type LifeJob,
	LifeJobSchema,
	type LifePlan,
	LifePlanSchema,
	type LifeSettingsRecord,
	LifeSettingsUpdateSchema,
	type LifeSimulation,
	LifeSimulationSchema,
} from "./companion-life-types.ts";
import { type CompanionChange, sanitizeMemoryText } from "./companion-store.ts";
import { CompanionIdentifierSchema, type MemoryScope } from "./companion-types.ts";
import { ExecutorError } from "./errors.ts";

const APP_ID = 0x44574c46;
const ScopeSchema = Type.Object(
	{ persona_id: CompanionIdentifierSchema, user_id: CompanionIdentifierSchema },
	{ additionalProperties: false },
);
const SettingsSchema = Type.Object(
	{ revision: Type.Integer({ minimum: 1 }), config: LifeConfigSchema },
	{ additionalProperties: false },
);
const IdentifierSchema = Type.String({ minLength: 1, maxLength: 200 });
const DiaryListOptionsSchema = Type.Object(
	{ limit: Type.Optional(Type.Integer()), cursor: Type.Optional(Type.Integer()) },
	{ additionalProperties: false },
);
const definitions = [
	[
		"table",
		"life_scopes",
		"CREATE TABLE life_scopes (persona TEXT NOT NULL,user_id TEXT NOT NULL,registered_at INTEGER NOT NULL,PRIMARY KEY(persona,user_id))",
	],
	[
		"table",
		"life_settings",
		"CREATE TABLE life_settings (persona TEXT NOT NULL,user_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(persona,user_id))",
	],
	[
		"table",
		"life_simulations",
		"CREATE TABLE life_simulations (persona TEXT NOT NULL,user_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(persona,user_id))",
	],
	[
		"table",
		"life_plans",
		"CREATE TABLE life_plans (persona TEXT NOT NULL,user_id TEXT NOT NULL,day TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(persona,user_id,day))",
	],
	[
		"table",
		"life_details",
		"CREATE TABLE life_details (persona TEXT NOT NULL,user_id TEXT NOT NULL,day TEXT NOT NULL,segment TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(persona,user_id,day,segment))",
	],
	[
		"table",
		"life_diaries",
		"CREATE TABLE life_diaries (persona TEXT NOT NULL,user_id TEXT NOT NULL,day TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,generated INTEGER NOT NULL,data TEXT,PRIMARY KEY(persona,user_id,day))",
	],
	[
		"table",
		"life_jobs",
		"CREATE TABLE life_jobs (persona TEXT NOT NULL,user_id TEXT NOT NULL,id TEXT NOT NULL,started_at INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(persona,user_id,id))",
	],
	["index", "life_jobs_recent", "CREATE INDEX life_jobs_recent ON life_jobs(persona,user_id,started_at DESC)"],
] as const;
type Row = Record<string, string | number | bigint | Uint8Array | null>;
type Parameter = string | number | bigint | null;
interface SchemaShape {
	type?: string;
	properties?: Record<string, SchemaShape>;
	items?: SchemaShape;
	anyOf?: SchemaShape[];
}

function fail(code: string, message: string): never {
	throw new ExecutorError(code, message);
}
function invalidStore(): never {
	return fail("LIFE_STORE_INVALID", "Companion life storage is invalid");
}
function mismatch(): never {
	return fail("LIFE_REVISION_MISMATCH", "Companion life data changed; refresh before saving");
}
function revision(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) fail("INVALID_PAYLOAD", "Invalid life revision");
}
function day(value: string): void {
	if (
		!Check(LifeDaySchema, value) ||
		!Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) ||
		new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
	)
		fail("INVALID_PAYLOAD", "Invalid life calendar day");
}
function time(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000)
		fail("INVALID_PAYLOAD", "Invalid life timestamp");
}
function scopeCheck(scope: MemoryScope): void {
	if (!Check(ScopeSchema, scope)) fail("INVALID_PAYLOAD", "Invalid companion life scope");
	sensitive(scope);
}
function sensitive(value: unknown): void {
	if (typeof value === "string") {
		if (sanitizeMemoryText(value) !== value)
			fail("SENSITIVE_MEMORY_CONTENT", "Credentials cannot be stored in companion life data");
	} else if (Array.isArray(value)) {
		for (const item of value) sensitive(item);
	} else if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) sensitive(item);
	}
}
// Shared model schemas allow omitted additionalProperties; storage deliberately does not.
function knownProperties(schema: SchemaShape, value: unknown): boolean {
	if (schema.anyOf)
		return schema.anyOf.some(
			(branch) => Check(branch as unknown as TSchema, value) && knownProperties(branch, value),
		);
	if (Array.isArray(value)) return !!schema.items && value.every((item) => knownProperties(schema.items!, item));
	if (value !== null && typeof value === "object") {
		const properties = schema.properties;
		return (
			!!properties &&
			Object.entries(value).every(
				([key, item]) => Object.hasOwn(properties, key) && knownProperties(properties[key], item),
			)
		);
	}
	return true;
}
function validated<T extends TSchema>(schema: T, value: unknown): Static<T> {
	if (!Check(schema, value) || !knownProperties(schema as SchemaShape, value))
		fail("INVALID_PAYLOAD", "Invalid companion life record");
	sensitive(value);
	return value;
}
function parse(value: unknown): unknown {
	if (typeof value !== "string") return invalidStore();
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return invalidStore();
	}
}
function limitCheck(limit: number, max: number): void {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > max)
		fail("INVALID_PAYLOAD", "Invalid companion life list limit");
}

/** Independent, scope-local life storage. Reads never initialize persistent state. */
export class CompanionLifeStore {
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

	private publish(changes: CompanionChange[]): void {
		for (const change of changes)
			for (const listener of this.listeners) {
				try {
					listener(change);
				} catch {
					// Notifications never undo a persisted native change.
				}
			}
	}

	private constructor(database: DatabaseSync) {
		this.database = database;
	}

	static async open(path: string): Promise<CompanionLifeStore> {
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
			const store = new CompanionLifeStore(database);
			if (exists) {
				if (
					store.one("PRAGMA application_id")?.application_id !== APP_ID ||
					store.one("PRAGMA user_version")?.user_version !== 1 ||
					store.one("PRAGMA quick_check")?.quick_check !== "ok"
				)
					invalidStore();
				store.validateStoredData();
			} else {
				store.transaction(() => {
					for (const [, , sql] of definitions) database!.exec(sql);
					database!.exec(`PRAGMA application_id = ${APP_ID}; PRAGMA user_version = 1;`);
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
			return fail("LIFE_STORE_INVALID", "Companion life storage could not be opened safely");
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
		const savepoint = `life_${depth}`;
		const pendingStart = this.pendingChanges.length;
		try {
			this.database.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
			try {
				const result = operation();
				if (result instanceof Promise) fail("INVALID_PAYLOAD", "Companion life transactions must be synchronous");
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
			return invalidStore();
		} finally {
			this.transactionDepth--;
		}
	}

	registerScope(scope: MemoryScope, now: number): void {
		scopeCheck(scope);
		time(now);
		this.run(
			"INSERT OR IGNORE INTO life_scopes(persona,user_id,registered_at) VALUES(?,?,?)",
			scope.persona_id,
			scope.user_id,
			now,
		);
	}

	scopes(): MemoryScope[] {
		return this.all("SELECT persona,user_id FROM life_scopes ORDER BY persona,user_id").map((row) =>
			this.rowScope(row),
		);
	}

	getSettings(scope: MemoryScope): LifeSettingsRecord {
		scopeCheck(scope);
		const row = this.one(
			"SELECT * FROM life_settings WHERE persona=? AND user_id=?",
			scope.persona_id,
			scope.user_id,
		);
		return row ? this.readSettings(row) : { revision: 0, config: structuredClone(DEFAULT_LIFE_CONFIG) };
	}

	saveSettings(scope: MemoryScope, input: unknown): LifeSettingsRecord {
		scopeCheck(scope);
		const value = validated(LifeSettingsUpdateSchema, input);
		revision(value.expected_revision);
		return this.transaction(() => {
			if (this.getSettings(scope).revision !== value.expected_revision) mismatch();
			const result = { revision: value.expected_revision + 1, config: value.config };
			revision(result.revision);
			this.run(
				"INSERT INTO life_settings(persona,user_id,revision,data) VALUES(?,?,?,?) ON CONFLICT(persona,user_id) DO UPDATE SET revision=excluded.revision,data=excluded.data",
				scope.persona_id,
				scope.user_id,
				result.revision,
				JSON.stringify(result),
			);
			return structuredClone(result);
		});
	}

	getSimulation(scope: MemoryScope): LifeSimulation | undefined {
		scopeCheck(scope);
		const row = this.one(
			"SELECT * FROM life_simulations WHERE persona=? AND user_id=?",
			scope.persona_id,
			scope.user_id,
		);
		return row ? this.readSimulation(row) : undefined;
	}

	putSimulation(scope: MemoryScope, value: LifeSimulation, expectedRevision: number): void {
		scopeCheck(scope);
		this.checkSimulation(value);
		this.nextRevision(value.revision, expectedRevision);
		this.transaction(() => {
			const old = this.getSimulation(scope);
			if ((old?.revision ?? 0) !== expectedRevision) mismatch();
			if (
				old &&
				(value.updated_at < old.updated_at ||
					(old.generated_day !== null &&
						(value.generated_day === null || value.generated_day < old.generated_day)))
			)
				fail("INVALID_PAYLOAD", "Life simulation cannot move backwards");
			this.run(
				"INSERT INTO life_simulations(persona,user_id,revision,data) VALUES(?,?,?,?) ON CONFLICT(persona,user_id) DO UPDATE SET revision=excluded.revision,data=excluded.data",
				scope.persona_id,
				scope.user_id,
				value.revision,
				JSON.stringify(value),
			);
		});
	}

	getPlan(scope: MemoryScope, date: string): LifePlan | undefined {
		scopeCheck(scope);
		day(date);
		const row = this.one(
			"SELECT * FROM life_plans WHERE persona=? AND user_id=? AND day=?",
			scope.persona_id,
			scope.user_id,
			date,
		);
		return row ? this.readPlan(row) : undefined;
	}

	putPlan(scope: MemoryScope, value: LifePlan, expectedRevision: number): void {
		scopeCheck(scope);
		this.checkPlan(value);
		this.nextRevision(value.revision, expectedRevision);
		this.transaction(() => {
			if ((this.getPlan(scope, value.date)?.revision ?? 0) !== expectedRevision) mismatch();
			this.run(
				"INSERT INTO life_plans(persona,user_id,day,revision,data) VALUES(?,?,?,?,?) ON CONFLICT(persona,user_id,day) DO UPDATE SET revision=excluded.revision,data=excluded.data",
				scope.persona_id,
				scope.user_id,
				value.date,
				value.revision,
				JSON.stringify(value),
			);
			this.run(
				"DELETE FROM life_details WHERE persona=? AND user_id=? AND day=?",
				scope.persona_id,
				scope.user_id,
				value.date,
			);
			this.run(
				"DELETE FROM life_plans WHERE persona=? AND user_id=? AND day NOT IN (SELECT day FROM life_plans WHERE persona=? AND user_id=? ORDER BY day DESC LIMIT 14)",
				scope.persona_id,
				scope.user_id,
				scope.persona_id,
				scope.user_id,
			);
		});
	}

	plans(scope: MemoryScope, limit = 14): LifePlan[] {
		scopeCheck(scope);
		limitCheck(limit, 14);
		return this.all(
			"SELECT * FROM life_plans WHERE persona=? AND user_id=? ORDER BY day DESC LIMIT ?",
			scope.persona_id,
			scope.user_id,
			limit,
		).map((row) => this.readPlan(row));
	}

	getDetail(scope: MemoryScope, date: string, segment: string): LifeDetail | undefined {
		scopeCheck(scope);
		day(date);
		validated(IdentifierSchema, segment);
		const row = this.one(
			"SELECT * FROM life_details WHERE persona=? AND user_id=? AND day=? AND segment=?",
			scope.persona_id,
			scope.user_id,
			date,
			segment,
		);
		return row ? this.readDetail(row) : undefined;
	}

	putDetail(scope: MemoryScope, value: LifeDetail, expectedRevision: number): void {
		scopeCheck(scope);
		this.checkDetail(value);
		this.nextRevision(value.revision, expectedRevision);
		this.transaction(() => {
			if ((this.getDetail(scope, value.date, value.segment)?.revision ?? 0) !== expectedRevision) mismatch();
			this.run(
				"INSERT INTO life_details(persona,user_id,day,segment,revision,data) VALUES(?,?,?,?,?,?) ON CONFLICT(persona,user_id,day,segment) DO UPDATE SET revision=excluded.revision,data=excluded.data",
				scope.persona_id,
				scope.user_id,
				value.date,
				value.segment,
				value.revision,
				JSON.stringify(value),
			);
			this.run(
				"DELETE FROM life_details WHERE persona=? AND user_id=? AND day NOT IN (SELECT DISTINCT day FROM life_details WHERE persona=? AND user_id=? ORDER BY day DESC LIMIT 14)",
				scope.persona_id,
				scope.user_id,
				scope.persona_id,
				scope.user_id,
			);
		});
	}

	details(scope: MemoryScope, date: string): LifeDetail[] {
		scopeCheck(scope);
		day(date);
		return this.all(
			"SELECT * FROM life_details WHERE persona=? AND user_id=? AND day=? ORDER BY segment",
			scope.persona_id,
			scope.user_id,
			date,
		).map((row) => this.readDetail(row));
	}

	getDiary(scope: MemoryScope, date: string): DiaryEntry | undefined {
		const row = this.diaryRow(scope, date);
		return row ? this.readDiary(row) : undefined;
	}

	getDiaryRevision(scope: MemoryScope, date: string): number {
		return Number(this.diaryRow(scope, date)?.revision ?? 0);
	}
	isDiaryDeleted(scope: MemoryScope, date: string): boolean {
		return this.diaryRow(scope, date)?.deleted === 1;
	}
	hasDiaryDate(scope: MemoryScope, date: string): boolean {
		return this.diaryRow(scope, date) !== undefined;
	}

	putDiary(scope: MemoryScope, value: DiaryEntry, expectedRevision: number, retention: number): void {
		scopeCheck(scope);
		this.checkDiary(value);
		this.nextRevision(value.revision, expectedRevision);
		limitCheck(retention, 60);
		this.transaction(() => {
			if (this.getDiaryRevision(scope, value.date) !== expectedRevision) mismatch();
			this.run(
				"INSERT INTO life_diaries(persona,user_id,day,revision,deleted,generated,data) VALUES(?,?,?,?,0,1,?) ON CONFLICT(persona,user_id,day) DO UPDATE SET revision=excluded.revision,deleted=0,generated=1,data=excluded.data",
				scope.persona_id,
				scope.user_id,
				value.date,
				value.revision,
				JSON.stringify(value),
			);
			// Keep only content-free markers for pruned dates. Bump CAS to invalidate in-flight regeneration.
			this.run(
				"UPDATE life_diaries SET data=NULL,revision=revision+1 WHERE persona=? AND user_id=? AND data IS NOT NULL AND day NOT IN (SELECT day FROM life_diaries WHERE persona=? AND user_id=? AND data IS NOT NULL ORDER BY day DESC LIMIT ?)",
				scope.persona_id,
				scope.user_id,
				scope.persona_id,
				scope.user_id,
				retention,
			);
		});
	}

	deleteDiary(scope: MemoryScope, date: string, expectedRevision: number): void {
		scopeCheck(scope);
		day(date);
		revision(expectedRevision);
		revision(expectedRevision + 1);
		this.transaction(() => {
			if (this.getDiaryRevision(scope, date) !== expectedRevision) mismatch();
			// A revision-zero tombstone also blocks a writer that has not committed its first body.
			this.run(
				"INSERT INTO life_diaries(persona,user_id,day,revision,deleted,generated,data) VALUES(?,?,?,?,1,0,NULL) ON CONFLICT(persona,user_id,day) DO UPDATE SET revision=excluded.revision,deleted=1,data=NULL",
				scope.persona_id,
				scope.user_id,
				date,
				expectedRevision + 1,
			);
		});
	}

	listDiaries(scope: MemoryScope, options: DiaryListOptions = {}): DiaryList {
		scopeCheck(scope);
		const limit = options.limit ?? 14;
		const cursor = options.cursor ?? 0;
		limitCheck(limit, 60);
		revision(cursor);
		if (!Check(DiaryListOptionsSchema, options)) fail("INVALID_PAYLOAD", "Invalid diary list options");
		const rows = this.all(
			"SELECT * FROM life_diaries WHERE persona=? AND user_id=? AND data IS NOT NULL ORDER BY day DESC LIMIT ? OFFSET ?",
			scope.persona_id,
			scope.user_id,
			limit + 1,
			cursor,
		);
		const items = rows.slice(0, limit).map((row) => {
			const entry = this.readDiary(row);
			if (!entry) return invalidStore();
			return {
				date: entry.date,
				revision: entry.revision,
				generated_at: entry.generated_at,
				summary: entry.summary,
				form: entry.form,
				source: entry.source,
				evidence_count: entry.evidence.length,
			};
		});
		return { items, next_cursor: rows.length > limit ? cursor + items.length : null };
	}

	putJob(scope: MemoryScope, value: LifeJob): void {
		scopeCheck(scope);
		this.checkJob(value);
		this.transaction(() => {
			const old = this.one(
				"SELECT * FROM life_jobs WHERE persona=? AND user_id=? AND id=?",
				scope.persona_id,
				scope.user_id,
				value.id,
			);
			if (old) {
				const previous = this.readJob(old);
				if (JSON.stringify(previous) === JSON.stringify(value)) return;
				if (
					previous.date !== value.date ||
					previous.kind !== value.kind ||
					previous.started_at !== value.started_at ||
					(previous.status !== "running" && previous.status !== value.status)
				)
					fail("INVALID_PAYLOAD", "Invalid life job update");
			}
			this.run(
				"INSERT INTO life_jobs(persona,user_id,id,started_at,data) VALUES(?,?,?,?,?) ON CONFLICT(persona,user_id,id) DO UPDATE SET data=excluded.data",
				scope.persona_id,
				scope.user_id,
				value.id,
				value.started_at,
				JSON.stringify(value),
			);
			this.run(
				"DELETE FROM life_jobs WHERE persona=? AND user_id=? AND rowid NOT IN (SELECT rowid FROM life_jobs WHERE persona=? AND user_id=? ORDER BY started_at DESC,rowid DESC LIMIT 50)",
				scope.persona_id,
				scope.user_id,
				scope.persona_id,
				scope.user_id,
			);
		});
	}

	jobs(scope: MemoryScope, limit = 10): LifeJob[] {
		scopeCheck(scope);
		limitCheck(limit, 50);
		return this.all(
			"SELECT * FROM life_jobs WHERE persona=? AND user_id=? ORDER BY started_at DESC,rowid DESC LIMIT ?",
			scope.persona_id,
			scope.user_id,
			limit,
		).map((row) => this.readJob(row));
	}

	/** Called once by the new single-owner coordinator, before any native work can start. */
	recoverInterruptedJobs(now: number): void {
		time(now);
		this.transaction(() => {
			for (const row of this.all("SELECT * FROM life_jobs WHERE json_extract(data,'$.status')='running'")) {
				const job = this.readJob(row);
				this.putJob(this.rowScope(row), {
					...job,
					status: "cancelled",
					finished_at: Math.max(now, job.started_at),
					error: { code: "LIFE_INTERRUPTED", message: "Generation interrupted before completion" },
				});
			}
		});
	}

	private nextRevision(value: number, expected: number): void {
		revision(value);
		revision(expected);
		if (value !== expected + 1) mismatch();
	}
	private diaryRow(scope: MemoryScope, date: string): Row | undefined {
		scopeCheck(scope);
		day(date);
		const row = this.one(
			"SELECT * FROM life_diaries WHERE persona=? AND user_id=? AND day=?",
			scope.persona_id,
			scope.user_id,
			date,
		);
		if (row) this.readDiary(row);
		return row;
	}
	private checkSimulation(value: LifeSimulation): void {
		validated(LifeSimulationSchema, value);
		revision(value.revision);
		day(value.hunger.day);
		if (value.generated_day !== null) day(value.generated_day);
		if (
			(value.generated_day !== null && value.hunger.day !== value.generated_day) ||
			new Set(value.conditions.map((item) => item.id)).size !== value.conditions.length ||
			new Set(value.hunger.attempted).size !== value.hunger.attempted.length
		)
			fail("INVALID_PAYLOAD", "Inconsistent life simulation");
		for (const condition of value.conditions)
			if (condition.end_at < condition.start_at) fail("INVALID_PAYLOAD", "Invalid life condition interval");
		if (value.cycle.last_discomfort_day !== null) day(value.cycle.last_discomfort_day);
	}
	private checkPlan(value: LifePlan): void {
		validated(LifePlanSchema, value);
		revision(value.revision);
		day(value.date);
		for (let index = 0; index < value.items.length; index++) {
			const item = value.items[index];
			const previous = value.items[index - 1];
			if (
				(item.end !== undefined && item.end <= item.time) ||
				(previous && (previous.time >= item.time || (previous.end !== undefined && previous.end > item.time)))
			)
				fail("INVALID_PAYLOAD", "Invalid life plan intervals");
		}
	}
	private checkDetail(value: LifeDetail): void {
		validated(LifeDetailSchema, value);
		revision(value.revision);
		day(value.date);
	}
	private checkDiary(value: DiaryEntry): void {
		validated(DiaryEntrySchema, value);
		revision(value.revision);
		day(value.date);
		if (
			!value.summary.trim() ||
			!value.body.trim() ||
			value.dream_fragments.some((fragment) => !value.body.includes(fragment.text))
		)
			fail("INVALID_PAYLOAD", "Invalid diary content");
		for (const evidence of value.evidence)
			if ((evidence.memory_id === null) !== (evidence.memory_revision === null))
				fail("INVALID_PAYLOAD", "Inconsistent diary evidence");
	}
	private checkJob(value: LifeJob): void {
		validated(LifeJobSchema, value);
		day(value.date);
		if (
			(value.status === "running") !== (value.finished_at === null) ||
			(value.finished_at !== null && value.finished_at < value.started_at)
		)
			fail("INVALID_PAYLOAD", "Inconsistent life job status");
	}
	private rowScope(row: Row): MemoryScope {
		const value = { persona_id: row.persona, user_id: row.user_id };
		if (!Check(ScopeSchema, value)) return invalidStore();
		sensitive(value);
		return value;
	}
	private readSettings(row: Row): LifeSettingsRecord {
		const value = validated(SettingsSchema, parse(row.data));
		this.rowScope(row);
		revision(value.revision);
		if (row.revision !== value.revision) invalidStore();
		return value;
	}
	private readSimulation(row: Row): LifeSimulation {
		const value = validated(LifeSimulationSchema, parse(row.data));
		this.rowScope(row);
		this.checkSimulation(value);
		if (row.revision !== value.revision) invalidStore();
		return value;
	}
	private readPlan(row: Row): LifePlan {
		const value = validated(LifePlanSchema, parse(row.data));
		this.rowScope(row);
		this.checkPlan(value);
		if (row.revision !== value.revision || row.day !== value.date) invalidStore();
		return value;
	}
	private readDetail(row: Row): LifeDetail {
		const value = validated(LifeDetailSchema, parse(row.data));
		this.rowScope(row);
		this.checkDetail(value);
		if (row.revision !== value.revision || row.day !== value.date || row.segment !== value.segment) invalidStore();
		return value;
	}
	private readDiary(row: Row): DiaryEntry | undefined {
		this.rowScope(row);
		if (typeof row.day !== "string" || typeof row.revision !== "number") return invalidStore();
		day(row.day);
		revision(row.revision);
		if (
			row.revision === 0 ||
			(row.deleted !== 0 && row.deleted !== 1) ||
			(row.generated !== 0 && row.generated !== 1)
		)
			invalidStore();
		if (row.data === null) {
			if (row.deleted !== 1 && row.generated !== 1) invalidStore();
			return undefined;
		}
		const value = validated(DiaryEntrySchema, parse(row.data));
		this.checkDiary(value);
		if (row.deleted !== 0 || row.generated !== 1 || row.day !== value.date || row.revision !== value.revision)
			invalidStore();
		return value;
	}
	private readJob(row: Row): LifeJob {
		const value = validated(LifeJobSchema, parse(row.data));
		this.rowScope(row);
		this.checkJob(value);
		if (row.id !== value.id || row.started_at !== value.started_at) invalidStore();
		return value;
	}

	private validateStoredData(): void {
		const objects = this.all("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'");
		if (
			objects.length !== definitions.length ||
			definitions.some(
				([type, name, sql]) => !objects.some((row) => row.type === type && row.name === name && row.sql === sql),
			)
		)
			invalidStore();
		for (const row of this.all("SELECT * FROM life_scopes")) {
			this.rowScope(row);
			if (typeof row.registered_at !== "number") invalidStore();
			time(Number(row.registered_at));
		}
		for (const row of this.all("SELECT * FROM life_settings")) this.readSettings(row);
		for (const row of this.all("SELECT * FROM life_simulations")) this.readSimulation(row);
		for (const row of this.all("SELECT * FROM life_plans")) this.readPlan(row);
		for (const row of this.all("SELECT * FROM life_details")) this.readDetail(row);
		for (const row of this.all("SELECT * FROM life_diaries")) this.readDiary(row);
		for (const row of this.all("SELECT * FROM life_jobs")) this.readJob(row);
		for (const [table, maximum, distinctDay] of [
			["life_plans", 14, false],
			["life_details", 14, true],
			["life_jobs", 50, false],
			["life_diaries", 60, false],
		] as const) {
			const count = distinctDay ? "count(DISTINCT day)" : "count(*)";
			const where = table === "life_diaries" ? " WHERE data IS NOT NULL" : "";
			if (this.one(`SELECT 1 FROM ${table}${where} GROUP BY persona,user_id HAVING ${count}>? LIMIT 1`, maximum))
				invalidStore();
		}
	}

	private ensureOpen(): void {
		if (this.closed) invalidStore();
	}
	private statement(sql: string): StatementSync {
		this.ensureOpen();
		let statement = this.statements.get(sql);
		if (!statement) {
			statement = this.database.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
	}
	private one(sql: string, ...parameters: Parameter[]): Row | undefined {
		try {
			return this.statement(sql).get(...parameters) as Row | undefined;
		} catch (error) {
			if (error instanceof ExecutorError) throw error;
			return invalidStore();
		}
	}
	private all(sql: string, ...parameters: Parameter[]): Row[] {
		try {
			return this.statement(sql).all(...parameters) as Row[];
		} catch (error) {
			if (error instanceof ExecutorError) throw error;
			return invalidStore();
		}
	}
	private run(sql: string, ...parameters: Parameter[]): void {
		try {
			const result = this.statement(sql).run(...parameters);
			const table = /^(?:INSERT(?: OR IGNORE)? INTO|UPDATE|DELETE FROM) (life_[a-z_]+)/u.exec(sql)?.[1];
			const persona_id = parameters[0];
			const user_id = parameters[1];
			if (Number(result.changes) && table && typeof persona_id === "string" && typeof user_id === "string") {
				const change: CompanionChange = {
					scope: { persona_id, user_id },
					kind: `${table.replace("life_", "life.")}.changed`,
					data: { ...(typeof parameters[2] === "string" ? { id: parameters[2] } : {}) },
				};
				if (table === "life_jobs" && typeof parameters[4] === "string") {
					const job = validated(LifeJobSchema, parse(parameters[4]));
					change.data = { id: job.id, kind: job.kind, status: job.status, usage: job.usage };
				}
				if (this.transactionDepth) this.pendingChanges.push(change);
				else this.publish([change]);
			}
		} catch (error) {
			if (error instanceof ExecutorError) throw error;
			invalidStore();
		}
	}
}
