import { initializeAdminSettings } from "./admin-settings.js";
import { initializeCompanionSettings } from "./companion-settings.js";
import { initializeLifeSettings } from "./life-settings.js";
import { initializeModelSettings } from "./model-settings.js";
import { initializePersonaSettings } from "./persona-settings.js";

const $ = (id) => document.getElementById(id);
const storage = sessionStorage;
const clientId = storage.getItem("dw-client") || crypto.randomUUID();
storage.setItem("dw-client", clientId);
let token = storage.getItem("dw-token") || "";
let selected = storage.getItem("dw-session") || "";
let sessions = [];
let defaults = {};
let permissions = new Set();
let principalId = "";
let features = {};
let canCreateSessions = false;
let socketPath = "/dw-agent/v1";
let socket;
let socketGeneration = 0;
let authGeneration = 0;
let selectionGeneration = 0;
let sessionsGeneration = 0;
let connected = false;
let reconnectTimer;
let refreshBusy = false;
let sidebarKey = "";
let messagesKey = "";
let tasksKey = "";
let creating = false;
let deleteTarget;
let renameTarget;
let personaOptionsGeneration = 0;
let settingsScopeGeneration = 0;
let companionScope;
const cache = new Map();
const streams = new Map();
const subscriptions = new Map();
const subscribed = new Set();
const recoveringStreams = new Set();
const deleting = new Set();
const absentSessions = new Set();
const executing = new Set();
const pending = new Map();
const reloadTimers = new Map();
const dirtySessions = new Set();
const drafts = new Map();
let catalogs = { workspaces: [], execution: [], models: [] };
try {
	for (const operation of JSON.parse(storage.getItem("dw-http-pending") || "[]")) pending.set(operation.id, operation);
	for (const [id, draft] of JSON.parse(storage.getItem("dw-drafts") || "[]")) drafts.set(id, draft);
} catch {
	storage.removeItem("dw-http-pending");
	storage.removeItem("dw-drafts");
}
// Legacy websocket mutations are deliberately never replayed.
storage.removeItem("dw-pending");
const finalStatuses = new Set(["completed", "failed", "cancelled"]);
const statuses = {
	queued: "排队中",
	running: "执行中",
	awaiting_approval: "等待审批",
	paused: "已暂停",
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消",
};
const labels = {
	"session.created": "会话创建",
	"session.updated": "会话更新",
	"session.deleted": "会话删除",
	"message.created": "消息保存",
	"run.started": "开始回复",
	"run.completed": "回复完成",
	"run.failed": "回复失败",
	"run.cancelled": "回复取消",
	"reply.segment": "回复句段",
	"task.created": "任务创建",
	"task.running": "任务执行",
	"task.paused": "任务暂停",
	"task.completed": "任务完成",
	"task.failed": "任务失败",
	"task.cancelled": "任务取消",
	"tool.started": "工具开始",
	"tool.finished": "工具结束",
};
const errors = {
	AUTH_FAILED: "访问令牌无效",
	SESSION_NOT_FOUND: "此会话已不存在，可能已被其他客户端删除。",
	SESSION_BUSY: "会话仍有正在执行的回复或任务。",
	REVISION_MISMATCH: "内容已被其他客户端更新，请重载后重新确认。",
	SESSION_REVISION_MISMATCH: "会话已更新，请关闭窗口后重新确认。",
	UI_STATE_CHANGED: "连接状态已更新，请重新操作。",
	MODEL_UNAVAILABLE: "模型不可用，请检查模型与凭据配置。",
	MODEL_AUTH_REQUIRED: "请在模型配置中设置供应商凭据。",
};
function node(tag, className, text) {
	const element = document.createElement(tag);
	if (className) element.className = className;
	if (text !== undefined) element.textContent = text;
	return element;
}
function icon(name) {
	const element = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
	use.setAttribute("href", `#i-${name}`);
	element.append(use);
	return element;
}
function state(id = selected) {
	if (!cache.has(id))
		cache.set(id, {
			resource: null,
			messages: new Map(),
			segments: new Map(),
			runs: new Map(),
			runStates: new Map(),
			tasks: new Map(),
			tools: new Map(),
			approvals: [],
			events: [],
			loading: null,
		});
	return cache.get(id);
}
function stream(id) {
	if (!streams.has(id)) streams.set(id, { cursor: 0, buffered: new Map(), seen: new Set() });
	return streams.get(id);
}
function describeError(error) {
	return errors[error?.code] || error?.message || "连接失败";
}
function notify(message, retry = false) {
	$("notice-text").textContent = message;
	$("retry").hidden = !retry;
	$("notice").hidden = !message;
}
function can(permission) {
	return permissions.has(permission);
}
function savePending() {
	storage.setItem("dw-http-pending", JSON.stringify([...pending.values()]));
}
function saveDraft() {
	if (!selected) return;
	drafts.set(selected, { text: $("input").value, kind: $("submission-kind").value });
	storage.setItem("dw-drafts", JSON.stringify([...drafts]));
}
function restoreDraft() {
	const draft = drafts.get(selected);
	$("input").value = draft?.text || "";
	$("submission-kind").value = draft?.kind || "chat";
}
async function api(path, options = {}) {
	const accessToken = token;
	const epoch = authGeneration;
	const headers = new Headers(options.headers);
	headers.set("Authorization", `Bearer ${accessToken}`);
	headers.set("X-Request-Id", crypto.randomUUID());
	if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
	if (options.method && options.method !== "GET" && !headers.has("Idempotency-Key"))
		headers.set("Idempotency-Key", crypto.randomUUID());
	const response = await fetch(path, { ...options, headers, cache: "no-store" });
	const result = response.status === 204 ? null : await response.json();
	if (accessToken !== token || epoch !== authGeneration) throw { code: "UI_STATE_CHANGED" };
	if (!response.ok) {
		if (response.status === 401) {
			token = "";
			storage.removeItem("dw-token");
			clearPrivateData();
			renderPage();
			showAuth();
		}
		throw { ...(result?.error || { message: `HTTP ${response.status}` }), status: response.status };
	}
	return result;
}
async function list(path) {
	const items = [];
	let cursor;
	do {
		const url = new URL(path, location.origin);
		url.searchParams.set("limit", "100");
		if (cursor) url.searchParams.set("cursor", cursor);
		const result = await api(`${url.pathname}${url.search}`);
		items.push(...result.items);
		if (result.next_cursor && result.next_cursor === cursor) throw new Error("资源分页未前进");
		cursor = result.next_cursor;
	} while (cursor);
	return items;
}
function operation(kind, path, body, sessionId = selected, method = "POST") {
	const value = { id: crypto.randomUUID(), kind, path, body, sessionId, method };
	pending.set(value.id, value);
	savePending();
	return value;
}
async function execute(value) {
	if (executing.has(value.id)) return;
	executing.add(value.id);
	render();
	try {
		if (["message", "task"].includes(value.kind)) await ensureSubscription(`session:${value.sessionId}`);
		const result = await api(value.path, {
			method: value.method,
			headers: { "Idempotency-Key": value.id },
			...(value.body === undefined ? {} : { body: JSON.stringify(value.body) }),
		});
		pending.delete(value.id);
		savePending();
		if (value.kind === "session") {
			mergeSession(result);
			storage.setItem("dw-persona", value.body.persona_id);
			storage.setItem("dw-user", value.body.user_id);
			$("new-dialog").close();
			navigate("/");
			await selectSession(result.id);
		} else if (value.kind === "delete") {
			removeSession(value.sessionId);
			$("delete-dialog").close();
		} else {
			if (value.kind === "action" && value.path.startsWith("/api/tasks/"))
				mergeResource(state(value.sessionId).tasks, result);
			if (value.kind === "action" && value.path.startsWith("/api/runs/"))
				mergeResource(state(value.sessionId).runs, result);
			if (value.kind === "message") mergeResource(state(value.sessionId).runs, result);
			if (value.kind === "task") mergeResource(state(value.sessionId).tasks, result);
			if (["message", "task"].includes(value.kind)) {
				const submitted = value.kind === "message" ? value.body.text : value.body.input;
				const draft = drafts.get(value.sessionId);
				if (draft?.text.trim() === submitted && draft.kind === (value.kind === "message" ? "chat" : "task")) {
					drafts.delete(value.sessionId);
					storage.setItem("dw-drafts", JSON.stringify([...drafts]));
					if (selected === value.sessionId && $("input").value.trim() === submitted) restoreDraft();
				}
			}
			if (value.sessionId && !absentSessions.has(value.sessionId)) await loadSession(value.sessionId);
		}
		notify("");
		return result;
	} catch (error) {
		// Only transport/5xx ambiguity is retryable with the exact persisted key and payload.
		if (error.status && error.status < 500) {
			pending.delete(value.id);
			savePending();
		}
		if (error.status === 404 && value.sessionId && ["message", "task", "delete"].includes(value.kind))
			removeSession(value.sessionId);
		throw error;
	} finally {
		executing.delete(value.id);
		render();
	}
}
function send(type, payload) {
	if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("事件连接已断开");
	const id = crypto.randomUUID();
	socket.send(JSON.stringify({ v: 1, type, id, payload }));
	return id;
}
function closeSocket() {
	socketGeneration++;
	clearTimeout(reconnectTimer);
	connected = false;
	subscribed.clear();
	for (const request of subscriptions.values()) {
		clearTimeout(request.timer);
		request.reject(new Error("事件连接已断开"));
	}
	subscriptions.clear();
	if (socket) socket.close();
	socket = undefined;
	renderControls();
}
function connect() {
	closeSocket();
	if (!token) return;
	const generation = socketGeneration;
	const url = new URL(socketPath, location.href);
	url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
	socket = new WebSocket(url);
	socket.addEventListener("open", () => {
		if (generation === socketGeneration) send("hello", { client_id: clientId, token, versions: [1] });
	});
	socket.addEventListener("message", (message) => {
		if (generation !== socketGeneration) return;
		let event;
		try {
			event = JSON.parse(message.data);
		} catch {
			notify("事件数据无效，请重新连接。", true);
			return;
		}
		if (event.type === "hello.accepted") {
			connected = true;
			void ensureSubscription("system").catch((error) => notify(describeError(error), true));
			if (selected)
				void ensureSubscription(`session:${selected}`)
					.then(() => retryPending())
					.catch((error) => notify(describeError(error), true));
			else void retryPending();
			renderControls();
			return;
		}
		const request = subscriptions.get(event.reply_to);
		if (request) {
			clearTimeout(request.timer);
			subscriptions.delete(event.reply_to);
			if (event.type === "subscription.accepted") {
				subscribed.add(request.streamId);
				request.resolve();
			} else {
				const error = event.payload?.error || event.payload || { message: "订阅被拒绝" };
				if (error.code === "SESSION_NOT_FOUND") removeSession(request.streamId.slice("session:".length));
				request.reject(error);
			}
			renderControls();
			return;
		}
		if (event.type === "command.rejected") {
			notify(describeError(event.payload?.error || event.payload), true);
			return;
		}
		if (event.api_version === "1" && event.stream_id && Number.isSafeInteger(event.seq)) ingest(event);
	});
	socket.addEventListener("close", () => {
		if (generation !== socketGeneration) return;
		connected = false;
		subscribed.clear();
		for (const request of subscriptions.values()) {
			clearTimeout(request.timer);
			request.reject(new Error("事件连接已断开"));
		}
		subscriptions.clear();
		renderControls();
		if (token) {
			notify("事件连接已断开，正在重连…", true);
			reconnectTimer = setTimeout(connect, 2000);
		}
	});
	socket.addEventListener("error", () => {
		if (generation === socketGeneration) notify("无法连接事件流", true);
	});
}
async function ensureSubscription(streamId) {
	if (streamId.startsWith("session:") && absentSessions.has(streamId.slice(8))) throw { code: "SESSION_NOT_FOUND" };
	if (subscribed.has(streamId)) return;
	const existing = [...subscriptions.values()].find((value) => value.streamId === streamId);
	if (existing) return existing.promise;
	if (!connected) throw new Error("请等待事件连接就绪，再提交内容。");
	const id = send("subscribe", { stream_id: streamId, after_seq: stream(streamId).cursor });
	let resolve;
	let reject;
	const promise = new Promise((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	const timer = setTimeout(() => {
		subscriptions.delete(id);
		reject(new Error("订阅确认超时，请重新连接。"));
		renderControls();
	}, 15000);
	const recovered = promise.catch((error) => recoverSubscription(streamId, error));
	subscriptions.set(id, { streamId, promise: recovered, resolve, reject, timer });
	return recovered;
}
async function recoverSubscription(streamId, error) {
	if (error.code !== "CURSOR_EXPIRED" || recoveringStreams.has(streamId)) throw error;
	recoveringStreams.add(streamId);
	try {
		if (streamId.startsWith("session:")) {
			const id = streamId.slice(8);
			const resource = await api(`/api/sessions/${encodeURIComponent(id)}`).catch((failure) => {
				if (failure.status === 404) removeSession(id);
				throw failure;
			});
			cache.delete(id);
			mergeSession(resource);
			await loadSession(id);
		}
		const earliest = error.details?.earliest_seq;
		if (!Number.isSafeInteger(earliest) || earliest < 1) throw error;
		const current = stream(streamId);
		current.cursor = earliest - 1;
		current.buffered.clear();
		current.seen.clear();
		await ensureSubscription(streamId);
		notify("事件历史已更新，已重新载入当前资源。");
	} finally {
		recoveringStreams.delete(streamId);
		render();
	}
}
function unsubscribe(id) {
	const streamId = `session:${id}`;
	if (connected && subscribed.has(streamId)) send("unsubscribe", { stream_id: streamId });
	subscribed.delete(streamId);
}
function ingest(event) {
	const current = stream(event.stream_id);
	if (event.seq <= current.cursor || current.seen.has(event.event_id)) return;
	current.buffered.set(event.seq, event);
	while (current.buffered.has(current.cursor + 1)) {
		const next = current.buffered.get(++current.cursor);
		current.buffered.delete(current.cursor);
		current.seen.add(next.event_id);
		applyEvent(next);
	}
	render();
}
function mergeResource(target, resource) {
	if (!resource?.id || !resource.data) return;
	const previous = target.get(resource.id);
	if (!previous || previous.revision <= resource.revision) target.set(resource.id, resource);
}
function mergeSession(resource) {
	if (!resource?.id || absentSessions.has(resource.id)) return;
	const current = state(resource.id);
	if (current.resource && current.resource.revision > resource.revision) return;
	current.resource = resource;
	const index = sessions.findIndex((item) => item.id === resource.id);
	if (index < 0) sessions.push(resource);
	else sessions[index] = resource;
}
function applyEvent(event) {
	const id = event.session_id || (event.stream_id.startsWith("session:") ? event.stream_id.slice(8) : null);
	if (event.type === "session.deleted") {
		if (id || event.data.id) removeSession(id || event.data.id);
		return;
	}
	if (event.type === "session.created" || event.type === "session.updated") mergeSession(event.data);
	if (!id || absentSessions.has(id)) return;
	const current = state(id);
	current.events.push(event);
	if (event.type === "message.created") mergeResource(current.messages, event.data);
	if (event.type === "message.updated") scheduleReload(id);
	if (event.type.startsWith("run.")) {
		current.runStates.set(event.data.id, event.data.status);
		scheduleReload(id);
	}
	if (event.type.startsWith("task.")) scheduleReload(id);
	if (event.type === "reply.segment")
		current.segments.set(event.data.segment_id, {
			...event.data,
			run_id: event.run_id,
			task_id: event.task_id,
			occurred_at: event.occurred_at,
		});
	if (event.type.startsWith("tool.")) {
		const tool = event.data;
		current.tools.set(tool.id || tool.tool_call_id, tool);
	}
	if (event.type === "reply.warning") notify(event.data.message);
	if (event.type.startsWith("approval.") && id === selected)
		void refreshApprovals(id).catch((error) => notify(describeError(error)));
}
function scheduleReload(id) {
	if (reloadTimers.has(id)) {
		dirtySessions.add(id);
		return;
	}
	const epoch = authGeneration;
	reloadTimers.set(
		id,
		setTimeout(async () => {
			dirtySessions.delete(id);
			try {
				if (absentSessions.has(id) || epoch !== authGeneration) return;
				await state(id).loading;
				if (!absentSessions.has(id) && epoch === authGeneration) await loadSession(id);
			} catch (error) {
				if (epoch === authGeneration) notify(describeError(error), true);
			} finally {
				reloadTimers.delete(id);
				if (dirtySessions.delete(id) && !absentSessions.has(id) && epoch === authGeneration) scheduleReload(id);
			}
		}, 100),
	);
}
async function refreshSessions() {
	const request = ++sessionsGeneration;
	const items = await list("/api/sessions");
	if (request !== sessionsGeneration) return;
	const available = new Set(items.map((item) => item.id));
	const known = sessions.map((item) => item.id);
	for (const item of items) mergeSession(item);
	for (const id of known) if (!available.has(id) && !deleting.has(id)) removeSession(id);
	if (selected && !available.has(selected) && !deleting.has(selected)) removeSession(selected);
	render();
}
async function refreshPersonaOptions() {
	const generation = ++personaOptionsGeneration;
	const personas = await list("/api/personas");
	if (generation !== personaOptionsGeneration) return;
	$("persona-options").replaceChildren(
		...personas.map((persona) => {
			const option = node("option");
			option.value = persona.id;
			return option;
		}),
	);
	const scope = currentSettingsScope();
	const ids = [...new Set([...personas.map((item) => item.id), scope.personaId])];
	$("settings-persona").replaceChildren(...ids.map((id) => new Option(id, id)));
	setSettingsScope(scope.personaId, scope.userId);
}
async function refreshCatalogs() {
	const [workspaces, execution, models] = await Promise.all([
		list("/api/workspaces"),
		list("/api/execution-profiles"),
		list("/api/model-profiles"),
	]);
	catalogs = { workspaces, execution, models };
	for (const [id, items, defaultId] of [
		["new-workspace", workspaces, defaults.workspace_id],
		["new-execution-profile", execution, defaults.execution_profile_id],
		["new-model-profile", models, defaults.model_profile_id],
	]) {
		const previous = $(id).value || defaultId;
		$(id).replaceChildren(
			...items.map((item) => new Option(item.data.name ? `${item.data.name} · ${item.id}` : item.id, item.id)),
		);
		if (items.some((item) => item.id === previous)) $(id).value = previous;
	}
	renderControls();
}
async function refreshApprovals(id) {
	if (!can("approve")) {
		state(id).approvals = [];
		return;
	}
	const approvals = await list(`/api/approvals?session_id=${encodeURIComponent(id)}`);
	if (!absentSessions.has(id)) state(id).approvals = approvals;
}
async function loadSession(id = selected) {
	if (!id || absentSessions.has(id)) return;
	const current = state(id);
	if (current.loading) return current.loading;
	current.loading = (async () => {
		try {
			const resource = await api(`/api/sessions/${encodeURIComponent(id)}`).catch((error) => {
				if (error.status === 404 && !deleting.has(id)) removeSession(id);
				throw error;
			});
			const [messages, tasks] = await Promise.all([
				list(`/api/sessions/${encodeURIComponent(id)}/messages`),
				list(`/api/tasks?session_id=${encodeURIComponent(id)}`),
			]);
			if (absentSessions.has(id) || cache.get(id) !== current) return;
			mergeSession(resource);
			for (const message of messages) mergeResource(current.messages, message);
			for (const task of tasks) mergeResource(current.tasks, task);
			await refreshApprovals(id);
			const runIds = new Set(messages.map((item) => item.data.run_id).filter(Boolean));
			if (resource.data.active_run_id) runIds.add(resource.data.active_run_id);
			const runs = await Promise.all(
				[...runIds]
					.filter((runId) => !finalStatuses.has(current.runs.get(runId)?.data.status))
					.map((runId) => api(`/api/runs/${encodeURIComponent(runId)}`)),
			);
			for (const run of runs) mergeResource(current.runs, run);
			const calls = await Promise.all(
				tasks.map((task) => list(`/api/tasks/${encodeURIComponent(task.id)}/tool-calls`)),
			);
			for (const call of calls.flat()) current.tools.set(call.id, call);
			render();
		} finally {
			current.loading = null;
		}
	})();
	return current.loading;
}
async function selectSession(id) {
	if (absentSessions.has(id)) return;
	saveDraft();
	const previous = selected;
	const generation = ++selectionGeneration;
	if (previous && previous !== id) unsubscribe(previous);
	selected = id;
	storage.setItem("dw-session", id);
	restoreDraft();
	notify("");
	render();
	try {
		// Subscribe independently of history: replay and message history merge by resource/segment IDs.
		if (connected) await ensureSubscription(`session:${id}`);
		else if (!socket) connect();
		await loadSession(id);
		if (generation === selectionGeneration && selected === id) render();
	} catch (error) {
		if (generation === selectionGeneration) notify(describeError(error), true);
	}
}
function removeSession(id) {
	absentSessions.add(id);
	unsubscribe(id);
	sessionsGeneration++;
	sessions = sessions.filter((item) => item.id !== id);
	cache.delete(id);
	drafts.delete(id);
	storage.setItem("dw-drafts", JSON.stringify([...drafts]));
	for (const [key, value] of pending) if (value.sessionId === id) pending.delete(key);
	savePending();
	if (selected === id) {
		selectionGeneration++;
		selected = "";
		storage.removeItem("dw-session");
		restoreDraft();
		notify("此会话已删除。请选择其他会话或新建会话。");
	}
	if (deleteTarget?.id === id && !deleting.has(id)) {
		deleteTarget.invalid = true;
		$("delete-error").textContent = errors.SESSION_NOT_FOUND;
		$("delete-error").hidden = false;
		$("delete-confirm").disabled = true;
	}
	render();
}
function showDelete(id) {
	const resource = state(id).resource;
	if (!resource || deleting.has(id) || !can("chat")) return;
	const busy = Boolean(
		resource.data.active_run_id || [...state(id).tasks.values()].some((item) => !finalStatuses.has(item.data.status)),
	);
	deleteTarget = { id, revision: resource.revision, epoch: authGeneration, busy };
	$("delete-preview").textContent = resource.data.title || "新会话";
	$("delete-session-id").textContent = id;
	$("delete-paused").hidden = ![...state(id).tasks.values()].some((item) => !finalStatuses.has(item.data.status));
	$("delete-busy").hidden = !busy;
	$("delete-error").hidden = true;
	$("delete-confirm").disabled = busy;
	$("delete-confirm").textContent = "永久删除";
	$("delete-dialog").showModal();
	$("delete-cancel").focus();
}
async function deleteSession(event) {
	event.preventDefault();
	const target = deleteTarget;
	if (!target || target.invalid || target.busy || deleting.has(target.id)) return;
	deleting.add(target.id);
	for (const id of ["delete-confirm", "delete-cancel", "close-delete"]) $(id).disabled = true;
	$("delete-confirm").textContent = "删除中…";
	try {
		await execute(
			operation(
				"delete",
				`/api/sessions/${encodeURIComponent(target.id)}?expected_revision=${target.revision}`,
				undefined,
				target.id,
				"DELETE",
			),
		);
	} catch (error) {
		if (target.epoch !== authGeneration) return;
		if (error.status === 409) {
			target.invalid = true;
			await refreshSessions();
		}
		$("delete-error").textContent = `${describeError(error)}${pending.size ? " 可通过重新连接重试同一请求。" : ""}`;
		$("delete-error").hidden = false;
	} finally {
		deleting.delete(target.id);
		$("delete-confirm").disabled = Boolean(target.invalid || absentSessions.has(target.id));
		$("delete-confirm").textContent = "永久删除";
		$("delete-cancel").disabled = false;
		$("close-delete").disabled = false;
		render();
	}
}
function renderSessions() {
	const query = $("search").value.trim().toLowerCase();
	const root = $("sessions");
	const key = JSON.stringify([
		selected,
		location.pathname,
		query,
		can("chat"),
		[...deleting],
		sessions.map((item) => [item.id, item.revision]),
	]);
	if (key === sidebarKey) return;
	sidebarKey = key;
	root.replaceChildren();
	$("session-count").textContent = sessions.length;
	const items = sessions.filter((item) =>
		`${item.data.title} ${item.data.persona_id} ${item.id}`.toLowerCase().includes(query),
	);
	for (const item of [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at))) {
		const row = node("div", "session-row");
		const active = selected === item.id && location.pathname === "/";
		const button = node("button", `session-item${active ? " selected" : ""}`);
		button.title = item.data.title || item.id;
		button.setAttribute("aria-current", active ? "page" : "false");
		button.setAttribute("aria-label", `打开会话：${item.data.title || "新会话"}（${item.id}）`);
		const itemIcon = node("span", "item-icon");
		itemIcon.append(icon("chat"));
		const body = node("span", "item-body");
		body.append(
			node("strong", "", item.data.title || "新会话"),
			node("small", "", `${item.data.persona_id} · ${item.data.user_id}`),
		);
		button.append(itemIcon, body, node("span", `status-dot${item.data.active_run_id ? " busy" : ""}`));
		button.addEventListener("click", () => {
			navigate("/");
			void selectSession(item.id);
		});
		const remove = node("button", "session-delete danger");
		remove.dataset.sessionId = item.id;
		remove.setAttribute("aria-label", `删除会话：${item.data.title || "新会话"}（${item.id}）`);
		remove.disabled = deleting.has(item.id) || !can("chat");
		remove.append(icon("trash"));
		remove.addEventListener("click", () => showDelete(item.id));
		row.append(button, remove);
		root.append(row);
	}
	if (!items.length) root.append(node("p", "no-sessions", query ? "无匹配会话" : "暂无会话"));
}
function activeRun(current) {
	const running = [...current.runStates].find(([, status]) => !finalStatuses.has(status));
	if (running) return running[0];
	const runs = [...current.runs.values()].filter(
		(item) => !finalStatuses.has(current.runStates.get(item.id) || item.data.status),
	);
	const active = current.resource?.data.active_run_id;
	return (
		runs.at(-1)?.id ||
		(active && !finalStatuses.has(current.runStates.get(active) || current.runs.get(active)?.data.status)
			? active
			: null)
	);
}
function renderControls() {
	const current = state();
	const hasSession = Boolean(selected && current.resource && !absentSessions.has(selected));
	const taskSupported = features.tasks === true;
	const chatSupported = features.chat === true;
	const run = activeRun(current);
	const task = $("submission-kind").value === "task";
	const awaiting = [...pending.values()].some((item) => item.sessionId === selected);
	const ready = connected && subscribed.has(`session:${selected}`);
	$("connection-label").textContent = !token ? "未连接" : connected ? "已连接" : "连接中";
	$("connection-dot").className = `status-dot${connected ? " online" : ""}`;
	// Draft editing remains available during generation and reconnect; only submission waits.
	$("input").disabled = !hasSession || deleting.has(selected);
	$("submission-kind").disabled = !hasSession;
	$("send").disabled =
		!hasSession ||
		!ready ||
		awaiting ||
		deleting.has(selected) ||
		!can(task ? "execute" : "chat") ||
		!(task ? taskSupported : chatSupported) ||
		(!task && Boolean(run)) ||
		!$("input").value.trim();
	$("send").setAttribute("aria-label", task ? "创建独立任务" : "发送对话");
	$("cancel").hidden = !run;
	$("cancel").disabled = !can("chat") || awaiting;
	$("rename-session").disabled = !hasSession || !can("chat") || deleting.has(selected) || awaiting;
	$("run-state").replaceChildren(
		node("span", `status-dot${run ? " busy" : hasSession ? " online" : ""}`),
		document.createTextNode(!hasSession ? "未选择会话" : run ? "回复中" : "对话就绪"),
	);
	$("inspector-status").textContent = run ? "回复中" : "空闲";
	$("composer-context").textContent = !hasSession
		? "选择或新建会话"
		: !ready
			? "等待事件订阅，草稿已保留"
			: awaiting
				? "请求处理中 · 重连使用同一请求标识"
				: task
					? "独立任务 · 不占用对话执行器"
					: run
						? "回复进行中 · 可编辑下一条草稿"
						: "对话 · Ctrl / ⌘ + Enter 发送";
	const pendingCreation = [...pending.values()].some((item) => item.kind === "session");
	$("new-session").disabled = creating || pendingCreation || (Boolean(token) && !canCreateSessions);
	$("create").disabled =
		creating ||
		pendingCreation ||
		!canCreateSessions ||
		!catalogs.workspaces.length ||
		!catalogs.execution.length ||
		!catalogs.models.length;
}
function messageSegments(current, resource) {
	const segments = new Map();
	for (const segment of resource.data.segments || []) segments.set(segment.segment_id, segment);
	for (const segment of current.segments.values())
		if (segment.message_id === resource.id) segments.set(segment.segment_id, segment);
	return [...segments.values()].sort((a, b) => a.index - b.index);
}
function renderMessages(current) {
	const key = JSON.stringify([
		selected,
		[...current.messages.values()],
		[...current.segments.values()],
		[...current.runs.values()].map((item) => [item.id, item.revision]),
	]);
	if (key === messagesKey) return;
	messagesKey = key;
	const resources = new Map(current.messages);
	for (const segment of current.segments.values()) {
		if (!resources.has(segment.message_id))
			resources.set(segment.message_id, {
				id: segment.message_id,
				created_at: segment.occurred_at,
				data: { role: "assistant", run_id: segment.run_id, task_id: segment.task_id, text: "" },
			});
	}
	const entries = [...resources.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
	const conversation = $("conversation");
	const stick = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 100;
	const root = $("messages");
	root.replaceChildren();
	const expressions = new Map();
	for (const resource of entries) {
		const data = resource.data;
		const segments = messageSegments(current, resource);
		const text = segments.length
			? segments.map((item) => item.text || `（${item.expression.description}）${item.speech}`).join("")
			: data.text;
		for (const segment of segments) expressions.set(segment.segment_id, segment);
		const article = node("article", `message ${data.role}`);
		article.dataset.messageId = resource.id;
		const body = node("div", "message-body");
		const label = node("div", "message-label", data.role === "user" ? "你" : "dw-agent");
		if (data.task_id) label.append(node("span", "action-label", "任务结果"));
		body.append(label, node("div", "message-text", text || ""));
		const run = current.runs.get(data.run_id);
		if (run && ["cancelled", "failed"].includes(run.data.status))
			body.append(
				node(
					"p",
					`feed-note${run.data.status === "failed" ? " error" : ""}`,
					`${statuses[run.data.status]} · 已接收的句段保留${run.data.error ? ` · ${describeError(run.data.error)}` : ""}`,
				),
			);
		article.append(node("div", "avatar", data.role === "user" ? "U" : "dw"), body);
		root.append(article);
	}
	$("empty").hidden = entries.length > 0;
	$("empty").querySelector("h2").textContent = selected ? "开始对话" : "开始一个会话";
	$("empty-new").hidden = Boolean(selected);
	if (stick) conversation.scrollTop = conversation.scrollHeight;
	$("expressions").replaceChildren();
	$("expression-count").textContent = expressions.size;
	if (!expressions.size) $("expressions").append(node("p", "muted", "暂无表达句段"));
	for (const segment of expressions.values()) {
		const card = node("article", "expression-card");
		const heading = node("header");
		heading.append(node("strong", "", `句段 ${segment.index + 1}`), node("span", "", segment.expression.language));
		card.append(heading, node("p", "", segment.expression.description), node("p", "segment-speech", segment.speech));
		if (segment.task_refs?.length) card.append(node("small", "", `任务引用：${segment.task_refs.join("、")}`));
		$("expressions").append(card);
	}
}
function actionButton(label, action, disabled = false) {
	const button = node("button", "text-button", label);
	button.type = "button";
	button.disabled = disabled;
	button.addEventListener("click", async () => {
		button.disabled = true;
		try {
			await action();
		} catch (error) {
			notify(describeError(error), true);
		} finally {
			render();
		}
	});
	return button;
}
function renderTasks(current) {
	const key = JSON.stringify([
		selected,
		can("execute"),
		can("approve"),
		features.tasks,
		[...current.tasks.values()],
		current.approvals,
		[...pending.keys()],
	]);
	if (key === tasksKey) return;
	tasksKey = key;
	$("tasks").replaceChildren();
	$("task-count").textContent = current.tasks.size;
	if (!current.tasks.size) $("tasks").append(node("p", "muted", "暂无独立任务。选择“任务”后提交可执行工具。"));
	for (const task of current.tasks.values()) {
		const card = node("article", "task-card");
		card.dataset.taskId = task.id;
		const data = task.data;
		const heading = node("header");
		heading.append(node("strong", "", statuses[data.status] || data.status), node("small", "", task.id));
		card.append(heading, node("p", "task-input", data.input));
		if (data.pause_requested && data.status !== "paused")
			card.append(node("p", "field-note", "已请求暂停，等待安全边界；尚未暂停。"));
		if (data.error) card.append(node("p", "form-error", describeError(data.error)));
		if (data.result)
			card.append(
				node(
					"p",
					"task-result",
					typeof data.result === "string" ? data.result : data.result.text || JSON.stringify(data.result, null, 2),
				),
			);
		const controls = node("div", "task-controls");
		const waiting = [...pending.values()].some((item) =>
			item.path.startsWith(`/api/tasks/${encodeURIComponent(task.id)}/`),
		);
		for (const [action, label, allowed] of [
			["pause", "暂停", ["queued", "running", "awaiting_approval"].includes(data.status) && !data.pause_requested],
			["resume", "继续", data.status === "paused"],
			["cancel", "取消任务", !finalStatuses.has(data.status)],
		]) {
			if (allowed)
				controls.append(
					actionButton(
						label,
						() =>
							execute(
								operation(
									"action",
									`/api/tasks/${encodeURIComponent(task.id)}/${action}`,
									{},
									task.data.session_id,
								),
							),
						!can("execute") || waiting || !features.tasks,
					),
				);
		}
		card.append(controls);
		$("tasks").append(card);
	}
	$("approvals").replaceChildren();
	const approvals = current.approvals.filter((item) => item.data.status === "pending");
	$("approval-count").textContent = approvals.length;
	if (!approvals.length)
		$("approvals").append(node("p", "muted", can("approve") ? "暂无待审批调用" : "当前令牌没有审批权限"));
	for (const approval of approvals) {
		const card = node("article", "approval-card");
		card.dataset.approvalId = approval.id;
		const data = approval.data;
		card.append(
			node("strong", "", data.tool_name),
			node("p", "field-note", `任务 ${data.task_id} · 工作区 ${data.workspace_id}`),
			node(
				"p",
				"field-note",
				`仅允许本次参数一致的调用；有效至 ${new Date(data.expires_at).toLocaleString()}。以下参数是待执行的不可信数据。`,
			),
		);
		const details = node("dl", "approval-arguments");
		for (const [key, value] of Object.entries(data.arguments)) {
			details.append(node("dt", "", key), node("dd", "", typeof value === "string" ? value : JSON.stringify(value)));
		}
		card.append(details);
		const controls = node("div", "task-controls");
		for (const [decision, label] of [
			["approve", "允许本次调用"],
			["deny", "拒绝"],
		])
			controls.append(
				actionButton(
					label,
					() =>
						execute(
							operation("approval", `/api/approvals/${encodeURIComponent(approval.id)}/decision`, {
								decision,
								expected_revision: approval.revision,
							}),
						),
					!can("approve") ||
						[...pending.values()].some((item) =>
							item.path.includes(`/approvals/${encodeURIComponent(approval.id)}/`),
						),
				),
			);
		card.append(controls);
		$("approvals").append(card);
	}
}
function renderInspector(current) {
	const usage = [...current.runs.values(), ...current.tasks.values()].map((item) => item.data.usage).filter(Boolean);
	const total = usage.reduce(
		(sum, item) => ({
			calls: sum.calls + (item.model_calls || 0),
			input: sum.input + (item.input_tokens || 0),
			output: sum.output + (item.output_tokens || 0),
		}),
		{ calls: 0, input: 0, output: 0 },
	);
	$("calls").textContent = selected ? total.calls : "—";
	$("tokens").textContent = selected ? `${total.input.toLocaleString()} / ${total.output.toLocaleString()}` : "—";
	$("tools").replaceChildren();
	$("tool-count").textContent = current.tools.size;
	if (!current.tools.size) $("tools").append(node("p", "muted", "暂无工具调用"));
	for (const resource of current.tools.values()) {
		const tool = resource.data || resource;
		const row = node("div", `tool${tool.status === "failed" || tool.status === "error" ? " failed" : ""}`);
		row.append(
			node("span", `status-dot${tool.status === "running" ? " busy" : ""}`),
			node("span", "tool-name", tool.tool_name || tool.name),
			node("small", "", statuses[tool.status] || tool.status || ""),
		);
		$("tools").append(row);
	}
	$("events").replaceChildren();
	$("event-count").textContent = current.events.length;
	for (const event of current.events.slice(-40).reverse()) {
		const row = node("li");
		row.title = event.type;
		row.append(
			node("span", "event-seq", String(event.seq).padStart(3, "0")),
			node("span", "event-name", labels[event.type] || event.type),
		);
		$("events").append(row);
	}
}
function render() {
	renderSessions();
	renderControls();
	const current = state();
	const data = current.resource?.data || {};
	$("session-title").textContent = data.title || (selected ? "新会话" : "工作台");
	const workspace = catalogs.workspaces.find((item) => item.id === data.workspace_id);
	$("session-path").textContent = selected
		? `${workspace?.data.name || data.workspace_id || "—"} · ${data.execution_profile_id || "—"}`
		: "—";
	$("session-path").title = workspace?.data.root || "";
	$("persona").textContent = data.persona_id ? `${data.persona_id} / ${data.persona_revision}` : "—";
	$("session-id").textContent = selected || "—";
	$("session-id").title = selected;
	$("sequence").textContent = selected ? stream(`session:${selected}`).cursor : "—";
	$("current-model").textContent = data.model_profile_id || "—";
	renderMessages(current);
	renderTasks(current);
	renderInspector(current);
}
function clearPrivateData() {
	authGeneration++;
	selectionGeneration++;
	sessionsGeneration++;
	closeSocket();
	for (const timer of reloadTimers.values()) clearTimeout(timer);
	reloadTimers.clear();
	dirtySessions.clear();
	deleteTarget = undefined;
	renameTarget = undefined;
	deleting.clear();
	absentSessions.clear();
	cache.clear();
	streams.clear();
	pending.clear();
	drafts.clear();
	permissions.clear();
	principalId = "";
	features = {};
	canCreateSessions = false;
	sessions = [];
	selected = "";
	creating = false;
	catalogs = { workspaces: [], execution: [], models: [] };
	for (const id of ["delete-dialog", "new-dialog", "rename-dialog"]) $(id).close();
	$("input").value = "";
	personaOptionsGeneration++;
	$("persona-options").replaceChildren();
	$("new-persona").value = "default";
	$("new-user").value = "local";
	for (const panel of [modelSettings, personaSettings, companionSettings, lifeSettings, adminSettings])
		panel.reset({ discard: true });
	companionScope = undefined;
	settingsScopeGeneration++;
	$("settings-persona").replaceChildren(new Option("default", "default"));
	$("settings-user").value = "local";
	for (const key of ["dw-session", "dw-http-pending", "dw-drafts", "dw-persona", "dw-user"]) storage.removeItem(key);
	render();
}
function showAuth() {
	$("logout").hidden = !token;
	$("auth-error").hidden = true;
	$("token").value = token;
	if (!$("auth-dialog").open) $("auth-dialog").showModal();
}
function currentSettingsScope() {
	return (
		companionScope ?? {
			personaId: state().resource?.data.persona_id || storage.getItem("dw-persona") || "default",
			userId: state().resource?.data.user_id || storage.getItem("dw-user") || "local",
		}
	);
}
function setSettingsScope(personaId, userId) {
	companionScope = { personaId, userId };
	if (![...$("settings-persona").options].some((option) => option.value === personaId))
		$("settings-persona").append(new Option(personaId, personaId));
	$("settings-persona").value = personaId;
	$("settings-user").value = userId;
	$("settings-scope-summary").textContent = `当前范围：${personaId} × ${userId} · 点击切换`;
}
function renderPage() {
	const page = location.pathname.slice(1);
	const settings = ["models", "personas", "companion", "life", "admin"].includes(page);
	settingsScopeGeneration++;
	$("settings-shell").hidden = !settings;
	$("settings-scope-fields").disabled = !token;
	$("settings-scope-details").hidden = page === "admin";
	$("settings-scope-details").open = !matchMedia("(max-width: 700px)").matches;
	$("settings-entry").setAttribute("aria-current", settings ? "page" : "false");
	if (settings) {
		const scope = currentSettingsScope();
		setSettingsScope(scope.personaId, scope.userId);
	}
	$("settings-scope-note").textContent =
		page === "models"
			? "后台模型分工：当前人格 × 用户；模型配置、供应商和凭据：全局共享。未保存草稿按范围分别保留。"
			: page === "personas"
				? "角色档案只按人格保存，用户不影响角色卡。聊天需新建会话；后台生活使用最新保存的角色卡。"
				: "关系、生活和后台模型使用同一人格 × 用户范围；切换范围保留各自草稿。用户 ID 不是访问权限。";
	for (const name of ["models", "personas", "companion", "life", "admin"])
		$("workspace").classList.toggle(`${name}-open`, page === name);
	$("session-page").hidden = settings;
	$("inspector").hidden = settings;
	for (const [name, id] of [
		["models", "model"],
		["personas", "persona"],
		["companion", "companion"],
		["life", "life"],
		["admin", "admin"],
	]) {
		$(`${name}-page`).hidden = page !== name;
		$(`${id}-settings`).setAttribute("aria-current", page === name ? "page" : "false");
	}
	$("admin-settings").hidden = !can("manage");
	const titles = {
		models: "模型与分工",
		personas: "角色档案",
		companion: "角色与记忆",
		life: "生活任务",
		admin: "管理",
	};
	document.title = settings ? `${titles[page]} · dw-agent` : "dw-agent";
	renderSessions();
	if (page === "models" && token) void modelSettings.load();
	else modelSettings.reset();
	if (page === "personas" && token) void personaSettings.load({ personaId: currentSettingsScope().personaId });
	else personaSettings.reset();
	if (page === "companion" && token) void companionSettings.load(currentSettingsScope());
	else companionSettings.reset();
	if (["life", "models"].includes(page) && token)
		void lifeSettings.load({ ...currentSettingsScope(), mode: page === "models" ? "models" : "life" });
	else lifeSettings.reset();
	if (page === "admin" && token) void adminSettings.load();
	else adminSettings.reset();
}
function navigate(path) {
	if (location.pathname === path) return;
	history.pushState(null, "", path);
	renderPage();
}
function showNew() {
	if (!token) {
		showAuth();
		return;
	}
	navigate("/");
	$("new-error").hidden = true;
	$("new-dialog").showModal();
	void Promise.all([refreshPersonaOptions(), refreshCatalogs()]).catch((error) => {
		$("new-error").textContent = describeError(error);
		$("new-error").hidden = false;
	});
}
async function retryPending() {
	for (const value of [...pending.values()]) {
		if (executing.has(value.id)) continue;
		if (value.sessionId && absentSessions.has(value.sessionId)) continue;
		try {
			await execute(value);
		} catch (error) {
			notify(describeError(error), true);
		}
	}
}
async function start() {
	const epoch = authGeneration;
	const bootstrap = await api("/api/bootstrap");
	defaults = bootstrap.defaults;
	socketPath = bootstrap.socket_path;
	permissions = new Set(bootstrap.principal.permissions);
	principalId = bootstrap.principal.id;
	canCreateSessions = can("chat") && bootstrap.principal.session_ids === null;
	const capabilities = await api("/api/capabilities");
	features = capabilities.features;
	canCreateSessions = canCreateSessions && features.chat === true;
	await Promise.all([refreshSessions(), refreshCatalogs(), refreshPersonaOptions()]);
	if (epoch !== authGeneration) return;
	const target = sessions.some((item) => item.id === selected) ? selected : sessions.at(-1)?.id || "";
	connect();
	if (target) await selectSession(target);
	else render();
}
$("auth-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	closeSocket();
	const nextToken = $("token").value.trim();
	if (nextToken !== token) clearPrivateData();
	else {
		authGeneration++;
		selectionGeneration++;
		sessionsGeneration++;
	}
	token = nextToken;
	storage.setItem("dw-token", token);
	$("auth-submit").disabled = true;
	const epoch = authGeneration;
	try {
		await start();
		if (epoch !== authGeneration) return;
		$("auth-dialog").close();
		renderPage();
		notify("");
	} catch (error) {
		if (epoch === authGeneration) {
			$("auth-error").textContent = describeError(error);
			$("auth-error").hidden = false;
		}
	} finally {
		$("auth-submit").disabled = false;
	}
});
$("logout").addEventListener("click", () => {
	token = "";
	clearPrivateData();
	storage.removeItem("dw-token");
	$("token").value = "";
	$("auth-dialog").close();
	notify("");
	renderPage();
});
$("close-auth").addEventListener("click", () => $("auth-dialog").close());
$("connection").addEventListener("click", showAuth);
for (const id of ["new-session", "empty-new"]) $(id).addEventListener("click", showNew);
$("close-new").addEventListener("click", () => $("new-dialog").close());
$("delete-form").addEventListener("submit", deleteSession);
for (const id of ["close-delete", "delete-cancel"]) $(id).addEventListener("click", () => $("delete-dialog").close());
$("delete-dialog").addEventListener("cancel", (event) => {
	if (deleteTarget && deleting.has(deleteTarget.id)) event.preventDefault();
});
$("delete-dialog").addEventListener("close", () => {
	const target = deleteTarget;
	deleteTarget = undefined;
	if (!target || target.epoch !== authGeneration || $("auth-dialog").open) return;
	const opener = [...$("sessions").querySelectorAll(".session-delete")].find(
		(button) => button.dataset.sessionId === target.id,
	);
	(opener || $("new-session")).focus();
});
$("new-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	if (creating || !canCreateSessions || [...pending.values()].some((item) => item.kind === "session")) return;
	creating = true;
	$("create").disabled = true;
	$("new-error").hidden = true;
	try {
		await execute(
			operation(
				"session",
				"/api/sessions",
				{
					persona_id: $("new-persona").value.trim(),
					user_id: $("new-user").value.trim(),
					workspace_id: $("new-workspace").value,
					execution_profile_id: $("new-execution-profile").value,
					model_profile_id: $("new-model-profile").value,
				},
				"",
			),
		);
	} catch (error) {
		$("new-error").textContent = describeError(error);
		$("new-error").hidden = false;
		notify(describeError(error), true);
	} finally {
		creating = false;
		renderControls();
	}
});
$("composer").addEventListener("submit", async (event) => {
	event.preventDefault();
	if ($("send").disabled) return;
	const id = selected;
	const text = $("input").value.trim();
	const task = $("submission-kind").value === "task";
	saveDraft();
	try {
		await execute(
			operation(
				task ? "task" : "message",
				`/api/sessions/${encodeURIComponent(id)}/${task ? "tasks" : "messages"}`,
				task ? { input: text } : { text },
				id,
			),
		);
	} catch (error) {
		notify(describeError(error), true);
	}
});
$("input").addEventListener("input", () => {
	saveDraft();
	renderControls();
});
$("input").addEventListener("keydown", (event) => {
	if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
		event.preventDefault();
		$("composer").requestSubmit();
	}
});
$("submission-kind").addEventListener("change", () => {
	saveDraft();
	renderControls();
});
$("search").addEventListener("input", renderSessions);
$("cancel").addEventListener("click", async () => {
	const run = activeRun(state());
	if (!run) return;
	try {
		await execute(operation("action", `/api/runs/${encodeURIComponent(run)}/cancel`, {}));
	} catch (error) {
		notify(describeError(error), true);
	}
});
$("rename-session").addEventListener("click", () => {
	const resource = state().resource;
	if (!resource) return;
	renameTarget = { id: resource.id, revision: resource.revision };
	$("rename-value").value = resource.data.title || "新会话";
	$("rename-error").hidden = true;
	$("rename-dialog").showModal();
	$("rename-value").select();
});
$("close-rename").addEventListener("click", () => $("rename-dialog").close());
$("rename-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const target = renameTarget;
	if (!target) return;
	$("rename-save").disabled = true;
	try {
		const result = await execute(
			operation(
				"rename",
				`/api/sessions/${encodeURIComponent(target.id)}`,
				{ title: $("rename-value").value.trim(), expected_revision: target.revision },
				target.id,
				"PATCH",
			),
		);
		mergeSession(result);
		$("rename-dialog").close();
		render();
	} catch (error) {
		$("rename-error").textContent = describeError(error);
		$("rename-error").hidden = false;
	} finally {
		$("rename-save").disabled = false;
	}
});
$("refresh").addEventListener("click", () => void refreshSessions().catch((error) => notify(describeError(error))));
$("retry").addEventListener("click", () => {
	if (token) connect();
	else showAuth();
});
$("dismiss-notice").addEventListener("click", () => notify(""));
$("toggle-panel").addEventListener("click", () => {
	const mobile = matchMedia("(max-width: 1150px)").matches;
	$("workspace").classList.toggle(mobile ? "panel-open" : "panel-hidden");
	$("toggle-panel").setAttribute(
		"aria-expanded",
		String(
			mobile ? $("workspace").classList.contains("panel-open") : !$("workspace").classList.contains("panel-hidden"),
		),
	);
});
function selectTab(tab, focus = false) {
	for (const name of ["execution", "expressions"]) {
		const active = tab === name;
		$(`tab-${name}`).setAttribute("aria-selected", String(active));
		$(`tab-${name}`).tabIndex = active ? 0 : -1;
		$(`${name}-panel`).hidden = !active;
	}
	if (focus) $(`tab-${tab}`).focus();
}
for (const tab of ["execution", "expressions"]) {
	$(`tab-${tab}`).addEventListener("click", () => selectTab(tab));
	$(`tab-${tab}`).addEventListener("keydown", (event) => {
		if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
			event.preventDefault();
			selectTab(
				event.key === "Home"
					? "execution"
					: event.key === "End"
						? "expressions"
						: tab === "execution"
							? "expressions"
							: "execution",
				true,
			);
		}
	});
}
const modelSettings = initializeModelSettings({
	api,
	canManage: () => can("manage"),
	onSaved: () => {
		if (token && ["/models", "/life"].includes(location.pathname)) void lifeSettings.refreshModelCatalog();
		void refreshCatalogs().catch((error) => notify(describeError(error)));
	},
});
$("new-persona").value = storage.getItem("dw-persona") || "default";
$("new-user").value = storage.getItem("dw-user") || "local";
const personaSettings = initializePersonaSettings({
	api,
	canManage: () => can("manage"),
	onUse: (id) => {
		storage.setItem("dw-persona", id);
		$("new-persona").value = id;
		showNew();
	},
	onChange: () => refreshPersonaOptions().catch((error) => notify(describeError(error))),
	onSelect: (id) => setSettingsScope(id, currentSettingsScope().userId),
});
function useScope(personaId, userId) {
	storage.setItem("dw-persona", personaId);
	storage.setItem("dw-user", userId);
	$("new-persona").value = personaId;
	$("new-user").value = userId;
	showNew();
}
const companionSettings = initializeCompanionSettings({
	api,
	canManage: () => can("manage"),
	onUse: useScope,
	onScopeChange: setSettingsScope,
});
const lifeSettings = initializeLifeSettings({ api, canManage: () => can("manage"), onUse: useScope });
const adminSettings = initializeAdminSettings({
	api,
	canManage: () => can("manage"),
	canManageTokens: () => principalId === "root",
	notify,
});
for (const link of [
	...[
		"settings-entry",
		"settings-back",
		"model-settings",
		"persona-settings",
		"companion-settings",
		"life-settings",
		"admin-settings",
	].map($),
	...document.querySelectorAll("[data-settings-link]"),
])
	link.addEventListener("click", (event) => {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		navigate(link.getAttribute("href"));
		if (location.pathname !== "/" && !token) showAuth();
	});
$("settings-scope-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	if (!token || !$("settings-scope-form").reportValidity()) return;
	const requested = { personaId: $("settings-persona").value, userId: $("settings-user").value };
	const previous = currentSettingsScope();
	const epoch = ++settingsScopeGeneration;
	if (location.pathname === "/personas") {
		const loaded = await personaSettings.select(requested.personaId);
		if (epoch !== settingsScopeGeneration) return;
		if (!loaded) {
			setSettingsScope(previous.personaId, previous.userId);
			return;
		}
		setSettingsScope(requested.personaId, requested.userId);
		if (matchMedia("(max-width: 700px)").matches) $("settings-scope-details").open = false;
		return;
	}
	setSettingsScope(requested.personaId, requested.userId);
	if (matchMedia("(max-width: 700px)").matches) $("settings-scope-details").open = false;
	if (location.pathname === "/companion") void companionSettings.load(requested);
	else if (["/life", "/models"].includes(location.pathname))
		void lifeSettings.load({ ...requested, mode: location.pathname === "/models" ? "models" : "life" });
});
matchMedia("(max-width: 700px)").addEventListener("change", (event) => {
	$("settings-scope-details").open = !event.matches;
});
window.addEventListener("popstate", renderPage);
window.addEventListener("keydown", (event) => {
	if (
		event.key === "Escape" &&
		$("workspace").classList.contains("panel-open") &&
		!document.querySelector("dialog[open]")
	) {
		$("workspace").classList.remove("panel-open");
		$("toggle-panel").setAttribute("aria-expanded", "false");
		$("toggle-panel").focus();
	}
});
setInterval(async () => {
	if (!token || refreshBusy || document.hidden) return;
	refreshBusy = true;
	const epoch = authGeneration;
	try {
		await refreshSessions();
		if (epoch === authGeneration && selected) await loadSession(selected);
	} catch (error) {
		if (epoch === authGeneration) notify(describeError(error), true);
	} finally {
		refreshBusy = false;
	}
}, 2500);
restoreDraft();
render();
renderPage();
$("toggle-panel").setAttribute("aria-expanded", String(!matchMedia("(max-width: 1150px)").matches));
if (token)
	void start()
		.then(renderPage)
		.catch((error) => notify(describeError(error), true));
else showAuth();
