import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ApiStore, Stored } from "./api-store.ts";
import { ExecutorError } from "./errors.ts";

export type Permission = "read" | "chat" | "execute" | "approve" | "manage";
export interface Principal {
	id: string;
	permissions: Permission[];
	session_ids: string[] | null;
	companion_scopes: string[] | null;
}
export interface TokenMetadata {
	name: string;
	permissions: Permission[];
	session_ids: string[] | null;
	companion_scopes: string[] | null;
	expires_at: string;
	revoked_at: string | null;
}
interface TokenSecret extends TokenMetadata {
	token_hash: string;
}
export interface TokenIssuance {
	token: string;
	record: Stored<TokenMetadata>;
}

const permissions: Permission[] = ["read", "chat", "execute", "approve", "manage"];
const Identifier = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,299}$" });
const Scopes = Type.Union([Type.Array(Identifier, { maxItems: 1000, uniqueItems: true }), Type.Null()]);
const CompanionScopes = Type.Union([
	Type.Array(Type.String({ pattern: "^[A-Za-z0-9_-]{1,100}:[A-Za-z0-9_-]{1,100}$" }), {
		maxItems: 1000,
		uniqueItems: true,
	}),
	Type.Null(),
]);
const PermissionList = Type.Array(Type.Enum(permissions), { minItems: 1, maxItems: 5, uniqueItems: true });
const CreateSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 100 }),
		permissions: PermissionList,
		session_ids: Type.Optional(Scopes),
		companion_scopes: Type.Optional(CompanionScopes),
		expires_at: Type.String(),
	},
	{ additionalProperties: false },
);
const SecretSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 100 }),
		permissions: PermissionList,
		session_ids: Scopes,
		companion_scopes: CompanionScopes,
		expires_at: Type.String(),
		revoked_at: Type.Union([Type.String(), Type.Null()]),
		token_hash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
	},
	{ additionalProperties: false },
);
const TOKEN_KIND = "auth_tokens";
const MAX_TIMER = 2_147_483_647;

function utcTime(value: string): number {
	if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(value)) return Number.NaN;
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 19) !== value.slice(0, 19))
		return Number.NaN;
	return timestamp;
}

/** The bootstrap secret exists only in memory. Managed token secrets are disclosed once and hashed at rest. */
export class ApiAuth {
	private readonly store: ApiStore;
	private readonly rootHash: Buffer;
	private readonly revocations = new Set<(id: string) => void>();
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private readonly notified = new Set<string>();
	private readonly unsubscribe: () => void;
	private closed = false;

	constructor(store: ApiStore, rootToken: string) {
		if (
			typeof rootToken !== "string" ||
			rootToken.length < 1 ||
			rootToken.length > 4096 ||
			/[\s\u0000-\u001f\u007f]/u.test(rootToken)
		)
			throw new ExecutorError("INVALID_AUTH_CONFIG", "A valid bootstrap token is required");
		this.store = store;
		this.rootHash = createHash("sha256").update(rootToken).digest();
		const records = store.all<unknown>(TOKEN_KIND).map((record) => this.secretRecord(record));
		this.unsubscribe = store.subscribe((event) => {
			if (event.type === "auth.token.revoked" && typeof event.data.token_id === "string")
				this.notify(event.data.token_id);
			if (event.type === "auth.token.created" && typeof event.data.token_id === "string") {
				const record = this.store.get<unknown>(TOKEN_KIND, event.data.token_id);
				if (record) this.scheduleExpiry(this.secretRecord(record));
			}
		});
		for (const record of records) if (record.data.revoked_at === null) this.scheduleExpiry(record);
	}

	authenticate(token: string): Principal {
		if (this.closed || typeof token !== "string" || token.length < 1 || token.length > 4096)
			throw new ExecutorError("UNAUTHORIZED", "A valid bearer token is required");
		const hash = createHash("sha256").update(token).digest();
		if (timingSafeEqual(hash, this.rootHash))
			return { id: "root", permissions: [...permissions], session_ids: null, companion_scopes: null };
		if (!/^dw_[A-Za-z0-9_-]{43}$/u.test(token))
			throw new ExecutorError("UNAUTHORIZED", "A valid bearer token is required");
		for (const candidate of this.store.all<unknown>(TOKEN_KIND)) {
			const record = this.secretRecord(candidate);
			if (!timingSafeEqual(Buffer.from(record.data.token_hash, "hex"), hash)) continue;
			this.ensureActive(record);
			return {
				id: record.id,
				permissions: [...record.data.permissions],
				session_ids: record.data.session_ids === null ? null : [...record.data.session_ids],
				companion_scopes: record.data.companion_scopes === null ? null : [...record.data.companion_scopes],
			};
		}
		throw new ExecutorError("UNAUTHORIZED", "A valid bearer token is required");
	}

	authorize(
		principal: Principal,
		permission: Permission,
		resource?: { session_id?: string; companion_scope?: string },
	): void {
		if (this.closed) throw new ExecutorError("UNAUTHORIZED", "Authorization is no longer active");
		if (!permissions.includes(permission))
			throw new ExecutorError("FORBIDDEN", "The requested permission is not granted");
		let current = principal;
		if (principal.id !== "root") {
			const stored = this.store.get<unknown>(TOKEN_KIND, principal.id);
			if (!stored) throw new ExecutorError("UNAUTHORIZED", "The token is no longer active");
			const record = this.secretRecord(stored);
			this.ensureActive(record);
			current = {
				id: record.id,
				permissions: record.data.permissions,
				session_ids: record.data.session_ids,
				companion_scopes: record.data.companion_scopes,
			};
		}
		if (
			!current.permissions.includes(permission) ||
			(resource?.session_id !== undefined &&
				current.session_ids !== null &&
				!current.session_ids.includes(resource.session_id)) ||
			(resource?.companion_scope !== undefined &&
				current.companion_scopes !== null &&
				!current.companion_scopes.includes(resource.companion_scope))
		)
			throw new ExecutorError("FORBIDDEN", "The requested permission or resource scope is not granted");
	}

	list(): Stored<TokenMetadata>[] {
		return this.store.all<unknown>(TOKEN_KIND).map((record) => this.publicRecord(this.secretRecord(record)));
	}

	create(value: unknown): TokenIssuance {
		if (this.closed) throw new ExecutorError("UNAUTHORIZED", "Authorization is no longer active");
		if (
			!Check(CreateSchema, value) ||
			value.name.trim().length === 0 ||
			!Number.isFinite(utcTime(value.expires_at)) ||
			utcTime(value.expires_at) <= Date.now()
		)
			throw new ExecutorError(
				"INVALID_PAYLOAD",
				"Token creation requires a name, unique permissions, valid scopes and a future UTC expires_at",
			);
		const token = `dw_${randomBytes(32).toString("base64url")}`;
		const secret: TokenSecret = {
			name: value.name.trim(),
			permissions: [...value.permissions],
			session_ids: value.session_ids ?? null,
			companion_scopes: value.companion_scopes ?? null,
			expires_at: new Date(utcTime(value.expires_at)).toISOString(),
			revoked_at: null,
			token_hash: createHash("sha256").update(token).digest("hex"),
		};
		const record = this.store.transaction(() => {
			const saved = this.store.put(TOKEN_KIND, randomUUID(), secret, null);
			this.store.append("system", "auth.token.created", { token_id: saved.id });
			return saved;
		});
		return { token, record: this.publicRecord(record) };
	}

	/** Idempotency stores only public metadata; replay cannot redisclose or regenerate the credential. */
	async createOnce(principalId: string, key: string, fingerprint: string, value: unknown): Promise<TokenIssuance> {
		if (principalId !== "root")
			throw new ExecutorError("FORBIDDEN", "Only the bootstrap administrator can administer tokens");
		let issued: TokenIssuance | undefined;
		const saved = await this.store.once(principalId, key, fingerprint, async () => {
			issued = this.create(value);
			return { record: issued.record };
		});
		if (!issued)
			throw new ExecutorError(
				"TOKEN_ALREADY_ISSUED",
				"This token was already issued and its secret cannot be shown again",
				false,
				{ token_id: saved.record.id },
			);
		return issued;
	}

	revoke(id: string, expectedRevision: number): void {
		if (this.closed) throw new ExecutorError("UNAUTHORIZED", "Authorization is no longer active");
		this.store.transaction(() => {
			const record = this.secretRecord(this.store.require<unknown>(TOKEN_KIND, id));
			if (record.revision !== expectedRevision)
				throw new ExecutorError("REVISION_CONFLICT", "The token changed; refresh before revoking");
			if (record.data.revoked_at !== null) return;
			this.store.put(TOKEN_KIND, id, { ...record.data, revoked_at: new Date().toISOString() }, expectedRevision);
			this.store.append("system", "auth.token.revoked", { token_id: id });
		});
	}

	subscribeRevocation(listener: (id: string) => void): () => void {
		if (this.closed) throw new ExecutorError("UNAUTHORIZED", "Authorization is no longer active");
		this.revocations.add(listener);
		return () => {
			this.revocations.delete(listener);
		};
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe();
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.revocations.clear();
		this.rootHash.fill(0);
	}

	private secretRecord(record: Stored<unknown>): Stored<TokenSecret> {
		if (
			!Check(SecretSchema, record.data) ||
			!Number.isFinite(utcTime(record.data.expires_at)) ||
			(record.data.revoked_at !== null && !Number.isFinite(utcTime(record.data.revoked_at)))
		)
			throw new ExecutorError("API_STORE_INVALID", "Stored token metadata is invalid");
		return record as Stored<TokenSecret>;
	}
	private publicRecord(record: Stored<TokenSecret>): Stored<TokenMetadata> {
		const { token_hash: _hash, ...metadata } = record.data;
		return {
			id: record.id,
			revision: record.revision,
			created_at: record.created_at,
			updated_at: record.updated_at,
			data: metadata,
		};
	}
	private ensureActive(record: Stored<TokenSecret>): void {
		if (record.data.revoked_at !== null || utcTime(record.data.expires_at) <= Date.now()) {
			this.notify(record.id);
			throw new ExecutorError("UNAUTHORIZED", "The token is expired or revoked");
		}
	}
	private scheduleExpiry(record: Stored<TokenSecret>): void {
		const previous = this.timers.get(record.id);
		clearTimeout(previous);
		const remaining = utcTime(record.data.expires_at) - Date.now();
		if (remaining <= 0) {
			this.notify(record.id);
			return;
		}
		const timer = setTimeout(
			() => {
				this.timers.delete(record.id);
				if (this.closed) return;
				if (utcTime(record.data.expires_at) <= Date.now()) this.notify(record.id);
				else this.scheduleExpiry(record);
			},
			Math.min(remaining, MAX_TIMER),
		);
		timer.unref();
		this.timers.set(record.id, timer);
	}
	private notify(id: string): void {
		const timer = this.timers.get(id);
		clearTimeout(timer);
		this.timers.delete(id);
		if (this.notified.has(id)) return;
		this.notified.add(id);
		for (const listener of [...this.revocations]) {
			try {
				listener(id);
			} catch {
				/* Revocation must remain effective when a connection listener fails. */
			}
		}
	}
}
