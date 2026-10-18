import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { Type } from "typebox";
import type { HostToolCall, HostToolGuard } from "../../coding-agent/src/core/execution-policy.ts";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "../../coding-agent/src/core/extensions/types.ts";
import { createBashToolDefinition } from "../../coding-agent/src/core/tools/bash.ts";
import { createEditToolDefinition } from "../../coding-agent/src/core/tools/edit.ts";
import { createFindToolDefinition } from "../../coding-agent/src/core/tools/find.ts";
import { createLsToolDefinition } from "../../coding-agent/src/core/tools/ls.ts";
import { createPowerShellToolDefinition } from "../../coding-agent/src/core/tools/powershell.ts";
import { createReadToolDefinition } from "../../coding-agent/src/core/tools/read.ts";
import { truncateHead } from "../../coding-agent/src/core/tools/truncate.ts";
import { createWriteToolDefinition } from "../../coding-agent/src/core/tools/write.ts";
import { codemodeSchema } from "../../coding-agent/src/extensions/codemode/tool.ts";
import { toolSearchSchema } from "../../coding-agent/src/extensions/tool-search/tool.ts";
import type { ApiStore, Stored } from "./api-store.ts";
import { ExecutorError } from "./errors.ts";

export interface ExecutionPolicyOptions {
	defaultCwd: string;
	agentDir: string;
	protectedRoots?: string[];
}

export interface Workspace {
	name: string;
	root: string;
	project_config_trusted: false;
}
export interface ExecutionProfile {
	name: string;
	tools: string[];
	approval: "always" | "writes" | "never";
	max_model_calls: number;
	max_concurrent_tasks: number;
	timeout_ms: number;
	approval_timeout_ms: number;
	isolation: "restricted" | "trusted_host";
}
export interface Approval {
	session_id?: string;
	task_id: string;
	workspace_id: string;
	execution_profile_id: string;
	tool_call_id: string;
	parent_tool_call_id?: string;
	tool_name: string;
	arguments: Record<string, unknown>;
	arguments_sha256: string;
	scope_sha256: string;
	status: "pending" | "approved" | "denied" | "expired" | "cancelled" | "consumed";
	expires_at: string;
	decided_at?: string;
	consumed_at?: string;
}
export interface FrozenExecutionScope {
	workspace: Stored<Workspace>;
	profile: Stored<ExecutionProfile>;
	session_id?: string;
}
export interface PreparedExecution extends FrozenExecutionScope {
	cwd: string;
	extensions: InlineExtension[];
	tools: string[];
	signal: AbortSignal;
	authorizeToolCall: HostToolGuard;
	release(): void;
}
export interface CatalogTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
	parameters?: unknown;
}
interface CallRecord {
	task_id: string;
	tool_call_id: string;
	fingerprint: string;
	status: "pending" | "denied" | "consumed";
}
const FILE_TOOLS = ["read", "write", "edit", "ls", "find", "grep"];
const MUTATING_TOOLS: Record<string, true | undefined> = { write: true, edit: true };
const DEFAULT_PROFILE: ExecutionProfile = {
	name: "Restricted workspace",
	tools: FILE_TOOLS,
	approval: "writes",
	max_model_calls: 32,
	max_concurrent_tasks: 1,
	timeout_ms: 300_000,
	approval_timeout_ms: 60_000,
	isolation: "restricted",
};
function invalid(message: string): never {
	throw new ExecutorError("INVALID_PAYLOAD", message);
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Expected a JSON object");
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`Unknown field: ${key}`);
}
function text(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0")) {
		invalid(`${name} must be a nonempty string`);
	}
	return value;
}
function revision(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) invalid("expected_revision is required");
	return value as number;
}
function positive(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`${name} must be a positive safe integer`);
	return value as number;
}
function identifier(value: unknown): string {
	const id = value === undefined ? randomUUID() : text(value, "id");
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) invalid("Invalid resource id");
	return id;
}
function canonical(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	}
	invalid("Tool arguments must contain only JSON values");
}
function hash(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}
function freeze(value: unknown): void {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
	for (const child of Object.values(value)) freeze(child);
	Object.freeze(value);
}
function contains(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function aborted(signal: AbortSignal): void {
	if (signal.aborted) throw new ExecutorError("OPERATION_CANCELLED", "Execution scope is cancelled or expired");
}
function profileData(value: Record<string, unknown>, previous = DEFAULT_PROFILE): ExecutionProfile {
	const data = { ...previous, ...value };
	const isolation = data.isolation;
	if (isolation !== "restricted" && isolation !== "trusted_host") invalid("Invalid isolation mode");
	if (!["always", "writes", "never"].includes(String(data.approval))) invalid("Invalid approval policy");
	if (
		!Array.isArray(data.tools) ||
		data.tools.some((name) => typeof name !== "string" || !/^[A-Za-z0-9_.:-]+$/.test(name))
	) {
		invalid("tools must be an array of exact tool names, not patterns");
	}
	return {
		name: text(data.name, "name"),
		tools: [...new Set(data.tools)],
		approval: data.approval as ExecutionProfile["approval"],
		isolation,
		max_model_calls: positive(data.max_model_calls, "max_model_calls"),
		max_concurrent_tasks: positive(data.max_concurrent_tasks, "max_concurrent_tasks"),
		timeout_ms: positive(data.timeout_ms, "timeout_ms"),
		approval_timeout_ms: positive(data.approval_timeout_ms, "approval_timeout_ms"),
	};
}
const PROFILE_FIELDS = [
	"name",
	"tools",
	"approval",
	"max_model_calls",
	"max_concurrent_tasks",
	"timeout_ms",
	"approval_timeout_ms",
	"isolation",
];

/**
 * Filesystem containment for the host's known filesystem tools, not an OS process sandbox.
 * No arbitrary code is made safe by cwd or by this class. Hostile concurrent processes can
 * still race directory renames: strong containment of arbitrary code requires OS isolation.
 */
class WorkspaceFiles {
	private readonly root: string;
	private readonly excluded: readonly string[];
	private readonly signal: AbortSignal;
	constructor(root: string, excluded: readonly string[], signal: AbortSignal) {
		this.root = root;
		this.excluded = excluded;
		this.signal = signal;
	}

	async check(input: string, allowMissing = false): Promise<string> {
		aborted(this.signal);
		const path = resolve(this.root, text(input, "path"));
		if (!contains(this.root, path) || this.excluded.some((root) => contains(root, path))) {
			throw new ExecutorError("WORKSPACE_ESCAPE", "Path is outside the permitted workspace");
		}
		// Windows alternate streams, device paths and trailing-dot aliases are not ordinary files.
		const parts = relative(this.root, path).split(sep).filter(Boolean);
		if (
			parts.some(
				(part) =>
					part.includes(":") ||
					(process.platform === "win32" &&
						(/[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:[ .]|$)/i.test(part))),
			)
		) {
			throw new ExecutorError("WORKSPACE_ESCAPE", "Unsupported filesystem alias");
		}
		if ((await realpath(this.root)) !== this.root)
			throw new ExecutorError("WORKSPACE_ESCAPE", "Workspace root changed");
		let current = this.root;
		for (const part of parts) {
			current = join(current, part);
			try {
				const info = await lstat(current);
				if (info.isSymbolicLink())
					throw new ExecutorError("WORKSPACE_ESCAPE", "Symbolic links and junctions are not permitted");
				const resolved = await realpath(current);
				if (!contains(this.root, resolved) || this.excluded.some((root) => contains(root, resolved))) {
					throw new ExecutorError("WORKSPACE_ESCAPE", "Resolved path escaped the permitted workspace");
				}
				if (info.isFile() && info.nlink > 1)
					throw new ExecutorError("WORKSPACE_ESCAPE", "Multiply linked files are not permitted");
				if (!info.isFile() && !info.isDirectory())
					throw new ExecutorError("WORKSPACE_ESCAPE", "Only ordinary files and directories are permitted");
			} catch (error) {
				if (allowMissing && isMissing(error)) break;
				throw error;
			}
		}
		aborted(this.signal);
		return path;
	}

	async read(path: string, headerBytes?: number): Promise<Buffer> {
		const checked = await this.check(path);
		const handle = await open(
			checked,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
		try {
			await this.verifyHandle(checked, handle);
			if (headerBytes !== undefined) {
				const header = Buffer.alloc(headerBytes);
				const { bytesRead } = await handle.read(header, 0, headerBytes, 0);
				return header.subarray(0, bytesRead);
			}
			return await handle.readFile();
		} finally {
			await handle.close();
		}
	}

	private async verifyHandle(path: string, handle: FileHandle): Promise<void> {
		await this.check(path);
		const actual = await handle.stat();
		const named = await lstat(path);
		if (!actual.isFile() || actual.nlink > 1 || actual.dev !== named.dev || actual.ino !== named.ino) {
			throw new ExecutorError("WORKSPACE_ESCAPE", "File changed during authorization");
		}
		aborted(this.signal);
	}

	async write(path: string, content: string): Promise<void> {
		const checked = await this.check(path, true);
		let handle: FileHandle;
		try {
			handle = await open(checked, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		} catch (error) {
			if (!isMissing(error)) throw error;
			handle = await open(
				checked,
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_EXCL |
					(constants.O_NOFOLLOW ?? 0) |
					(constants.O_NONBLOCK ?? 0),
				0o600,
			);
		}
		try {
			// In particular, never O_TRUNC before checking the opened file's identity.
			await this.verifyHandle(checked, handle);
			await handle.truncate(0);
			aborted(this.signal);
			await handle.writeFile(content, "utf8");
		} finally {
			await handle.close();
		}
	}

	async mkdir(path: string): Promise<void> {
		const checked = await this.check(path, true);
		let current = this.root;
		for (const part of relative(this.root, checked).split(sep).filter(Boolean)) {
			current = join(current, part);
			await this.check(current, true);
			try {
				await mkdir(current);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			}
			await this.check(current);
		}
	}

	async info(path: string) {
		return stat(await this.check(path));
	}
	async entries(path: string): Promise<string[]> {
		return readdir(await this.check(path));
	}
	async exists(path: string): Promise<boolean> {
		try {
			await this.check(path);
			return true;
		} catch (error) {
			if (isMissing(error)) return false;
			throw error;
		}
	}

	async *walk(path: string): AsyncGenerator<string> {
		const checked = await this.check(path);
		if (!(await this.info(checked)).isDirectory()) {
			yield checked;
			return;
		}
		for (const name of (await this.entries(checked)).sort()) {
			if (name === ".git" || name === "node_modules") continue;
			const child = join(checked, name);
			if (this.excluded.some((root) => contains(root, child))) continue;
			// Skip links rather than traverse them, even when they target another permitted directory.
			if ((await lstat(child)).isSymbolicLink()) continue;
			await this.check(child);
			if ((await this.info(child)).isDirectory()) yield* this.walk(child);
			else if ((await this.info(child)).isFile()) yield child;
		}
	}
}

const grepSchema = Type.Object({
	pattern: Type.String(),
	path: Type.Optional(Type.String()),
	glob: Type.Optional(Type.String()),
	ignoreCase: Type.Optional(Type.Boolean()),
	literal: Type.Optional(Type.Boolean()),
	context: Type.Optional(Type.Integer({ minimum: 0 })),
	limit: Type.Optional(Type.Integer({ minimum: 1 })),
});
// Only a regular expression and text cross into this worker, never executable source from a tool.
// Keeping regex evaluation off the host thread makes even pathological patterns cancellable.
const SEARCH_WORKER = `const {parentPort,workerData}=require('node:worker_threads');
try { const {text,pattern,ignoreCase,literal,limit}=workerData;
const lines=text.replace(/\\r\\n?/g,'\\n').split('\\n');
const regex=literal?null:new RegExp(pattern,ignoreCase?'i':'');
const needle=ignoreCase?pattern.toLowerCase():pattern;
const matches=[];
for(let i=0;i<lines.length&&matches.length<limit;i++) {
 const line=ignoreCase?lines[i].toLowerCase():lines[i];
 if(regex?regex.test(lines[i]):line.includes(needle)) matches.push(i);
}
parentPort.postMessage({matches});
} catch(error) {parentPort.postMessage({error:String(error.message||error)});}`;
function matchLines(
	text: string,
	pattern: string,
	ignoreCase: boolean,
	literal: boolean,
	limit: number,
	signal: AbortSignal,
): Promise<number[]> {
	aborted(signal);
	const { promise, resolve: resolveMatch, reject } = Promise.withResolvers<number[]>();
	const worker = new Worker(SEARCH_WORKER, {
		eval: true,
		execArgv: [],
		workerData: { text, pattern, ignoreCase, literal, limit },
	});
	const cleanup = () => {
		signal.removeEventListener("abort", onAbort);
		void worker.terminate();
	};
	const onAbort = () => {
		cleanup();
		reject(new ExecutorError("OPERATION_CANCELLED", "Search cancelled"));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	worker.once("message", (message: { matches?: number[]; error?: string }) => {
		cleanup();
		if (message.error) reject(new ExecutorError("INVALID_PAYLOAD", message.error));
		else resolveMatch(message.matches ?? []);
	});
	worker.once("error", (error) => {
		cleanup();
		reject(error);
	});
	if (signal.aborted) onAbort();
	return promise;
}
function filesystemTools(
	files: WorkspaceFiles,
	cwd: string,
	signal: AbortSignal,
	pi: Pick<ExtensionAPI, "registerTool">,
): void {
	const access = async (path: string) => {
		await files.check(path);
	};
	const readFile = (path: string) => files.read(path);
	const writeFile = (path: string, content: string) => files.write(path, content);
	const grep: ToolDefinition<typeof grepSchema> = {
		name: "grep",
		label: "grep",
		description:
			"Search workspace text using JavaScript regular expressions or literal strings. Skips symbolic links, .git and node_modules; includes other files regardless of ignore rules.",
		parameters: grepSchema,
		async execute(_id, input, callSignal) {
			const scopedSignal = callSignal ? AbortSignal.any([signal, callSignal]) : signal;
			const root = await files.check(input.path ?? ".");
			const limit = input.limit ?? 100;
			const context = input.context ?? 0;
			let count = 0;
			const output: string[] = [];
			for await (const path of files.walk(root)) {
				aborted(scopedSignal);
				const name = relative(root, path).split(sep).join("/") || basename(path);
				if (input.glob && !matchesGlob(name, input.glob) && !matchesGlob(basename(path), input.glob)) continue;
				const content = (await files.read(path)).toString("utf8");
				if (content.includes("\0")) continue;
				const matches = await matchLines(
					content,
					input.pattern,
					input.ignoreCase ?? false,
					input.literal ?? false,
					limit - count,
					scopedSignal,
				);
				const lines = content.replace(/\r\n?/g, "\n").split("\n");
				for (const index of matches) {
					for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i++) {
						output.push(`${name}${i === index ? ":" : "-"}${i + 1}: ${lines[i].slice(0, 2000)}`);
					}
					count++;
				}
				if (count >= limit || Buffer.byteLength(output.join("\n")) > 50_000) break;
			}
			const result = truncateHead(output.join("\n") || "No matches found");
			return {
				content: [{ type: "text", text: result.content }],
				details: { match_count: count, truncated: result.truncated || count >= limit },
			};
		},
	};
	const find = createFindToolDefinition(cwd, {
		operations: {
			exists: (path) => files.exists(path),
			async glob(pattern, root, options) {
				const result: string[] = [];
				for await (const path of files.walk(root)) {
					const name = relative(root, path).split(sep).join("/");
					if (matchesGlob(name, pattern) || (!pattern.includes("/") && matchesGlob(basename(path), pattern)))
						result.push(path);
					if (result.length >= options.limit) break;
				}
				return result;
			},
		},
	});
	find.description =
		"Find workspace files by glob. Skips symbolic links, .git and node_modules; includes other files regardless of ignore rules.";
	pi.registerTool(
		createReadToolDefinition(cwd, {
			operations: {
				access,
				readFile,
				async detectImageMimeType(path) {
					const buffer = await files.read(path, 12);
					if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
					if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "image/jpeg";
					if (buffer.subarray(0, 3).toString() === "GIF") return "image/gif";
					if (buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP")
						return "image/webp";
					if (buffer.subarray(0, 2).toString() === "BM") return "image/bmp";
					return undefined;
				},
			},
		}),
	);
	pi.registerTool(createWriteToolDefinition(cwd, { operations: { writeFile, mkdir: (path) => files.mkdir(path) } }));
	pi.registerTool(createEditToolDefinition(cwd, { operations: { access, readFile, writeFile } }));
	pi.registerTool(
		createLsToolDefinition(cwd, {
			operations: {
				exists: (path) => files.exists(path),
				stat: (path) => files.info(path),
				readdir: (path) => files.entries(path),
			},
		}),
	);
	pi.registerTool(find);
	pi.registerTool(grep);
}

export class ExecutionPolicies {
	private readonly active = new Map<string, { profileId: string; abort: () => void }>();
	private readonly waiters = new Map<string, () => void>();
	private catalog: () => readonly CatalogTool[] = () => [];
	private protectedRoots: string[] = [];
	private closed = false;
	private readonly store: ApiStore;
	private readonly options: ExecutionPolicyOptions;
	constructor(store: ApiStore, options: ExecutionPolicyOptions) {
		this.store = store;
		this.options = options;
	}

	async initialize(): Promise<void> {
		const systemRoots =
			process.platform === "linux" ? ["/proc", "/sys", "/dev"] : process.platform === "darwin" ? ["/dev"] : [];
		this.protectedRoots = await Promise.all(
			[...new Set([this.options.agentDir, ...(this.options.protectedRoots ?? []), ...systemRoots])].map((root) =>
				realpath(root),
			),
		);
		if (!this.store.get<Workspace>("workspaces", "default")) {
			await this.createWorkspace({ id: "default", name: "Default workspace", root: this.options.defaultCwd });
		}
		if (!this.store.get<ExecutionProfile>("execution-profiles", "default")) this.createProfile({ id: "default" });
		// Grants never survive the execution scope that created them.
		for (const item of this.store.all<Approval>("approvals")) {
			if (item.data.status === "pending" || item.data.status === "approved") {
				this.saveApproval(item, { ...item.data, status: "cancelled" });
			}
		}
	}

	setToolCatalog(catalog: () => readonly CatalogTool[]): void {
		this.catalog = catalog;
	}
	capabilities() {
		return {
			platform: process.platform,
			isolation_modes: ["restricted", "trusted_host"],
			restricted: { filesystem_tools: FILE_TOOLS, arbitrary_code: false, process_sandbox: false, symlinks: false },
			trusted_host: { arbitrary_code: true, per_call_approval_required: true, process_sandbox: false },
			os_sandbox: {
				available: false,
				reason: "No OS process sandbox is configured; filesystem guards are not process isolation",
			},
		};
	}
	private query(query: unknown, filters: string[] = []) {
		const input = query === undefined ? {} : object(query);
		keys(input, ["cursor", "limit", ...filters]);
		const filter: Record<string, string> = {};
		for (const key of filters) if (input[key] !== undefined) filter[key] = text(input[key], key);
		const limit =
			input.limit === undefined
				? undefined
				: positive(typeof input.limit === "string" ? Number(input.limit) : input.limit, "limit");
		return {
			...(input.cursor === undefined ? {} : { cursor: text(input.cursor, "cursor") }),
			...(limit === undefined ? {} : { limit }),
			...(Object.keys(filter).length ? { filter } : {}),
		};
	}
	listWorkspaces(query?: unknown) {
		return this.store.list<Workspace>("workspaces", this.query(query));
	}
	getWorkspace(id: string) {
		return this.store.require<Workspace>("workspaces", id);
	}
	async createWorkspace(value: unknown) {
		const input = object(value);
		keys(input, ["id", "name", "root"]);
		const id = identifier(input.id);
		const root = await this.workspaceRoot(input.root);
		return this.store.put<Workspace>(
			"workspaces",
			id,
			{ name: text(input.name, "name"), root, project_config_trusted: false },
			null,
		);
	}
	async updateWorkspace(id: string, value: unknown) {
		const input = object(value);
		keys(input, ["expected_revision", "name", "root"]);
		const previous = this.getWorkspace(id);
		const root = input.root === undefined ? previous.data.root : await this.workspaceRoot(input.root);
		return this.store.put<Workspace>(
			"workspaces",
			id,
			{
				name: input.name === undefined ? previous.data.name : text(input.name, "name"),
				root,
				project_config_trusted: false,
			},
			revision(input.expected_revision),
		);
	}
	private async workspaceRoot(value: unknown): Promise<string> {
		const root = await realpath(text(value, "root"));
		if (!(await stat(root)).isDirectory()) invalid("Workspace root must be an existing directory");
		if (this.protectedRoots.some((protectedRoot) => contains(protectedRoot, root)))
			invalid("Protected agent configuration and service data cannot be a workspace");
		return root;
	}
	deleteWorkspace(id: string, expectedRevision: number): void {
		this.assertUnused("workspace_id", id);
		this.store.remove("workspaces", id, revision(expectedRevision));
	}
	listProfiles(query?: unknown) {
		return this.store.list<ExecutionProfile>("execution-profiles", this.query(query));
	}
	getProfile(id: string) {
		return this.store.require<ExecutionProfile>("execution-profiles", id);
	}
	createProfile(value: unknown) {
		const input = object(value);
		keys(input, ["id", ...PROFILE_FIELDS]);
		const { id: suppliedId, ...data } = input;
		return this.store.put<ExecutionProfile>("execution-profiles", identifier(suppliedId), profileData(data), null);
	}
	updateProfile(id: string, value: unknown) {
		const input = object(value);
		keys(input, ["expected_revision", ...PROFILE_FIELDS]);
		const { expected_revision: expectedRevision, ...data } = input;
		return this.store.put<ExecutionProfile>(
			"execution-profiles",
			id,
			profileData(data, this.getProfile(id).data),
			revision(expectedRevision),
		);
	}
	deleteProfile(id: string, expectedRevision: number): void {
		this.assertUnused("execution_profile_id", id);
		this.store.remove("execution-profiles", id, revision(expectedRevision));
	}
	private assertUnused(field: string, id: string): void {
		if (id === "default") throw new ExecutorError("CONFLICT", "The default resource cannot be deleted");
		for (const kind of ["session", "task"]) {
			if (this.store.all<Record<string, unknown>>(kind).some((item) => item.data[field] === id)) {
				throw new ExecutorError("CONFLICT", "Resource is referenced by a session or task");
			}
		}
	}
	listApprovals(query?: unknown) {
		this.expireApprovals();
		return this.store.list<Approval>("approvals", this.query(query, ["task_id", "session_id", "status"]));
	}
	getApproval(id: string) {
		this.expireApprovals();
		return this.store.require<Approval>("approvals", id);
	}
	decideApproval(id: string, value: unknown) {
		const input = object(value);
		keys(input, ["decision", "expected_revision"]);
		if (input.decision !== "approve" && input.decision !== "deny") invalid("decision must be approve or deny");
		const expectedRevision = revision(input.expected_revision);
		this.expireApprovals();
		const result = this.store.transaction(() => {
			const item = this.store.require<Approval>("approvals", id);
			if (item.revision !== expectedRevision)
				throw new ExecutorError("REVISION_CONFLICT", "Approval revision changed");
			if (item.data.status !== "pending") throw new ExecutorError("CONFLICT", "Approval is no longer pending");
			return this.saveApproval(item, {
				...item.data,
				status: input.decision === "approve" ? "approved" : "denied",
				decided_at: new Date().toISOString(),
			});
		});
		this.waiters.get(id)?.();
		return result;
	}
	private saveApproval(item: Stored<Approval>, data: Approval) {
		return this.store.transaction(() => {
			const updated = this.store.put<Approval>("approvals", item.id, data, item.revision);
			this.store.append(
				data.session_id ? `session:${data.session_id}` : "system",
				`approval.${data.status}`,
				{
					approval_id: item.id,
					task_id: data.task_id,
					status: data.status,
					revision: updated.revision,
					...(data.session_id ? { session_id: data.session_id } : {}),
				},
				{ task_id: data.task_id, ...(data.session_id ? { session_id: data.session_id } : {}) },
			);
			return updated;
		});
	}
	private expireApprovals(): void {
		for (const item of this.store.all<Approval>("approvals")) {
			if (
				(item.data.status === "pending" || item.data.status === "approved") &&
				Date.parse(item.data.expires_at) <= Date.now()
			) {
				this.saveApproval(item, { ...item.data, status: "expired" });
				this.waiters.get(item.id)?.();
			}
		}
	}
	listTools(scope?: unknown) {
		const input = scope === undefined ? {} : object(scope);
		keys(input, ["workspace_id", "execution_profile_id"]);
		const workspace = this.getWorkspace(
			input.workspace_id === undefined ? "default" : text(input.workspace_id, "workspace_id"),
		);
		const profile = this.getProfile(
			input.execution_profile_id === undefined
				? "default"
				: text(input.execution_profile_id, "execution_profile_id"),
		);
		const signal = new AbortController().signal;
		const builtins: CatalogTool[] = [];
		const collector: Pick<ExtensionAPI, "registerTool"> = {
			registerTool(tool) {
				builtins.push({ name: tool.name, description: tool.description, parameters: tool.parameters });
			},
		};
		filesystemTools(
			new WorkspaceFiles(workspace.data.root, this.protectedRoots, signal),
			workspace.data.root,
			signal,
			collector,
		);
		collector.registerTool(createBashToolDefinition(workspace.data.root));
		collector.registerTool(createPowerShellToolDefinition(workspace.data.root));
		const tools: CatalogTool[] = [
			...builtins,
			{
				name: "codemode",
				description: "Run JavaScript calling other tools; every nested call is independently authorized",
				parameters: codemodeSchema,
			},
			{ name: "tool_search", description: "Search registered tool metadata", parameters: toolSearchSchema },
			...this.catalog(),
		];
		const unique = new Map(tools.map((tool) => [tool.name, tool]));
		return {
			items: [...unique.values()].map((tool) => ({
				name: tool.name,
				description: tool.description ?? "",
				parameters: tool.parameters ?? tool.inputSchema ?? {},
				allowed:
					profile.data.tools.includes(tool.name) &&
					(FILE_TOOLS.includes(tool.name) || profile.data.isolation === "trusted_host"),
				requires_approval: this.requiresApproval(profile.data, tool.name),
				isolation: profile.data.isolation,
			})),
			next_cursor: null,
		};
	}
	private requiresApproval(profile: ExecutionProfile, toolName: string): boolean {
		return (
			profile.isolation === "trusted_host" ||
			!FILE_TOOLS.includes(toolName) ||
			profile.approval === "always" ||
			(profile.approval === "writes" && MUTATING_TOOLS[toolName] === true)
		);
	}

	/** Import spent call identities, including interrupted calls whose external outcome is unknown. */
	importToolCalls(taskId: string, toolCallIds: readonly string[]): void {
		text(taskId, "task_id");
		this.store.transaction(() => {
			for (const toolCallId of toolCallIds) {
				text(toolCallId, "tool_call_id");
				const id = hash([taskId, toolCallId]);
				if (this.store.get<CallRecord>("policy-tool-calls", id)) continue;
				this.store.put<CallRecord>(
					"policy-tool-calls",
					id,
					{
						task_id: taskId,
						tool_call_id: toolCallId,
						fingerprint: hash(["legacy-import", taskId, toolCallId]),
						status: "consumed",
					},
					null,
				);
			}
		});
	}

	async prepare(
		taskId: string,
		workspaceId: string,
		profileId: string,
		signal: AbortSignal,
		onState: (state: "awaiting_approval" | "running", approvalId?: string) => void,
		frozen?: FrozenExecutionScope,
	): Promise<PreparedExecution> {
		if (this.closed) throw new ExecutorError("SERVICE_CLOSED", "Execution policy service is closed");
		aborted(signal);
		if (this.active.has(taskId)) throw new ExecutorError("CONFLICT", "Task already has an active execution scope");
		const workspace = structuredClone(frozen?.workspace ?? this.getWorkspace(workspaceId));
		const profile = structuredClone(frozen?.profile ?? this.getProfile(profileId));
		if (workspace.id !== workspaceId || profile.id !== profileId)
			invalid("Frozen execution scope does not match task configuration");
		if ((await this.workspaceRoot(workspace.data.root)) !== workspace.data.root)
			throw new ExecutorError("WORKSPACE_ESCAPE", "Workspace root changed");
		// Root validation yields to the filesystem. Reserve only after rechecking lifecycle,
		// cancellation and same-task identity, without another await before active.set().
		if (this.closed) throw new ExecutorError("SERVICE_CLOSED", "Execution policy service is closed");
		aborted(signal);
		if (this.active.has(taskId)) throw new ExecutorError("CONFLICT", "Task already has an active execution scope");
		const active = [...this.active.values()].filter((scope) => scope.profileId === profileId).length;
		if (active >= profile.data.max_concurrent_tasks)
			throw new ExecutorError("TASK_CONCURRENCY_LIMIT", "Execution profile concurrency limit reached", true);
		freeze(workspace);
		freeze(profile);
		const controller = new AbortController();
		const scopedSignal = AbortSignal.any([signal, controller.signal]);
		// Timers cannot represent arbitrarily large safe integers. Clamp each interval and recheck.
		const deadline = Date.now() + profile.data.timeout_ms;
		let timer: NodeJS.Timeout;
		const arm = () => {
			timer = setTimeout(
				() => {
					if (Date.now() >= deadline) controller.abort();
					else arm();
				},
				Math.min(2_147_483_647, Math.max(1, deadline - Date.now())),
			);
			timer.unref?.();
		};
		arm();
		const files = new WorkspaceFiles(workspace.data.root, this.protectedRoots, scopedSignal);
		const extensions: InlineExtension[] = [
			{
				name: "workspace-filesystem-guard",
				factory(pi) {
					filesystemTools(files, workspace.data.root, scopedSignal, pi);
					pi.on("user_bash", async () => {
						throw new ExecutorError(
							"TOOL_NOT_ALLOWED",
							"Direct shell execution is not permitted in task sessions",
						);
					});
				},
			},
		];
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			clearTimeout(timer);
			controller.abort();
			this.active.delete(taskId);
		};
		this.active.set(taskId, { profileId, abort: release });
		const scopeHash = hash({ task_id: taskId, workspace, profile, session_id: frozen?.session_id ?? null });
		const authorizeToolCall: HostToolGuard = async (call, callSignal) => {
			try {
				Object.freeze(call);
				const effectiveSignal = callSignal ? AbortSignal.any([scopedSignal, callSignal]) : scopedSignal;
				aborted(effectiveSignal);
				if (!profile.data.tools.includes(call.toolName))
					throw new ExecutorError("TOOL_NOT_ALLOWED", "Tool is not allowed by this execution profile");
				if (!FILE_TOOLS.includes(call.toolName) && profile.data.isolation !== "trusted_host") {
					throw new ExecutorError(
						"ISOLATION_UNAVAILABLE",
						"Arbitrary shell, codemode, MCP and extension tools require trusted_host and per-call approval; no OS sandbox is configured",
					);
				}
				if (FILE_TOOLS.includes(call.toolName))
					await files.check(
						typeof call.input.path === "string" ? call.input.path : ".",
						MUTATING_TOOLS[call.toolName] === true,
					);
				const argsHash = hash(call.input);
				const callKey = hash([taskId, call.toolCallId]);
				const fingerprint = hash([scopeHash, call.toolName, argsHash, call.parentToolCallId ?? null]);
				if (this.store.get<CallRecord>("policy-tool-calls", callKey))
					throw new ExecutorError("TOOL_CALL_REPLAY", "Tool call id has already been admitted or refused");
				this.store.put<CallRecord>(
					"policy-tool-calls",
					callKey,
					{ task_id: taskId, tool_call_id: call.toolCallId, fingerprint, status: "pending" },
					null,
				);
				try {
					if (this.requiresApproval(profile.data, call.toolName)) {
						await this.approveCall(
							call,
							taskId,
							workspaceId,
							profileId,
							argsHash,
							scopeHash,
							effectiveSignal,
							Math.min(profile.data.approval_timeout_ms, Math.max(1, deadline - Date.now())),
							onState,
							frozen?.session_id,
						);
					}
					aborted(effectiveSignal);
					if (hash(call.input) !== argsHash)
						throw new ExecutorError("APPROVAL_SCOPE_CHANGED", "Tool arguments changed after authorization");
					if (FILE_TOOLS.includes(call.toolName))
						await files.check(
							typeof call.input.path === "string" ? call.input.path : ".",
							MUTATING_TOOLS[call.toolName] === true,
						);
					aborted(effectiveSignal);
					// There are no extension handlers after this hook. Freeze retained references too.
					freeze(call.input);
					const record = this.store.require<CallRecord>("policy-tool-calls", callKey);
					this.store.put<CallRecord>(
						"policy-tool-calls",
						callKey,
						{ ...record.data, status: "consumed" },
						record.revision,
					);
					return undefined;
				} catch (error) {
					const record = this.store.require<CallRecord>("policy-tool-calls", callKey);
					if (record.data.status === "pending")
						this.store.put<CallRecord>(
							"policy-tool-calls",
							callKey,
							{ ...record.data, status: "denied" },
							record.revision,
						);
					throw error;
				}
			} catch (error) {
				return { block: true, reason: error instanceof Error ? error.message : "Tool execution denied" };
			}
		};
		return {
			cwd: workspace.data.root,
			workspace,
			profile,
			...(frozen?.session_id ? { session_id: frozen.session_id } : {}),
			extensions,
			tools: [...profile.data.tools],
			signal: scopedSignal,
			authorizeToolCall,
			release,
		};
	}

	private async approveCall(
		call: HostToolCall,
		taskId: string,
		workspaceId: string,
		profileId: string,
		argsHash: string,
		scopeHash: string,
		signal: AbortSignal,
		timeoutMs: number,
		onState: (state: "awaiting_approval" | "running", approvalId?: string) => void,
		sessionId?: string,
	): Promise<void> {
		const id = randomUUID();
		const data: Approval = {
			task_id: taskId,
			workspace_id: workspaceId,
			execution_profile_id: profileId,
			...(sessionId ? { session_id: sessionId } : {}),
			tool_call_id: call.toolCallId,
			...(call.parentToolCallId ? { parent_tool_call_id: call.parentToolCallId } : {}),
			tool_name: call.toolName,
			arguments: JSON.parse(canonical(call.input)) as Record<string, unknown>,
			arguments_sha256: argsHash,
			scope_sha256: scopeHash,
			status: "pending",
			expires_at: new Date(Date.now() + timeoutMs).toISOString(),
		};
		this.store.transaction(() => {
			const record = this.store.put<Approval>("approvals", id, data, null);
			this.store.append(
				sessionId ? `session:${sessionId}` : "system",
				"approval.pending",
				{
					approval_id: id,
					task_id: taskId,
					status: "pending",
					revision: record.revision,
					...(sessionId ? { session_id: sessionId } : {}),
				},
				{ task_id: taskId, ...(sessionId ? { session_id: sessionId } : {}) },
			);
		});
		try {
			onState("awaiting_approval", id);
			const { promise, resolve: resolveWait } = Promise.withResolvers<void>();
			let settled = false;
			let timer: NodeJS.Timeout;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.waiters.delete(id);
				signal.removeEventListener("abort", finish);
				resolveWait();
			};
			const pollDeadline = () => {
				timer = setTimeout(
					() => {
						if (Date.now() >= Date.parse(data.expires_at)) finish();
						else pollDeadline();
					},
					Math.min(2_147_483_647, Math.max(1, Date.parse(data.expires_at) - Date.now())),
				);
				timer.unref?.();
			};
			this.waiters.set(id, finish);
			signal.addEventListener("abort", finish, { once: true });
			pollDeadline();
			if (signal.aborted || this.store.require<Approval>("approvals", id).data.status !== "pending") finish();
			await promise;
			// Commit refusal states before throwing; throwing inside the transaction would
			// roll them back and accidentally leave a reusable approved grant.
			const refusal = this.store.transaction((): ExecutorError | undefined => {
				const item = this.store.require<Approval>("approvals", id);
				if (signal.aborted) {
					if (item.data.status === "pending" || item.data.status === "approved")
						this.saveApproval(item, { ...item.data, status: "cancelled" });
					return new ExecutorError("OPERATION_CANCELLED", "Execution scope is cancelled or expired");
				}
				if (Date.parse(item.data.expires_at) <= Date.now()) {
					if (item.data.status === "pending" || item.data.status === "approved")
						this.saveApproval(item, { ...item.data, status: "expired" });
					return new ExecutorError("APPROVAL_EXPIRED", "Tool approval expired");
				}
				if (item.data.status !== "approved")
					return new ExecutorError("APPROVAL_DENIED", "Tool approval was denied or cancelled");
				if (
					item.data.scope_sha256 !== scopeHash ||
					hash(call.input) !== argsHash ||
					item.data.arguments_sha256 !== argsHash
				) {
					this.saveApproval(item, { ...item.data, status: "cancelled" });
					return new ExecutorError("APPROVAL_SCOPE_CHANGED", "Tool call no longer matches its approval");
				}
				this.saveApproval(item, { ...item.data, status: "consumed", consumed_at: new Date().toISOString() });
				return undefined;
			});
			if (refusal) throw refusal;
		} finally {
			const item = this.store.require<Approval>("approvals", id);
			if (item.data.status === "pending" || item.data.status === "approved")
				this.saveApproval(item, { ...item.data, status: "cancelled" });
			const remaining = this.store
				.all<Approval>("approvals")
				.find(
					(approval) =>
						approval.data.task_id === taskId &&
						(approval.data.status === "pending" || approval.data.status === "approved"),
				);
			if (remaining) onState("awaiting_approval", remaining.id);
			else onState("running");
		}
	}
	close(): void {
		this.closed = true;
		for (const scope of [...this.active.values()]) scope.abort();
		for (const item of this.store.all<Approval>("approvals")) {
			if (item.data.status === "pending" || item.data.status === "approved")
				this.saveApproval(item, { ...item.data, status: "cancelled" });
		}
		for (const resolveWait of this.waiters.values()) resolveWait();
		this.waiters.clear();
	}
}
