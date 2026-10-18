import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiAuth } from "../src/api-auth.ts";
import { ApiStore } from "../src/api-store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
const now = "2030-01-01T00:00:00.000Z";
const future = "2030-01-02T00:00:00.000Z";
const rootToken = "test-root-secret-not-for-storage";
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.useRealTimers();
});
async function setup() {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(now));
	const directory = await mkdtemp(join(tmpdir(), "dw-api-auth-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "api.sqlite");
	const store = new ApiStore(path);
	cleanups.push(() => store.close());
	const auth = new ApiAuth(store, rootToken);
	cleanups.push(() => auth.close());
	return { path, store, auth };
}

describe("API authentication and authorization", () => {
	it("bootstraps an unrestricted root without persisting its token or hash", async () => {
		const { auth, store, path } = await setup();
		const principal = auth.authenticate(rootToken);
		expect(principal).toEqual({
			id: "root",
			permissions: ["read", "chat", "execute", "approve", "manage"],
			session_ids: null,
			companion_scopes: null,
		});
		auth.authorize(principal, "manage", { session_id: "anything", companion_scope: "any:user" });
		expect(auth.list()).toEqual([]);
		expect(store.all("auth_tokens")).toEqual([]);
		expect(() => auth.authenticate("invalid")).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
		auth.close();
		store.close();
		expect((await readFile(path)).includes(Buffer.from(rootToken))).toBe(false);
	});

	it("discloses managed credentials once, hashes at rest and authenticates after restart", async () => {
		const { auth, store, path } = await setup();
		const issued = auth.create({ name: "Viewer", permissions: ["read"], expires_at: future });
		expect(issued.token).toMatch(/^dw_[A-Za-z0-9_-]{43}$/u);
		expect(issued.record.data).toEqual({
			name: "Viewer",
			permissions: ["read"],
			session_ids: null,
			companion_scopes: null,
			expires_at: future,
			revoked_at: null,
		});
		expect(JSON.stringify(auth.list())).not.toContain(issued.token);
		expect(JSON.stringify(auth.list())).not.toContain("token_hash");
		const internal = store.require<{ token_hash: string }>("auth_tokens", issued.record.id);
		expect(internal.data.token_hash).toMatch(/^[0-9a-f]{64}$/u);
		expect(JSON.stringify(internal)).not.toContain(issued.token);
		expect(auth.authenticate(issued.token)).toMatchObject({ id: issued.record.id, permissions: ["read"] });
		auth.close();
		store.close();
		expect((await readFile(path)).includes(Buffer.from(issued.token))).toBe(false);
		const reopened = new ApiStore(path);
		cleanups.push(() => reopened.close());
		const restored = new ApiAuth(reopened, rootToken);
		cleanups.push(() => restored.close());
		expect(restored.authenticate(issued.token).id).toBe(issued.record.id);
	});

	it("enforces permission, session and companion scopes independently with null and empty semantics", async () => {
		const { auth } = await setup();
		const issued = auth.create({
			name: "Scoped",
			permissions: ["read", "chat"],
			expires_at: future,
			session_ids: ["session-one"],
			companion_scopes: ["guide:alice"],
		});
		const principal = auth.authenticate(issued.token);
		auth.authorize(principal, "read", { session_id: "session-one", companion_scope: "guide:alice" });
		expect(() => auth.authorize(principal, "read", { session_id: "session-two" })).toThrowError(
			expect.objectContaining({ code: "FORBIDDEN" }),
		);
		expect(() => auth.authorize(principal, "read", { companion_scope: "guide:bob" })).toThrowError(
			expect.objectContaining({ code: "FORBIDDEN" }),
		);
		expect(() => auth.authorize(principal, "execute", { session_id: "session-one" })).toThrowError(
			expect.objectContaining({ code: "FORBIDDEN" }),
		);
		principal.permissions.push("manage");
		principal.session_ids?.push("session-two");
		expect(() => auth.authorize(principal, "manage")).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
		expect(() => auth.authorize(principal, "read", { session_id: "session-two" })).toThrowError(
			expect.objectContaining({ code: "FORBIDDEN" }),
		);
		const empty = auth.create({
			name: "None",
			permissions: ["read"],
			expires_at: future,
			session_ids: [],
			companion_scopes: [],
		});
		const none = auth.authenticate(empty.token);
		auth.authorize(none, "read");
		expect(() => auth.authorize(none, "read", { session_id: "session-one" })).toThrowError(
			expect.objectContaining({ code: "FORBIDDEN" }),
		);
		expect(() => auth.authorize(none, "read", { companion_scope: "guide:alice" })).toThrowError(
			expect.objectContaining({ code: "FORBIDDEN" }),
		);
	});

	it("revokes after commit, rejects stale principals, retains metadata and persists revocation", async () => {
		const { auth, store, path } = await setup();
		const issued = auth.create({ name: "Revoked", permissions: ["read"], expires_at: future });
		const principal = auth.authenticate(issued.token);
		const notices: string[] = [];
		auth.subscribeRevocation((id) => {
			notices.push(id);
			expect(auth.list().find((record) => record.id === id)?.data.revoked_at).toBe(now);
		});
		auth.subscribeRevocation(() => {
			throw new Error("broken socket");
		});
		expect(() => auth.revoke(issued.record.id, 2)).toThrowError(
			expect.objectContaining({ code: "REVISION_CONFLICT" }),
		);
		expect(notices).toEqual([]);
		auth.revoke(issued.record.id, 1);
		expect(notices).toEqual([issued.record.id]);
		expect(() => auth.authenticate(issued.token)).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
		expect(() => auth.authorize(principal, "read")).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
		expect(auth.list()[0]).toMatchObject({ revision: 2, data: { revoked_at: now } });
		auth.revoke(issued.record.id, 2);
		expect(notices).toEqual([issued.record.id]);
		auth.close();
		store.close();
		const reopened = new ApiStore(path);
		cleanups.push(() => reopened.close());
		const restored = new ApiAuth(reopened, rootToken);
		cleanups.push(() => restored.close());
		expect(() => restored.authenticate(issued.token)).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
	});

	it("discards revocation callbacks and metadata on outer rollback", async () => {
		const { auth, store } = await setup();
		const issued = auth.create({ name: "Rollback", permissions: ["read"], expires_at: future });
		const revoked = vi.fn();
		auth.subscribeRevocation(revoked);
		expect(() =>
			store.transaction(() => {
				auth.revoke(issued.record.id, 1);
				throw new Error("rollback");
			}),
		).toThrow("rollback");
		expect(revoked).not.toHaveBeenCalled();
		expect(auth.authenticate(issued.token).id).toBe(issued.record.id);
		expect(auth.list()[0].revision).toBe(1);
	});

	it("expires active subscriptions on time and rejects already-authenticated principals", async () => {
		const { auth } = await setup();
		const issued = auth.create({ name: "Short", permissions: ["read"], expires_at: "2030-01-01T00:00:01Z" });
		const principal = auth.authenticate(issued.token);
		const notices: string[] = [];
		const unsubscribe = auth.subscribeRevocation((id) => {
			notices.push(id);
		});
		vi.advanceTimersByTime(999);
		expect(notices).toEqual([]);
		auth.authorize(principal, "read");
		vi.advanceTimersByTime(1);
		expect(notices).toEqual([issued.record.id]);
		expect(() => auth.authenticate(issued.token)).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
		expect(() => auth.authorize(principal, "read")).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
		expect(notices).toEqual([issued.record.id]);
		unsubscribe();
	});

	it("idempotently issues without persisting plaintext and never rediscloses or regenerates on replay", async () => {
		const { auth, store, path } = await setup();
		const body = { name: "One time", permissions: ["read"], expires_at: future };
		const first = auth.createOnce("root", "token-request", "token-fingerprint", body);
		const second = auth.createOnce("root", "token-request", "token-fingerprint", body);
		const replay = expect(second).rejects.toMatchObject({ code: "TOKEN_ALREADY_ISSUED" });
		const issued = await first;
		await replay;
		await expect(auth.createOnce("root", "token-request", "token-fingerprint", body)).rejects.toMatchObject({
			code: "TOKEN_ALREADY_ISSUED",
			details: { token_id: issued.record.id },
		});
		await expect(auth.createOnce("root", "token-request", "different", body)).rejects.toMatchObject({
			code: "IDEMPOTENCY_CONFLICT",
		});
		expect(auth.list()).toHaveLength(1);
		expect(auth.authenticate(issued.token).id).toBe(issued.record.id);
		auth.close();
		store.close();
		const bytes = await readFile(path);
		expect(bytes.includes(Buffer.from(issued.token))).toBe(false);
		expect(bytes.includes(Buffer.from(rootToken))).toBe(false);
		const reopened = new ApiStore(path);
		cleanups.push(() => reopened.close());
		const restored = new ApiAuth(reopened, rootToken);
		cleanups.push(() => restored.close());
		await expect(restored.createOnce("root", "token-request", "token-fingerprint", body)).rejects.toMatchObject({
			code: "TOKEN_ALREADY_ISSUED",
			details: { token_id: issued.record.id },
		});
		expect(restored.list()).toHaveLength(1);
	});

	it("rejects managed-token issuance before idempotency lookup even when manage permission is granted", async () => {
		const { auth } = await setup();
		const manager = auth.create({
			name: "Scoped manager",
			permissions: ["read", "manage"],
			expires_at: future,
			session_ids: ["one"],
			companion_scopes: ["guide:alice"],
		});
		const principal = auth.authenticate(manager.token);
		auth.authorize(principal, "manage");
		const body = {
			name: "Root-issued",
			permissions: ["read", "chat", "execute", "approve", "manage"],
			expires_at: future,
		};
		const rootIssued = await auth.createOnce("root", "shared-key", "shared-fingerprint", body);
		await expect(auth.createOnce(principal.id, "shared-key", "shared-fingerprint", body)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(auth.createOnce(principal.id, "new-key", "new-fingerprint", body)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(auth.list()).toHaveLength(2);
		expect(auth.list().find((record) => record.id === rootIssued.record.id)).toEqual(rootIssued.record);
		expect(auth.authenticate(rootIssued.token)).toMatchObject({
			id: rootIssued.record.id,
			session_ids: null,
			companion_scopes: null,
		});
	});

	it("validates strict token schemas and refuses malformed stored secrets", async () => {
		const { auth, store } = await setup();
		const valid = { name: "Valid", permissions: ["read"], expires_at: future };
		for (const value of [
			null,
			{},
			{ ...valid, extra: true },
			{ ...valid, name: "   " },
			{ ...valid, permissions: [] },
			{ ...valid, permissions: ["read", "read"] },
			{ ...valid, permissions: ["superuser"] },
			{ ...valid, expires_at: now },
			{ ...valid, expires_at: "2030-02-30T00:00:00Z" },
			{ ...valid, expires_at: "2030-01-02" },
			{ ...valid, companion_scopes: ["guide:alice:extra"] },
			{ ...valid, session_ids: ["../outside"] },
		])
			expect(() => auth.create(value)).toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
		expect(auth.list()).toEqual([]);
		store.put("auth_tokens", "broken", { token_hash: "not a hash" }, null);
		expect(() => new ApiAuth(store, rootToken)).toThrowError(expect.objectContaining({ code: "API_STORE_INVALID" }));
	});
});
