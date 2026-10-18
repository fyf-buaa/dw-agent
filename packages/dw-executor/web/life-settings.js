export function initializeLifeSettings({ api, onUse, canManage = () => false }) {
	const $ = (id) => document.getElementById(id);
	const identifier = /^[A-Za-z0-9_-]{1,100}$/;
	const drafts = new Map();
	const fields = new Map();
	const modelChoices = new Map();
	const dependencies = [];
	const modelNames = new Map([
		["plan_model", "日程模型"],
		["diary_model", "日记模型"],
		["detail_model", "细化模型"],
	]);
	let modelCatalog;
	let modelCatalogState = "loading";
	let scope;
	let view;
	let mode = "life";
	let catalogGeneration = 0;
	let generation = 0;
	let listGeneration = 0;
	let diaryGeneration = 0;
	let controller = new AbortController();
	let busy = false;
	let listBusy = false;
	let diaryBusy = false;
	let baseline = "";
	let settingsRevision = 0;
	let configBase = {};
	let records = [];
	let nextCursor = null;
	const jobs = new Map();
	let jobGeneration = 0;
	let schedule;
	let scheduleToggle;
	let selectedDate = "";
	const text = (tag, value, className = "") => {
		const element = document.createElement(tag);
		element.textContent = value;
		element.className = className;
		return element;
	};
	const key = (value, section = mode) => `${value.persona_id}/${value.user_id}/${section}`;
	const node = (part) => $(mode === "models" ? `model-task-${part}` : `life-${part}`);
	const configNode = (part) => $(mode === "models" ? `model-task-${part}` : `life-config-${part}`);
	const root = (value = scope) =>
		`/api/companions/${encodeURIComponent(value.persona_id)}/${encodeURIComponent(value.user_id)}`;
	const dateTime = (value) => (value === null || value === undefined ? "—" : new Date(value).toLocaleString());
	const status = (message) => {
		node("status").textContent = message;
	};
	const fieldValues = () => [
		...[...fields].map(([name, field]) => [name, field.type === "checkbox" ? field.checked : field.value]),
		...[...modelChoices].map(([name, choice]) => [
			name,
			{ mode: choice.mode.value, provider: choice.provider.value, model: choice.model.value },
		]),
	];
	const dirty = () => Boolean(view) && JSON.stringify(fieldValues()) !== baseline;
	function clearError() {
		node("error").hidden = true;
		node("error").textContent = "";
	}
	function showError(error) {
		if (error?.name === "AbortError") return;
		node("error").textContent =
			{
				LIFE_REVISION_MISMATCH:
					"版本冲突：未保存设置草稿仍保留原编辑版本，未覆盖服务器。请复制需要保留的内容，再选择放弃草稿并重载、合并修改；日记或状态操作请只读刷新后重试。",
				LIFE_NOT_FOUND: "此记录已不存在或不属于当前范围，请只读刷新。",
				LIFE_STORE_INVALID: "生活数据存储不可用，未重置或覆盖数据。请检查服务端。",
				INVALID_PAYLOAD: "内容无效，请检查字段范围与模型设置。",
				SENSITIVE_MEMORY_CONTENT: "内容含凭据特征，未保存。请移除密钥、密码与令牌。",
				PERSONA_NOT_FOUND: "人格不存在，请前往角色档案检查。",
				INVALID_PERSONA: "人格配置无效，请前往角色档案修复。",
			}[error?.code] ||
			error?.message ||
			"请求失败。未保存的设置草稿已保留，请检查连接后重试。";
		node("error").hidden = false;
	}
	function button(label, handler, danger = false) {
		const element = text("button", label, `text-button${danger ? " danger" : ""}`);
		element.type = "button";
		element.addEventListener("click", handler);
		return element;
	}
	function controls() {
		const ready = Boolean(view) && !busy && canManage();
		for (const section of ["life", "models"]) {
			const prefix = section === "models" ? "model-task" : "life-config";
			$(`${prefix}-fields`).disabled = mode !== section || !ready;
			$(`${prefix}-save`).disabled = mode !== section || !ready || !dirty();
			$(`${prefix}-discard`).disabled = mode !== section || !ready || !dirty();
		}
		$("model-task-refresh").disabled = false;
		$("life-use").disabled = !ready || mode !== "life";
		$("life-refresh").disabled = false;
		for (const id of [
			"life-advance",
			"life-condition-label",
			"life-condition-hours",
			"life-condition-add",
			"life-plan-generate",
			"life-detail-generate",
		])
			$(id).disabled = mode !== "life" || !ready || !view?.enabled;
		$("life-detail-generate").disabled =
			mode !== "life" || !ready || !view?.enabled || !view?.settings.config.enable_detail_enhancement;
		for (const id of ["life-condition-label", "life-condition-hours", "life-condition-add"])
			$(id).disabled = mode !== "life" || !ready || !view?.enabled || !view?.settings.config.enable_humanized_states;
		$("life-detail-generate").title = view?.settings.config.enable_detail_enhancement
			? "按当前日程段生成虚构细节，会消耗独立模型额度"
			: "先在日程细化设置中启用并保存";
		$("life-plan-regenerate").disabled = mode !== "life" || !ready || !view?.enabled || !view?.plan;
		$("life-diary-generate").disabled =
			mode !== "life" || !ready || !view?.enabled || view?.today_diary_generated || view?.today_diary_deleted;
		$("life-diary-regenerate").disabled = mode !== "life" || !ready || !view?.enabled;
		$("life-diary-block").disabled = mode !== "life" || !ready || view?.today_diary_deleted;
		$("life-diary-more").disabled = mode !== "life" || !ready || listBusy;
		for (const element of $("life-conditions").querySelectorAll("button")) element.disabled = !ready;
		for (const element of $("life-diaries").querySelectorAll("button")) element.disabled = !view || diaryBusy;
		for (const element of $("life-diary").querySelectorAll("button")) element.disabled = !ready || diaryBusy;
	}
	function stash() {
		if (!scope || !view) return;
		drafts.set(key(scope), {
			settings: dirty() ? { values: fieldValues(), baseline, revision: settingsRevision, configBase } : null,
			schedule:
				mode === "life" && scheduleToggle && schedule && scheduleToggle.checked !== schedule.data.enabled
					? { checked: scheduleToggle.checked, revision: schedule.revision }
					: null,
			...(mode === "life" ? { manual: [$("life-condition-label").value, $("life-condition-hours").value] } : {}),
		});
	}
	function invalidate() {
		controller.abort();
		controller = new AbortController();
		generation++;
		listGeneration++;
		diaryGeneration++;
		busy = false;
		listBusy = false;
		diaryBusy = false;
		catalogGeneration++;
	}
	function clearView() {
		view = undefined;
		selectedDate = "";
		records = [];
		nextCursor = null;
		baseline = "";
		settingsRevision = 0;
		configBase = {};
		fields.clear();
		modelChoices.clear();
		dependencies.length = 0;
		for (const id of [
			"life-projection",
			"life-conditions",
			"life-history",
			"life-config-groups",
			"model-task-routes",
			"life-plan",
			"life-details",
			"life-diaries",
			"life-jobs",
		])
			$(id).replaceChildren();
		$("life-diary").replaceChildren(text("p", "选择日期查看日记与来源。", "muted"));
		$("life-condition-form").reset();
		$("life-config-revision").textContent = "未载入";
		$("model-task-revision").textContent = "未载入";
		$("model-task-overview").replaceChildren();
		$("model-primary-summary").textContent = "";
		$("life-model-summary").textContent = "";
		$("model-task-disabled").hidden = true;
		$("life-diary-status").textContent = "";
		$("life-diary-more").hidden = true;
		$("life-disabled").hidden = true;
		controls();
	}
	function enumValues(schema) {
		if (schema.enum) return schema.enum;
		if (schema.anyOf?.every((item) => Object.hasOwn(item, "const"))) return schema.anyOf.map((item) => item.const);
		return undefined;
	}
	function settingsChanged() {
		updateDependencies();
		status(
			dirty()
				? `${mode === "models" ? "任务模型" : "生活设置"}有未保存的修改；切换页面与范围会分别保留草稿，概览仍显示服务器已保存设置。`
				: "此页设置未变更；概览显示已保存设置。",
		);
		controls();
	}
	function updateModelChoice(choice) {
		const custom = choice.mode.value === "custom";
		choice.grid.hidden = !custom;
		for (const field of [choice.provider, choice.model]) {
			field.disabled = !custom;
			field.required = custom;
			field.setCustomValidity("");
		}
	}
	function updateModelSuggestions(choice) {
		const providers = modelCatalog?.providers || [];
		choice.providers.replaceChildren(
			...providers.map((provider) =>
				Object.assign(text("option", provider.name || provider.id), { value: provider.id }),
			),
		);
		const models = providers.find((provider) => provider.id === choice.provider.value)?.models || [];
		choice.models.replaceChildren(
			...models.map((model) => Object.assign(text("option", model.name || model.id), { value: model.id })),
		);
		choice.note.textContent =
			modelCatalogState === "failed"
				? "模型目录只读载入失败；仍可手动输入供应商与模型 ID。这里只填写 ID，不要填写密钥、密码或令牌。"
				: modelCatalogState === "loading"
					? "正在只读载入模型目录；可直接手动填写 ID，不会调用模型。请勿填写凭据。"
					: "可从目录建议中选择，也可手动填写未列出的供应商与模型 ID。这里只填写 ID，不要填写密钥、密码或令牌。";
	}
	async function loadModelCatalog(epoch = generation) {
		const request = ++catalogGeneration;
		modelCatalogState = "loading";
		for (const choice of modelChoices.values()) updateModelSuggestions(choice);
		renderModelOverview();
		try {
			const [providers, models, profiles] = await Promise.all([
				api("/api/providers", { signal: controller.signal }),
				api("/api/models", { signal: controller.signal }),
				api("/api/model-profiles/default", { signal: controller.signal }),
			]);
			if (epoch !== generation || request !== catalogGeneration || !view) return;
			modelCatalog = {
				providers: providers.items.map(({ id, data }) => ({
					id,
					...data,
					models: models.items.filter((item) => item.data.provider === id).map((item) => item.data),
				})),
				selection: profiles.data.life,
			};
			modelCatalogState = "ready";
		} catch {
			if (epoch !== generation || request !== catalogGeneration || !view) return;
			modelCatalogState = "failed";
		}
		if (epoch !== generation || request !== catalogGeneration || !view) return;
		for (const choice of modelChoices.values()) updateModelSuggestions(choice);
		renderModelOverview();
	}
	function renderModelChoice(name, current) {
		const wrapper = document.createElement("fieldset");
		wrapper.id = `model-task-${name}`;
		wrapper.className = "life-model-choice life-wide settings-task-card";
		wrapper.append(text("legend", modelNames.get(name)));
		const modeLabel = text("label", "");
		const mode = document.createElement("select");
		mode.id = `model-task-${name}-mode`;
		modeLabel.htmlFor = mode.id;
		modeLabel.append(text("span", "模型来源"), mode);
		mode.append(
			Object.assign(text("option", "跟随默认配置的生活模型"), { value: "default" }),
			Object.assign(text("option", "单独指定模型"), { value: "custom" }),
		);
		mode.value = current === null || current === undefined ? "default" : "custom";
		const grid = document.createElement("div");
		grid.className = "roleplay-grid";
		const choice = { mode, grid };
		for (const [part, title, maxLength] of [
			["provider", "供应商 ID", 200],
			["model", "模型 ID", 500],
		]) {
			const label = text("label", "");
			const field = document.createElement("input");
			field.type = "text";
			field.id = `model-task-${name}-${part}`;
			field.maxLength = maxLength;
			field.value = current?.[part] ?? "";
			field.autocomplete = "off";
			field.spellcheck = false;
			label.htmlFor = field.id;
			const suggestions = document.createElement("datalist");
			suggestions.id = `${field.id}-suggestions`;
			field.setAttribute("list", suggestions.id);
			label.append(text("span", title), field);
			grid.append(label);
			wrapper.append(suggestions);
			choice[part] = field;
			choice[part === "provider" ? "providers" : "models"] = suggestions;
			field.addEventListener("input", () => {
				field.setCustomValidity("");
				if (part === "provider") updateModelSuggestions(choice);
				settingsChanged();
			});
		}
		choice.note = text("small", "", "field-note");
		wrapper.append(modeLabel, grid, choice.note);
		mode.addEventListener("change", () => {
			updateModelChoice(choice);
			settingsChanged();
		});
		updateModelChoice(choice);
		updateModelSuggestions(choice);
		modelChoices.set(name, choice);
		return wrapper;
	}
	function renderModelOverview() {
		if (!view) return;
		const config = view.settings.config;
		const selection = modelCatalog?.selection;
		const catalogNote =
			modelCatalogState === "failed"
				? "（目录刷新失败；保留上次已知的默认生活模型，手动指定模型不受影响）"
				: modelCatalogState === "loading"
					? "（正在刷新默认生活模型）"
					: "";
		const project = selection
			? `${selection.provider} / ${selection.model}`
			: "默认生活模型（尚无法读取供应商 / 模型）";
		const resolved = (name) =>
			config[name] ? `${config[name].provider} / ${config[name].model}` : `${project} · 跟随默认生活模型`;
		const thinking = selection?.thinking_level || "默认（Pi 自动选择）";
		$("model-primary-summary").textContent =
			`已保存的默认模型配置：生活 ${project}；生活思考：${thinking}。聊天、Agent 与生活分别配置，运行中任务保留启动快照。${catalogNote}`;
		const prerequisite = view.enabled ? "角色扮演已启用" : "角色扮演未启用：后台任务不运行";
		const rows = [
			[
				"生活默认配置",
				project,
				"生活角色使用独立配置；运行中的任务不被切换",
				`生活思考：${thinking}；按实际调用计费`,
			],
			[
				"日程",
				resolved("plan_model"),
				`${prerequisite}；${config.enable_daily_plan ? "自动生成已开启" : "自动生成已关闭，仍可手动生成"}`,
				"独立后台调用；思考关闭或最低支持档，不继承主模型思考",
			],
			[
				"日记",
				resolved("diary_model"),
				`${prerequisite}；${config.enable_daily_diary ? "自动写日记已开启" : "自动写日记已关闭，仍可手动生成"}`,
				"写作、修正与衍生素材共用此路由；独立计费，思考关闭或最低支持档",
			],
			[
				"日程细化",
				resolved("detail_model"),
				`${prerequisite}；${config.enable_detail_enhancement ? "细化已开启；需当前 / 临近日程段（配置作息或生成日程）" : "细化已关闭，自动与手动细化均不可用"}`,
				"独立后台调用与额度；思考关闭或最低支持档",
			],
			[
				"记忆",
				"无独立模型",
				"由角色档案的长期记忆开关控制；提取附在主回复，检索在本地完成",
				"提取随主回复计费；检索不调用模型，无独立模型可分配",
			],
			[
				"数学状态",
				"不调用模型",
				`${prerequisite}；${config.enable_humanized_states ? "拟人状态总开关已开启" : "拟人状态总开关已关闭，子项保留但不生效"}`,
				"睡眠、梦境、健康、胃口与周期按规则推进，无 LLM 额度",
			],
		];
		$("model-task-overview").replaceChildren(
			...rows.map((values) => {
				const row = document.createElement("tr");
				values.forEach((value, index) => {
					const cell = text("td", value);
					cell.dataset.label = ["任务", "实际模型", "运行状态", "思考与计费"][index];
					row.append(cell);
				});
				return row;
			}),
		);
		$("life-model-summary").textContent =
			`已保存实际模型：日程 ${resolved("plan_model")}；日记 ${resolved("diary_model")}；细化 ${resolved("detail_model")}。后台思考关闭或最低支持档，独立计费。${prerequisite}。此处与模型页概览均不预览未保存草稿。${catalogNote}`;
		$("model-task-disabled").hidden = view.enabled;
		$("model-task-disabled").textContent =
			"此人格未启用角色扮演。可以预先保存模型分工；后台任务需先在“角色档案”启用并保存角色扮演。自动日程 / 日记关闭时仍可手动生成；细化须单独启用。";
	}
	function updateDependencies() {
		for (const { section, note, requires, enabledText, inactiveText } of dependencies) {
			const active = Boolean(view?.enabled) && requires.every((name) => fields.get(name)?.checked);
			section.classList.toggle("config-inactive", !active);
			note.textContent = !view?.enabled
				? "需先在“角色档案”启用并保存角色扮演；下级参数保留，可预先编辑。"
				: active
					? enabledText
					: `${inactiveText} 参数保留，可预先编辑。`;
		}
	}
	function renderSettings(value) {
		fields.clear();
		modelChoices.clear();
		dependencies.length = 0;
		$("life-config-groups").replaceChildren();
		$("model-task-routes").replaceChildren();
		if (mode === "models") {
			for (const name of modelNames.keys())
				$("model-task-routes").append(renderModelChoice(name, value.settings.config[name]));
		} else {
			const properties = value.settings_schema.properties;
			const used = new Set(modelNames.keys());
			const titles = {
				enable_daily_plan: "自动生成日程",
				enable_daily_diary: "自动写日记",
				inject_passive_states: "聊天回复前注入拟人状态与日记上下文",
			};
			function addFields(parent, names) {
				const grid = text("div", "", "life-settings-grid");
				for (const name of names) {
					const schema = properties[name];
					if (!schema || used.has(name)) continue;
					used.add(name);
					const label = document.createElement("label");
					const options = enumValues(schema);
					const multiline = schema.type === "string" && schema.maxLength > 200;
					const field = document.createElement(options ? "select" : multiline ? "textarea" : "input");
					field.id = `life-setting-${name}`;
					field.name = name;
					label.htmlFor = field.id;
					label.append(text("span", titles[name] || schema.title || name));
					if (options)
						for (const option of options)
							field.append(Object.assign(text("option", String(option)), { value: String(option) }));
					else if (schema.type === "boolean") {
						field.type = "checkbox";
						label.className = "check-label";
					} else if (schema.type === "integer" || schema.type === "number") {
						field.type = "number";
						field.step = schema.type === "integer" ? "1" : "any";
						if (schema.minimum !== undefined) field.min = String(schema.minimum);
						if (schema.maximum !== undefined) field.max = String(schema.maximum);
						field.required = true;
					} else if (!multiline) {
						field.type = schema.pattern?.includes("[0-5][0-9]") ? "time" : "text";
						if (schema.pattern) {
							field.pattern = schema.pattern;
							field.required = true;
						}
					}
					if (multiline) {
						label.classList.add("life-wide");
						field.rows = 4;
					}
					if (schema.maxLength) field.maxLength = schema.maxLength;
					if (schema.minLength) field.minLength = schema.minLength;
					const current = value.settings.config[name];
					if (field.type === "checkbox") field.checked = Boolean(current);
					else field.value = String(current ?? "");
					field.dataset.kind = schema.type || "string";
					field.addEventListener("input", () => {
						field.setCustomValidity("");
						settingsChanged();
					});
					label.append(field);
					if (schema.type !== "boolean")
						label.append(
							text(
								"small",
								`服务默认：${JSON.stringify(schema.default)}${schema.minimum !== undefined ? `；范围 ${schema.minimum}～${schema.maximum}` : ""}`,
							),
						);
					grid.append(label);
					fields.set(name, field);
				}
				parent.append(grid);
			}
			function group(parent, id, title, names, note, open = true) {
				const section = text("details", "", "life-settings-group config-subgroup");
				section.id = `life-config-group-${id}`;
				section.open = open;
				section.append(text("summary", title));
				if (note) section.append(text("p", note, "config-dependency-note"));
				addFields(section, names);
				parent.append(section);
				return section;
			}
			function dependent(parent, id, title, names, requires, enabledText, inactiveText, open = true) {
				const section = group(parent, id, title, names, "", open);
				const note = text("p", "", "config-dependency-note");
				section.insertBefore(note, section.children[1]);
				dependencies.push({ section, note, requires, enabledText, inactiveText });
				return section;
			}
			const host = $("life-config-groups");
			host.append(
				text(
					"p",
					"下方为编辑草稿，保存后生效；状态、生成按钮和模型摘要显示已保存配置。角色扮演是后台生活前提，关闭上级开关不清空下级参数。",
					"config-dependency-note",
				),
			);
			const plan = group(
				host,
				"schedule",
				"日程：自动安排",
				["enable_daily_plan"],
				"自动开关只控制定时生成；关闭后仍可手动生成日程，不代表关闭配置作息。",
			);
			dependent(
				plan,
				"schedule-timing",
				"自动日程时间与条目数",
				["daily_plan_time", "daily_plan_item_count"],
				["enable_daily_plan"],
				"草稿已开启自动日程。",
				"草稿已关闭自动日程；手动生成仍会使用条目数。",
			);
			const diary = group(
				host,
				"diary",
				"日记：自动写作与内容",
				["enable_daily_diary"],
				"自动开关只控制定时写作；关闭后仍可手动生成。今天已生成 / 已删除的限制以日记状态为准；写作、修正与衍生素材共用日记模型。",
			);
			dependent(
				diary,
				"diary-timing",
				"自动日记时间",
				["daily_diary_time"],
				["enable_daily_diary"],
				"草稿已开启自动日记。",
				"草稿已关闭自动日记；定时不会触发，仍可手动生成。",
			);
			group(
				diary,
				"diary-writing",
				"写作参数与保留",
				[
					"daily_diary_form",
					"daily_diary_length",
					"daily_diary_creativity",
					"daily_diary_custom_direction",
					"daily_diary_generate_share_seed",
					"max_diary_entries",
				],
				"这些参数也用于显式手动生成，与自动写作开关分开。",
			);
			const detail = group(
				host,
				"detail",
				"日程细化",
				["enable_detail_enhancement"],
				"细化开关同时约束自动与显式手动细化；需要当前 / 临近的配置作息段或生成日程段，不要求开启自动日程。每次生成会独立调用细化模型。",
			);
			dependent(
				detail,
				"detail-timing",
				"细化提前量",
				["detail_enhancement_lead_minutes"],
				["enable_detail_enhancement"],
				"草稿已开启细化。",
				"草稿已关闭细化；自动和手动细化均不运行。",
			);
			const state = group(
				host,
				"state",
				"数学状态：总开关与子项",
				["enable_humanized_states"],
				"睡眠、梦境、健康、胃口和周期均按数学规则模拟，不调用模型；关闭总开关会让子项不生效而非删除设置。",
			);
			dependent(
				state,
				"state-options",
				"强度与健康、胃口子项",
				["humanized_state_intensity", "enable_health_state", "enable_hunger_state"],
				["enable_humanized_states"],
				"总开关已开启，健康和胃口子开关独立生效。",
				"总开关已关闭，子项暂不生效。",
			);
			const cycle = dependent(
				state,
				"cycle",
				"周期模拟",
				["enable_cycle_state"],
				["enable_humanized_states"],
				"周期子开关在总开关下独立生效。",
				"总开关关闭，周期子项当前不生效。",
			);
			const advancedCycle = dependent(
				cycle,
				"advanced-cycle",
				"高级：六阶段周期策略",
				["enable_advanced_cycle_strategy"],
				["enable_humanized_states", "enable_cycle_state"],
				"已满足六阶段策略的父级依赖；仍需启用本策略。",
				"六阶段策略需同时开启拟人状态总开关和周期模拟。",
				false,
			);
			const phases = dependent(
				advancedCycle,
				"cycle-parameters",
				"六阶段参数",
				["advanced_cycle_link_intensity", "advanced_cycle_start_offset"],
				["enable_humanized_states", "enable_cycle_state", "enable_advanced_cycle_strategy"],
				"六阶段草稿依赖已满足。",
				"六阶段参数尚不生效：需要总开关、周期和六阶段策略。",
			);
			for (const [name, title] of [
				["menstrual", "月经期"],
				["follicular", "卵泡期"],
				["pre_ovulation", "排卵前期"],
				["ovulation", "排卵期"],
				["luteal", "黄体期"],
				["pms", "PMS 期"],
			]) {
				const phase = group(
					phases,
					`cycle-${name}`,
					title,
					["days", "mood", "energy"].map((part) => `advanced_cycle_${name}_${part}`),
					"",
					false,
				);
				group(
					phase,
					`cycle-${name}-prompt`,
					"高级：阶段描述提示词",
					[`advanced_cycle_${name}_prompt`],
					"仅用于此阶段的虚构状态描述。",
					false,
				);
			}
			const discomfort = dependent(
				advancedCycle,
				"discomfort",
				"六阶段不适模拟",
				["advanced_cycle_discomfort_simulation"],
				["enable_humanized_states", "enable_cycle_state", "enable_advanced_cycle_strategy"],
				"可独立开启不适模拟。",
				"不适模拟需先满足总开关、周期与六阶段策略。",
			);
			dependent(
				discomfort,
				"discomfort-parameters",
				"不适概率与类型",
				["advanced_cycle_discomfort_chance", "advanced_cycle_discomfort_types"],
				[
					"enable_humanized_states",
					"enable_cycle_state",
					"enable_advanced_cycle_strategy",
					"advanced_cycle_discomfort_simulation",
				],
				"不适模拟草稿依赖已满足。",
				"不适参数尚不生效：还需要开启不适模拟。",
			);
			group(
				host,
				"injection",
				"聊天上下文注入",
				["inject_passive_states"],
				"仅控制聊天中的拟人状态与日记上下文注入；不控制状态模拟或自动任务，也不依赖拟人状态总开关。",
			);
			group(
				host,
				"weather",
				"虚构天气背景",
				["weather_context"],
				"手动设置虚构背景，不联网查询天气，不是模型路由。",
			);
			group(
				host,
				"prompts",
				"高级：日程与角色提示词",
				[
					"schedule_persona_prompt",
					"schedule_worldview_prompt",
					"roleplay_user_profile_prompt",
					"daily_plan_prompt",
				],
				"供日程生成使用；不会修改主聊天人格。留空采用服务默认。",
				false,
			);
			const extra = Object.keys(properties).filter((name) => !used.has(name));
			if (extra.length) group(host, "other", "其他设置", extra, "", false);
			updateDependencies();
		}
		settingsRevision = value.settings.revision;
		configBase = structuredClone(value.settings.config);
		baseline = JSON.stringify(fieldValues());
		configNode("revision").textContent = `编辑版本 ${settingsRevision}`;
		if (mode === "life" && schedule) renderSchedule();
	}
	function usage(value, source) {
		const box = document.createElement("div");
		box.append(
			text(
				"p",
				`${source ? `来源 ${source} · ` : ""}实际模型调用 ${value.model_calls} · 输入 / 输出 token ${value.usage.input_tokens} / ${value.usage.output_tokens}${value.generated_at ? ` · ${dateTime(value.generated_at)} · 版本 ${value.revision}` : ""}`,
				"field-note",
			),
		);
		for (const warning of value.warnings) box.append(text("p", warning, "companion-warning"));
		return box;
	}
	function renderView(value, updateSettings = false) {
		view = value;
		if (updateSettings || !(fields.size || modelChoices.size)) renderSettings(value);
		else
			configNode("revision").textContent =
				`编辑版本 ${settingsRevision}；服务器当前版本 ${value.settings.revision}${dirty() ? "（草稿保留）" : ""}`;
		renderModelOverview();
		if (mode === "models") {
			controls();
			return;
		}
		$("life-disabled").hidden = value.enabled;
		const state = value.state;
		const projection = {
			当前范围: `${value.scope.persona_id} / ${value.scope.user_id}`,
			配置时区时间: value.local_time,
			状态版本: `${state.revision} · ${state.initialized ? "已初始化" : "尚未初始化，显示基线"}`,
			虚构精力: `${state.energy} / 100`,
			虚构活动: `${state.activity.label} · ${state.activity.location || "未配置地点"} · ${state.activity.source}`,
			虚构情绪: state.mood_bias,
			虚构睡眠: state.sleep,
			虚构梦境: state.dream,
			虚构身体状态: state.health,
			虚构胃口: state.hunger,
			虚构周期: `${state.body_cycle} · ${state.cycle.strategy} · ${state.cycle.phase || "—"} · 第 ${state.cycle.day ?? "—"} / ${state.cycle.total_days} 天`,
			虚构天气: state.weather,
			虚构地点: state.location,
			说明: state.note,
		};
		$("life-projection").replaceChildren(
			...Object.entries(projection).map(([label, content]) => {
				const row = document.createElement("div");
				row.append(text("dt", label), text("dd", content));
				return row;
			}),
		);
		const epoch = generation;
		$("life-conditions").replaceChildren(
			...state.conditions.map((condition) => {
				const card = text("div", "", "life-record");
				card.append(
					text("strong", `${condition.title} · ${condition.label}`),
					text(
						"p",
						`${condition.kind} · ${condition.phase} · 情绪 ${condition.mood} · 强度 ${condition.intensity} · 精力变化 ${condition.energy_delta}`,
					),
					text(
						"p",
						`${dateTime(condition.start_at)} ～ ${dateTime(condition.end_at)} · 起因 ${condition.cause || "—"}`,
						"field-note",
					),
					button("移除此虚构状态", () => {
						if (epoch !== generation) return;
						void mutate(
							`/life/conditions/${encodeURIComponent(condition.id)}`,
							{ expected_revision: state.revision, operation: "remove" },
							"PATCH",
							"已移除虚构状态，未调用模型。",
						);
					}),
				);
				return card;
			}),
		);
		if (!state.conditions.length) $("life-conditions").append(text("p", "暂无持续中的虚构状态。", "muted"));
		$("life-history").replaceChildren(
			...state.history
				.toReversed()
				.map((item) =>
					text(
						"li",
						`${dateTime(item.at)} · ${item.kind} · ${item.label}${item.from_phase || item.to_phase ? ` · ${item.from_phase || "—"} → ${item.to_phase || "—"}` : ""} · 虚构`,
					),
				),
		);
		$("life-plan").replaceChildren();
		if (value.plan) {
			$("life-plan").append(
				text("h3", `${value.plan.date} · 计划，不代表已完成`),
				usage(value.plan, value.plan.source),
			);
			const list = document.createElement("ol");
			list.append(
				...value.plan.items.map((item) =>
					text(
						"li",
						`${item.time}${item.end ? `～${item.end}` : ""} · ${item.activity} · ${item.mood}${item.location ? ` · ${item.location}` : ""} · planned`,
					),
				),
			);
			$("life-plan").append(list);
		} else $("life-plan").append(text("p", "今天尚无生成的日程。查询不会生成日程。", "muted"));
		$("life-details").replaceChildren(
			...value.details.map((detail) => {
				const card = text("div", "", "life-record");
				card.append(
					text("h3", `模拟细节 · ${detail.segment}`),
					text("p", `${detail.summary} · ${detail.location}`),
					usage(detail, "simulated"),
				);
				const list = document.createElement("ul");
				list.append(
					...detail.today_events.map((item) => text("li", `${item.time} · ${item.event} · ${item.level}`)),
				);
				card.append(list);
				return card;
			}),
		);
		$("life-diary-status").textContent =
			`今天 ${state.date} · 日记版本 ${value.today_diary_revision} · ${value.today_diary_deleted ? "已删除，自动生成被阻止" : value.today_diary_generated ? "已生成或已按保留策略清理；不会自动重建" : "尚未生成"}`;
		$("life-jobs").replaceChildren(
			...value.jobs.map((job) => {
				const card = text("div", "", "life-record");
				card.append(
					text("strong", `${job.date} · ${job.kind} · ${job.status}`),
					text("p", `${dateTime(job.started_at)} ～ ${dateTime(job.finished_at)}`, "field-note"),
					usage(job),
				);
				if (job.error) card.append(text("p", `${job.error.code} · ${job.error.message}`, "form-error"));
				return card;
			}),
		);
		if (!value.jobs.length) $("life-jobs").append(text("p", "暂无后台任务记录。", "muted"));
		renderJobs();
		controls();
	}
	function renderList() {
		const epoch = generation;
		$("life-diaries").replaceChildren(
			...records.map((item) => {
				const option = button("", () => {
					if (epoch === generation) void loadDiary(item.date);
				});
				option.className = "life-diary-option";
				option.setAttribute("aria-pressed", String(item.date === selectedDate));
				option.append(
					text("strong", `${item.date} · ${item.form}`),
					text("span", item.summary),
					text("small", `${item.source} · 版本 ${item.revision} · 证据 ${item.evidence_count}`),
				);
				return option;
			}),
		);
		if (!records.length) $("life-diaries").append(text("p", "此范围暂无保留的日记。", "muted"));
		$("life-diary-more").hidden = nextCursor === null;
		controls();
	}
	function renderDiary(value) {
		selectedDate = value.date;
		const epoch = generation;
		$("life-diary").replaceChildren(
			text("h3", `${value.date} · ${value.form}`),
			text("p", value.summary),
			text("div", value.body, "life-diary-body"),
			usage(value, value.source),
			text("p", `标签：${value.tags.join("、") || "无"}`, "field-note"),
		);
		const sources = document.createElement("details");
		sources.append(text("summary", "来源证据与等级"));
		const list = document.createElement("ol");
		list.className = "life-evidence";
		list.append(
			...value.evidence.map((item) => {
				const row = document.createElement("li");
				row.append(text("strong", `${item.level} · ${item.source} · ${dateTime(item.at)}`), text("p", item.text));
				if (item.memory_id) row.append(text("small", `记忆 ${item.memory_id} · 版本 ${item.memory_revision}`));
				if (item.session_id || item.run_id)
					row.append(text("p", `会话 ${item.session_id || "—"} · run ${item.run_id || "—"}`, "field-note"));
				return row;
			}),
		);
		if (!value.evidence.length) list.append(text("li", "没有当日来源证据，不应视作现实事实。"));
		sources.append(list);
		const derivatives = document.createElement("details");
		derivatives.append(text("summary", "虚构连续性与衍生素材（不自动批准为用户事实）"));
		derivatives.append(text("p", `分享素材：${value.share_seed || "无"}`));
		for (const item of value.dream_fragments)
			derivatives.append(text("p", `梦境片段：${item.text} · 权重 ${item.weight}`));
		derivatives.append(
			text(
				"p",
				`连续线索：${value.continuity_thread.motif || "无"} · ${value.continuity_thread.status} · ${value.continuity_thread.next_hint}`,
			),
		);
		for (const item of value.long_term_events)
			derivatives.append(text("p", `虚构长期事件：${item.title} · ${item.status} · ${item.next_hint}`));
		$("life-diary").append(
			sources,
			derivatives,
			button(
				"删除这篇日记",
				() => {
					if (epoch === generation) void deleteDiary(value.date, value.revision);
				},
				true,
			),
		);
		renderList();
	}
	async function loadDiaries(append = false) {
		if (!view) return;
		const epoch = generation;
		const request = ++listGeneration;
		const path = `${root()}/diaries?${new URLSearchParams({ limit: "30", ...(append && nextCursor !== null ? { cursor: String(nextCursor) } : {}) })}`;
		listBusy = true;
		controls();
		try {
			const result = await api(path, { signal: controller.signal });
			if (epoch !== generation || request !== listGeneration) return;
			const items = result.items.map((item) => item.data);
			records = append ? [...records, ...items] : items;
			nextCursor = result.next_cursor;
			renderList();
		} catch (error) {
			if (epoch === generation && request === listGeneration) showError(error);
		} finally {
			if (epoch === generation && request === listGeneration) {
				listBusy = false;
				controls();
			}
		}
	}
	async function loadDiary(date) {
		if (!view) return;
		const epoch = generation;
		const request = ++diaryGeneration;
		const path = `${root()}/diaries/${encodeURIComponent(date)}`;
		selectedDate = date;
		diaryBusy = true;
		$("life-diary").replaceChildren(text("p", "正在只读载入日记…", "muted"));
		renderList();
		try {
			const value = await api(path, { signal: controller.signal });
			if (epoch === generation && request === diaryGeneration) renderDiary(value.data);
		} catch (error) {
			if (epoch === generation && request === diaryGeneration) {
				$("life-diary").replaceChildren();
				showError(error);
			}
		} finally {
			if (epoch === generation && request === diaryGeneration) {
				diaryBusy = false;
				controls();
			}
		}
	}
	async function load({ personaId, userId, mode: requestedMode = mode } = {}) {
		const requested = {
			persona_id: personaId ?? scope?.persona_id ?? "default",
			user_id: userId ?? scope?.user_id ?? "local",
		};
		if (!identifier.test(requested.persona_id) || !identifier.test(requested.user_id)) {
			showError({ code: "INVALID_PAYLOAD" });
			return;
		}
		stash();
		invalidate();
		const epoch = generation;
		scope = requested;
		mode = requestedMode === "models" ? "models" : "life";
		clearView();
		clearError();
		busy = true;
		status("正在只读载入此范围…共享范围控件仍可使用。");
		controls();
		try {
			const [resource, scheduleResource] = await Promise.all([
				api(`${root(requested)}/life`, { signal: controller.signal }),
				api(`${root(requested)}/schedule`, { signal: controller.signal }),
			]);
			const result = resource.data;
			if (epoch !== generation) return;
			schedule = scheduleResource;
			renderView(result, true);
			const draft = drafts.get(key(requested));
			if (draft?.settings) {
				for (const [name, value] of draft.settings.values) {
					const choice = modelChoices.get(name);
					if (choice) {
						choice.mode.value = value.mode;
						choice.provider.value = value.provider;
						choice.model.value = value.model;
						updateModelChoice(choice);
						updateModelSuggestions(choice);
					} else {
						const field = fields.get(name);
						if (!field) continue;
						if (field.type === "checkbox") field.checked = value;
						else field.value = value;
					}
				}
				baseline = draft.settings.baseline;
				settingsRevision = draft.settings.revision;
				configBase = draft.settings.configBase;
				configNode("revision").textContent =
					`草稿版本 ${settingsRevision}；服务器当前版本 ${result.settings.revision}`;
			}
			if (draft?.manual) [$("life-condition-label").value, $("life-condition-hours").value] = draft.manual;
			if (draft?.schedule && scheduleToggle) {
				scheduleToggle.checked = draft.schedule.checked;
				schedule = { ...schedule, revision: draft.schedule.revision };
			}
			updateDependencies();
			status(
				draft?.settings
					? `已载入；此范围${mode === "models" ? "任务模型" : "生活设置"}草稿已恢复，保存仍使用草稿原版本；概览显示服务器已保存值。`
					: "已载入；查询未调用模型，概览显示已保存配置；所有操作仅作用于当前范围。",
			);
			void loadModelCatalog(epoch);
			if (mode === "life") await Promise.all([loadDiaries(), loadJobs()]);
		} catch (error) {
			if (epoch === generation) showError(error);
		} finally {
			if (epoch === generation) {
				busy = false;
				controls();
			}
		}
	}
	async function mutate(suffix, body, method = "POST", message = "操作已完成。", savedSettings = false) {
		if (!view || busy || !canManage()) return false;
		const epoch = generation;
		const path = `${root()}${suffix}`;
		busy = true;
		clearError();
		controls();
		try {
			const result = await api(path, {
				method,
				headers: { "Content-Type": "application/json" },
				...(method !== "DELETE" ? { body: JSON.stringify(body) } : {}),
			});
			if (epoch !== generation) return false;
			const current = result.data;
			renderView(current, savedSettings || !dirty());
			if (savedSettings) drafts.delete(key(scope));
			status(message);
			if (suffix.includes("diaries")) await loadDiaries();
			return epoch === generation;
		} catch (error) {
			if (epoch === generation) showError(error);
			return false;
		} finally {
			if (epoch === generation) {
				busy = false;
				controls();
			}
		}
	}
	async function deleteDiary(date, revision) {
		if (
			!view ||
			busy ||
			!window.confirm(
				`确定删除 ${date} 的日记并保留删除版本？正文与衍生素材将不可查看；自动任务不会重建。仅今天可显式强制重生成。`,
			)
		)
			return;
		const epoch = generation;
		if (
			await mutate(
				`/diaries/${encodeURIComponent(date)}?${new URLSearchParams({ expected_revision: String(revision) })}`,
				undefined,
				"DELETE",
				"已删除日记；保留墓碑阻止自动重建。",
			)
		) {
			if (epoch !== generation) return;
			if (selectedDate === date) {
				diaryGeneration++;
				diaryBusy = false;
				selectedDate = "";
				$("life-diary").replaceChildren(text("p", "日记已删除。", "muted"));
				renderList();
			}
		}
	}
	function generate(kind, force = false) {
		if (!view || busy || !canManage()) return;
		if (
			force &&
			!window.confirm(
				`确定强制重生成今天的${kind === "diary" ? "日记（包括恢复已删除日记）" : "虚构日程"}？将消耗独立模型额度并按当前版本替换已有内容。`,
			)
		)
			return;
		const body = { force };
		if (kind === "diary") body.expected_revision = view.today_diary_revision;
		if (kind === "plan") body.expected_revision = view.plan?.revision ?? 0;
		const jobScope = { ...scope };
		const epoch = generation;
		const jobEpoch = jobGeneration;
		status("正在提交持久后台任务；离开页面或切换范围不会取消，可在任务记录中显式取消。");
		void api(`${root(jobScope)}/jobs`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kind, ...body }),
		})
			.then((resource) => {
				if (jobEpoch !== jobGeneration) return;
				jobs.set(resource.id, { resource, scope: jobScope });
				renderJobs();
				void pollJob(resource.id);
				if (epoch === generation) status("任务已提交；可安全切换页面，返回后继续查看。");
			})
			.catch((error) => {
				if (epoch === generation) showError(error);
			});
	}
	$("life-config-form").noValidate = true;
	$("model-tasks-form").noValidate = true;
	$("life-refresh").addEventListener("click", () => void load({ mode: "life" }));
	$("model-task-refresh").addEventListener("click", () => void load({ mode: "models" }));
	$("life-use").addEventListener("click", () => {
		if (view && !busy) onUse?.(scope.persona_id, scope.user_id);
	});
	$("life-disabled")
		.querySelector("a")
		.addEventListener("click", (event) => {
			if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			event.preventDefault();
			$("persona-settings").click();
		});
	function discardSettings(section) {
		if (
			mode !== section ||
			!view ||
			busy ||
			!dirty() ||
			!window.confirm(`确定放弃此范围${section === "models" ? "任务模型" : "生活设置"}草稿，并载入服务器最新设置？`)
		)
			return;
		baseline = JSON.stringify(fieldValues());
		drafts.delete(key(scope));
		void load();
	}
	$("life-config-discard").addEventListener("click", () => discardSettings("life"));
	$("model-task-discard").addEventListener("click", () => discardSettings("models"));
	async function saveSettings(event, section) {
		event.preventDefault();
		if (mode !== section || !view || busy || !dirty()) return;
		const config = structuredClone(configBase);
		for (const [name, field] of fields) {
			field.setCustomValidity("");
			config[name] =
				field.type === "checkbox"
					? field.checked
					: ["integer", "number"].includes(field.dataset.kind)
						? Number(field.value)
						: field.value;
		}
		for (const [name, choice] of modelChoices) {
			updateModelChoice(choice);
			const custom = choice.mode.value === "custom";
			if (custom)
				for (const [field, label, limit] of [
					[choice.provider, "供应商", 200],
					[choice.model, "模型", 500],
				]) {
					if (!field.value.trim()) field.setCustomValidity(`请输入非空${label} ID，不要填写凭据。`);
					else if (field.value.length > limit) field.setCustomValidity(`${label} ID 不能超过 ${limit} 个字符。`);
				}
			config[name] = custom ? { provider: choice.provider.value, model: choice.model.value } : null;
		}
		const form = section === "models" ? $("model-tasks-form") : $("life-config-form");
		const invalid = [...form.querySelectorAll("input, select, textarea")].find(
			(field) => !field.disabled && !field.checkValidity(),
		);
		if (invalid) {
			for (let section = invalid.closest("details"); section; section = section.parentElement?.closest("details"))
				section.open = true;
			invalid.reportValidity();
			invalid.focus();
			return;
		}
		await mutate(
			"/life/settings",
			{ expected_revision: settingsRevision, config },
			"PATCH",
			section === "models"
				? "任务模型分配已保存，适用于此人格与用户的后续后台调用；生活开关未修改，未调用模型。"
				: "生活设置已保存，即时作用于此人格与用户；模型分配未修改，未调用模型。",
			true,
		);
	}
	$("life-config-form").addEventListener("submit", (event) => void saveSettings(event, "life"));
	$("model-tasks-form").addEventListener("submit", (event) => void saveSettings(event, "models"));
	$("life-advance").addEventListener(
		"click",
		() => void mutate("/life/advance", {}, "POST", "虚构状态已按当前时间数学推进，未调用模型。"),
	);
	$("life-condition-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		if (!view || busy || !$("life-condition-form").reportValidity()) return;
		const label = $("life-condition-label").value.trim();
		if (!label) {
			$("life-condition-label").setCustomValidity("请输入非空虚构状态。");
			$("life-condition-label").reportValidity();
			return;
		}
		const epoch = generation;
		const hours = $("life-condition-hours").value;
		if (
			await mutate(
				"/life/conditions",
				{ expected_revision: view.state.revision, label, ...(hours ? { duration_hours: Number(hours) } : {}) },
				"POST",
				"已添加手动虚构状态，未调用模型。",
			)
		) {
			if (epoch === generation) $("life-condition-form").reset();
		}
	});
	$("life-condition-label").addEventListener("input", () => $("life-condition-label").setCustomValidity(""));
	$("life-plan-generate").addEventListener("click", () => generate("plan"));
	$("life-plan-regenerate").addEventListener("click", () => generate("plan", true));
	$("life-detail-generate").addEventListener("click", () => generate("detail"));
	$("life-diary-generate").addEventListener("click", () => generate("diary"));
	$("life-diary-regenerate").addEventListener("click", () => generate("diary", true));
	$("life-diary-block").addEventListener("click", () => {
		if (view) void deleteDiary(view.state.date, view.today_diary_revision);
	});
	$("life-diary-more").addEventListener("click", () => {
		if (!listBusy && nextCursor !== null) void loadDiaries(true);
	});
	function renderSchedule() {
		const row = text("div", "", "life-record");
		scheduleToggle = document.createElement("input");
		scheduleToggle.type = "checkbox";
		const draft = drafts.get(key(scope))?.schedule;
		scheduleToggle.checked = draft?.checked ?? schedule.data.enabled;
		if (draft) schedule = { ...schedule, revision: draft.revision };
		scheduleToggle.addEventListener("change", stash);
		scheduleToggle.disabled = !canManage();
		const label = text("label", "启用此人格 × 用户的后台调度");
		label.prepend(scheduleToggle);
		const save = button("保存调度状态", async () => {
			if (!canManage()) return;
			const epoch = generation;
			try {
				const saved = await api(`${root()}/schedule`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ expected_revision: schedule.revision, enabled: scheduleToggle.checked }),
				});
				if (epoch === generation) {
					schedule = saved;
					const stored = drafts.get(key(scope));
					if (stored) stored.schedule = null;
					status("后台调度状态已保存。");
				}
			} catch (error) {
				if (epoch === generation) showError(error);
			}
		});
		save.disabled = !canManage();
		row.append(label, save, text("p", "独立于页面与会话生命周期；自动日程、日记仍受各自开关控制。", "field-note"));
		$("life-config-groups").prepend(row);
	}
	function renderJobs() {
		if (!scope || !view || mode !== "life") return;
		$("life-jobs")
			.querySelectorAll("[data-api-job]")
			.forEach((node) => {
				node.remove();
			});
		for (const { resource, scope: jobScope } of jobs.values()) {
			if (key(jobScope, "life") !== key(scope, "life")) continue;
			const job = resource.data;
			const card = text("div", "", "life-record");
			card.dataset.apiJob = resource.id;
			card.append(
				text("strong", `${job.kind} · ${job.cancel_requested ? "取消已请求，等待实际调用停止" : job.status}`),
			);
			if (job.error) card.append(text("p", job.error.message, "form-error"));
			if (job.usage)
				card.append(
					text(
						"p",
						`实际用量：输入 ${job.usage.input_tokens ?? 0} / 输出 ${job.usage.output_tokens ?? 0}`,
						"field-note",
					),
				);
			if (["queued", "running"].includes(job.status) && canManage())
				card.append(
					button(
						"显式取消任务",
						async () => {
							try {
								const cancelled = await api(`/api/jobs/${encodeURIComponent(resource.id)}/cancel`, {
									method: "POST",
									headers: { "Content-Type": "application/json" },
									body: "{}",
								});
								jobs.set(resource.id, { resource: cancelled, scope: jobScope });
								renderJobs();
							} catch (error) {
								showError(error);
							}
						},
						true,
					),
				);
			$("life-jobs").append(card);
		}
	}
	async function loadJobs() {
		const jobScope = { ...scope };
		const epoch = generation;
		let cursor;
		do {
			const query = new URLSearchParams({
				companion_scope: `${jobScope.persona_id}:${jobScope.user_id}`,
				...(cursor ? { cursor } : {}),
			});
			const page = await api(`/api/jobs?${query}`, { signal: controller.signal });
			if (epoch !== generation) return;
			for (const resource of page.items) {
				if (resource.data.companion_scope !== `${jobScope.persona_id}:${jobScope.user_id}`) continue;
				const known = jobs.has(resource.id);
				jobs.set(resource.id, { resource, scope: jobScope });
				if (!known && ["queued", "running"].includes(resource.data.status)) void pollJob(resource.id);
			}
			cursor = page.next_cursor;
		} while (cursor);
		renderJobs();
	}
	async function pollJob(id) {
		const entry = jobs.get(id);
		if (!entry || !["queued", "running"].includes(entry.resource.data.status)) return;
		await new Promise((resolve) => setTimeout(resolve, 1200));
		if (!jobs.has(id)) return;
		try {
			const resource = await api(`/api/jobs/${encodeURIComponent(id)}`);
			if (!jobs.has(id)) return;
			jobs.set(id, { ...entry, resource });
			renderJobs();
			if (["queued", "running"].includes(resource.data.status)) void pollJob(id);
			else if (scope && view && key(entry.scope, "life") === key(scope, "life")) {
				const epoch = generation;
				const latest = await api(`${root()}/life`);
				if (epoch === generation) {
					renderView(latest.data, !dirty());
					if (mode === "life") await loadDiaries();
				}
			}
		} catch (error) {
			if (scope && key(entry.scope, "life") === key(scope, "life")) showError(error);
			if (jobs.has(id)) setTimeout(() => void pollJob(id), 3000);
		}
	}
	window.addEventListener("beforeunload", (event) => {
		stash();
		if (![...drafts.values()].some((draft) => draft.settings || draft.schedule || draft.manual?.some(Boolean)))
			return;
		event.preventDefault();
		event.returnValue = "";
	});
	return {
		load,
		refreshModelCatalog() {
			if (view) return loadModelCatalog();
		},
		reset({ discard = false } = {}) {
			if (!discard) stash();
			invalidate();
			if (discard) {
				jobGeneration++;
				jobs.clear();
				drafts.clear();
				scope = undefined;
				modelCatalog = undefined;
				modelCatalogState = "loading";
			}
			clearView();
			for (const prefix of ["life", "model-task"]) {
				$(`${prefix}-error`).hidden = true;
				$(`${prefix}-error`).textContent = "";
				$(`${prefix}-status`).textContent = discard
					? "连接后载入此范围设置。"
					: "未保存的设置草稿已保留，返回此范围后可继续编辑。";
			}
		},
	};
}
