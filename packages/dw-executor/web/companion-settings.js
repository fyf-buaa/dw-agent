import { createRecordEditor } from "./record-editor.js";

export function initializeCompanionSettings({ api, onUse, onScopeChange, canManage = () => false }) {
	const $ = (id) => document.getElementById(id);
	const dateEditor = createRecordEditor($("companion-user-dates"), "dates");
	const identifier = /^[A-Za-z0-9_-]{1,100}$/;
	const stateFields = {
		"companion-user-name": "user_name",
		"companion-address": "address",
		"companion-background": "relationship_background",
		"companion-affinity": "affinity",
		"companion-valence": "valence",
		"companion-arousal": "arousal",
		"companion-user-dates": "important_dates",
	};
	const stateIds = Object.keys(stateFields);
	const memoryIds = [
		"memory-create-kind",
		"memory-create-domain",
		"memory-create-key",
		"memory-create-pin",
		"memory-create-importance",
		"memory-create-durability",
		"memory-create-expiry",
		"memory-content",
	];
	const filterIds = ["memory-status", "memory-kind", "memory-query", "recall-query"];
	const drafts = new Map();
	let scope;
	let profile;
	let baseline = "";
	let stateRevision = 0;
	let generation = 0;
	let listGeneration = 0;
	let recallGeneration = 0;
	let busy = false;
	let listBusy = false;
	let nextCursor = null;
	let memoryMode = null;
	let memoryBaseline = "";
	let records = [];
	const text = (tag, value, className = "") => {
		const node = document.createElement(tag);
		node.className = className;
		node.textContent = value;
		return node;
	};
	const values = (ids) =>
		ids.map((id) =>
			id === "companion-user-dates"
				? dateEditor.getValue()
				: $(id).type === "checkbox"
					? $(id).checked
					: $(id).value,
		);
	function fill(ids, data) {
		ids.forEach((id, index) => {
			if (id === "companion-user-dates") dateEditor.setValue(data[index] ?? []);
			else {
				if ($(id).type === "checkbox") $(id).checked = Boolean(data[index]);
				else $(id).value = data[index] ?? "";
				$(id).setCustomValidity("");
			}
		});
	}
	const stateDirty = () => Boolean(profile) && JSON.stringify(values(stateIds)) !== baseline;
	const memoryDirty = () => memoryMode !== null && JSON.stringify(values(memoryIds)) !== memoryBaseline;
	const key = (value) => `${value.persona_id}/${value.user_id}`;
	const root = (value = scope) =>
		`/api/companions/${encodeURIComponent(value.persona_id)}/${encodeURIComponent(value.user_id)}`;
	const dateTime = (value) => (value === null || value === undefined ? "—" : new Date(value).toLocaleString());
	function status(message) {
		$("companion-status").textContent = message;
	}
	function errorMessage(error) {
		return (
			{
				MEMORY_REVISION_MISMATCH:
					"关系或记忆版本已变化，未提交编辑已保留。请复制草稿后刷新，再合并修改；记忆操作请刷新列表后重试。",
				COMPANION_REVISION_MISMATCH: "关系状态已被其他操作修改。草稿已保留；请复制草稿后刷新，再合并修改。",
				COMPANION_STATE_REVISION_MISMATCH: "关系状态版本冲突。草稿已保留；请复制后刷新并合并修改。",
				CORE_MEMORY_BUDGET_EXCEEDED: "核心记忆超出 8 条或总字符预算，请先取消其他固定记录。",
				SENSITIVE_MEMORY_CONTENT: "内容包含凭据特征，未保存。请移除密钥、密码、令牌等敏感内容。",
				MEMORY_NOT_FOUND: "此记忆不存在或不属于当前范围，请刷新。",
				PERSONA_NOT_FOUND: "人格不存在，请前往人格设定检查。",
				INVALID_PAYLOAD: "内容无效，请检查字段范围、日期与必填项。",
				INVALID_PERSONA: "人格配置无效，请前往人格设定修复。",
			}[error?.code] || "请求失败，请检查连接后重试。未保存的编辑已保留。"
		);
	}
	function showError(error, target = "companion-error") {
		$(target).textContent = errorMessage(error);
		$(target).hidden = false;
	}
	function clearError() {
		$("companion-error").hidden = true;
		$("companion-error").textContent = "";
	}
	function controls() {
		const ready = Boolean(profile) && !busy;
		$("companion-state-fields").disabled = !ready || !canManage();
		$("companion-state-save").disabled = !ready || !canManage() || !stateDirty();
		$("companion-use").disabled = !ready;
		$("memory-new").disabled = !ready || !canManage();
		$("memory-search").disabled = !ready || listBusy;
		$("memory-more").disabled = !ready || listBusy;
		$("recall-preview").disabled = !ready;
		$("memory-submit").disabled = busy || !canManage();
		$("memory-close").disabled = busy;
		$("memory-create-fields").disabled = busy || memoryMode?.operation === "correct";
		$("memory-content").readOnly = busy;
		for (const id of ["memory-status", "memory-kind", "memory-query", "recall-query"]) $(id).disabled = !ready;
		$("companion-refresh").disabled = busy;
		$("memory-list")
			.querySelectorAll("button")
			.forEach((button) => {
				button.disabled = !ready || !canManage();
			});
	}
	function stash() {
		if (!scope || !profile) return;
		drafts.set(key(scope), {
			state: stateDirty() ? { values: values(stateIds), baseline, revision: stateRevision } : null,
			memory:
				memoryMode && memoryDirty()
					? { values: values(memoryIds), mode: memoryMode, baseline: memoryBaseline }
					: null,
			filters: values(filterIds),
		});
	}
	function clearView() {
		profile = undefined;
		records = [];
		nextCursor = null;
		baseline = "";
		stateRevision = 0;
		memoryMode = null;
		memoryBaseline = "";
		fill(stateIds, []);
		$("memory-form").reset();
		$("companion-disabled").hidden = true;
		$("companion-state-revision").textContent = "未载入";
		for (const id of [
			"companion-projection",
			"companion-dates",
			"companion-goals",
			"companion-ledger",
			"memory-list",
			"recall-core",
			"recall-dynamic",
		])
			$(id).replaceChildren();
		$("memory-counts").textContent = "";
		$("memory-more").hidden = true;
		$("memory-new").textContent = "手动新增";
		$("memory-dialog-error").hidden = true;
		$("memory-dialog").close();
		controls();
	}
	function applyState(state) {
		fill(stateIds, [
			state.user_name,
			state.address,
			state.relationship_background,
			state.affinity,
			state.valence,
			state.arousal,
			state.important_dates,
		]);
		stateRevision = state.revision;
		baseline = JSON.stringify(values(stateIds));
		$("companion-state-revision").textContent = `编辑版本 ${stateRevision}`;
	}
	function renderProfile(value, updateEditor = true) {
		if (!value.config && profile?.config) value = { ...value, config: profile.config };
		profile = value;
		$("companion-disabled").hidden = value.enabled;
		$("companion-projection").replaceChildren();
		const projection = {
			当前范围: `${value.scope.persona_id} / ${value.scope.user_id}`,
			配置时区时间: `${value.local_time} (${value.config?.timezone || "配置时区"})`,
			虚构精力: String(value.energy),
			虚构活动: `${value.activity.label} · ${value.activity.location || "未配置地点"} · ${value.activity.source}`,
			关系阶段: value.state.stage,
			当前亲密分: String(value.state.affinity),
			"当前情绪 / 唤醒": `${value.state.valence} / ${value.state.arousal}`,
			最后互动: dateTime(value.state.last_interaction_at),
			长期记忆: value.config?.memory_enabled === false ? "已关闭（已有记忆仍可管理）" : "已启用",
		};
		for (const [label, content] of Object.entries(projection)) {
			const row = document.createElement("div");
			row.append(text("dt", label), text("dd", content));
			$("companion-projection").append(row);
		}
		for (const [id, entries, format] of [
			[
				"companion-dates",
				value.important_dates,
				(item) =>
					`${item.subject === "user" ? "用户" : "角色"} · ${item.date} ${item.label} · ${item.days_until} 天后`,
			],
			["companion-goals", value.goals, (item) => `${item.id} · ${item.text} · ${item.status}`],
			[
				"companion-ledger",
				value.ledger,
				(item) =>
					`${dateTime(item.timestamp)} · ${item.delta >= 0 ? "+" : ""}${item.delta} · ${item.reason}${item.evidence_quote ? ` · 用户证据：${item.evidence_quote}` : ""}${item.run_id ? ` · run ${item.run_id}` : " · 手动记录"}`,
			],
		]) {
			$(id).replaceChildren(...entries.map((item) => text("li", format(item))));
			if (!entries.length) $(id).append(text("li", "暂无记录", "muted"));
		}
		$("memory-counts").textContent = Object.entries(value.memory_counts)
			.map(([name, count]) => `${name}: ${count}`)
			.join(" · ");
		if (updateEditor) applyState(value.state);
		controls();
	}
	async function refreshProfile(epoch) {
		const result = await api(root());
		if (epoch !== generation) return;
		renderProfile(result.data, !stateDirty());
	}
	function button(label, handler) {
		const node = text("button", label, "text-button");
		node.type = "button";
		node.disabled = busy;
		node.addEventListener("click", handler);
		return node;
	}
	function evidence(record) {
		const box = document.createElement("div");
		box.append(
			text(
				"p",
				`ID ${record.id} · 版本 ${record.revision} · key ${record.key || "—"} · 置信度 ${record.confidence} · 重要性 ${record.importance} · ${record.durability}`,
				"field-note",
			),
		);
		box.append(
			text(
				"p",
				`创建 ${dateTime(record.created_at)} · 更新 ${dateTime(record.updated_at)} · 到期 ${dateTime(record.expires_at)} · 召回 ${record.recall_count} 次 · 最后召回 ${dateTime(record.last_recalled_at)}${record.supersedes ? ` · 替代 ${record.supersedes}` : ""}`,
				"field-note",
			),
		);
		for (const source of record.sources) {
			const item = document.createElement("blockquote");
			item.append(
				text("p", source.quote || "（无引用 / 已清除）"),
				text(
					"small",
					`${source.speaker} · ${dateTime(source.timestamp)} · session ${source.session_id || "—"} · run ${source.run_id || "—"}`,
				),
			);
			box.append(item);
		}
		if (!record.sources.length) box.append(text("p", "没有可显示的来源证据。", "muted"));
		return box;
	}
	function renderMemories() {
		$("memory-list").replaceChildren();
		const epoch = generation;
		for (const record of records) {
			const card = document.createElement("article");
			card.className = "memory-card";
			card.append(
				text("h3", `${record.kind} · ${record.domain} · ${record.status}${record.pinned ? " · 核心固定" : ""}`),
			);
			if (record.status === "pending") card.append(text("p", "待审核提议，尚未确认为事实。", "companion-warning"));
			card.append(
				text(
					"p",
					record.status === "forgotten" ? "内容与来源引用已遗忘，仅保留防重复处理标记。" : record.content,
					"memory-content",
				),
			);
			const actions = document.createElement("div");
			actions.className = "persona-actions";
			const details = document.createElement("details");
			details.append(text("summary", "详情与来源证据"));
			let detailLoaded = false;
			details.addEventListener("toggle", async () => {
				if (!details.open || detailLoaded || epoch !== generation) return;
				detailLoaded = true;
				try {
					const value = await api(`${root()}/memories/${encodeURIComponent(record.id)}`);
					if (epoch === generation && details.isConnected) details.append(evidence(value.data));
				} catch (error) {
					if (epoch !== generation) return;
					detailLoaded = false;
					details.append(text("p", errorMessage(error), "form-error"));
				}
			});
			if (record.status !== "forgotten") {
				if (record.status === "pending") actions.append(button("审核通过", () => void mutate(record, "approve")));
				if (record.status === "active")
					actions.append(
						button(
							record.pinned ? "取消固定" : "固定核心",
							() => void mutate(record, record.pinned ? "unpin" : "pin"),
						),
					);
				if (["active", "pending"].includes(record.status)) {
					actions.append(
						button("归档", () => void mutate(record, "archive")),
						button("纠正为新版本", () => openMemory(record)),
					);
				}
				if (record.status === "archived") actions.append(button("恢复", () => void mutate(record, "restore")));
				const forget = button("永久遗忘", () => void mutate(record, "forget"));
				forget.classList.add("danger");
				actions.append(forget);
			}
			card.append(actions, details);
			$("memory-list").append(card);
		}
		if (!records.length) $("memory-list").append(text("p", "当前范围与筛选条件下没有记忆。", "muted"));
		$("memory-more").hidden = nextCursor === null;
		controls();
	}
	async function loadMemories(append = false) {
		if (!scope || !profile) return;
		const epoch = generation;
		const request = ++listGeneration;
		const query = new URLSearchParams({
			status: $("memory-status").value,
			q: $("memory-query").value.trim(),
			limit: "50",
		});
		if ($("memory-kind").value) query.set("kind", $("memory-kind").value);
		if (append && nextCursor !== null) query.set("cursor", nextCursor);
		listBusy = true;
		controls();
		try {
			const result = await api(`${root()}/memories?${query}`);
			if (epoch !== generation || request !== listGeneration) return;
			const items = result.items.map((item) => item.data);
			records = append ? [...records, ...items] : items;
			nextCursor = result.next_cursor;
			renderMemories();
		} catch (error) {
			if (epoch === generation && request === listGeneration) showError(error);
		} finally {
			if (epoch === generation && request === listGeneration) {
				listBusy = false;
				controls();
			}
		}
	}
	async function mutate(record, operation, content) {
		if (busy || !profile || !canManage()) return false;
		if (
			operation === "forget" &&
			!window.confirm(
				"确定永久遗忘这条记忆？内容和来源引用将不可恢复，关联来源情景也将被清除/排除以防重新引入。此操作不声称物理删除原始会话历史文件。",
			)
		)
			return false;
		const epoch = generation;
		const endpoint = `${root()}/memories/${encodeURIComponent(record.id)}`;
		busy = true;
		clearError();
		controls();
		try {
			await api(endpoint, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					expected_revision: record.revision,
					operation,
					...(content !== undefined ? { content } : {}),
				}),
			});
			if (epoch !== generation) return false;
			status(operation === "forget" ? "已遗忘。原始会话历史由历史功能独立管理。" : "记忆已更新。");
			$("recall-core").replaceChildren();
			$("recall-dynamic").replaceChildren();
			recallGeneration++;
			await Promise.all([loadMemories(), refreshProfile(epoch)]);
			return epoch === generation;
		} catch (error) {
			if (epoch === generation) {
				showError(error);
				if ($("memory-dialog").open) showError(error, "memory-dialog-error");
			}
			return false;
		} finally {
			if (epoch === generation) {
				busy = false;
				controls();
			}
		}
	}
	function configureMemoryDialog() {
		const correcting = memoryMode?.operation === "correct";
		$("memory-dialog-title").textContent = correcting ? "纠正记忆为新版本" : "手动新增记忆";
		$("memory-create-fields").hidden = correcting;
		$("memory-create-fields").disabled = correcting;
		$("memory-dialog-note").textContent = correcting
			? "保存会创建新的已确认版本并替代旧记录，保留固定状态；旧记录的证据不被冒充为新内容的证据。"
			: "手动新增会作为用户确认的记录保存。请勿保存密钥、密码或凭据。";
	}
	function openMemory(record) {
		if (!profile || busy) return;
		if (!record && !memoryDirty()) memoryMode = null;
		if (memoryDirty() && record) {
			if (!window.confirm("已有未保存的记忆编辑，是否放弃并开始此操作？")) return;
			memoryMode = null;
		}
		if (record || !memoryMode) {
			$("memory-form").reset();
			memoryMode = record ? { operation: "correct", record } : { operation: "create" };
			$("memory-content").value = record?.content ?? "";
			memoryBaseline = JSON.stringify(values(memoryIds));
		}
		configureMemoryDialog();
		$("memory-dialog-error").hidden = true;
		$("memory-dialog").showModal();
		$("memory-content").focus();
	}
	async function load({ personaId, userId, discard = false } = {}) {
		const requested = {
			persona_id: personaId ?? scope?.persona_id ?? "default",
			user_id: userId ?? scope?.user_id ?? "local",
		};
		if (!identifier.test(requested.persona_id) || !identifier.test(requested.user_id)) {
			showError({ code: "INVALID_PAYLOAD" });
			return;
		}
		stash();
		if (discard) drafts.delete(key(requested));
		const epoch = ++generation;
		listGeneration++;
		recallGeneration++;
		busy = true;
		listBusy = false;
		scope = requested;
		clearView();
		clearError();
		status("正在载入此人格与用户的状态…");
		try {
			const result = await api(root(requested));
			if (epoch !== generation) return;
			renderProfile(result.data);
			const draft = drafts.get(key(requested));
			fill(filterIds, draft?.filters ?? ["active", "", "", ""]);
			if (draft?.state) {
				fill(stateIds, draft.state.values);
				baseline = draft.state.baseline;
				stateRevision = draft.state.revision;
				$("companion-state-revision").textContent =
					`草稿版本 ${stateRevision}；服务器当前版本 ${result.data.state.revision}`;
			}
			if (draft?.memory) {
				fill(memoryIds, draft.memory.values);
				memoryMode = draft.memory.mode;
				memoryBaseline = draft.memory.baseline;
				$("memory-new").textContent = "继续未保存的记忆编辑";
			}
			status(
				draft?.state || draft?.memory
					? "已载入。此范围未保存的草稿已保留，保存仍使用草稿原版本。"
					: "已载入。所有关系与记忆操作只作用于当前范围。",
			);
			onScopeChange?.(requested.persona_id, requested.user_id);
			await loadMemories();
		} catch (error) {
			if (epoch === generation) showError(error);
		} finally {
			if (epoch === generation) {
				busy = false;
				controls();
			}
		}
	}
	$("companion-disabled")
		.querySelector("a")
		.addEventListener("click", (event) => {
			if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			event.preventDefault();
			$("persona-settings").click();
		});
	$("companion-refresh").addEventListener("click", () => {
		if (stateDirty() && !window.confirm("刷新会放弃当前关系草稿并读取最新版本，是否继续？")) return;
		// Memory edits are independent of a relationship refresh and retain their original revision.
		stash();
		const saved = scope && drafts.get(key(scope));
		if (saved) saved.state = null;
		if (profile) baseline = JSON.stringify(values(stateIds));
		void load();
	});
	$("companion-use").addEventListener("click", () => {
		if (profile && !busy) onUse?.(scope.persona_id, scope.user_id);
	});
	for (const id of stateIds)
		$(id).addEventListener("input", () => {
			status(stateDirty() ? "关系状态有未保存的修改。" : "关系状态未变更。");
			controls();
		});
	$("companion-state-form").noValidate = true;
	$("companion-state-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		if (!profile || busy || !canManage() || !stateDirty()) return;
		dateEditor.validate();
		const dates = dateEditor.getValue();
		if (!$("companion-state-form").reportValidity()) return;
		const epoch = generation;
		const body = {
			expected_revision: stateRevision,
			user_name: $("companion-user-name").value,
			address: $("companion-address").value,
			relationship_background: $("companion-background").value,
			affinity: Number($("companion-affinity").value),
			valence: Number($("companion-valence").value),
			arousal: Number($("companion-arousal").value),
			important_dates: dates,
		};
		const previous = JSON.parse(baseline);
		values(stateIds).forEach((value, index) => {
			if (JSON.stringify(value) === JSON.stringify(previous[index])) delete body[stateFields[stateIds[index]]];
		});
		busy = true;
		clearError();
		controls();
		try {
			const result = await api(`${root()}/state`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (epoch !== generation) return;
			renderProfile(result.data);
			status("关系状态已保存。静态人格卡与已有会话权限不变。");
		} catch (error) {
			if (epoch === generation) showError(error);
		} finally {
			if (epoch === generation) {
				busy = false;
				controls();
			}
		}
	});
	$("memory-filter-form").addEventListener("submit", (event) => {
		event.preventDefault();
		if (!busy) {
			clearError();
			void loadMemories();
		}
	});
	for (const id of ["memory-status", "memory-kind"])
		$(id).addEventListener("change", () => {
			if (!busy) void loadMemories();
		});
	$("memory-query").addEventListener("input", () => {
		listGeneration++;
		listBusy = false;
		nextCursor = null;
		records = [];
		renderMemories();
		status("搜索条件已改变，请点击“搜索 / 筛选”载入结果。");
	});
	$("memory-more").addEventListener("click", () => {
		if (!listBusy && nextCursor !== null) void loadMemories(true);
	});
	$("memory-new").addEventListener("click", () => openMemory());
	$("memory-close").addEventListener("click", () => {
		$("memory-dialog").close();
		stash();
		$("memory-new").textContent = memoryDirty() ? "继续未保存的记忆编辑" : "手动新增";
	});
	$("memory-dialog").addEventListener("cancel", (event) => {
		if (busy) event.preventDefault();
	});
	$("memory-dialog").addEventListener("close", () => {
		$("memory-new").textContent = memoryDirty() ? "继续未保存的记忆编辑" : "手动新增";
	});
	$("memory-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		if (!profile || busy || !canManage() || !memoryMode || !$("memory-form").reportValidity()) return;
		if (!$("memory-content").value.trim()) {
			$("memory-content").setCustomValidity("内容不能全为空白。");
			$("memory-content").reportValidity();
			return;
		}
		const epoch = generation;
		if (memoryMode.operation === "correct") {
			if (await mutate(memoryMode.record, "correct", $("memory-content").value)) {
				memoryMode = null;
				$("memory-dialog").close();
				$("memory-new").textContent = "手动新增";
			}
			return;
		}
		const expiry = $("memory-create-expiry").value;
		const body = {
			kind: $("memory-create-kind").value,
			domain: $("memory-create-domain").value,
			content: $("memory-content").value,
			pinned: $("memory-create-pin").checked,
			importance: Number($("memory-create-importance").value),
			durability: $("memory-create-durability").value,
			expires_at: expiry ? new Date(expiry).getTime() : null,
		};
		if ($("memory-create-key").value.trim()) body.key = $("memory-create-key").value.trim();
		busy = true;
		controls();
		$("memory-dialog-error").hidden = true;
		try {
			await api(`${root()}/memories`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (epoch !== generation) return;
			memoryMode = null;
			$("memory-dialog").close();
			$("memory-new").textContent = "手动新增";
			status("手动记忆已保存为已确认记录。");
			$("recall-core").replaceChildren();
			$("recall-dynamic").replaceChildren();
			recallGeneration++;
			await Promise.all([loadMemories(), refreshProfile(epoch)]);
		} catch (error) {
			if (epoch === generation) showError(error, "memory-dialog-error");
		} finally {
			if (epoch === generation) {
				busy = false;
				controls();
			}
		}
	});
	$("memory-content").addEventListener("input", () => $("memory-content").setCustomValidity(""));
	$("recall-query").addEventListener("input", () => {
		recallGeneration++;
		$("recall-core").replaceChildren();
		$("recall-dynamic").replaceChildren();
		controls();
	});
	$("recall-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		if (!profile || busy || !$("recall-form").reportValidity()) return;
		const epoch = generation;
		const request = ++recallGeneration;
		clearError();
		$("recall-preview").disabled = true;
		try {
			const resource = await api(`${root()}/recall?${new URLSearchParams({ q: $("recall-query").value })}`);
			const result = resource.data;
			if (epoch !== generation || request !== recallGeneration) return;
			for (const [id, items, dynamic] of [
				["recall-core", result.core, false],
				["recall-dynamic", result.items, true],
			]) {
				$(id).replaceChildren(
					...items.map((value) => {
						const item = dynamic ? value.item : value;
						const card = document.createElement("article");
						card.className = "memory-card";
						card.append(
							text("h3", `${item.kind} · ${item.domain} · ${item.id}`),
							text("p", item.content, "memory-content"),
						);
						if (dynamic) card.append(text("p", `评分 ${value.score} · ${value.reason}`, "field-note"));
						return card;
					}),
				);
				if (!items.length)
					$(id).append(
						text("p", dynamic ? "没有与当前查询匹配的动态候选。" : "没有可用的固定核心记忆。", "muted"),
					);
			}
			status("召回预览完成；未调用模型、未增加召回次数。");
		} catch (error) {
			if (epoch === generation && request === recallGeneration) showError(error);
		} finally {
			if (epoch === generation && request === recallGeneration) controls();
		}
	});
	window.addEventListener("beforeunload", (event) => {
		stash();
		if (![...drafts.values()].some((draft) => draft.state || draft.memory)) return;
		event.preventDefault();
		event.returnValue = "";
	});
	return {
		load,
		setScope: (personaId, userId) => load({ personaId, userId }),
		reset({ discard = false } = {}) {
			if (!discard) stash();
			generation++;
			listGeneration++;
			recallGeneration++;
			busy = false;
			listBusy = false;
			if (discard) {
				drafts.clear();
				scope = undefined;
				fill(filterIds, ["active", "", "", ""]);
				$("memory-form").reset();
			}
			clearView();
			clearError();
			status(discard ? "连接后载入角色与长期记忆。" : "未保存草稿已保留，返回后可继续编辑。");
		},
	};
}
