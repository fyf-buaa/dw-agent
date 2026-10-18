import { createHash } from "node:crypto";
import { Check } from "typebox/value";
import type { ApiAuth, Permission, Principal } from "./api-auth.ts";
import type { ApiListOptions, Stored } from "./api-store.ts";
import { MemoryKindSchema, type MemoryScope, MemoryStatusSchema } from "./companion-types.ts";
import { ExecutorError } from "./errors.ts";
import { ModelTestSchema } from "./model-test.ts";
import { SOCKET_PATH } from "./protocol.ts";
import type { ExecutorService } from "./service.ts";

export interface HttpContext {
	principal: Principal;
	params: Record<string, string>;
	query: URLSearchParams;
	body: unknown;
	idempotencyKey: string;
	fingerprint: string;
}
export interface HttpRoute {
	method: string;
	path: string;
	permission: Permission;
	status: number;
	oneTimeSecret?: boolean;
	handler: (context: HttpContext) => unknown | Promise<unknown>;
	replay?: (context: HttpContext, resourceId: string) => unknown | Promise<unknown>;
}

export function objectBody(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ExecutorError("INVALID_PAYLOAD", "A JSON object is required");
	return value as Record<string, unknown>;
}
export function integerQuery(query: URLSearchParams, name: string, fallback?: number): number {
	const values = query.getAll(name);
	if (!values.length && fallback !== undefined) return fallback;
	if (values.length !== 1 || !/^\d+$/.test(values[0]) || !Number.isSafeInteger(Number(values[0])))
		throw new ExecutorError("INVALID_PAYLOAD", `Invalid ${name}`);
	return Number(values[0]);
}
export function listQuery(query: URLSearchParams): ApiListOptions {
	const limit = integerQuery(query, "limit", 50);
	if (limit < 1 || limit > 200) throw new ExecutorError("INVALID_PAYLOAD", "limit must be between 1 and 200");
	return { limit, ...(query.has("cursor") ? { cursor: query.get("cursor")! } : {}) };
}
export function requestFingerprint(method: string, path: string, query: URLSearchParams, body: unknown): string {
	const canonical = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(canonical);
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([key, item]) => [key, canonical(item)]),
			);
		return value;
	};
	return createHash("sha256")
		.update(JSON.stringify([method, path, [...query].sort(([a], [b]) => a.localeCompare(b)), canonical(body)]))
		.digest("hex");
}

/** A companion scope is an authorization boundary, not an identity supplied by the model. */
export function authorizeSession(
	service: ExecutorService,
	auth: ApiAuth,
	principal: Principal,
	permission: Permission,
	id: string,
): void {
	auth.authorize(principal, permission, { session_id: id });
	let data: { persona_id: string; user_id: string };
	try {
		data = service.api.getSession(id).data;
	} catch (error) {
		const removed = service.api.store.get<{ persona_id: string; user_id: string }>("deleted_session", id);
		if (!removed) throw error;
		data = removed.data;
	}
	auth.authorize(principal, permission, { companion_scope: `${data.persona_id}:${data.user_id}` });
}
export function authorizeStream(service: ExecutorService, auth: ApiAuth, principal: Principal, streamId: string): void {
	if (streamId === "system") {
		auth.authorize(principal, "manage");
		return;
	}
	const session = /^session:([A-Za-z0-9][A-Za-z0-9_.-]{0,299})$/.exec(streamId);
	if (session) {
		authorizeSession(service, auth, principal, "read", session[1]);
		return;
	}
	const companion = /^companion:([A-Za-z0-9_-]{1,100}):([A-Za-z0-9_-]{1,100})$/.exec(streamId);
	if (companion) {
		auth.authorize(principal, "read", { companion_scope: `${companion[1]}:${companion[2]}` });
		return;
	}
	throw new ExecutorError("INVALID_PAYLOAD", "Invalid event stream");
}

export function createHttpRoutes(service: ExecutorService, auth: ApiAuth): HttpRoute[] {
	const api = service.api;
	const routes: HttpRoute[] = [];
	const add = (
		method: string,
		path: string,
		permission: Permission,
		handler: HttpRoute["handler"],
		status = 200,
		oneTimeSecret = false,
	) => {
		routes.push({ method, path, permission, handler, status, ...(oneTimeSecret ? { oneTimeSecret } : {}) });
	};
	const scope = (ctx: HttpContext, permission: Permission = "read"): MemoryScope => {
		const result = { persona_id: ctx.params.persona, user_id: ctx.params.user };
		auth.authorize(ctx.principal, permission, { companion_scope: `${result.persona_id}:${result.user_id}` });
		return result;
	};
	const session = (ctx: HttpContext, permission: Permission) =>
		authorizeSession(service, auth, ctx.principal, permission, ctx.params.id);
	const scoped = <T extends { session_id: string }>(ctx: HttpContext, record: Stored<T>, permission: Permission) => {
		authorizeSession(service, auth, ctx.principal, permission, record.data.session_id);
		return record;
	};
	const readable = <T>(principal: Principal, record: Stored<T>): boolean => {
		try {
			const value = objectBody(record.data);
			if (typeof value.session_id === "string") authorizeSession(service, auth, principal, "read", value.session_id);
			else if (typeof value.persona_id === "string" && typeof value.user_id === "string") {
				auth.authorize(principal, "read", {
					session_id: record.id,
					companion_scope: `${value.persona_id}:${value.user_id}`,
				});
			} else auth.authorize(principal, "manage");
			return true;
		} catch (error) {
			if (error instanceof ExecutorError && ["FORBIDDEN", "NOT_FOUND", "SESSION_NOT_FOUND"].includes(error.code))
				return false;
			throw error;
		}
	};
	const events = (ctx: HttpContext, streamId: string) => {
		authorizeStream(service, auth, ctx.principal, streamId);
		return api.store.events(streamId, integerQuery(ctx.query, "after_seq", 0), integerQuery(ctx.query, "limit", 100));
	};
	const jobScope = (ctx: HttpContext, permission: Permission) => {
		const job = api.jobs.get(ctx.params.id);
		const value = objectBody(job.data);
		const ownScope = value.scope && typeof value.scope === "object" ? objectBody(value.scope) : value;
		if (typeof ownScope.session_id === "string")
			authorizeSession(service, auth, ctx.principal, permission, ownScope.session_id);
		else if (typeof ownScope.companion_scope === "string")
			auth.authorize(ctx.principal, permission, { companion_scope: ownScope.companion_scope });
		else auth.authorize(ctx.principal, "manage");
		return job;
	};
	const tokenAdministrator = (ctx: HttpContext): void => {
		if (ctx.principal.id !== "root")
			throw new ExecutorError("FORBIDDEN", "Only the bootstrap principal can administer credentials");
	};

	add("GET", "/bootstrap", "read", (ctx) => ({
		api_version: "1",
		socket_path: SOCKET_PATH,
		principal: ctx.principal,
		defaults: {
			workspace_id: "default",
			execution_profile_id: "default",
			model_profile_id: "default",
			persona_id: "default",
			user_id: "local",
		},
	}));
	add("GET", "/capabilities", "read", () => api.capabilities());
	add("GET", "/sessions", "read", (ctx) => {
		const page = api.listSessions(listQuery(ctx.query));
		return { ...page, items: page.items.filter((item) => readable(ctx.principal, item)) };
	});
	add(
		"POST",
		"/sessions",
		"chat",
		(ctx) => {
			if (ctx.principal.session_ids !== null)
				throw new ExecutorError("FORBIDDEN", "This token cannot create additional sessions");
			const value = objectBody(ctx.body);
			auth.authorize(ctx.principal, "chat", {
				companion_scope: `${value.persona_id ?? "default"}:${value.user_id ?? "local"}`,
			});
			return api.createSession(value);
		},
		201,
	);
	add("GET", "/sessions/:id", "read", (ctx) => {
		session(ctx, "read");
		return api.getSession(ctx.params.id);
	});
	add("PATCH", "/sessions/:id", "chat", (ctx) => {
		session(ctx, "chat");
		return api.patchSession(ctx.params.id, ctx.body);
	});
	add("DELETE", "/sessions/:id", "chat", (ctx) => {
		session(ctx, "chat");
		return api.deleteSession(ctx.params.id, integerQuery(ctx.query, "expected_revision"));
	});
	add("GET", "/sessions/:id/messages", "read", (ctx) => {
		session(ctx, "read");
		return api.listMessages(ctx.params.id, listQuery(ctx.query));
	});
	add(
		"POST",
		"/sessions/:id/messages",
		"chat",
		(ctx) => {
			session(ctx, "chat");
			return api.submitMessage(ctx.params.id, ctx.body);
		},
		202,
	);
	add("GET", "/sessions/:id/events", "read", (ctx) => events(ctx, `session:${ctx.params.id}`));
	add("GET", "/events", "read", (ctx) => events(ctx, ctx.query.get("stream_id") ?? ""));
	add("GET", "/runs/:id", "read", (ctx) => scoped(ctx, api.getRun(ctx.params.id), "read"));
	add(
		"POST",
		"/runs/:id/cancel",
		"chat",
		(ctx) => {
			scoped(ctx, api.getRun(ctx.params.id), "chat");
			return api.cancelRun(ctx.params.id);
		},
		202,
	);
	add(
		"POST",
		"/sessions/:id/tasks",
		"execute",
		(ctx) => {
			session(ctx, "execute");
			return api.createTask(ctx.params.id, ctx.body);
		},
		202,
	);
	add("GET", "/tasks", "read", (ctx) => {
		const page = api.listTasks({
			...listQuery(ctx.query),
			...(ctx.query.has("session_id") ? { filter: { session_id: ctx.query.get("session_id")! } } : {}),
		});
		return { ...page, items: page.items.filter((item) => readable(ctx.principal, item)) };
	});
	add("GET", "/tasks/:id", "read", (ctx) => scoped(ctx, api.getTask(ctx.params.id), "read"));
	for (const action of ["pause", "resume", "cancel"] as const)
		add(
			"POST",
			`/tasks/:id/${action}`,
			"execute",
			(ctx) => {
				scoped(ctx, api.getTask(ctx.params.id), "execute");
				return action === "pause"
					? api.pauseTask(ctx.params.id)
					: action === "resume"
						? api.resumeTask(ctx.params.id)
						: api.cancelTask(ctx.params.id);
			},
			202,
		);
	add("GET", "/tasks/:id/tool-calls", "read", (ctx) => {
		scoped(ctx, api.getTask(ctx.params.id), "read");
		return api.toolCalls(ctx.params.id, listQuery(ctx.query));
	});
	add("PUT", "/sessions/:id/scene-context", "chat", (ctx) => {
		session(ctx, "chat");
		return api.putScene(ctx.params.id, ctx.body);
	});
	add(
		"POST",
		"/sessions/:id/presentation-events",
		"chat",
		(ctx) => {
			session(ctx, "chat");
			return api.presentation(ctx.params.id, ctx.body);
		},
		201,
	);
	add("GET", "/approvals", "approve", (ctx) => {
		const filter = Object.fromEntries(
			["session_id", "task_id", "status"].flatMap((key) => (ctx.query.has(key) ? [[key, ctx.query.get(key)!]] : [])),
		);
		const page = api.policy.listApprovals({ ...listQuery(ctx.query), ...filter });
		return {
			...page,
			items: page.items.filter((item) => {
				try {
					const task = api.getTask(item.data.task_id);
					scoped(ctx, task, "approve");
					return true;
				} catch (error) {
					if (error instanceof ExecutorError && ["FORBIDDEN", "NOT_FOUND"].includes(error.code)) return false;
					throw error;
				}
			}),
		};
	});
	add("GET", "/approvals/:id", "approve", (ctx) => {
		const item = api.policy.getApproval(ctx.params.id);
		scoped(ctx, api.getTask(item.data.task_id), "approve");
		return item;
	});
	add("POST", "/approvals/:id/decision", "approve", (ctx) => {
		const item = api.policy.getApproval(ctx.params.id);
		scoped(ctx, api.getTask(item.data.task_id), "approve");
		return api.policy.decideApproval(ctx.params.id, ctx.body);
	});
	add("GET", "/tools", "read", (ctx) =>
		api.policy.listTools({
			workspace_id: ctx.query.get("workspace_id") ?? "default",
			execution_profile_id: ctx.query.get("execution_profile_id") ?? "default",
		}),
	);

	add("GET", "/personas", "read", () => api.companion.getPersonas());
	add("POST", "/personas", "manage", (ctx) => api.companion.createPersona(ctx.body), 201);
	add("GET", "/personas/:id", "read", (ctx) => api.companion.getPersona(ctx.params.id));
	add("PATCH", "/personas/:id", "manage", (ctx) => api.companion.savePersona(ctx.params.id, ctx.body));
	const c = "/companions/:persona/:user";
	add("GET", c, "read", (ctx) => api.companion.getCompanion(scope(ctx)));
	add("PATCH", `${c}/state`, "manage", (ctx) => api.companion.updateCompanionState(scope(ctx, "manage"), ctx.body));
	add("GET", `${c}/memories`, "read", (ctx) => {
		const status = ctx.query.get("status") ?? "active";
		const kind = ctx.query.get("kind");
		const query = ctx.query.get("q") ?? "";
		const page = listQuery(ctx.query);
		if (
			(status !== "all" && !Check(MemoryStatusSchema, status)) ||
			(kind !== null && !Check(MemoryKindSchema, kind)) ||
			query.length > 2000 ||
			page.limit! > 100
		)
			throw new ExecutorError("INVALID_PAYLOAD", "Invalid memory query");
		return api.companion.getMemories(scope(ctx), { ...page, status, ...(kind ? { kind } : {}), query });
	});
	add("POST", `${c}/memories`, "manage", (ctx) => api.companion.createMemory(scope(ctx, "manage"), ctx.body), 201);
	add("GET", `${c}/memories/:id`, "read", (ctx) => api.companion.getMemory(scope(ctx), ctx.params.id));
	add("PATCH", `${c}/memories/:id`, "manage", (ctx) =>
		api.companion.updateMemory(scope(ctx, "manage"), ctx.params.id, ctx.body),
	);
	add("GET", `${c}/recall`, "read", (ctx) => api.companion.previewRecall(scope(ctx), ctx.query.get("q") ?? ""));
	add("GET", `${c}/life`, "read", (ctx) => api.companion.getLife(scope(ctx)));
	add("PATCH", `${c}/life/settings`, "manage", (ctx) =>
		api.companion.saveLifeSettings(scope(ctx, "manage"), ctx.body),
	);
	add("POST", `${c}/life/advance`, "manage", (ctx) => api.companion.advanceLife(scope(ctx, "manage"), ctx.body));
	add(
		"POST",
		`${c}/life/conditions`,
		"manage",
		(ctx) => api.companion.addLifeCondition(scope(ctx, "manage"), ctx.body),
		201,
	);
	add("PATCH", `${c}/life/conditions/:id`, "manage", (ctx) =>
		api.companion.removeLifeCondition(scope(ctx, "manage"), ctx.params.id, ctx.body),
	);
	add("GET", `${c}/life/plan`, "read", (ctx) => api.companion.getPlan(scope(ctx)));
	add("GET", `${c}/diaries`, "read", (ctx) => {
		const page = listQuery(ctx.query);
		if (page.limit! > 60) throw new ExecutorError("INVALID_PAYLOAD", "Diary limit cannot exceed 60");
		return api.companion.getDiaries(scope(ctx), page);
	});
	add("GET", `${c}/diaries/:date`, "read", (ctx) => api.companion.getDiary(scope(ctx), ctx.params.date));
	add("DELETE", `${c}/diaries/:date`, "manage", (ctx) =>
		api.companion.deleteDiary(scope(ctx, "manage"), ctx.params.date, {
			expected_revision: integerQuery(ctx.query, "expected_revision"),
			operation: "delete",
		}),
	);
	add("GET", `${c}/schedule`, "read", (ctx) => api.companion.getSchedule(scope(ctx)));
	add("PATCH", `${c}/schedule`, "manage", (ctx) => api.companion.saveSchedule(scope(ctx, "manage"), ctx.body));
	add("DELETE", `${c}/schedule`, "manage", async (ctx) => {
		await api.companion.removeSchedule(scope(ctx, "manage"), integerQuery(ctx.query, "expected_revision"));
		return { removed: true };
	});
	add("POST", `${c}/jobs`, "manage", (ctx) => api.companion.createJob(scope(ctx, "manage"), ctx.body), 202);
	add("GET", "/jobs", "read", (ctx) => {
		const filter = Object.fromEntries(
			["companion_scope", "session_id", "status", "kind"].flatMap((key) =>
				ctx.query.has(key) ? [[key, ctx.query.get(key)!]] : [],
			),
		);
		const page = api.jobs.list({ ...listQuery(ctx.query), filter });
		return {
			...page,
			items: page.items.filter((item) => {
				try {
					jobScope({ ...ctx, params: { id: item.id } }, "read");
					return true;
				} catch (error) {
					if (
						error instanceof ExecutorError &&
						["FORBIDDEN", "NOT_FOUND", "SESSION_NOT_FOUND"].includes(error.code)
					)
						return false;
					throw error;
				}
			}),
		};
	});
	add("GET", "/jobs/:id", "read", (ctx) => jobScope(ctx, "read"));
	add(
		"POST",
		"/jobs/:id/cancel",
		"manage",
		(ctx) => {
			jobScope(ctx, "manage");
			return api.jobs.cancel(ctx.params.id);
		},
		202,
	);

	add("GET", "/providers", "read", () => api.models.providers());
	add("PATCH", "/providers/:id", "manage", (ctx) => api.models.saveProvider(ctx.params.id, ctx.body));
	add("DELETE", "/providers/:id", "manage", (ctx) =>
		api.models.deleteProvider(ctx.params.id, integerQuery(ctx.query, "expected_revision")),
	);
	add("GET", "/models", "read", () => api.models.models());
	add("PATCH", "/providers/:provider/models/:id", "manage", (ctx) =>
		api.models.saveModel(ctx.params.provider, ctx.params.id, ctx.body),
	);
	add("DELETE", "/providers/:provider/models/:id", "manage", (ctx) =>
		api.models.deleteModel(ctx.params.provider, ctx.params.id, integerQuery(ctx.query, "expected_revision")),
	);
	add("GET", "/model-profiles", "read", (ctx) => api.models.profiles(listQuery(ctx.query)));
	add("POST", "/model-profiles", "manage", (ctx) => api.models.create(ctx.body), 201);
	add("GET", "/model-profiles/:id", "read", (ctx) => api.models.get(ctx.params.id));
	add("PATCH", "/model-profiles/:id", "manage", (ctx) => api.models.update(ctx.params.id, ctx.body));
	add("DELETE", "/model-profiles/:id", "manage", (ctx) =>
		api.models.remove(ctx.params.id, integerQuery(ctx.query, "expected_revision")),
	);
	add(
		"POST",
		"/model-tests",
		"manage",
		(ctx) => {
			if (!Check(ModelTestSchema, ctx.body))
				throw new ExecutorError("INVALID_PAYLOAD", "Invalid model test request");
			const { api_key: _credential, ...input } = ctx.body;
			return api.jobs.create("model_test", input, (signal) => api.models.test(ctx.body, signal));
		},
		202,
	);
	add("GET", "/workspaces", "read", (ctx) => api.policy.listWorkspaces(listQuery(ctx.query)));
	add("POST", "/workspaces", "manage", (ctx) => api.policy.createWorkspace(ctx.body), 201);
	add("GET", "/workspaces/:id", "read", (ctx) => api.policy.getWorkspace(ctx.params.id));
	add("PATCH", "/workspaces/:id", "manage", (ctx) => api.policy.updateWorkspace(ctx.params.id, ctx.body));
	add("DELETE", "/workspaces/:id", "manage", (ctx) =>
		api.policy.deleteWorkspace(ctx.params.id, integerQuery(ctx.query, "expected_revision")),
	);
	add("GET", "/execution-profiles", "read", (ctx) => api.policy.listProfiles(listQuery(ctx.query)));
	add("POST", "/execution-profiles", "manage", (ctx) => api.policy.createProfile(ctx.body), 201);
	add("GET", "/execution-profiles/:id", "read", (ctx) => api.policy.getProfile(ctx.params.id));
	add("PATCH", "/execution-profiles/:id", "manage", (ctx) => api.policy.updateProfile(ctx.params.id, ctx.body));
	add("DELETE", "/execution-profiles/:id", "manage", (ctx) =>
		api.policy.deleteProfile(ctx.params.id, integerQuery(ctx.query, "expected_revision")),
	);
	add("GET", "/tokens", "manage", (ctx) => {
		tokenAdministrator(ctx);
		return { items: auth.list(), next_cursor: null };
	});
	add(
		"POST",
		"/tokens",
		"manage",
		(ctx) => {
			tokenAdministrator(ctx);
			return auth.createOnce(ctx.principal.id, ctx.idempotencyKey, ctx.fingerprint, ctx.body);
		},
		201,
		true,
	);
	add("DELETE", "/tokens/:id", "manage", (ctx) => {
		tokenAdministrator(ctx);
		auth.revoke(ctx.params.id, integerQuery(ctx.query, "expected_revision"));
		return { id: ctx.params.id, revoked: true };
	});

	add("GET", "/mcp/servers", "manage", (ctx) => api.integrations.listMcp(listQuery(ctx.query)));
	add("GET", "/mcp/servers/:id", "manage", (ctx) => api.integrations.getMcp(ctx.params.id));
	add("PUT", "/mcp/servers/:id", "manage", (ctx) => api.integrations.saveMcp(ctx.params.id, ctx.body));
	add("DELETE", "/mcp/servers/:id", "manage", (ctx) =>
		api.integrations.deleteMcp(ctx.params.id, integerQuery(ctx.query, "expected_revision")),
	);
	add("POST", "/mcp/servers/:id/reconnect", "manage", (ctx) => api.integrations.reconnectMcp(ctx.params.id));
	add("POST", "/mcp/servers/:id/authorization", "manage", (ctx) =>
		api.integrations.beginMcpAuth(ctx.params.id, ctx.body),
	);
	add("GET", "/mcp/servers/:id/authorization", "manage", (ctx) => api.integrations.getMcpAuth(ctx.params.id));
	add("POST", "/mcp/servers/:id/authorization/complete", "manage", (ctx) =>
		api.integrations.completeMcpAuth(ctx.params.id, ctx.body),
	);
	add("DELETE", "/mcp/servers/:id/authorization", "manage", (ctx) => api.integrations.logoutMcp(ctx.params.id));
	for (const kind of ["extensions", "skills"] as const) {
		add("GET", `/${kind}`, "manage", () => api.integrations.listResources(kind));
		add("PATCH", `/${kind}/:id`, "manage", (ctx) => api.integrations.updateResource(kind, ctx.params.id, ctx.body));
	}
	add("POST", "/resources/reload", "manage", () => api.integrations.reload());
	// Cache identifiers rather than private bodies: forgetting/deleting canonical data also
	// removes it from an idempotent retry. Replays return the resource's current snapshot.
	const replays: Record<string, NonNullable<HttpRoute["replay"]>> = {
		"/sessions": (ctx, id) => {
			authorizeSession(service, auth, ctx.principal, "chat", id);
			return api.getSession(id);
		},
		"/sessions/:id/messages": (ctx, id) => scoped(ctx, api.getRun(id), "chat"),
		"/runs/:id/cancel": (ctx, id) => scoped(ctx, api.getRun(id), "chat"),
		"/sessions/:id/tasks": (ctx, id) => scoped(ctx, api.getTask(id), "execute"),
		"/tasks/:id/pause": (ctx, id) => scoped(ctx, api.getTask(id), "execute"),
		"/tasks/:id/resume": (ctx, id) => scoped(ctx, api.getTask(id), "execute"),
		"/tasks/:id/cancel": (ctx, id) => scoped(ctx, api.getTask(id), "execute"),
		"/sessions/:id/presentation-events": (ctx, id) => {
			session(ctx, "chat");
			return api.store.require("presentation", id);
		},
		"/approvals/:id/decision": (ctx, id) => {
			const item = api.policy.getApproval(id);
			scoped(ctx, api.getTask(item.data.task_id), "approve");
			return item;
		},
		"/personas": (_ctx, id) => api.companion.getPersona(id),
		[`${c}/memories`]: (ctx, id) => api.companion.getMemory(scope(ctx, "manage"), id),
		[`${c}/life/advance`]: (ctx) => api.companion.getLife(scope(ctx, "manage")),
		[`${c}/life/conditions`]: (ctx) => api.companion.getLife(scope(ctx, "manage")),
		[`${c}/jobs`]: (ctx, id) => jobScope({ ...ctx, params: { id } }, "manage"),
		"/jobs/:id/cancel": (ctx, id) => jobScope({ ...ctx, params: { id } }, "manage"),
		"/model-tests": (ctx, id) => jobScope({ ...ctx, params: { id } }, "manage"),
		"/model-profiles": (_ctx, id) => api.models.get(id),
		"/workspaces": (_ctx, id) => api.policy.getWorkspace(id),
		"/execution-profiles": (_ctx, id) => api.policy.getProfile(id),
		"/mcp/servers/:id/reconnect": (_ctx, id) => api.integrations.getMcp(id),
		"/mcp/servers/:id/authorization": (_ctx, id) => api.integrations.getMcpAuth(id),
		"/mcp/servers/:id/authorization/complete": (_ctx, id) => api.integrations.getMcpAuth(id),
	};
	for (const route of routes) if (route.method === "POST" && replays[route.path]) route.replay = replays[route.path];
	return routes;
}
