import { createRecordEditor } from "./record-editor.js";

export function initializePersonaSettings({ api, onUse, onChange, onSelect, canManage = () => false }) {
	const $ = (id) => document.getElementById(id);
	let personas = [];
	let fileErrors = [];
	let editable = false;
	let catalogLoaded = false;
	let current;
	let currentRevision;
	let creating = false;
	let busy = false;
	let generation = 0;
	let roleplayDefaults;
	let roleplayBaseline = "";
	const roleplayKeys = [
		"enabled",
		"name",
		"identity",
		"world",
		"backstory",
		"traits",
		"speech_style",
		"boundaries",
		"timezone",
		"wake_time",
		"sleep_time",
		"routine",
		"important_dates",
		"goals",
		"memory_enabled",
		"memory_budget_chars",
	];
	const roleplayEditors = {
		routine: createRecordEditor($("roleplay-routine"), "routine"),
		important_dates: createRecordEditor($("roleplay-important_dates"), "dates"),
		goals: createRecordEditor($("roleplay-goals"), "goals"),
	};
	$("persona-form").noValidate = true;
	const roleplayDraft = () =>
		JSON.stringify(
			roleplayKeys.map((key) => {
				if (roleplayEditors[key]) return roleplayEditors[key].getValue();
				const field = $(`roleplay-${key}`);
				return field.type === "checkbox" ? field.checked : field.value;
			}),
		);
	function readRoleplay() {
		const value = {};
		for (const key of roleplayKeys) {
			if (roleplayEditors[key]) {
				value[key] = roleplayEditors[key].getValue();
				continue;
			}
			const field = $(`roleplay-${key}`);
			value[key] =
				field.type === "checkbox"
					? field.checked
					: key === "memory_budget_chars"
						? Number(field.value)
						: field.value;
		}
		return value;
	}
	function applyRoleplay(config) {
		for (const key of roleplayKeys) {
			if (roleplayEditors[key]) {
				roleplayEditors[key].setValue(config?.[key] ?? []);
				continue;
			}
			const field = $(`roleplay-${key}`);
			field.setCustomValidity("");
			if (field.type === "checkbox") field.checked = config?.[key] ?? false;
			else field.value = config?.[key] ?? "";
		}
		roleplayBaseline = roleplayDraft();
	}
	const text = (tag, className, value) => {
		const element = document.createElement(tag);
		element.className = className;
		element.textContent = value;
		return element;
	};
	const dirty = () =>
		Boolean(current) &&
		($("persona-id").value !== current.persona.id ||
			$("persona-prompt").value !== current.persona.system_prompt ||
			roleplayDraft() !== roleplayBaseline);
	const discardAllowed = () => !dirty() || window.confirm("有未保存的人格编辑，是否放弃这些修改？");
	function status(message) {
		$("persona-save-status").textContent = message;
		$("persona-save-status").hidden = !message;
	}
	function clearError() {
		$("persona-save-error").hidden = true;
		$("persona-save-error").textContent = "";
	}
	function showError(error, fallback) {
		const messages = {
			PERSONA_REVISION_MISMATCH: "人格已被其他操作修改。当前编辑已保留，请复制需要的内容，刷新后再编辑保存。",
			PERSONA_MANAGEMENT_UNAVAILABLE: "当前人格提供器不支持页面管理。请在新建会话时手动填写人格 ID。",
			PERSONA_NOT_FOUND: "人格不存在，请刷新目录。",
			INVALID_PERSONA: "人格文件或保存内容无效，请检查输入或修复文件后刷新。",
			PERSONA_SAVE_FAILED: "人格文件保存失败，编辑内容已保留。请检查数据目录是否可写。",
			INVALID_PAYLOAD: "保存内容无效，请检查人格 ID、系统提示和完整角色卡配置（时区、日程、日期与目标）。",
		};
		$("persona-save-error").textContent = messages[error?.code] || fallback;
		$("persona-save-error").hidden = false;
	}
	function validate() {
		const id = $("persona-id").value;
		const collision =
			creating && (personas.some((item) => item.id === id) || fileErrors.some((item) => item.id === id));
		$("persona-id").setCustomValidity(collision ? "此 ID 已存在或有无法读取的文件，请选择其他 ID。" : "");
		const prompt = $("persona-prompt").value;
		$("persona-prompt").setCustomValidity(
			prompt.length > 65536 ? "系统提示不能超过 65536 个字符。" : !prompt.trim() ? "系统提示不能全为空白。" : "",
		);
		let valid = true;
		for (const editor of Object.values(roleplayEditors)) {
			if (!editor.validate()) valid = false;
		}
		return valid;
	}
	function applyPersona(result, isNew = false, revision) {
		current = result;
		currentRevision = revision;
		creating = isNew;
		$("persona-id").value = result?.persona.id || "";
		$("persona-revision").value = revision ?? "";
		$("persona-prompt").value = result?.persona.system_prompt || "";
		roleplayDefaults = result?.roleplay_defaults ?? roleplayDefaults;
		applyRoleplay(result?.persona.roleplay ?? roleplayDefaults);
		validate();
		if (result?.persona.id && !isNew) onSelect?.(result.persona.id);
	}
	function renderEditor() {
		const canEdit = editable && current && current.editable !== false;
		$("persona-editor-title").textContent = creating ? "新建人格" : current?.persona.id || "选择或新建人格";
		$("persona-builtin").hidden = !current?.builtin;
		$("persona-id").readOnly = !creating;
		$("persona-id").disabled = busy || !canEdit;
		$("persona-revision").disabled = !current;
		$("persona-prompt").disabled = busy || !current;
		$("persona-prompt").readOnly = !canEdit;
		$("persona-roleplay").disabled = busy || !canEdit || !roleplayDefaults;
		$("persona-character-count").textContent = `${$("persona-prompt").value.length} / 65536 字符`;
		$("persona-save").disabled = busy || !canEdit || !dirty();
		$("persona-save").textContent = busy ? "处理中…" : "保存人格";
		$("persona-use").disabled = busy || !current || creating || dirty();
		$("persona-new").disabled = busy || !editable;
		$("persona-refresh").disabled = busy;
		$("persona-search").disabled = busy;
		$("persona-readonly").hidden = !catalogLoaded || editable;
		const roleplayEnabled = $("roleplay-enabled").checked;
		$("persona-roleplay-note").textContent = roleplayEnabled
			? "当前编辑：角色扮演已开启。保存后后台使用此角色卡；聊天需要新建会话。已有关系和记忆按人格 × 用户共享。"
			: "当前编辑：角色扮演关闭。系统提示仍生效，关系、记忆与后台生活暂不参与角色扮演；下级参数保留且仍可预先编辑，不删除已有数据。";
		$("persona-memory-note").textContent = !roleplayEnabled
			? "当前编辑：需先启用角色扮演，长期记忆参数保留。记忆提炼随主回复完成，本地检索不设置独立模型。"
			: $("roleplay-memory_enabled").checked
				? "当前编辑：长期记忆开启。提炼随主回复完成，不使用独立模型；召回使用本地检索，不产生额外模型调用。"
				: "当前编辑：长期记忆关闭，参数和已有记录保留，仍可在“记忆与关系”中管理。保存并新建会话后生效。";
	}
	function renderList() {
		const query = $("persona-search").value.trim().toLowerCase();
		const visible = personas.filter((item) => `${item.id} ${item.preview}`.toLowerCase().includes(query));
		$("persona-count").textContent = `${visible.length} / ${personas.length}`;
		$("persona-list").replaceChildren();
		for (const item of visible) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "persona-option";
			button.disabled = busy;
			button.setAttribute("aria-pressed", String(!creating && current?.persona.id === item.id));
			button.append(text("strong", "", item.id));
			if (item.builtin) button.append(text("span", "badge", "内置 default"));
			button.append(text("small", "", item.preview || "（无预览）"));
			button.addEventListener("click", () => void select(item.id));
			$("persona-list").append(button);
		}
		if (!visible.length) {
			$("persona-list").append(text("p", "muted", busy ? "正在加载…" : query ? "无匹配人格" : "暂无可管理的人格"));
		}
		$("persona-file-errors").hidden = !fileErrors.length;
		$("persona-errors").replaceChildren();
		for (const error of fileErrors) {
			$("persona-errors").append(text("li", "", `${error.id}：${error.message}`));
		}
	}
	function render() {
		renderEditor();
		renderList();
	}
	async function select(id) {
		if (busy) return false;
		if (!creating && current?.persona.id === id) return true;
		if (!discardAllowed()) {
			if (current?.persona.id) onSelect?.(current.persona.id);
			return false;
		}
		const requestGeneration = ++generation;
		busy = true;
		clearError();
		status("正在读取人格…");
		render();
		try {
			const result = await api(`/api/personas/${encodeURIComponent(id)}`);
			if (requestGeneration !== generation) return;
			applyPersona(result.data, false, result.revision);
			status("已载入。聊天用于新会话；后台生活读取最新保存的角色卡。");
			return true;
		} catch (error) {
			if (requestGeneration !== generation) return;
			showError(error, "无法读取人格，请检查连接或修复文件后刷新。");
			status(dirty() ? "未保存的编辑已保留。" : "读取失败，可重试或刷新目录。");
			return false;
		} finally {
			if (requestGeneration === generation) {
				busy = false;
				render();
			}
		}
	}
	async function load({ discard = false, personaId } = {}) {
		if (busy) return;
		if (!discard && dirty()) {
			if (personaId && personaId !== current?.persona.id) return select(personaId);
			if (current?.persona.id && !creating) onSelect?.(current.persona.id);
			status("未保存的编辑已保留，可继续编辑或刷新目录。");
			render();
			return;
		}
		const requestGeneration = ++generation;
		const preferredId = personaId ?? (!creating ? current?.persona.id : undefined);
		busy = true;
		clearError();
		status("正在加载人格目录…");
		render();
		try {
			const result = await api("/api/personas");
			if (requestGeneration !== generation) return;
			personas = result.items.map(({ id, data }) => ({
				id,
				revision: data.persona.revision,
				preview: data.persona.system_prompt.slice(0, 160),
				builtin: data.builtin,
			}));
			fileErrors = result.errors || [];
			editable = result.editable && canManage();
			roleplayDefaults = result.roleplay_defaults;
			catalogLoaded = true;
			applyPersona(undefined);
			render();
			const id =
				personas.find((item) => item.id === preferredId)?.id ||
				personas.find((item) => item.id === "default")?.id ||
				personas[0]?.id;
			if (id) {
				const detail = await api(`/api/personas/${encodeURIComponent(id)}`);
				if (requestGeneration !== generation) return;
				applyPersona(detail.data, false, detail.revision);
			}
			status(
				id
					? "已载入。聊天用于新会话；后台生活读取最新保存的角色卡。"
					: editable
						? "可新建人格，或修复文件后刷新。"
						: "可在新建会话时手动填写人格 ID。",
			);
		} catch (error) {
			if (requestGeneration !== generation) return;
			showError(error, "无法加载人格，请检查连接或修复文件后刷新。");
			status(dirty() ? "未保存的编辑已保留。" : "加载失败，请刷新重试。");
		} finally {
			if (requestGeneration === generation) {
				busy = false;
				render();
			}
		}
	}
	$("persona-refresh").addEventListener("click", () => {
		if (discardAllowed()) void load({ discard: true });
	});
	$("persona-search").addEventListener("input", renderList);
	$("persona-new").addEventListener("click", () => {
		if (busy || !editable || !discardAllowed()) return;
		clearError();
		applyPersona({ persona: { id: "", revision: null, system_prompt: "" }, builtin: false, editable: true }, true);
		status("填写 ID 和系统提示后保存；保存时自动生成版本。");
		render();
		$("persona-id").focus();
	});
	for (const id of ["persona-id", "persona-prompt", ...roleplayKeys.map((key) => `roleplay-${key}`)]) {
		$(id).addEventListener("input", () => {
			validate();
			clearError();
			status(dirty() ? "有未保存的修改。请先保存，再用于新会话。" : "内容未变更。");
			renderEditor();
		});
	}
	$("persona-use").addEventListener("click", () => {
		if (!busy && current && !creating && !dirty()) onUse?.(current.persona.id);
	});
	$("persona-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		if (busy || !editable || !current || current.editable === false) return;
		const recordsValid = validate();
		const invalid = [...$("persona-form").querySelectorAll("input, select, textarea")].find(
			(field) => !field.checkValidity(),
		);
		if (invalid)
			for (let section = invalid.closest("details"); section; section = section.parentElement?.closest("details"))
				section.open = true;
		const formValid = $("persona-form").reportValidity();
		if (!recordsValid || !formValid) return;
		const id = $("persona-id").value;
		if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return;
		const requestGeneration = ++generation;
		const value = {
			system_prompt: $("persona-prompt").value,
			...(creating ? { id } : { expected_revision: currentRevision }),
			roleplay: readRoleplay(),
		};
		busy = true;
		clearError();
		status("正在保存…");
		render();
		let saved = false;
		try {
			const resource = await api(creating ? "/api/personas" : `/api/personas/${encodeURIComponent(id)}`, {
				method: creating ? "POST" : "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(value),
			});
			const result = resource.data;
			if (requestGeneration !== generation) return;
			applyPersona(result, false, resource.revision);
			const summary = {
				id: result.persona.id,
				revision: result.persona.revision,
				preview: result.persona.system_prompt.slice(0, 160),
				builtin: result.builtin,
			};
			personas = personas.filter((item) => item.id !== summary.id);
			personas.push(summary);
			personas.sort((left, right) => left.id.localeCompare(right.id));
			status("已保存。聊天请用于新会话；后台生活使用此角色卡，已有聊天会话快照不变。");
			saved = true;
		} catch (error) {
			if (requestGeneration !== generation) return;
			showError(error, "保存失败，编辑内容已保留，请检查连接后重试。");
			status("未保存的编辑已保留。");
		} finally {
			if (requestGeneration === generation) {
				busy = false;
				render();
			}
		}
		if (saved && requestGeneration === generation) onChange?.();
	});
	window.addEventListener("beforeunload", (event) => {
		if (!dirty()) return;
		event.preventDefault();
		event.returnValue = "";
	});
	return {
		load,
		select,
		reset({ discard = false } = {}) {
			generation++;
			busy = false;
			if (!discard && dirty()) {
				status("未保存的编辑已保留。返回人格设定页后可继续编辑或刷新。");
				render();
				return;
			}
			personas = [];
			fileErrors = [];
			editable = false;
			catalogLoaded = false;
			roleplayDefaults = undefined;
			$("persona-search").value = "";
			applyPersona(undefined);
			clearError();
			status("选择人格后可查看或编辑系统提示。");
			render();
		},
	};
}
