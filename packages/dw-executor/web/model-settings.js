export function initializeModelSettings({ api, onSaved, canManage = () => false }) {
	const $ = (id) => document.getElementById(id);
	const encode = encodeURIComponent;
	let providers = [];
	let models = [];
	let profiles = [];
	let profile;
	let role = "chat";
	let providerId = "";
	let modelId = "";
	let baseline = "";
	let busy = false;
	let customDirty = false;
	let resumeCustom = false;
	let customBase;
	let activeTest;
	let generation = 0;
	let testGeneration = 0;
	const drafts = new Map();
	const roles = { chat: "聊天", agent: "Agent 任务", life: "后台生活" };
	const thinkingLabels = {
		off: "关闭",
		minimal: "最少",
		low: "低",
		medium: "中",
		high: "高",
		xhigh: "很高",
		max: "最高",
	};
	const node = (tag, value, className = "") =>
		Object.assign(document.createElement(tag), { textContent: value, className });
	const controls = node("div", "", "roleplay-grid");
	const profileSelect = document.createElement("select");
	profileSelect.id = "model-profile";
	const roleSelect = document.createElement("select");
	roleSelect.id = "model-profile-role";
	for (const [value, label] of Object.entries(roles)) roleSelect.append(new Option(label, value));
	const budget = document.createElement("input");
	budget.id = "model-max-output-tokens";
	budget.type = "number";
	budget.min = "1";
	budget.max = String(Number.MAX_SAFE_INTEGER);
	budget.step = "1";
	budget.required = true;
	for (const [title, field] of [
		["模型配置", profileSelect],
		["独立用途", roleSelect],
		["配置最大输出 token", budget],
	]) {
		const label = node("label", title);
		label.append(field);
		controls.append(label);
	}
	const createProfile = node("button", "新建模型配置", "text-button");
	createProfile.type = "button";
	const deleteProfile = node("button", "删除此配置", "text-button danger");
	deleteProfile.type = "button";
	controls.append(createProfile, deleteProfile);
	$("models-form").prepend(controls);
	const currentProvider = () => providers.find((item) => item.id === providerId);
	const chosen = () => models.find((item) => item.data.provider === providerId && item.data.id === modelId)?.data;
	const selection = () => ({
		provider: providerId,
		model: modelId,
		thinking_level: $("model-thinking").value || null,
		max_output_tokens: Number(budget.value),
	});
	const roleInput = (value) => ({
		provider: value.provider,
		model: value.model,
		thinking_level: value.thinking_level ?? null,
		max_output_tokens: value.max_output_tokens,
	});
	const draftKey = () => `${profile?.id}/${role}`;
	const dirty = () => Boolean(profile) && JSON.stringify(selection()) !== baseline;
	const hasDraft = () => dirty() || drafts.size > 0 || customDirty;
	function stash() {
		if (dirty()) drafts.set(draftKey(), { value: selection(), revision: profile.revision, baseline });
	}
	function message(text, failed = false) {
		$(failed ? "model-save-error" : "model-save-status").textContent = text;
		$(failed ? "model-save-error" : "model-save-status").hidden = false;
	}
	function thinkingOptions(select, levels, value) {
		select.replaceChildren(new Option("默认（Pi 自动选择）", ""));
		for (const level of levels) select.append(new Option(thinkingLabels[level] || level, level));
		select.value = levels.includes(value) ? value : "";
	}
	function applyRole() {
		const saved = profile?.data[role];
		const draft = drafts.get(draftKey());
		const value = draft?.value || saved;
		providerId = value?.provider || providers[0]?.id || "";
		modelId = value?.model || models.find((item) => item.data.provider === providerId)?.data.id || "";
		budget.value = value?.max_output_tokens || chosen()?.max_tokens || 8192;
		thinkingOptions($("model-thinking"), chosen()?.thinking_levels || ["off"], value?.thinking_level || "");
		baseline = draft?.baseline || JSON.stringify(selection());
		render();
	}
	function render() {
		const provider = currentProvider()?.data;
		const model = chosen();
		const locked = busy || !canManage();
		profileSelect.replaceChildren(...profiles.map((item) => new Option(item.data.name || item.id, item.id)));
		profileSelect.value = profile?.id || "";
		roleSelect.value = role;
		$("model-provider").replaceChildren(
			...providers.map(
				(item) => new Option(`${item.data.name || item.id}${item.data.custom ? " · 自定义" : ""}`, item.id),
			),
		);
		$("model-provider").value = providerId;
		const all = models.filter((item) => item.data.provider === providerId).map((item) => item.data);
		const query = $("model-search").value.trim().toLowerCase();
		const visible = all.filter((item) => `${item.id} ${item.name}`.toLowerCase().includes(query));
		$("model-count").textContent = `${visible.length} / ${all.length}`;
		$("model-list").replaceChildren(
			...visible.map((item) => {
				const button = node("button", "", "model-option");
				button.type = "button";
				button.disabled = busy;
				button.setAttribute("aria-pressed", String(item.id === modelId));
				button.append(
					node("strong", item.name || item.id),
					node("span", item.id),
					node("small", `${item.context_window.toLocaleString()} ctx`),
				);
				button.addEventListener("click", () => {
					modelId = item.id;
					thinkingOptions($("model-thinking"), item.thinking_levels || ["off"], "");
					render();
				});
				return button;
			}),
		);
		$("model-name").textContent = model?.name || "选择模型";
		$("model-id").textContent = model?.id || "—";
		$("model-context").textContent = model?.context_window.toLocaleString() || "—";
		const effective = model ? Math.min(model.max_tokens, Number(budget.value), model.context_window - 1) : null;
		$("model-output").textContent = model
			? `声明 ${model.max_tokens.toLocaleString()} · 配置 ${Number(budget.value).toLocaleString()} · 有效上限 ${effective.toLocaleString()}`
			: "—";
		$("model-capabilities").replaceChildren(
			...[
				model?.reasoning ? "推理" : "",
				...(model?.input || []).map((kind) => (kind === "image" ? "图像输入" : "文本输入")),
			]
				.filter(Boolean)
				.map((value) => node("span", value, "badge")),
		);
		const saved = profile?.data[role];
		$("model-current").textContent = saved
			? `${profile.data.name || profile.id} · ${roles[role]}（已保存）：${saved.provider} / ${saved.model} · 声明 ${saved.declared_max_tokens ?? "未知"} / 配置 ${saved.max_output_tokens} / 有效 ${saved.effective_max_tokens ?? "未知"}。三种用途独立；运行中任务使用启动快照。`
			: "尚未加载模型配置";
		$("model-thinking-note").textContent =
			"当前用途的独立思考设置；输出预算取模型声明与配置的较小值，并受上下文窗口约束。";
		$("model-auth-status").textContent = provider?.auth.configured ? "已配置凭据" : "未配置凭据";
		$("model-auth-note").textContent = provider?.api_key
			? "留空保留供应商凭据；不会返回已有密钥。"
			: "此供应商使用 Pi 登录或环境配置。";
		$("model-thinking").disabled = locked || !model?.reasoning;
		$("model-key").disabled = locked || !provider?.api_key;
		budget.disabled = locked;
		$("model-save").disabled = locked || !model || !profile;
		$("model-custom-new").disabled = locked;
		$("model-custom-edit").hidden = !provider?.custom;
		$("model-custom-edit").disabled = locked;
		$("model-test").disabled = locked || !model || Boolean(activeTest);
		$("model-test").textContent = activeTest ? "后台测试中…" : "测试所选模型";
		$("model-test-cancel").hidden = !activeTest || !canManage();
		createProfile.disabled = locked;
		deleteProfile.disabled = locked || !profile || profile.id === "default";
		profileSelect.disabled = busy;
		roleSelect.disabled = busy;
		$("model-provider").disabled = busy;
		$("model-refresh").disabled = busy;
	}
	async function reload({ discard = false } = {}) {
		if (discard) {
			drafts.clear();
			customDirty = false;
		}
		const epoch = ++generation;
		busy = true;
		render();
		try {
			const [providerList, modelList, profileList] = await Promise.all([
				api("/api/providers"),
				api("/api/models"),
				api("/api/model-profiles"),
			]);
			if (epoch !== generation) return;
			providers = providerList.items;
			models = modelList.items;
			profiles = profileList.items;
			profile =
				profiles.find((item) => item.id === profile?.id) ||
				profiles.find((item) => item.id === "default") ||
				profiles[0];
			applyRole();
		} catch (error) {
			if (epoch === generation) message(error.message || "读取模型资源失败", true);
		} finally {
			if (epoch === generation) {
				busy = false;
				render();
			}
		}
	}
	async function load() {
		if (!profiles.length) await reload();
		else render();
		if (!activeTest && canManage()) {
			const epoch = generation;
			let cursor;
			try {
				do {
					const query = new URLSearchParams({ kind: "model_test", limit: "200", ...(cursor ? { cursor } : {}) });
					const page = await api(`/api/jobs?${query}`);
					if (epoch !== generation) return;
					const pending = page.items.find(
						(item) => item.data.kind === "model_test" && ["queued", "running"].includes(item.data.status),
					);
					if (pending) {
						if (!activeTest) void pollTest(pending);
						break;
					}
					cursor = page.next_cursor;
				} while (cursor);
			} catch (error) {
				if (epoch === generation) message(error.message, true);
			}
		}
		if (resumeCustom) {
			resumeCustom = false;
			$("custom-dialog").showModal();
		}
	}
	profileSelect.addEventListener("change", () => {
		stash();
		profile = profiles.find((item) => item.id === profileSelect.value);
		applyRole();
	});
	roleSelect.addEventListener("change", () => {
		stash();
		role = roleSelect.value;
		applyRole();
	});
	budget.addEventListener("input", render);
	$("model-search").addEventListener("input", render);
	$("model-provider").addEventListener("change", () => {
		providerId = $("model-provider").value;
		modelId = models.find((item) => item.data.provider === providerId)?.data.id || "";
		$("model-key").value = "";
		thinkingOptions($("model-thinking"), chosen()?.thinking_levels || ["off"], "");
		render();
	});
	$("model-refresh").addEventListener("click", () => {
		if (!hasDraft() || window.confirm("刷新会放弃模型配置与自定义模型草稿，是否继续？"))
			void reload({ discard: true });
	});
	$("models-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		if (busy || !canManage() || !profile || !chosen() || !$("models-form").reportValidity()) return;
		const savedProfile = profile;
		const savedRole = role;
		const key = draftKey();
		const value = selection();
		const revision = drafts.get(key)?.revision ?? profile.revision;
		const credential = $("model-key").value.trim();
		$("model-key").value = "";
		busy = true;
		render();
		try {
			if (credential) {
				const savedProvider = await api(`/api/providers/${encode(providerId)}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ expected_revision: currentProvider().revision, api_key: credential }),
				});
				providers = providers.map((item) => (item.id === savedProvider.id ? savedProvider : item));
			}
			const resource = await api(`/api/model-profiles/${encode(savedProfile.id)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ expected_revision: revision, [savedRole]: value }),
			});
			drafts.delete(key);
			profiles = profiles.map((item) => (item.id === resource.id ? resource : item));
			profile = resource;
			applyRole();
			message("此配置用途已保存；其他用途保持不变。运行中的任务不会被切换。");
			onSaved?.(resource);
		} catch (error) {
			message(error.message || "保存失败；草稿保留。若已保存凭据，其不会因配置冲突回滚。", true);
		} finally {
			busy = false;
			render();
		}
	});
	createProfile.addEventListener("click", async () => {
		const name = window.prompt("新模型配置名称");
		if (!name?.trim() || !canManage() || busy) return;
		stash();
		busy = true;
		try {
			const resource = await api("/api/model-profiles", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: name.trim(),
					...(profile
						? {
								chat: roleInput(profile.data.chat),
								agent: roleInput(profile.data.agent),
								life: roleInput(profile.data.life),
							}
						: {}),
				}),
			});
			profiles.push(resource);
			profile = resource;
			applyRole();
		} catch (error) {
			message(error.message, true);
		} finally {
			busy = false;
			render();
		}
	});
	deleteProfile.addEventListener("click", async () => {
		if (
			!canManage() ||
			!profile ||
			profile.id === "default" ||
			!window.confirm("确定删除此模型配置？引用它的会话将无法启动新任务。")
		)
			return;
		try {
			await api(`/api/model-profiles/${encode(profile.id)}?expected_revision=${profile.revision}`, {
				method: "DELETE",
			});
			await reload();
		} catch (error) {
			message(error.message, true);
		}
	});
	function showTest(resource) {
		const job = resource.data;
		$("model-test-result").hidden = false;
		$("model-test-result").dataset.state =
			job.status === "failed" ? "error" : job.status === "completed" ? "success" : "";
		const result = job.result;
		$("model-test-result").textContent = result
			? `可用 · ${result.duration_ms} ms · 输入 ${result.usage.input_tokens} / 输出 ${result.usage.output_tokens} token · 思考 ${result.thinking_level}`
			: job.error?.message ||
				`测试 ${job.cancel_requested ? "取消已请求，等待实际调用停止" : job.status} · ${resource.id}`;
	}
	async function pollTest(resource, epoch = testGeneration) {
		if (epoch !== testGeneration) return;
		showTest(resource);
		if (!["queued", "running"].includes(resource.data.status)) {
			activeTest = undefined;
			render();
			return;
		}
		activeTest = resource;
		render();
		await new Promise((resolve) => setTimeout(resolve, 1200));
		if (!activeTest || activeTest.id !== resource.id) return;
		try {
			await pollTest(await api(`/api/jobs/${encode(resource.id)}`), epoch);
		} catch (error) {
			if (epoch !== testGeneration) return;
			message(error.message, true);
			if (activeTest?.id === resource.id) setTimeout(() => void pollTest(resource, epoch), 3000);
		}
	}
	$("model-test").addEventListener("click", async () => {
		if (!canManage() || busy || activeTest || !chosen()) return;
		const epoch = testGeneration;
		busy = true;
		render();
		try {
			const apiKey = $("model-key").value.trim();
			const resource = await api("/api/model-tests", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					provider: providerId,
					model: modelId,
					...($("model-thinking").value ? { thinking_level: $("model-thinking").value } : {}),
					...(apiKey ? { api_key: apiKey } : {}),
				}),
			});
			void pollTest(resource, epoch);
		} catch (error) {
			message(error.message, true);
		} finally {
			busy = false;
			render();
		}
	});
	$("model-test-cancel").addEventListener("click", async () => {
		if (!activeTest || !canManage()) return;
		try {
			const resource = await api(`/api/jobs/${encode(activeTest.id)}/cancel`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
			activeTest = ["queued", "running"].includes(resource.data.status) ? resource : undefined;
			showTest(resource);
			render();
		} catch (error) {
			message(error.message, true);
		}
	});
	function customThinking() {
		thinkingOptions(
			$("custom-thinking"),
			$("custom-reasoning").checked ? ["off", "minimal", "low", "medium", "high"] : ["off"],
			$("custom-thinking").value,
		);
	}
	function openCustom(edit) {
		if (!canManage() || busy) return;
		if (!customDirty || window.confirm("放弃已有自定义模型草稿并开始编辑？")) {
			$("custom-form").reset();
			customBase = edit
				? models.find((item) => item.data.provider === providerId && item.data.id === modelId)
				: undefined;
			$("custom-provider").value = edit ? providerId : "";
			$("custom-provider").readOnly = edit;
			$("custom-model").value = edit ? modelId : "";
			$("custom-url").value = edit ? currentProvider()?.data.base_url || "" : "";
			$("custom-context").value = customBase?.data.context_window || 131072;
			$("custom-output").value = customBase?.data.max_tokens || 8192;
			$("custom-image").checked = customBase?.data.input.includes("image") || false;
			$("custom-reasoning").checked = customBase?.data.reasoning || false;
			customDirty = false;
			customThinking();
		}
		$("custom-dialog").showModal();
	}
	$("model-custom-new").addEventListener("click", () => openCustom(false));
	$("model-custom-edit").addEventListener("click", () => openCustom(true));
	$("custom-reasoning").addEventListener("change", customThinking);
	$("custom-form").addEventListener("input", (event) => {
		if (event.target !== $("custom-key")) customDirty = true;
	});
	$("close-custom").addEventListener("click", () => {
		if (!busy) $("custom-dialog").close();
	});
	$("custom-dialog").addEventListener("cancel", (event) => {
		if (busy) event.preventDefault();
	});
	$("custom-dialog").addEventListener("close", () => {
		$("custom-key").value = "";
	});
	$("custom-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		if (!canManage() || busy || !$("custom-form").reportValidity()) return;
		const provider = $("custom-provider").value.trim();
		const model = $("custom-model").value.trim();
		const existing = providers.find((item) => item.id === provider);
		const existingModel = models.find((item) => item.data.provider === provider && item.data.id === model);
		const credential = $("custom-key").value.trim();
		$("custom-key").value = "";
		busy = true;
		render();
		for (const element of $("custom-form").elements) element.disabled = true;
		try {
			await api(`/api/providers/${encode(provider)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					expected_revision: existing?.revision ?? null,
					base_url: $("custom-url").value.trim(),
					api: existing?.data.api || "openai-completions",
					...(credential ? { api_key: credential } : {}),
				}),
			});
			await api(`/api/providers/${encode(provider)}/models/${encode(model)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					expected_revision: existingModel?.revision ?? null,
					name: model,
					context_window: Number($("custom-context").value),
					max_tokens: Number($("custom-output").value),
					reasoning: $("custom-reasoning").checked,
					input: ["text", ...($("custom-image").checked ? ["image"] : [])],
				}),
			});
			stash();
			customDirty = false;
			$("custom-dialog").close();
			await reload();
			providerId = provider;
			modelId = model;
			thinkingOptions($("model-thinking"), chosen()?.thinking_levels || ["off"], $("custom-thinking").value);
			message("供应商与模型定义已保存；选择配置用途后保存，才会更新会话使用的模型。");
		} catch (error) {
			$("custom-error").textContent =
				`${error.message}。编辑草稿仍保留；供应商与模型为独立资源，请刷新目录检查已保存部分。`;
			$("custom-error").hidden = false;
		} finally {
			busy = false;
			for (const element of $("custom-form").elements) element.disabled = false;
			render();
		}
	});
	window.addEventListener("beforeunload", (event) => {
		if (hasDraft()) {
			event.preventDefault();
			event.returnValue = "";
		}
	});
	return {
		load,
		reset({ discard = false } = {}) {
			stash();
			$("model-key").value = "";
			$("custom-key").value = "";
			resumeCustom = !discard && $("custom-dialog").open;
			$("custom-dialog").close();
			if (discard) {
				generation++;
				testGeneration++;
				busy = false;
				drafts.clear();
				profiles = [];
				providers = [];
				models = [];
				profile = undefined;
				baseline = "";
				customDirty = false;
				activeTest = undefined;
			}
			if (discard) {
				$("model-test-result").hidden = true;
				$("model-test-result").textContent = "";
			}
			render();
		},
	};
}
