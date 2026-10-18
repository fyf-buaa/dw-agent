import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionStore, sanitizeMemoryText } from "../src/companion-store.ts";
import {
	type CompanionState,
	type MemoryEvidence,
	type MemoryInsert,
	type MemoryScope,
	memoryContextEntry,
} from "../src/companion-types.ts";

const cleanups: (() => void | Promise<void>)[] = [];
const scope: MemoryScope = { persona_id: "guide", user_id: "alice" };
const otherUser: MemoryScope = { persona_id: "guide", user_id: "bob" };
const otherPersona: MemoryScope = { persona_id: "friend", user_id: "alice" };
const now = 1_800_000_000_000;
const day = 86_400_000;

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "dw-companion-store-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "nested", "companion.sqlite");
	const store = await CompanionStore.open(path);
	cleanups.push(() => store.close());
	return { root, path, store };
}

function source(run = "run-1", quote = "我喜欢乌龙茶", speaker: MemoryEvidence["speaker"] = "user"): MemoryEvidence {
	return { session_id: "session-1", run_id: run, speaker, quote, timestamp: now };
}

function memory(id: string, content: string, overrides: Partial<MemoryInsert> = {}): MemoryInsert {
	return {
		id,
		kind: "fact",
		domain: "user",
		content,
		key: null,
		status: "active",
		pinned: false,
		confidence: 0.9,
		importance: 0.5,
		durability: "normal",
		expires_at: null,
		created_at: now,
		sources: [source(id, content)],
		supersedes: null,
		...overrides,
	};
}

function state(overrides: Partial<CompanionState> = {}): CompanionState {
	return {
		revision: 1,
		affinity: 12,
		stage: "familiar",
		valence: 0.25,
		arousal: 0.4,
		user_name: "Alice",
		address: "小艾",
		relationship_background: "共同阅读小说",
		important_dates: [{ date: "03-14", label: "生日" }],
		last_interaction_at: now,
		updated_at: now,
		affinity_day: "2027-01-15",
		affinity_daily_change: 3,
		...overrides,
	};
}

describe("companion SQLite store", () => {
	it("isolates record reads, counts, full-text retrieval, pins, state, ledger and run IDs by both scope fields", async () => {
		const { store } = await setup();
		const entry = store.create(scope, { kind: "fact", domain: "user", content: "Alice grows orchids" }, now);
		store.create(
			scope,
			{ kind: "event", domain: "relationship", content: "Visited a fictional observatory", pinned: true },
			now,
		);
		store.setState(scope, state());
		store.appendRelationshipEvent(scope, {
			id: "audit",
			run_id: "run",
			delta: 1,
			reason: "friendly exchange",
			evidence_quote: "thank you",
			timestamp: now,
		});
		store.markProcessed(scope, "run");
		for (const foreign of [otherUser, otherPersona]) {
			expect(store.get(foreign, entry.id)).toBeUndefined();
			expect(store.list(foreign, { status: "all" })).toEqual({ items: [], total: 0, next_cursor: null });
			expect(store.search(foreign, "orchids", 6, now)).toEqual([]);
			expect(store.pinned(foreign, now)).toEqual([]);
			expect(store.getState(foreign)).toBeUndefined();
			expect(store.ledger(foreign)).toEqual([]);
			expect(store.hasProcessed(foreign, "run")).toBe(false);
			expect(Object.values(store.counts(foreign)).reduce((sum, count) => sum + count, 0)).toBe(0);
			expect(() =>
				store.mutate(foreign, entry.id, { operation: "forget", expected_revision: entry.revision }, now),
			).toThrowError(expect.objectContaining({ code: "MEMORY_NOT_FOUND" }));
			store.markRecalled(foreign, [entry.id], now);
		}
		expect(store.get(scope, entry.id)?.recall_count).toBe(0);
		const ownScores = store.search(scope, "orchids", 6, now);
		const separate = store.insert(otherUser, memory(entry.id, "Bob grows orchids"));
		expect(separate.user_id).toBe("bob");
		expect(store.search(otherUser, "orchids", 6, now).map((entry) => entry.item.id)).toEqual([separate.id]);
		expect(store.search(scope, "orchids", 6, now)).toEqual(ownScores);
	});

	it("retrieves Chinese and English lexical evidence without unrelated or low-signal fallback", async () => {
		const { store } = await setup();
		const tea = store.create(
			scope,
			{ kind: "fact", domain: "user", content: "我喜欢在周末喝乌龙茶，也会练习陶艺。" },
			now,
		);
		const hike = store.create(
			scope,
			{ kind: "event", domain: "user", content: "Mountain hiking around Alpine lakes is a favorite hobby" },
			now,
		);
		store.create(
			scope,
			{ kind: "reflection", domain: "character", content: "The character's library is in a fictional castle" },
			now,
		);
		expect(store.search(scope, "你喜欢哪一种乌龙茶？", 6, now).map((result) => result.item.id)).toContain(tea.id);
		expect(store.search(scope, "ALPINE hiking", 6, now).map((result) => result.item.id)).toContain(hike.id);
		for (const query of ["", " ", "the and for", "你好", "quasar neutrino", "火星量子引擎", '" OR * --'])
			expect(store.search(scope, query, 6, now)).toEqual([]);
	});

	it("recalls older selective evidence despite a large recent history of partial query matches", async () => {
		const { store } = await setup();
		const telescope = store.create(
			scope,
			{
				kind: "fact",
				domain: "user",
				content: "Mango telescope belongs to Alice",
				durability: "durable",
				importance: 1,
			},
			now - day,
		);
		store.transaction(() => {
			for (let index = 0; index < 200; index++)
				store.create(
					scope,
					{ kind: "event", domain: "world", content: `Mango archive event ${index} records an unrelated chapter` },
					now + index,
				);
		});
		expect(store.search(scope, "mango telescope", 6, now + 200)[0].item.id).toBe(telescope.id);
	});

	it("excludes expired, pending, archived, superseded, forgotten and pinned records from dynamic retrieval", async () => {
		const { store } = await setup();
		const active = store.insert(scope, memory("active", "orchids active collection"));
		store.insert(scope, memory("expired", "orchids expired collection", { expires_at: now }));
		store.insert(scope, memory("pending", "orchids pending collection", { status: "pending" }));
		store.insert(scope, memory("archived", "orchids archived collection", { status: "archived" }));
		store.insert(scope, memory("superseded", "orchids superseded collection", { status: "superseded" }));
		const forgotten = store.insert(scope, memory("forgotten", "orchids forgotten collection"));
		store.mutate(scope, forgotten.id, { operation: "forget", expected_revision: forgotten.revision }, now);
		const pinned = store.insert(scope, memory("pinned", "orchids pinned collection", { pinned: true }));
		store.insert(
			scope,
			memory("expired-pin", "orchids expired pinned collection", { pinned: true, expires_at: now }),
		);
		expect(store.search(scope, "orchids", 20, now).map((result) => result.item.id)).toEqual([active.id]);
		expect(store.pinned(scope, now).map((record) => record.id)).toEqual([pinned.id]);
		expect(store.list(scope, { status: "all" }).total).toBe(8);
		expect(store.get(scope, "expired")?.content).not.toBe("");
	});

	it("merges normalized duplicates and attributed sources without downgrading or resurrecting automatic entries", async () => {
		const { store } = await setup();
		const first = store.insert(scope, memory("first", "  Enjoys   Alpine Hiking  "));
		const next = store.insert(
			scope,
			memory("second", "enjoys alpine hiking", {
				status: "pending",
				sources: [source("run-2", "Alpine Hiking", "assistant")],
			}),
		);
		expect(next.id).toBe(first.id);
		expect(next.status).toBe("active");
		expect(next.sources).toEqual([
			source("first", "  Enjoys   Alpine Hiking  "),
			source("run-2", "Alpine Hiking", "assistant"),
		]);
		expect(
			store.insert(
				scope,
				memory("third", "enjoys alpine hiking", { sources: [source("run-2", "Alpine Hiking", "assistant")] }),
			).revision,
		).toBe(next.revision);
		const archived = store.mutate(scope, first.id, { operation: "archive", expected_revision: next.revision }, now);
		expect(store.insert(scope, memory("fourth", "enjoys alpine hiking")).status).toBe("archived");
		const restored = store.mutate(
			scope,
			first.id,
			{ operation: "restore", expected_revision: archived.revision },
			now,
		);
		const erased = store.mutate(scope, first.id, { operation: "forget", expected_revision: restored.revision }, now);
		expect(store.insert(scope, memory("fifth", "enjoys alpine hiking")).id).toBe(erased.id);
		expect(store.search(scope, "Alpine Hiking", 6, now)).toEqual([]);
		const deliberate = store.create(
			scope,
			{ kind: "fact", domain: "user", content: "enjoys alpine hiking" },
			now + 1,
		);
		expect(deliberate.id).not.toBe(erased.id);
		expect(deliberate.status).toBe("active");
		expect(deliberate.sources[0].speaker).toBe("manual");
	});

	it("retains a bounded source list and old run associations for subsequent forgetting", async () => {
		const { store } = await setup();
		const episode = store.insert(
			scope,
			memory("episode-0", "User: lives in Hangzhou; Assistant: understood", {
				kind: "episode",
				sources: [source("origin-0", "lives in Hangzhou")],
			}),
		);
		let fact = store.insert(
			scope,
			memory("fact-0", "Lives in Hangzhou", { sources: [source("origin-0", "lives in Hangzhou")] }),
		);
		for (let index = 1; index <= 25; index++)
			fact = store.insert(
				scope,
				memory(`fact-${index}`, "Lives in Hangzhou", { sources: [source(`origin-${index}`, "lives in Hangzhou")] }),
			);
		expect(fact.sources).toHaveLength(20);
		expect(new Set(fact.sources.map((item) => item.run_id)).size).toBe(20);
		store.mutate(scope, fact.id, { operation: "forget", expected_revision: fact.revision }, now);
		expect(store.get(scope, episode.id)).toMatchObject({ status: "forgotten", content: "", sources: [] });
	});

	it("makes keyed manual replacement and pending approval atomic revisions without replacing unrelated multi-valued facts", async () => {
		const { store } = await setup();
		const before = store.create(
			scope,
			{ kind: "fact", domain: "user", content: "Lives in Suzhou", key: "user.home" },
			now,
		);
		const model = store.insert(
			scope,
			memory("proposal", "Lives in Hangzhou", {
				key: "user.home",
				status: "pending",
				sources: [source("move", "I moved to Hangzhou")],
			}),
		);
		expect(store.get(scope, before.id)?.status).toBe("active");
		expect(store.search(scope, "Hangzhou", 6, now)).toEqual([]);
		expect(() => store.mutate(scope, model.id, { operation: "approve", expected_revision: 99 }, now)).toThrowError(
			expect.objectContaining({ code: "MEMORY_REVISION_MISMATCH" }),
		);
		expect(store.get(scope, before.id)?.revision).toBe(before.revision);
		const approved = store.mutate(
			scope,
			model.id,
			{ operation: "approve", expected_revision: model.revision },
			now + 1,
		);
		expect(approved).toMatchObject({ status: "active", supersedes: before.id, sources: model.sources });
		expect(store.get(scope, before.id)).toMatchObject({ status: "superseded", revision: before.revision + 1 });
		const replacement = store.create(
			scope,
			{ kind: "fact", domain: "user", content: "Lives in Chengdu", key: "user.home" },
			now + 2,
		);
		expect(replacement.supersedes).toBe(approved.id);
		expect(store.get(scope, approved.id)?.status).toBe("superseded");
		const world = store.create(
			scope,
			{ kind: "fact", domain: "world", content: "The story home is a castle", key: "user.home" },
			now,
		);
		const reading = store.create(scope, { kind: "fact", domain: "user", content: "Enjoys reading" }, now);
		const pottery = store.create(scope, { kind: "fact", domain: "user", content: "Enjoys pottery" }, now);
		expect([world, reading, pottery].every((record) => store.get(scope, record.id)?.status === "active")).toBe(true);
	});

	it("allows a deliberate keyed Suzhou to Hangzhou to Suzhou return without resurrecting old automatic content", async () => {
		const { store } = await setup();
		const suzhou = store.create(
			scope,
			{ kind: "fact", domain: "user", key: "user.home", content: "Lives in Suzhou" },
			now,
		);
		const hangzhou = store.create(
			scope,
			{ kind: "fact", domain: "user", key: "user.home", content: "Lives in Hangzhou" },
			now + 1,
		);
		const historical = store.get(scope, suzhou.id);
		expect(historical).toMatchObject({ status: "superseded", pinned: false });
		expect(store.insert(scope, memory("automatic-return", "Lives in Suzhou", { key: "user.home" }))).toEqual(
			historical,
		);
		expect(store.get(scope, hangzhou.id)?.status).toBe("active");

		const returned = store.create(
			scope,
			{ kind: "fact", domain: "user", key: "user.home", content: "Lives in Suzhou" },
			now + 2,
		);
		expect(new Set([suzhou.id, hangzhou.id, returned.id]).size).toBe(3);
		expect(returned).toMatchObject({
			status: "active",
			supersedes: hangzhou.id,
			revision: 1,
			created_at: now + 2,
		});
		expect(store.get(scope, suzhou.id)).toEqual(historical);
		expect(store.get(scope, hangzhou.id)).toMatchObject({ status: "superseded", revision: hangzhou.revision + 1 });
		expect(store.search(scope, "Suzhou", 6, now + 2).map((result) => result.item.id)).toEqual([returned.id]);
		expect(store.search(scope, "Hangzhou", 6, now + 2)).toEqual([]);

		const archived = store.mutate(
			scope,
			returned.id,
			{ operation: "archive", expected_revision: returned.revision },
			now + 3,
		);
		expect(() =>
			store.create(scope, { kind: "fact", domain: "user", key: "user.home", content: "Lives in Suzhou" }, now + 4),
		).toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
		expect(store.get(scope, returned.id)).toEqual(archived);
		expect(store.list(scope, { status: "all" }).total).toBe(3);
	});

	it("corrects into a new manual-evidenced active record, preserving origin and pin while superseding the prior record", async () => {
		const { store } = await setup();
		const old = store.insert(scope, memory("wrong", "My favorite tea is green tea", { pinned: true }));
		const correction = store.mutate(
			scope,
			old.id,
			{ operation: "correct", expected_revision: old.revision, content: "My favorite tea is oolong tea" },
			now + 1,
		);
		expect(correction.id).not.toBe(old.id);
		expect(correction).toMatchObject({ status: "active", pinned: true, supersedes: old.id, revision: 1 });
		expect(correction.sources).toContainEqual(old.sources[0]);
		expect(correction.sources).toContainEqual({
			session_id: null,
			run_id: null,
			speaker: "manual",
			quote: "My favorite tea is oolong tea",
			timestamp: now + 1,
		});
		expect(store.get(scope, old.id)).toMatchObject({ status: "superseded", pinned: false, content: old.content });
		expect(store.pinned(scope, now + 1).map((record) => record.id)).toEqual([correction.id]);
	});

	it("rejects stale mutations without changing content, source, status, index or pin", async () => {
		const { store } = await setup();
		const old = store.create(scope, { kind: "fact", domain: "user", content: "Grows orchids" }, now);
		const current = store.mutate(scope, old.id, { operation: "pin", expected_revision: old.revision }, now + 1);
		for (const operation of ["forget", "archive", "correct", "unpin", "approve", "restore"]) {
			expect(() =>
				store.mutate(
					scope,
					old.id,
					{ operation, expected_revision: old.revision, content: "Rejected correction" },
					now + 2,
				),
			).toThrowError(expect.objectContaining({ code: "MEMORY_REVISION_MISMATCH" }));
			expect(store.get(scope, old.id)).toEqual(current);
		}
	});

	it("enforces core entry count and escaped whole-entry budget, rolling back failed insertion and correction", async () => {
		const { store } = await setup();
		const entries = Array.from({ length: 8 }, (_, index) =>
			store.insert(
				scope,
				memory(`c${index}`, `Core ${index}`, { pinned: true, key: `user.core${index}`, sources: [] }),
			),
		);
		expect(store.pinned(scope, now)).toHaveLength(8);
		expect(() =>
			store.create(scope, { kind: "fact", domain: "user", content: "Ninth note", pinned: true }, now),
		).toThrowError(expect.objectContaining({ code: "CORE_MEMORY_BUDGET_EXCEEDED" }));
		expect(store.list(scope, { status: "all" }).total).toBe(8);
		expect(() =>
			store.mutate(
				scope,
				entries[0].id,
				{ operation: "correct", expected_revision: entries[0].revision, content: "<".repeat(200) },
				now,
			),
		).toThrowError(expect.objectContaining({ code: "CORE_MEMORY_BUDGET_EXCEEDED" }));
		expect(store.get(scope, entries[0].id)).toEqual(entries[0]);
		const replaced = store.create(
			scope,
			{ kind: "fact", domain: "user", content: "Revised core zero", pinned: true, key: "user.core0" },
			now + 1,
		);
		expect(store.pinned(scope, now + 1)).toHaveLength(8);
		expect(store.get(scope, entries[0].id)?.status).toBe("superseded");
		expect(replaced.pinned).toBe(true);
		const isolated = otherUser;
		expect(() =>
			store.create(isolated, { kind: "fact", domain: "user", content: "<".repeat(400), pinned: true }, now),
		).toThrowError(expect.objectContaining({ code: "CORE_MEMORY_BUDGET_EXCEEDED" }));
		expect(store.counts(isolated).active).toBe(0);
	});

	it("accounts for source metadata and escaped JSON at the exact core-cap boundary", async () => {
		const { store } = await setup();
		const seed = store.create(scope, { kind: "fact", domain: "user", content: '<"' }, now);
		const encodedSeed = JSON.stringify([memoryContextEntry(seed)])
			.replace(/</g, "\\u003c")
			.replace(/>/g, "\\u003e");
		// One entry reserves its trailing comma in addition to the actual encoded array delimiters.
		const content = `${seed.content}${"x".repeat(2047 - encodedSeed.length)}`;
		const boundary = store.create(scope, { kind: "fact", domain: "user", content, pinned: true }, now);
		const encodedCore = JSON.stringify(store.pinned(scope, now).map(memoryContextEntry))
			.replace(/</g, "\\u003c")
			.replace(/>/g, "\\u003e");
		expect(encodedCore).toHaveLength(2047);
		expect(() =>
			store.mutate(
				scope,
				boundary.id,
				{ operation: "correct", expected_revision: boundary.revision, content: `${content}x` },
				now,
			),
		).toThrowError(expect.objectContaining({ code: "CORE_MEMORY_BUDGET_EXCEEDED" }));
		expect(store.get(scope, boundary.id)).toEqual(boundary);
		expect(store.pinned(scope, now)).toEqual([boundary]);
		expect(store.list(scope, { status: "all" }).total).toBe(2);
	});

	it("archives and restores without losing evidence; forgetting erases linked episodes and blocks journal resurrection", async () => {
		const { store } = await setup();
		const origin = source("origin-run", "我在苏州工作");
		const episode = store.insert(
			scope,
			memory("origin-episode", "User: 我在苏州工作; Assistant: 很高兴认识你", {
				kind: "episode",
				sources: [origin],
			}),
		);
		const fact = store.insert(scope, memory("work", "在苏州工作", { sources: [origin] }));
		store.markProcessed(scope, "origin-run");
		const archived = store.mutate(scope, fact.id, { operation: "archive", expected_revision: fact.revision }, now);
		expect(archived.content).toBe(fact.content);
		expect(archived.sources).toEqual(fact.sources);
		const restored = store.mutate(
			scope,
			fact.id,
			{ operation: "restore", expected_revision: archived.revision },
			now,
		);
		expect(restored.status).toBe("active");
		const erased = store.mutate(scope, fact.id, { operation: "forget", expected_revision: restored.revision }, now);
		expect(erased).toMatchObject({ status: "forgotten", content: "", sources: [], key: null, pinned: false });
		expect(store.get(scope, episode.id)).toMatchObject({ status: "forgotten", content: "", sources: [] });
		expect(store.search(scope, "苏州", 6, now)).toEqual([]);
		expect(store.hasProcessed(scope, "origin-run")).toBe(true);
		expect(
			store.insert(scope, memory("origin-episode", episode.content, { kind: "episode", sources: [origin] })).status,
		).toBe("forgotten");
		expect(
			store.insert(
				scope,
				memory("recovered-episode", `${episode.content} extended`, { kind: "episode", sources: [origin] }),
			).status,
		).toBe("forgotten");
		expect(store.insert(scope, memory("recovered-fact", "苏州是我的工作地点", { sources: [origin] })).status).toBe(
			"forgotten",
		);
		expect(() =>
			store.mutate(scope, erased.id, { operation: "restore", expected_revision: erased.revision }, now),
		).toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
		expect(store.mutate(scope, erased.id, { operation: "forget", expected_revision: erased.revision }, now)).toEqual(
			erased,
		);
	});

	it("redacts automatic episodes and rejects credential-bearing manual, proposal, correction and ledger writes", async () => {
		const { store, path } = await setup();
		const credentials = [
			"Bearer privateBearer998877",
			"api_key=privateApiSecret998877",
			"密码是私密口令998877",
			'{"password":"privatePassword998877"}',
			"Cookie: sid=cookieSecret998877; refresh=otherSecret998877",
			"https://alice:urlSecret998877@example.test/path",
			"https://example.test/?token=querySecret998877",
			["-----BEGIN ", "PRIVATE KEY-----\nprivatePem998877\n-----END ", "PRIVATE KEY-----"].join(""),
			'{"密码":"带有 空格的口令998877"}',
		];
		for (const [index, credential] of credentials.entries()) {
			expect(sanitizeMemoryText(credential)).not.toBe(credential);
			expect(sanitizeMemoryText(sanitizeMemoryText(credential))).toBe(sanitizeMemoryText(credential));
			expect(() => store.create(scope, { kind: "fact", domain: "user", content: credential }, now)).toThrowError(
				expect.objectContaining({ code: "SENSITIVE_MEMORY_CONTENT" }),
			);
			expect(() =>
				store.insert(
					scope,
					memory(`sensitive-fact-${index}`, "A harmless proposed statement", {
						status: "pending",
						sources: [source(`credential-${index}`, credential)],
					}),
				),
			).toThrowError(expect.objectContaining({ code: "SENSITIVE_MEMORY_CONTENT" }));
			store.insert(
				scope,
				memory(`redacted-${index}`, `讨论凭据 ${credential}`, {
					kind: "episode",
					sources: [source(`credential-${index}`, credential)],
				}),
			);
		}
		const safe = store.create(scope, { kind: "fact", domain: "user", content: "A safe preference" }, now);
		expect(() =>
			store.mutate(
				scope,
				safe.id,
				{ operation: "correct", expected_revision: safe.revision, content: credentials[0] },
				now,
			),
		).toThrowError(expect.objectContaining({ code: "SENSITIVE_MEMORY_CONTENT" }));
		expect(() =>
			store.appendRelationshipEvent(scope, {
				id: "bad-audit",
				run_id: null,
				delta: 1,
				reason: credentials[1],
				evidence_quote: "hello",
				timestamp: now,
			}),
		).toThrowError(expect.objectContaining({ code: "SENSITIVE_MEMORY_CONTENT" }));
		for (const query of [
			"privateBearer998877",
			"privateApiSecret998877",
			"privatePassword998877",
			"cookieSecret998877",
			"otherSecret998877",
			"privatePem998877",
			"私密口令998877",
		])
			expect(store.search(scope, query, 6, now)).toEqual([]);
		expect(store.search(scope, credentials[0], 6, now)).toEqual([]);
		store.close();
		const bytes = await readFile(path);
		for (const secret of [
			"privateBearer998877",
			"privateApiSecret998877",
			"privatePassword998877",
			"cookieSecret998877",
			"otherSecret998877",
			"privatePem998877",
		])
			expect(bytes.includes(Buffer.from(secret))).toBe(false);
	});

	it("uses soft age decay, importance and actual recall reinforcement without deleting old records", async () => {
		const { store } = await setup();
		const old = store.insert(
			scope,
			memory("old", "Orchids grow in the eastern greenhouse", {
				created_at: now - 800 * day,
				importance: 0.1,
				durability: "short",
			}),
		);
		const recent = store.insert(
			scope,
			memory("recent", "Orchids bloom in the western conservatory", { importance: 1, durability: "durable" }),
		);
		const before = store.search(scope, "orchids", 6, now);
		expect(before.map((result) => result.item.id)).toEqual([recent.id, old.id]);
		expect(store.get(scope, old.id)?.status).toBe("active");
		expect(store.get(scope, old.id)?.recall_count).toBe(0);
		store.search(scope, "orchids", 6, now);
		store.list(scope, {});
		expect(store.get(scope, old.id)?.recall_count).toBe(0);
		store.markRecalled(scope, [old.id, old.id, "missing"], now);
		expect(store.get(scope, old.id)).toMatchObject({
			recall_count: 1,
			last_recalled_at: now,
			revision: old.revision,
			updated_at: old.updated_at,
		});
	});

	it("updates only scoped recall statistics for eligible injected memories and rolls them back with the turn", async () => {
		const { store, path } = await setup();
		const active = store.insert(scope, memory("recall-active", "Orchids in the greenhouse"));
		const pinned = store.insert(scope, memory("recall-pinned", "Orchids by the window", { pinned: true }));
		const excluded = [
			store.insert(scope, memory("recall-expired", "Orchids expired", { expires_at: now })),
			store.insert(scope, memory("recall-pending", "Orchids pending", { status: "pending" })),
			store.insert(scope, memory("recall-archived", "Orchids archived", { status: "archived" })),
			store.insert(scope, memory("recall-superseded", "Orchids superseded", { status: "superseded" })),
		];
		const foreign = store.insert(otherUser, memory(active.id, "Orchids in another user's garden"));
		const ids = [active.id, active.id, pinned.id, ...excluded.map((record) => record.id), "missing"];
		const recalledAt = now + 1000;
		expect(() =>
			store.transaction(() => {
				store.markRecalled(scope, ids, recalledAt);
				throw new Error("abort injection");
			}),
		).toThrow();
		expect(store.get(scope, active.id)).toEqual(active);
		expect(store.get(scope, pinned.id)).toEqual(pinned);
		store.markRecalled(scope, ids, recalledAt);
		for (const record of [active, pinned])
			expect(store.get(scope, record.id)).toEqual({ ...record, recall_count: 1, last_recalled_at: recalledAt });
		for (const record of excluded) expect(store.get(scope, record.id)).toEqual(record);
		expect(store.get(otherUser, foreign.id)).toEqual(foreign);
		store.close();
		const reopened = await CompanionStore.open(path);
		cleanups.push(() => reopened.close());
		expect(reopened.search(scope, "Orchids", 6, recalledAt).map((result) => result.item.id)).toEqual([active.id]);
		expect(reopened.pinned(scope, recalledAt)).toEqual([
			{ ...pinned, recall_count: 1, last_recalled_at: recalledAt },
		]);
	});

	it("suppresses near-identical recall candidates and preserves diversity across relevant records", async () => {
		const { store } = await setup();
		store.create(
			scope,
			{ kind: "fact", domain: "user", content: "orchids alpine greenhouse garden spring watering rare collection" },
			now,
		);
		store.create(
			scope,
			{
				kind: "reflection",
				domain: "user",
				content: "orchids alpine greenhouse garden spring watering rare collection!",
			},
			now,
		);
		const different = store.create(
			scope,
			{ kind: "event", domain: "user", content: "orchids exhibition hosted downtown during winter" },
			now,
		);
		const results = store.search(scope, "orchids", 6, now);
		expect(results).toHaveLength(2);
		expect(results.map((result) => result.item.id)).toContain(different.id);
	});

	it("paginates filtered scope-local management records with safe parameter-bound query strings", async () => {
		const { store } = await setup();
		for (let index = 0; index < 5; index++)
			store.create(scope, { kind: "fact", domain: "user", content: `orchid item ${index}` }, now + index);
		store.create(scope, { kind: "event", domain: "user", content: "orchid exhibition" }, now);
		store.create(otherUser, { kind: "fact", domain: "user", content: "orchid private item" }, now);
		const first = store.list(scope, { kind: "fact", query: "orchid", limit: 2 });
		expect(first.total).toBe(5);
		expect(first.next_cursor).toBe(2);
		const second = store.list(scope, { kind: "fact", query: "orchid", limit: 2, cursor: first.next_cursor! });
		const third = store.list(scope, { kind: "fact", query: "orchid", limit: 2, cursor: second.next_cursor! });
		expect(new Set([...first.items, ...second.items, ...third.items].map((record) => record.id)).size).toBe(5);
		expect(third.next_cursor).toBeNull();
		expect(store.list(scope, { query: "' OR 1=1 --" }).total).toBe(0);
		for (const options of [{ limit: 0 }, { limit: 101 }, { cursor: -1 }, { cursor: 1.5 }])
			expect(() => store.list(scope, options)).toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
	});

	it("rolls back all turn effects including FTS, state, ledger and processed marker, with nested transaction reuse", async () => {
		const { store } = await setup();
		expect(() =>
			store.transaction(() => {
				store.insert(scope, memory("aborted", "Orchids in the aborted transaction"));
				store.setState(scope, state());
				store.setDailyAffinity(scope, "2027-01-15", 2);
				store.appendRelationshipEvent(scope, {
					id: "aborted",
					run_id: "aborted",
					delta: 2,
					reason: "greeting",
					evidence_quote: "hi",
					timestamp: now,
				});
				store.markProcessed(scope, "aborted");
				throw new Error("abort turn");
			}),
		).toThrow();
		expect(store.list(scope, { status: "all" }).total).toBe(0);
		expect(store.search(scope, "orchids", 6, now)).toEqual([]);
		expect(store.getState(scope)).toBeUndefined();
		expect(store.getDailyAffinity(scope, "2027-01-15")).toBe(0);
		expect(store.ledger(scope)).toEqual([]);
		expect(store.hasProcessed(scope, "aborted")).toBe(false);
		store.transaction(() => {
			store.insert(scope, memory("kept", "Orchids in the successful transaction"));
			store.setDailyAffinity(scope, "2027-01-15", 4);
			try {
				store.transaction(() => {
					store.insert(scope, memory("nested-abort", "Cacti in an aborted savepoint"));
					store.setDailyAffinity(scope, "2027-01-15", 8);
					throw new Error("nested abort");
				});
			} catch {
				/* The outer transaction can safely continue after a rolled-back savepoint. */
			}
			store.markProcessed(scope, "kept");
		});
		expect(store.get(scope, "nested-abort")).toBeUndefined();
		expect(store.getDailyAffinity(scope, "2027-01-15")).toBe(4);
		expect(store.get(scope, "kept")).toBeDefined();
		expect(store.hasProcessed(scope, "kept")).toBe(true);
	});

	it("persists records, state CAS, ledger, recall reinforcement and processed-run idempotence across reopen", async () => {
		const { store, path } = await setup();
		const record = store.insert(scope, memory("lasting", "Orchids persist across sessions"));
		store.setState(scope, state());
		expect(() => store.setState(scope, state({ affinity: 30 }))).toThrowError(
			expect.objectContaining({ code: "MEMORY_REVISION_MISMATCH" }),
		);
		store.setState(scope, state({ revision: 2, affinity: 15 }));
		store.appendRelationshipEvent(scope, {
			id: "lasting",
			run_id: "lasting-run",
			delta: 3,
			reason: "kindness",
			evidence_quote: "thank you",
			timestamp: now,
		});
		store.markRecalled(scope, [record.id], now);
		store.markProcessed(scope, "lasting-run");
		store.markProcessed(scope, "lasting-run");
		const forgottenSource = source("forgotten-run", "Studies astrophysics");
		const episode = store.insert(
			scope,
			memory("forgotten-episode", "User studies astrophysics", { kind: "episode", sources: [forgottenSource] }),
		);
		const forgotten = store.insert(
			scope,
			memory("forgotten-fact", "Studies astrophysics", { status: "pending", sources: [forgottenSource] }),
		);
		store.mutate(scope, forgotten.id, { operation: "forget", expected_revision: forgotten.revision }, now);
		store.markProcessed(scope, "forgotten-run");
		store.close();
		store.close();
		const reopened = await CompanionStore.open(path);
		cleanups.push(() => reopened.close());
		expect(reopened.getState(scope)).toEqual(state({ revision: 2, affinity: 15 }));
		expect(reopened.get(scope, record.id)).toMatchObject({ ...record, recall_count: 1, last_recalled_at: now });
		expect(reopened.search(scope, "orchids", 6, now).map((result) => result.item.id)).toEqual([record.id]);
		expect(reopened.hasProcessed(scope, "lasting-run")).toBe(true);
		expect(reopened.get(scope, forgotten.id)).toMatchObject({ status: "forgotten", content: "", sources: [] });
		expect(reopened.get(scope, episode.id)).toMatchObject({ status: "forgotten", content: "", sources: [] });
		expect(reopened.hasProcessed(scope, "forgotten-run")).toBe(true);
		expect(
			reopened.insert(
				scope,
				memory("replayed-source", "Studies astrophysics in a new excerpt", {
					kind: "episode",
					sources: [forgottenSource],
				}),
			).status,
		).toBe("forgotten");
		expect(reopened.search(scope, "astrophysics", 6, now)).toEqual([]);
		let applied = false;
		reopened.transaction(() => {
			if (reopened.hasProcessed(scope, "lasting-run")) return;
			applied = true;
			reopened.setState(scope, state({ revision: 3, affinity: 18 }));
			reopened.markProcessed(scope, "lasting-run");
		});
		expect(applied).toBe(false);
		expect(reopened.getState(scope)?.affinity).toBe(15);
		expect(reopened.ledger(scope)).toHaveLength(1);
	});

	it("persists monotonic per-day affinity budgets independently for both scope fields", async () => {
		const { store, path } = await setup();
		const first = "2027-01-15";
		const second = "2027-01-16";
		expect(store.getDailyAffinity(scope, first)).toBe(0);
		store.setDailyAffinity(scope, first, 3);
		store.setDailyAffinity(scope, first, 12);
		store.setDailyAffinity(scope, first, 12);
		store.setDailyAffinity(scope, second, 4);
		for (const foreign of [otherUser, otherPersona]) {
			expect(store.getDailyAffinity(foreign, first)).toBe(0);
			store.setDailyAffinity(foreign, first, 2);
		}
		for (const amount of [-1, 0, 11, 13, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
			expect(() => store.setDailyAffinity(scope, first, amount)).toThrowError(
				expect.objectContaining({ code: "INVALID_PAYLOAD" }),
			);
		expect(() => store.setDailyAffinity(scope, "not-a-day", 1)).toThrowError(
			expect.objectContaining({ code: "INVALID_PAYLOAD" }),
		);
		expect(() => store.getDailyAffinity(scope, "not-a-day")).toThrowError(
			expect.objectContaining({ code: "INVALID_PAYLOAD" }),
		);
		store.close();
		const reopened = await CompanionStore.open(path);
		cleanups.push(() => reopened.close());
		expect(reopened.getDailyAffinity(scope, first)).toBe(12);
		expect(reopened.getDailyAffinity(scope, second)).toBe(4);
		for (const foreign of [otherUser, otherPersona]) {
			expect(reopened.getDailyAffinity(foreign, first)).toBe(2);
			expect(reopened.getDailyAffinity(foreign, second)).toBe(0);
		}
	});

	it("bounds the independent relationship ledger and deduplicates event IDs", async () => {
		const { store } = await setup();
		store.setDailyAffinity(scope, "2027-01-15", 12);
		store.transaction(() => {
			for (let index = 0; index < 505; index++)
				store.appendRelationshipEvent(scope, {
					id: `event-${index}`,
					run_id: `run-${index}`,
					delta: 1,
					reason: "friendly",
					evidence_quote: "thanks",
					timestamp: now + index,
				});
		});
		expect(store.ledger(scope, 500)).toHaveLength(500);
		expect(store.ledger(scope, 1)[0].id).toBe("event-504");
		const event = store.ledger(scope, 1)[0];
		store.appendRelationshipEvent(scope, event);
		expect(store.ledger(scope, 500)).toHaveLength(500);
		expect(store.ledger(scope, 500).some((entry) => entry.id === "event-0")).toBe(false);
		expect(store.getDailyAffinity(scope, "2027-01-15")).toBe(12);
	});

	it("rejects unknown, empty, corrupt, version-mismatched and malformed databases without replacing them with empty storage", async () => {
		const { root, store, path } = await setup();
		store.create(scope, { kind: "fact", domain: "user", content: "A lasting record" }, now);
		store.close();
		const unknown = join(root, "unknown.sqlite");
		const foreign = new DatabaseSync(unknown);
		foreign.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('preserve me')");
		foreign.close();
		const empty = join(root, "empty.sqlite");
		const corrupt = join(root, "corrupt.sqlite");
		await writeFile(empty, "");
		await writeFile(corrupt, "not a SQLite database");
		for (const invalid of [unknown, empty, corrupt]) {
			const before = await readFile(invalid);
			await expect(CompanionStore.open(invalid)).rejects.toMatchObject({ code: "COMPANION_STORE_INVALID" });
			expect(await readFile(invalid)).toEqual(before);
		}
		const altered = new DatabaseSync(path);
		altered.exec("PRAGMA user_version = 999");
		altered.close();
		await expect(CompanionStore.open(path)).rejects.toMatchObject({ code: "COMPANION_STORE_INVALID" });
		const repairedVersion = new DatabaseSync(path);
		repairedVersion.exec("PRAGMA user_version = 1; UPDATE memories SET data='{}'");
		repairedVersion.close();
		await expect(CompanionStore.open(path)).rejects.toMatchObject({ code: "COMPANION_STORE_INVALID" });
		const missingIndexPath = join(root, "missing-index.sqlite");
		const indexed = await CompanionStore.open(missingIndexPath);
		indexed.create(scope, { kind: "fact", domain: "user", content: "Orchids should remain searchable" }, now);
		indexed.close();
		const missingIndex = new DatabaseSync(missingIndexPath);
		missingIndex.exec("DELETE FROM memory_fts");
		missingIndex.close();
		await expect(CompanionStore.open(missingIndexPath)).rejects.toMatchObject({ code: "COMPANION_STORE_INVALID" });
	});

	it("rejects missing or invalid persisted daily affinity budgets without rebuilding storage", async () => {
		for (const sql of [
			"DROP TABLE affinity_days",
			"INSERT INTO affinity_days VALUES('guide','alice','2027-01-15',13)",
			"INSERT INTO affinity_days VALUES('guide','alice','2027-01-15',1.5)",
			"INSERT INTO affinity_days VALUES('guide','alice','not-a-day',1)",
			"INSERT INTO affinity_days VALUES('','alice','2027-01-15',1)",
		]) {
			const { store, path } = await setup();
			store.close();
			const altered = new DatabaseSync(path);
			altered.exec(sql);
			altered.close();
			await expect(CompanionStore.open(path)).rejects.toMatchObject({ code: "COMPANION_STORE_INVALID" });
		}
	});

	it("rejects blank manual content, malformed internal entries and credentials in persistent user state", async () => {
		const { store } = await setup();
		expect(() => store.create(scope, { kind: "fact", domain: "user", content: "  " }, now)).toThrowError(
			expect.objectContaining({ code: "INVALID_PAYLOAD" }),
		);
		expect(() => store.insert(scope, memory("bad", "invalid score", { importance: 2 }))).toThrowError(
			expect.objectContaining({ code: "INVALID_PAYLOAD" }),
		);
		expect(() => store.setState(scope, state({ relationship_background: "password=secret998877" }))).toThrowError(
			expect.objectContaining({ code: "SENSITIVE_MEMORY_CONTENT" }),
		);
		expect(store.getState(scope)).toBeUndefined();
	});
});
