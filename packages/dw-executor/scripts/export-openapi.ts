import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ModelThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import { type TSchema, Type } from "typebox";
import { HttpErrorSchema, PageSchema, ResourceIdSchema, RevisionSchema, RFC3339TimestampSchema, StoredSchema } from "../src/api-schemas.ts";
import { DiaryEntrySchema, LifeAdvanceSchema, LifeConditionCreateSchema, LifeConditionRemoveSchema, LifeConditionSchema, LifeConfigSchema, LifeDetailSchema, LifeEvolutionSchema, LifeJobSchema, LifePlanSchema, LifeSettingsUpdateSchema } from "../src/companion-life-types.ts";
import { CompanionStateUpdateSchema, ImportantDateSchema, MemoryCreateSchema, MemoryDomainSchema, MemoryDurabilitySchema, MemoryKindSchema, MemoryMutationSchema, MemoryStatusSchema, RoleplaySchema } from "../src/companion-types.ts";
import { ApiEventSchema, ErrorSchema, ExpressionSchema, SegmentSchema, StreamIdSchema } from "../src/protocol.ts";

const object = (properties: Record<string, TSchema>) => Type.Object(properties, { additionalProperties: false });
const ref = (name: string) => Type.Ref(`#/components/schemas/${name}`);
const optional = Type.Optional;
const nullable = (schema: TSchema) => Type.Union([schema, Type.Null()]);
const text = Type.String();
const identifier = ResourceIdSchema;
const scopeIdentifier = Type.String({ pattern: "^[A-Za-z0-9_-]{1,100}$" });
const configIdentifier = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" });
const timestamp = RFC3339TimestampSchema;
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const natural = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const epoch = Type.Integer({ minimum: 0 });
const record = Type.Record(Type.String(), Type.Unknown());
const strings = Type.Array(text);
const revision = RevisionSchema;
const permission = Type.Enum(["read", "chat", "execute", "approve", "manage"]);
const scope = object({ persona_id: scopeIdentifier, user_id: scopeIdentifier });
const activity = object({ label: text, location: text, virtual: Type.Literal(true), source: text });
const usage = object({ model_calls: optional(natural), input_tokens: natural, output_tokens: natural });
const rolePatch = object({ provider: optional(Type.String({ minLength: 1, maxLength: 200 })), model: optional(Type.String({ minLength: 1, maxLength: 500 })), thinking_level: optional(nullable(ModelThinkingLevelSchema)), max_output_tokens: optional(positive) });
const roleView = object({ provider: text, model: text, thinking_level: optional(text), max_output_tokens: positive,
	declared_max_tokens: nullable(positive), configured_max_tokens: positive, effective_max_tokens: nullable(positive), context_window: nullable(positive), available: Type.Boolean() });
const profileFields = { name: optional(Type.String({ minLength: 1, maxLength: 200 })), chat: optional(rolePatch), agent: optional(rolePatch), life: optional(rolePatch) };
const executionFields = {
	name: Type.String({ minLength: 1, maxLength: 4096 }), tools: Type.Array(Type.String({ pattern: "^[A-Za-z0-9_.:-]+$" })), approval: Type.Enum(["always", "writes", "never"]),
	max_model_calls: positive, max_concurrent_tasks: positive, timeout_ms: positive, approval_timeout_ms: positive,
	isolation: Type.Enum(["restricted", "trusted_host"]),
};
const executionPatchFields = Object.fromEntries(Object.entries(executionFields).map(([key, value]) => [key, optional(value)]));
const mcpExposure = Type.Enum(["codemode", "deferred", "direct", "hidden"]);
const stringMap = Type.Record(Type.String(), text);
const mcpBase = { exposure: optional(mcpExposure), description: optional(text), toolExposure: optional(Type.Record(Type.String(), mcpExposure)), enabled: optional(Type.Boolean()), timeout: optional(Type.Number({ exclusiveMinimum: 0 })) };
const mcpConfig = Type.Union([
	object({ ...mcpBase, type: optional(Type.Literal("stdio")), command: text, args: optional(Type.Array(text, { writeOnly: true })), env: optional(nullable(Type.Record(Type.String(), text, { writeOnly: true }))), cwd: optional(text) }),
	object({ ...mcpBase, type: optional(Type.Literal("http")), url: text, headers: optional(nullable(Type.Record(Type.String(), text, { writeOnly: true }))), auth: optional(object({ provider: text })), oauth: optional(object({
		clientId: optional(text), clientSecret: optional(Type.String({ writeOnly: true })), callbackPort: optional(Type.Integer({ minimum: 1, maximum: 65535 })),
		callbackUrl: optional(text), scope: optional(text), clientName: optional(text), clientRegistration: optional(Type.Enum(["dcr", "cimd"])), authServerMetadataUrl: optional(text),
	})) }),
]);
const mcpPublicConfig = Type.Union([
	object({ ...mcpBase, type: optional(Type.Literal("stdio")), command: text, cwd: optional(text) }),
	object({ ...mcpBase, type: optional(Type.Literal("http")), url: text, auth: optional(object({ provider: text })), oauth: optional(object({
		clientId: optional(text), callbackPort: optional(Type.Integer({ minimum: 1, maximum: 65535 })), callbackUrl: optional(text),
		scope: optional(text), clientName: optional(text), clientRegistration: optional(Type.Enum(["dcr", "cimd"])), authServerMetadataUrl: optional(text),
	})) }),
]);
const selection = { persona_id: optional(scopeIdentifier), user_id: optional(scopeIdentifier), title: optional(Type.String({ minLength: 1, maxLength: 200 })), workspace_id: optional(scopeIdentifier), execution_profile_id: optional(scopeIdentifier), model_profile_id: optional(scopeIdentifier) };
const memoryEvidence = object({ session_id: nullable(text), run_id: nullable(text), speaker: Type.Enum(["user", "assistant", "manual"]), quote: text, timestamp: epoch });
const state = object({ revision: natural, affinity: Type.Integer({ minimum: -100, maximum: 100 }), stage: Type.Enum(["avoidant", "wary", "neutral", "familiar", "friendly", "close", "trusted", "bonded"]),
	valence: Type.Number(), arousal: Type.Number(), user_name: text, address: text, relationship_background: text, important_dates: Type.Array(ImportantDateSchema),
	last_interaction_at: nullable(epoch), updated_at: epoch, affinity_day: text, affinity_daily_change: Type.Number() });
const lifeState = object({ date: text, initialized: Type.Boolean(), revision: natural, virtual: Type.Literal(true), inject: Type.Boolean(),
	sleep: text, dream: text, health: text, hunger: text, body_cycle: text, location: text, weather: text, mood_bias: text, energy: Type.Number(), note: text,
	activity, conditions: Type.Array(LifeConditionSchema), history: Type.Array(LifeEvolutionSchema), cycle: object({ strategy: Type.Enum(["legacy", "advanced"]), phase: text, day: nullable(natural), total_days: natural, next_expected_at: nullable(epoch) }) });
const lifeView = object({ scope, enabled: Type.Boolean(), local_time: text, settings: object({ revision: natural, config: LifeConfigSchema }), settings_schema: record,
	setting_groups: Type.Array(object({ id: text, title: text, fields: strings })), state: lifeState, plan: nullable(LifePlanSchema), details: Type.Array(LifeDetailSchema), jobs: Type.Array(LifeJobSchema),
	today_diary_revision: natural, today_diary_deleted: Type.Boolean(), today_diary_generated: Type.Boolean() });

export const HttpSchemas: Record<string, TSchema> = {
	Error: ErrorSchema, HttpError: HttpErrorSchema, Expression: ExpressionSchema, ReplySegment: SegmentSchema, ApiEvent: ApiEventSchema,
	Usage: usage,
	Principal: object({ id: identifier, permissions: Type.Array(permission), session_ids: nullable(Type.Array(identifier)), companion_scopes: nullable(strings) }),
	Bootstrap: object({ api_version: Type.Literal("1"), socket_path: Type.Literal("/dw-agent/v1"), principal: ref("Principal"), defaults: object({ workspace_id: identifier, execution_profile_id: identifier, model_profile_id: identifier, persona_id: identifier, user_id: identifier }) }),
	Capabilities: Type.Object({ api_version: Type.Literal("1"),
		protocol: object({ versions: Type.Array(positive), socket_path: text, commands: strings }),
		http: object({ prefix: text, idempotency: Type.Boolean() }),
		events: object({ durable: Type.Boolean(), replay: Type.Boolean(), delivery: text }),
		features: Type.Record(Type.String(), Type.Boolean()) }, { additionalProperties: true, description: "Configured runtime capabilities. Feature flags reflect actual support and availability; a workspace is not an OS sandbox." }),
	Health: object({ status: Type.Enum(["live", "ready"]), api_version: Type.Literal("1") }),
	SessionCreate: object(selection),
	SessionPatch: object({ expected_revision: positive, title: optional(Type.String({ minLength: 1, maxLength: 200 })), workspace_id: optional(identifier), execution_profile_id: optional(identifier), model_profile_id: optional(identifier) }),
	SessionData: object({ persona_id: identifier, user_id: identifier, persona_revision: text, title: text, workspace_id: identifier, execution_profile_id: identifier, model_profile_id: identifier, active_run_id: nullable(identifier) }),
	MessageCreate: object({ text: Type.String({ minLength: 1, maxLength: 65536 }) }),
	MessageData: object({ session_id: identifier, role: Type.Enum(["user", "assistant"]), text, speech: optional(text), expression: optional(ExpressionSchema), segments: optional(Type.Array(SegmentSchema)), run_id: optional(identifier), task_id: optional(identifier) }),
	RunData: Type.Object({ session_id: identifier, status: Type.Enum(["queued", "running", "completed", "failed", "cancelled"]), input: text, message_id: identifier,
		result: optional(record), usage: optional(usage), error: optional(ErrorSchema), cancel_requested: optional(Type.Boolean()) }, { additionalProperties: true }),
	TaskCreate: object({ input: Type.String({ minLength: 1, maxLength: 65536 }), workspace_id: optional(identifier), execution_profile_id: optional(identifier), model_profile_id: optional(identifier) }),
	TaskData: Type.Object({ session_id: identifier, status: Type.Enum(["queued", "running", "awaiting_approval", "paused", "completed", "failed", "cancelled"]), input: text,
		workspace_id: identifier, execution_profile_id: identifier, model_profile_id: identifier, result: optional(record), usage: optional(usage), error: optional(ErrorSchema), pause_requested: optional(Type.Boolean()), cancel_requested: optional(Type.Boolean()) }, { additionalProperties: true }),
	ToolCallData: Type.Object({ task_id: identifier, tool_call_id: text, tool_name: text, parent_tool_call_id: optional(text), status: optional(text) }, { additionalProperties: true, description: "Structured tool state; not a provider private-reasoning stream." }),
	EventPage: object({ items: Type.Array(ApiEventSchema), has_more: Type.Boolean(), latest_seq: natural }),
	MessageUpdatedData: object({ message_id: identifier, revision: positive, session_id: identifier, status: Type.Literal("streaming"), role: Type.Literal("assistant") }),
	RunEventData: object({ id: identifier, revision: positive, session_id: identifier, status: Type.Enum(["queued", "running", "completed", "failed", "cancelled"]), usage: optional(usage) }),
	TaskEventData: object({ id: identifier, revision: positive, session_id: identifier, status: Type.Enum(["queued", "running", "awaiting_approval", "paused", "completed", "failed", "cancelled"]), pause_requested: optional(Type.Boolean()), cancel_requested: optional(Type.Boolean()), usage: optional(usage) }),
	ApprovalEventData: object({ approval_id: identifier, task_id: identifier, session_id: optional(identifier), status: Type.Enum(["pending", "approved", "denied", "expired", "cancelled", "consumed"]), revision: positive }),
	SceneInput: object({ expected_revision: nullable(positive), version: Type.Literal(1), source_client_id: scopeIdentifier, captured_at: timestamp, expires_at: timestamp,
		allowed_object_ids: Type.Array(scopeIdentifier, { maxItems: 100 }), objects: Type.Array(object({ id: scopeIdentifier, label: optional(Type.String({ minLength: 1, maxLength: 200 })), description: optional(Type.String({ minLength: 1, maxLength: 2000 })), position: optional(object({ x: Type.Number(), y: Type.Number(), z: Type.Number() })) }), { maxItems: 100 }) }),
	SceneData: Type.Object({ session_id: identifier, version: Type.Literal(1), source_client_id: scopeIdentifier, captured_at: timestamp, expires_at: timestamp, allowed_object_ids: Type.Array(scopeIdentifier), objects: Type.Array(record) }, { additionalProperties: true }),
	PresentationInput: object({ segment_id: Type.String({ minLength: 1, maxLength: 300 }), status: Type.Enum(["started", "completed", "interrupted", "failed"]), occurred_at: timestamp, error_code: optional(scopeIdentifier) }),
	PresentationData: Type.Object({ session_id: identifier, segment_id: text, status: Type.Enum(["started", "completed", "interrupted", "failed"]), occurred_at: timestamp, error_code: optional(text) }, { additionalProperties: true }),
	WorkspaceCreate: object({ id: optional(configIdentifier), name: Type.String({ minLength: 1, maxLength: 4096 }), root: Type.String({ minLength: 1, maxLength: 4096 }) }),
	WorkspacePatch: object({ expected_revision: positive, name: optional(Type.String({ minLength: 1, maxLength: 4096 })), root: optional(Type.String({ minLength: 1, maxLength: 4096 })) }),
	WorkspaceData: object({ name: text, root: text, project_config_trusted: Type.Literal(false) }),
	ExecutionProfileCreate: object({ id: optional(configIdentifier), ...executionPatchFields }),
	ExecutionProfilePatch: object({ expected_revision: positive, ...executionPatchFields }),
	ExecutionProfileData: object(executionFields),
	ApprovalDecision: object({ decision: Type.Enum(["approve", "deny"]), expected_revision: positive }),
	ApprovalData: object({ session_id: optional(identifier), task_id: identifier, workspace_id: identifier, execution_profile_id: identifier, tool_call_id: text, parent_tool_call_id: optional(text), tool_name: text, arguments: record, arguments_sha256: text, scope_sha256: text,
		status: Type.Enum(["pending", "approved", "denied", "expired", "cancelled", "consumed"]), expires_at: timestamp, decided_at: optional(timestamp), consumed_at: optional(timestamp) }),
	Tools: object({ items: Type.Array(object({ name: text, description: text, parameters: Type.Unknown(), allowed: Type.Boolean(), requires_approval: Type.Boolean(), isolation: Type.Enum(["restricted", "trusted_host"]) })), next_cursor: Type.Null() }),
	ModelProfileCreate: object({ id: optional(scopeIdentifier), ...profileFields }),
	ModelProfilePatch: object({ expected_revision: revision, ...profileFields }),
	ModelProfileData: object({ name: text, chat: roleView, agent: roleView, life: roleView }),
	ProviderData: object({ name: text, custom: Type.Boolean(), base_url: nullable(text), api: nullable(text), api_key: Type.Boolean(), oauth: Type.Boolean(), auth: object({ configured: Type.Boolean(), source: nullable(text) }) }),
	ProviderPatch: object({ expected_revision: nullable(positive), name: optional(Type.String({ minLength: 1, maxLength: 200 })), base_url: optional(Type.String({ minLength: 1, maxLength: 2048 })), api: optional(text), api_key: optional(Type.String({ minLength: 1, maxLength: 8192, pattern: "^[^\\u0000-\\u0020\\u007f]+$", writeOnly: true })), headers: optional(stringMap), compat: optional(record), authHeader: optional(Type.Boolean()) }),
	ModelData: object({ provider: text, id: text, name: text, context_window: positive, max_tokens: positive, reasoning: Type.Boolean(), input: strings, thinking_levels: strings }),
	ModelPatch: object({ expected_revision: nullable(positive), name: optional(Type.String({ minLength: 1, maxLength: 500 })), context_window: optional(positive), max_tokens: optional(positive), reasoning: optional(Type.Boolean()), input: optional(Type.Array(Type.Enum(["text", "image"]), { minItems: 1, uniqueItems: true })),
		api: optional(text), base_url: optional(text), thinkingLevelMap: optional(record), inputLimits: optional(record), cost: optional(record), promptCache: optional(record), samplingParams: optional(record), samplingParamsByThinkingLevel: optional(record), headers: optional(stringMap), compat: optional(record) }),
	ModelTestInput: object({ provider: Type.String({ minLength: 1, maxLength: 200 }), model: Type.String({ minLength: 1, maxLength: 500 }), thinking_level: optional(ModelThinkingLevelSchema), api_key: optional(Type.String({ minLength: 1, maxLength: 8192, pattern: "^[^\\u0000-\\u0020\\u007f]+$", writeOnly: true })) }),
	ModelTestResult: object({ available: Type.Literal(true), provider: text, model: text, thinking_level: ModelThinkingLevelSchema, duration_ms: natural, usage }),
	PersonaCreate: object({ id: scopeIdentifier, system_prompt: Type.String({ minLength: 1, maxLength: 65536 }), roleplay: optional(RoleplaySchema) }),
	PersonaPatch: object({ expected_revision: revision, system_prompt: Type.String({ minLength: 1, maxLength: 65536 }), roleplay: optional(RoleplaySchema) }),
	PersonaData: object({ persona: object({ id: identifier, revision: text, system_prompt: Type.String({ minLength: 1, maxLength: 65536 }), roleplay: optional(RoleplaySchema) }), builtin: Type.Boolean(), editable: Type.Boolean(), roleplay_defaults: RoleplaySchema }),
	Roleplay: RoleplaySchema,
	CompanionStatePatch: CompanionStateUpdateSchema,
	CompanionData: Type.Object({ scope, enabled: Type.Boolean(), state, local_time: text, energy: Type.Number(), activity,
		important_dates: Type.Array(object({ date: text, label: text, days_until: Type.Integer(), subject: Type.Enum(["character", "user"]) })), goals: RoleplaySchema.properties.goals,
		ledger: Type.Array(object({ id: text, run_id: nullable(text), delta: Type.Number(), reason: text, evidence_quote: text, timestamp: epoch })), memory_counts: Type.Record(Type.String(), natural), life_state: optional(lifeState) }, { additionalProperties: true }),
	MemoryCreate: MemoryCreateSchema, MemoryPatch: MemoryMutationSchema,
	MemoryData: object({ id: text, persona_id: text, user_id: text, kind: MemoryKindSchema, domain: MemoryDomainSchema, content: text, key: nullable(text), status: MemoryStatusSchema,
		pinned: Type.Boolean(), confidence: Type.Number(), importance: Type.Number(), durability: MemoryDurabilitySchema, expires_at: nullable(epoch), created_at: epoch, updated_at: epoch, revision,
		sources: Type.Array(memoryEvidence), supersedes: nullable(text), recall_count: natural, last_recalled_at: nullable(epoch) }),
	RecallData: object({ core: Type.Array(ref("MemoryData")), items: Type.Array(object({ item: ref("MemoryData"), score: Type.Number(), reason: text })) }),
	LifeData: lifeView, LifeConfig: LifeConfigSchema, LifeSettingsPatch: LifeSettingsUpdateSchema,
	LifeAdvanceInput: LifeAdvanceSchema, LifeConditionCreate: LifeConditionCreateSchema, LifeConditionPatch: LifeConditionRemoveSchema,
	LifePlanData: nullable(LifePlanSchema), DiaryData: DiaryEntrySchema,
	DiaryListData: object({ date: text, revision, generated_at: epoch, summary: text, form: text, source: text, evidence_count: natural }),
	SchedulePatch: object({ expected_revision: revision, enabled: Type.Boolean() }),
	ScheduleData: object({ persona_id: identifier, user_id: identifier, enabled: Type.Boolean() }),
	CompanionJobInput: object({ kind: Type.Enum(["plan", "diary", "detail"]), force: optional(Type.Boolean()), expected_revision: optional(natural) }),
	JobData: object({ kind: text, status: Type.Enum(["queued", "running", "completed", "failed", "cancelled"]), input: Type.Unknown(),
		cancel_requested: Type.Boolean(), started_at: nullable(timestamp), finished_at: nullable(timestamp), result: optional(Type.Unknown()), usage,
		error: optional(object({ code: text, message: text })), companion_scope: optional(text), session_id: optional(identifier) }),
	TokenCreate: object({ name: Type.String({ minLength: 1, maxLength: 100 }), permissions: Type.Array(permission, { minItems: 1, maxItems: 5, uniqueItems: true }), session_ids: optional(nullable(Type.Array(identifier, { maxItems: 1000, uniqueItems: true }))), companion_scopes: optional(nullable(Type.Array(Type.String({ pattern: "^[A-Za-z0-9_-]{1,100}:[A-Za-z0-9_-]{1,100}$" }), { maxItems: 1000, uniqueItems: true }))), expires_at: timestamp }),
	TokenData: object({ name: text, permissions: Type.Array(permission), session_ids: nullable(Type.Array(identifier)), companion_scopes: nullable(strings), expires_at: timestamp, revoked_at: nullable(timestamp) }),
	TokenCreated: object({ token: Type.String({ description: "Shown only once. A repeated request cannot recover the plaintext token." }), record: ref("Token") }),
	McpConfig: mcpConfig,
	McpPut: object({ expected_revision: nullable(revision), config: mcpConfig }),
	McpData: object({ config: mcpPublicConfig, status: Type.Enum(["disabled", "connecting", "connected", "disconnected", "needs-auth", "failed", "closed"]), tools: Type.Array(object({ name: text, server: text, tool: text, inputSchema: record, description: optional(text), exposure: mcpExposure, status: text })), has_resources: Type.Boolean(), oauth: object({ supported: Type.Boolean(), authenticated: Type.Boolean(), remote_revocation_supported: Type.Literal(false) }), secret_fields: strings, error: optional(object({ code: text, message: text })) }),
	McpAuthorization: object({ status: Type.Enum(["pending", "succeeded", "failed"]), authorization_url: optional(text), expires_at: optional(timestamp), reconnect_required: optional(Type.Boolean()), error: optional(object({ code: text, message: text })) }),
	McpAuthorizationComplete: object({ redirect_url: text }),
	InstalledResourceData: object({ name: text, path: text, enabled: Type.Boolean(), kind: Type.Enum(["extensions", "skills"]) }),
	InstalledResourcePatch: object({ expected_revision: revision, enabled: Type.Boolean() }),
	NullResult: Type.Null(),
	DeletedSession: object({ id: identifier, deleted: Type.Literal(true) }),
	RevokedToken: object({ id: identifier, revoked: Type.Literal(true) }),
	McpLogout: object({ authenticated: Type.Literal(false), local_credentials_removed: Type.Boolean(), remote_revocation_supported: Type.Literal(false) }),
	ReloadResult: object({ reloaded: Type.Literal(true) }),
	RemovedSchedule: object({ removed: Type.Literal(true) }),
};

for (const name of ["Session", "Message", "Run", "Task", "ToolCall", "Scene", "Presentation", "Workspace", "ExecutionProfile", "Approval", "ModelProfile", "Provider", "Model", "Persona", "Companion", "Memory", "Recall", "Life", "LifePlan", "Diary", "DiaryList", "Schedule", "Job", "Token", "Mcp", "InstalledResource"]) {
	HttpSchemas[name] = StoredSchema(ref(`${name}Data`));
	HttpSchemas[`${name}Page`] = PageSchema(ref(name));
}
HttpSchemas.PersonaPage = object({ items: Type.Array(ref("Persona")), next_cursor: Type.Null(), errors: Type.Array(object({ id: text, message: text })), editable: Type.Boolean(), roleplay_defaults: RoleplaySchema });
HttpSchemas.MemoryPage = object({ items: Type.Array(ref("Memory")), next_cursor: nullable(text), total: natural });

type Method = "get" | "post" | "put" | "patch" | "delete";
type Permission = "read" | "chat" | "execute" | "approve" | "manage";
interface Operation {
	method: Method;
	path: string;
	id: string;
	permission?: Permission;
	bootstrapOnly?: boolean;
	response: string;
	body?: string;
	status?: number;
	paged?: boolean;
	pageLimit?: number;
	query?: Record<string, TSchema>;
	revision?: boolean;
	description?: string;
}

/** Public routing contract. Paths intentionally contain no removed endpoint aliases. */
export const HttpOperations: Operation[] = [
	{ method: "get", path: "/health/live", id: "getLiveness", response: "Health" },
	{ method: "get", path: "/health/ready", id: "getReadiness", response: "Health" },
	{ method: "get", path: "/bootstrap", id: "getBootstrap", permission: "read", response: "Bootstrap" },
	{ method: "get", path: "/capabilities", id: "getCapabilities", permission: "read", response: "Capabilities" },
	{ method: "get", path: "/sessions", id: "listSessions", permission: "read", response: "SessionPage", paged: true },
	{ method: "post", path: "/sessions", id: "createSession", permission: "chat", body: "SessionCreate", response: "Session", status: 201 },
	{ method: "get", path: "/sessions/{id}", id: "getSession", permission: "read", response: "Session" },
	{ method: "patch", path: "/sessions/{id}", id: "patchSession", permission: "chat", body: "SessionPatch", response: "Session" },
	{ method: "delete", path: "/sessions/{id}", id: "deleteSession", permission: "chat", response: "DeletedSession", revision: true },
	{ method: "get", path: "/sessions/{id}/messages", id: "listMessages", permission: "read", response: "MessagePage", paged: true },
	{ method: "post", path: "/sessions/{id}/messages", id: "submitMessage", permission: "chat", body: "MessageCreate", response: "Run", status: 202 },
	{ method: "get", path: "/sessions/{id}/events", id: "listSessionEvents", permission: "read", response: "EventPage", query: { after_seq: natural, limit: Type.Integer({ minimum: 1, maximum: 200 }) } },
	{ method: "get", path: "/events", id: "listEvents", permission: "read", response: "EventPage", query: { stream_id: StreamIdSchema, after_seq: natural, limit: Type.Integer({ minimum: 1, maximum: 200 }) } },
	{ method: "get", path: "/runs/{id}", id: "getRun", permission: "read", response: "Run" },
	{ method: "post", path: "/runs/{id}/cancel", id: "cancelRun", permission: "chat", response: "Run", status: 202 },
	{ method: "get", path: "/tasks", id: "listTasks", permission: "read", response: "TaskPage", paged: true, query: { session_id: identifier } },
	{ method: "post", path: "/sessions/{id}/tasks", id: "createTask", permission: "execute", body: "TaskCreate", response: "Task", status: 202 },
	{ method: "get", path: "/tasks/{id}", id: "getTask", permission: "read", response: "Task" },
	...(["pause", "resume", "cancel"] as const).map((action): Operation => ({ method: "post", path: `/tasks/{id}/${action}`, id: `${action}Task`, permission: "execute", response: "Task", status: 202 })),
	{ method: "get", path: "/tasks/{id}/tool-calls", id: "listToolCalls", permission: "read", response: "ToolCallPage", paged: true },
	{ method: "put", path: "/sessions/{id}/scene-context", id: "putSceneContext", permission: "chat", body: "SceneInput", response: "Scene", description: "Untrusted scene data, at most 32 KiB and 100 objects. Object IDs must appear in allowed_object_ids. Expiry is bounded to five minutes. This is not persistent memory or executable instruction." },
	{ method: "post", path: "/sessions/{id}/presentation-events", id: "recordPresentation", permission: "chat", body: "PresentationInput", response: "Presentation", status: 201, description: "The segment must belong to this session. started precedes completed/interrupted/failed. An identical report is idempotent; a terminal state cannot be changed." },
	{ method: "get", path: "/approvals", id: "listApprovals", permission: "approve", response: "ApprovalPage", paged: true, query: { session_id: identifier, task_id: identifier, status: Type.Enum(["pending", "approved", "denied", "expired", "cancelled", "consumed"]) } },
	{ method: "get", path: "/approvals/{id}", id: "getApproval", permission: "approve", response: "Approval" },
	{ method: "post", path: "/approvals/{id}/decision", id: "decideApproval", permission: "approve", body: "ApprovalDecision", response: "Approval" },
	{ method: "get", path: "/tools", id: "listTools", permission: "read", response: "Tools", query: { workspace_id: identifier, execution_profile_id: identifier } },
	{ method: "get", path: "/personas", id: "listPersonas", permission: "read", response: "PersonaPage" },
	{ method: "post", path: "/personas", id: "createPersona", permission: "manage", body: "PersonaCreate", response: "Persona", status: 201 },
	{ method: "get", path: "/personas/{id}", id: "getPersona", permission: "read", response: "Persona" },
	{ method: "patch", path: "/personas/{id}", id: "patchPersona", permission: "manage", body: "PersonaPatch", response: "Persona" },
	{ method: "get", path: "/companions/{persona}/{user}", id: "getCompanion", permission: "read", response: "Companion" },
	{ method: "patch", path: "/companions/{persona}/{user}/state", id: "patchCompanionState", permission: "manage", body: "CompanionStatePatch", response: "Companion" },
	{ method: "get", path: "/companions/{persona}/{user}/memories", id: "listMemories", permission: "read", response: "MemoryPage", paged: true, pageLimit: 100, query: { q: Type.String({ maxLength: 2000 }), status: Type.Enum(["active", "pending", "superseded", "archived", "forgotten", "all"]), kind: MemoryKindSchema } },
	{ method: "post", path: "/companions/{persona}/{user}/memories", id: "createMemory", permission: "manage", body: "MemoryCreate", response: "Memory", status: 201 },
	{ method: "get", path: "/companions/{persona}/{user}/memories/{id}", id: "getMemory", permission: "read", response: "Memory" },
	{ method: "patch", path: "/companions/{persona}/{user}/memories/{id}", id: "patchMemory", permission: "manage", body: "MemoryPatch", response: "Memory" },
	{ method: "get", path: "/companions/{persona}/{user}/recall", id: "previewRecall", permission: "read", response: "Recall", query: { q: text } },
	{ method: "get", path: "/companions/{persona}/{user}/life", id: "getLife", permission: "read", response: "Life" },
	{ method: "patch", path: "/companions/{persona}/{user}/life/settings", id: "patchLifeSettings", permission: "manage", body: "LifeSettingsPatch", response: "Life" },
	{ method: "post", path: "/companions/{persona}/{user}/life/advance", id: "advanceLife", permission: "manage", body: "LifeAdvanceInput", response: "Life" },
	{ method: "post", path: "/companions/{persona}/{user}/life/conditions", id: "createLifeCondition", permission: "manage", body: "LifeConditionCreate", response: "Life", status: 201 },
	{ method: "patch", path: "/companions/{persona}/{user}/life/conditions/{id}", id: "removeLifeCondition", permission: "manage", body: "LifeConditionPatch", response: "Life" },
	{ method: "get", path: "/companions/{persona}/{user}/life/plan", id: "getLifePlan", permission: "read", response: "LifePlan" },
	{ method: "get", path: "/companions/{persona}/{user}/diaries", id: "listDiaries", permission: "read", response: "DiaryListPage", paged: true, pageLimit: 60 },
	{ method: "get", path: "/companions/{persona}/{user}/diaries/{date}", id: "getDiary", permission: "read", response: "Diary" },
	{ method: "delete", path: "/companions/{persona}/{user}/diaries/{date}", id: "deleteDiary", permission: "manage", response: "Life", revision: true },
	{ method: "get", path: "/companions/{persona}/{user}/schedule", id: "getSchedule", permission: "read", response: "Schedule" },
	{ method: "patch", path: "/companions/{persona}/{user}/schedule", id: "patchSchedule", permission: "manage", body: "SchedulePatch", response: "Schedule" },
	{ method: "delete", path: "/companions/{persona}/{user}/schedule", id: "removeSchedule", permission: "manage", response: "RemovedSchedule", revision: true },
	{ method: "post", path: "/companions/{persona}/{user}/jobs", id: "createCompanionJob", permission: "manage", body: "CompanionJobInput", response: "Job", status: 202 },
	{ method: "get", path: "/jobs", id: "listJobs", permission: "read", response: "JobPage", paged: true, query: { companion_scope: text, session_id: identifier, kind: text, status: Type.Enum(["queued", "running", "completed", "failed", "cancelled"]) } },
	{ method: "get", path: "/jobs/{id}", id: "getJob", permission: "read", response: "Job" },
	{ method: "post", path: "/jobs/{id}/cancel", id: "cancelJob", permission: "manage", response: "Job", status: 202 },
	{ method: "get", path: "/providers", id: "listProviders", permission: "read", response: "ProviderPage" },
	{ method: "patch", path: "/providers/{id}", id: "patchProvider", permission: "manage", body: "ProviderPatch", response: "Provider", description: "expected_revision is null for a new custom provider and the catalog revision for an update. Credentials are literal write-only strings, never returned." },
	{ method: "delete", path: "/providers/{id}", id: "deleteProvider", permission: "manage", response: "NullResult", revision: true },
	{ method: "get", path: "/models", id: "listModels", permission: "read", response: "ModelPage" },
	{ method: "patch", path: "/providers/{provider}/models/{id}", id: "patchModel", permission: "manage", body: "ModelPatch", response: "Model", description: "Path id is the percent-encoded provider model name, not the catalog resource ID. expected_revision is null on creation." },
	{ method: "delete", path: "/providers/{provider}/models/{id}", id: "deleteModel", permission: "manage", response: "NullResult", revision: true },
	{ method: "get", path: "/model-profiles", id: "listModelProfiles", permission: "read", response: "ModelProfilePage", paged: true },
	{ method: "post", path: "/model-profiles", id: "createModelProfile", permission: "manage", body: "ModelProfileCreate", response: "ModelProfile", status: 201 },
	{ method: "get", path: "/model-profiles/{id}", id: "getModelProfile", permission: "read", response: "ModelProfile" },
	{ method: "patch", path: "/model-profiles/{id}", id: "patchModelProfile", permission: "manage", body: "ModelProfilePatch", response: "ModelProfile" },
	{ method: "delete", path: "/model-profiles/{id}", id: "deleteModelProfile", permission: "manage", response: "NullResult", revision: true },
	{ method: "post", path: "/model-tests", id: "createModelTest", permission: "manage", body: "ModelTestInput", response: "Job", status: 202 },
	...(["workspaces", "execution-profiles"] as const).flatMap((kind): Operation[] => {
		const name = kind === "workspaces" ? "Workspace" : "ExecutionProfile";
		return [
			{ method: "get", path: `/${kind}`, id: `list${name}s`, permission: "read", response: `${name}Page`, paged: true },
			{ method: "post", path: `/${kind}`, id: `create${name}`, permission: "manage", body: `${name}Create`, response: name, status: 201 },
			{ method: "get", path: `/${kind}/{id}`, id: `get${name}`, permission: "read", response: name },
			{ method: "patch", path: `/${kind}/{id}`, id: `patch${name}`, permission: "manage", body: `${name}Patch`, response: name },
			{ method: "delete", path: `/${kind}/{id}`, id: `delete${name}`, permission: "manage", response: "NullResult", revision: true },
		];
	}),
	{ method: "get", path: "/tokens", id: "listTokens", permission: "manage", bootstrapOnly: true, response: "TokenPage", description: "Bootstrap principal.id === root only. Managed tokens cannot enumerate or delegate tokens, even with manage permission." },
	{ method: "post", path: "/tokens", id: "createToken", permission: "manage", bootstrapOnly: true, body: "TokenCreate", response: "TokenCreated", status: 201, description: "Bootstrap principal.id === root only. The plaintext token is returned once, never persisted for response replay. Repeating the same key cannot reveal it again." },
	{ method: "delete", path: "/tokens/{id}", id: "revokeToken", permission: "manage", bootstrapOnly: true, response: "RevokedToken", revision: true, description: "Bootstrap principal.id === root only; manage permission on a managed token is insufficient." },
	{ method: "get", path: "/mcp/servers", id: "listMcpServers", permission: "manage", response: "McpPage", paged: true },
	{ method: "get", path: "/mcp/servers/{id}", id: "getMcpServer", permission: "manage", response: "Mcp" },
	{ method: "put", path: "/mcp/servers/{id}", id: "putMcpServer", permission: "manage", body: "McpPut", response: "Mcp" },
	{ method: "delete", path: "/mcp/servers/{id}", id: "deleteMcpServer", permission: "manage", response: "NullResult", revision: true },
	{ method: "post", path: "/mcp/servers/{id}/reconnect", id: "reconnectMcpServer", permission: "manage", response: "Mcp" },
	{ method: "get", path: "/mcp/servers/{id}/authorization", id: "getMcpAuthorization", permission: "manage", response: "McpAuthorization" },
	{ method: "post", path: "/mcp/servers/{id}/authorization", id: "beginMcpAuthorization", permission: "manage", response: "McpAuthorization" },
	{ method: "post", path: "/mcp/servers/{id}/authorization/complete", id: "completeMcpAuthorization", permission: "manage", body: "McpAuthorizationComplete", response: "McpAuthorization" },
	{ method: "delete", path: "/mcp/servers/{id}/authorization", id: "logoutMcpServer", permission: "manage", response: "McpLogout" },
	...(["extensions", "skills"] as const).flatMap((kind): Operation[] => [
		{ method: "get", path: `/${kind}`, id: `list${kind === "skills" ? "Skills" : "Extensions"}`, permission: "manage", response: "InstalledResourcePage" },
		{ method: "patch", path: `/${kind}/{id}`, id: `patch${kind === "skills" ? "Skill" : "Extension"}`, permission: "manage", body: "InstalledResourcePatch", response: "InstalledResource" },
	]),
	{ method: "post", path: "/resources/reload", id: "reloadResources", permission: "manage", response: "ReloadResult", description: "Reload installed allowlisted resources only when sessions are idle. Busy sessions return a conflict; no implicit cancellation or package installation." },
];

export function createOpenApiSpec() {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const operation of HttpOperations) {
		const parameters: Record<string, unknown>[] = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
			name: match[1], in: "path", required: true,
			schema: match[1] === "date" ? Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }) : Type.String({ minLength: 1, maxLength: 500 }),
		}));
		if (operation.method === "post") parameters.push({ $ref: "#/components/parameters/IdempotencyKey" });
		if (operation.revision) parameters.push({ $ref: "#/components/parameters/ExpectedRevision" });
		if (operation.paged) parameters.push({ $ref: "#/components/parameters/Cursor" }, operation.pageLimit
			? { name: "limit", in: "query", required: false, schema: Type.Integer({ minimum: 1, maximum: operation.pageLimit, default: 50 }) }
			: { $ref: "#/components/parameters/Limit" });
		for (const [name, schema] of Object.entries(operation.query ?? {})) parameters.push({ name, in: "query", required: name === "stream_id", schema });
		const result: Record<string, unknown> = {
			operationId: operation.id, tags: [operation.path.split("/")[1]], summary: operation.id.replace(/([A-Z])/g, " $1"),
			security: operation.permission ? [{ bearerAuth: [] }] : [], parameters,
			...(operation.permission ? { "x-required-permission": operation.permission } : {}),
			...(operation.bootstrapOnly ? { "x-required-principal": { id: "root" } } : {}),
			...(operation.description ? { description: operation.description } : {}),
			responses: {
				[String(operation.status ?? 200)]: { description: operation.status === 202 ? "Accepted; execution continues independently of this connection" : "Success", headers: { "X-Request-Id": { schema: text, description: "Server-generated request correlation ID" } }, content: { "application/json": { schema: ref(operation.response) } } },
				"400": { $ref: "#/components/responses/BadRequest" }, "401": { $ref: "#/components/responses/Unauthorized" }, "403": { $ref: "#/components/responses/Forbidden" },
				"404": { $ref: "#/components/responses/NotFound" }, "405": { $ref: "#/components/responses/MethodNotAllowed" }, "409": { $ref: "#/components/responses/Conflict" }, "410": { $ref: "#/components/responses/CursorExpired" }, "413": { $ref: "#/components/responses/TooLarge" }, "415": { $ref: "#/components/responses/UnsupportedMediaType" }, "500": { $ref: "#/components/responses/InternalError" }, "503": { $ref: "#/components/responses/Unavailable" },
			},
		};
		if (operation.body) result.requestBody = { required: true, content: { "application/json": { schema: ref(operation.body) } } };
		else if (operation.method === "post") result.requestBody = { required: true, content: { "application/json": { schema: object({}) } } };
		(paths[operation.path] ??= {})[operation.method] = result;
	}
	const responses: Record<string, unknown> = {};
	for (const [name, description] of Object.entries({ BadRequest: "Invalid input or cursor", Unauthorized: "Authentication required, expired or revoked", Forbidden: "Missing permission or resource scope", NotFound: "Resource not found", MethodNotAllowed: "Method is not supported for this resource; see Allow header", Conflict: "Revision, idempotency or lifecycle conflict", CursorExpired: "The cursor can no longer be replayed", TooLarge: "Request exceeds byte or object limits", UnsupportedMediaType: "Content-Type must be application/json", InternalError: "Safe internal failure", Unavailable: "Configured capability unavailable" })) {
		responses[name] = { description, headers: { "X-Request-Id": { schema: text } }, content: { "application/json": { schema: ref("HttpError") } } };
	}
	return {
		openapi: "3.1.0", jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
		info: { title: "dw-agent HTTP API", version: "1", description: "HTTP resource operations under /api; authenticated replayable event subscriptions at /dw-agent/v1. Generated from scripts/export-openapi.ts. No legacy business commands or aliases." },
		servers: [{ url: "/api" }], paths,
		components: {
			securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "Root bootstrap token or managed scoped token. Never put a token in a URL." } },
			parameters: {
				IdempotencyKey: { name: "Idempotency-Key", in: "header", required: true, schema: Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9_.:-]+$" }), description: "Persist and replay the exact original key, method, path, query and body. Keys are principal-scoped; a changed request conflicts. An interrupted durable intent must not be re-executed with a new key." },
				ExpectedRevision: { name: "expected_revision", in: "query", required: true, schema: revision, description: "Current resource revision; refresh on conflict, do not overwrite blindly." },
				Cursor: { name: "cursor", in: "query", required: false, schema: Type.String({ minLength: 1 }), description: "Opaque query-scoped cursor from next_cursor; never interpret as an offset or event seq." },
				Limit: { name: "limit", in: "query", required: false, schema: Type.Integer({ minimum: 1, maximum: 200, default: 50 }) },
			}, responses, schemas: HttpSchemas,
		},
		"x-websocket": {
			path: "/dw-agent/v1", schema: "./protocol-v1.schema.json", commands: ["hello", "subscribe", "unsubscribe"],
			streams: ["session:ID", "companion:PERSONA:USER", "system"],
			delivery: "At least once; deduplicate by stream_id and seq, replay from the last contiguous per-stream cursor.",
			event_data: { "reply.segment": ref("ReplySegment"), "message.created": ref("Message"), "message.updated": ref("MessageUpdatedData"),
				"run.started|run.completed|run.failed|run.cancelled": ref("RunEventData"), "task.created|task.*": ref("TaskEventData"), "approval.*": ref("ApprovalEventData") },
			resource_refresh: "Run/task/approval notifications are bounded references and status, not full resources. GET the referenced run/task/approval or session messages when details are needed. Approval arguments and hashes are available by authorized GET only. reply.segment is the authoritative streamed presentation payload.",
		},
	};
}

export function exportOpenApi(outputDir = new URL("../schemas/", import.meta.url)): void {
	mkdirSync(outputDir, { recursive: true });
	writeFileSync(new URL("openapi.json", outputDir), `${JSON.stringify(createOpenApiSpec(), null, "\t")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) exportOpenApi();
