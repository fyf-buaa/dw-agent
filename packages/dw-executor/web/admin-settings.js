export function initializeAdminSettings({ api, canManage = () => false, canManageTokens = () => false, notify }) {
	const host = document.getElementById("admin-page");
	const encode = encodeURIComponent;
	const editors = [];
	const node = (tag, value = "", className = "") =>
		Object.assign(document.createElement(tag), { textContent: value, className });
	const heading = node("h1", "服务管理");
	const note = node(
		"p",
		"管理仅向具有 manage 权限的令牌开放。配置更改按版本保存；密钥不会从服务器返回。",
		"field-note",
	);
	const error = node("p", "", "form-error");
	error.setAttribute("role", "alert");
	const status = node("p", "", "persona-save-status");
	status.setAttribute("role", "status");
	const content = node("div", "", "settings-content");
	let secretGeneration = 0;
	let generation = 0;
	let loaded = false;
	let tokenSection;
	const secretViews = new Set();
	const clearSecrets = () => {
		for (const field of host.querySelectorAll('input[type="password"], input[data-secret]')) field.value = "";
		for (const view of host.querySelectorAll("[data-secret-view]")) view.replaceChildren();
		for (const view of secretViews) view.replaceChildren();
	};
	function report(failure) {
		error.textContent = failure.message || "管理请求失败；未保存草稿已保留。";
	}
	function success(message) {
		error.textContent = "";
		status.textContent = message;
		notify?.(message);
	}
	function button(label, handler, danger = false) {
		const result = node("button", label, `text-button${danger ? " danger" : ""}`);
		result.type = "button";
		result.addEventListener("click", () => {
			if (canManage()) void handler();
		});
		return result;
	}
	async function request(path, method, value) {
		if (!canManage()) throw new Error("需要管理权限。");
		if ((path === "/api/tokens" || path.startsWith("/api/tokens/")) && !canManageTokens())
			throw new Error("访问令牌管理仅向 bootstrap root 开放。");
		return api(path, {
			method,
			...(value !== undefined
				? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }
				: {}),
		});
	}
	async function listAll(path) {
		let cursor;
		const items = [];
		do {
			const result = await api(`${path}${cursor ? `?cursor=${encode(cursor)}` : ""}`);
			items.push(...result.items);
			cursor = result.next_cursor;
		} while (cursor);
		return items;
	}
	function section(title, description) {
		const box = node("details", "", "companion-card life-settings-group");
		box.open = true;
		box.append(node("summary", title), node("p", description, "field-note"));
		content.append(box);
		return box;
	}
	function field(parent, title, options = {}) {
		const label = node("label", title);
		const input = document.createElement(options.choices ? "select" : "input");
		if (options.choices) for (const [value, caption] of options.choices) input.append(new Option(caption, value));
		else input.type = options.type || "text";
		input.required = options.required || false;
		if (options.min !== undefined) input.min = String(options.min);
		if (options.max !== undefined) input.max = String(options.max);
		if (input.type === "number") input.step = "1";
		if (input.type === "password") input.autocomplete = "new-password";
		label.append(input);
		parent.append(label);
		return input;
	}
	function rows(parent, title, { pairs = false, secret = false, choices } = {}) {
		const box = node("fieldset", "", "life-wide");
		box.append(node("legend", title));
		const list = node("div", "", "record-editor-list");
		let records = [];
		function append(key = "", value = "") {
			const row = node("div", "", "record-editor-grid");
			const first = field(row, pairs ? "名称" : "值", { type: secret && !pairs ? "password" : "text" });
			first.value = key;
			const second = pairs
				? field(row, secret ? "新值（留空保留已配置值）" : "值", { type: secret ? "password" : "text", choices })
				: null;
			if (second) second.value = value || choices?.[0]?.[0] || "";
			const entry = { row, first, second };
			row.append(
				button(
					"移除",
					() => {
						records = records.filter((record) => record !== entry);
						row.remove();
					},
					true,
				),
			);
			records.push(entry);
			list.append(row);
		}
		box.append(
			list,
			button("添加条目", () => append()),
		);
		parent.append(box);
		return {
			set(value) {
				records = [];
				list.replaceChildren();
				for (const item of pairs ? Object.entries(value || {}) : value || [])
					pairs ? append(item[0], secret ? "" : item[1]) : append(item);
			},
			get() {
				if (pairs)
					return Object.fromEntries(
						records
							.filter((item) => item.first.value.trim() && (!secret || item.second.value))
							.map((item) => [item.first.value.trim(), item.second.value]),
					);
				return records.map((item) => item.first.value.trim()).filter(Boolean);
			},
			clearSecrets() {
				if (secret) for (const item of records) (pairs ? item.second : item.first).value = "";
			},
		};
	}
	function resourceEditor({
		title,
		description,
		path,
		defaults,
		fields: definitions,
		read,
		serialize,
		removable = true,
		method = "PATCH",
		afterSave,
	}) {
		const box = section(title, description);
		const toolbar = node("div", "", "persona-actions");
		const select = document.createElement("select");
		select.setAttribute("aria-label", `选择${title}`);
		const revision = node("p", "", "field-note");
		const form = document.createElement("form");
		const grid = node("fieldset", "", "roleplay-grid");
		const controls = {};
		let records = [];
		let current;
		let baseline = "";
		let busy = false;
		const snapshot = () =>
			JSON.stringify(
				Object.fromEntries(
					Object.entries(controls).map(([key, control]) => [
						key,
						control.get ? control.get() : control.type === "checkbox" ? control.checked : control.value,
					]),
				),
			);
		const dirty = () => snapshot() !== baseline;
		for (const definition of definitions)
			controls[definition.key] = definition.rows
				? rows(grid, definition.title, definition.rows)
				: field(grid, definition.title, definition);
		function fill(record) {
			current = record;
			const data = record ? (read ? read(record) : record.data) : defaults;
			for (const [key, control] of Object.entries(controls)) {
				if (control.set) control.set(data[key]);
				else if (control.type === "checkbox") control.checked = Boolean(data[key]);
				else control.value = data[key] ?? "";
			}
			baseline = snapshot();
			select.value = record?.id || "";
			revision.textContent = record ? `资源 ${record.id} · 编辑版本 ${record.revision}` : "新建资源";
			remove.disabled = !record || record.id === "default" || !removable;
		}
		async function refresh({ preserve = true } = {}) {
			const epoch = generation;
			const values = await listAll(path);
			if (epoch !== generation) return;
			records = values;
			select.replaceChildren(
				new Option("新建资源", ""),
				...records.map((record) => new Option(record.data.name || record.id, record.id)),
			);
			if (preserve && dirty()) {
				select.value = current?.id || "";
				revision.textContent += " · 列表已刷新，草稿保留原版本";
			} else fill(records.find((record) => record.id === current?.id) || records[0]);
		}
		const create = button("新建", () => {
			if (!dirty() || window.confirm("放弃此表单未保存的草稿？")) fill(undefined);
		});
		const reload = button("刷新列表", async () => {
			try {
				await refresh();
			} catch (failure) {
				report(failure);
			}
		});
		const discard = button("放弃草稿并载入最新", async () => {
			if (!window.confirm("放弃此表单未保存的草稿？")) return;
			try {
				await refresh({ preserve: false });
			} catch (failure) {
				report(failure);
			}
		});
		const remove = button(
			"删除",
			async () => {
				if (!current || current.id === "default" || !window.confirm("确定删除所选资源？")) return;
				try {
					await request(`${path}/${encode(current.id)}?expected_revision=${current.revision}`, "DELETE");
					fill(undefined);
					await refresh({ preserve: false });
					success("资源已删除。");
				} catch (failure) {
					report(failure);
				}
			},
			true,
		);
		select.addEventListener("change", () => {
			const chosen = select.value;
			if (dirty() && !window.confirm("放弃此表单未保存的草稿？")) {
				select.value = current?.id || "";
				return;
			}
			fill(records.find((record) => record.id === chosen));
		});
		toolbar.append(select, create, reload, discard);
		if (removable) toolbar.append(remove);
		const save = node("button", "保存", "primary");
		save.type = "submit";
		form.append(grid, save);
		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			if (busy || !canManage() || !form.reportValidity()) return;
			const values = Object.fromEntries(
				Object.entries(controls).map(([key, control]) => [
					key,
					control.get
						? control.get()
						: control.type === "checkbox"
							? control.checked
							: control.type === "number"
								? Number(control.value)
								: control.value,
				]),
			);
			const value = serialize ? serialize(values, current) : values;
			busy = true;
			grid.disabled = true;
			save.disabled = true;
			try {
				const resource = await request(
					current ? `${path}/${encode(current.id)}` : path,
					current ? method : "POST",
					{ ...value, ...(current ? { expected_revision: current.revision } : {}) },
				);
				fill(resource);
				await refresh({ preserve: false });
				afterSave?.(resource);
				success("资源已保存。");
			} catch (failure) {
				report(failure);
			} finally {
				busy = false;
				grid.disabled = false;
				save.disabled = false;
			}
		});
		box.append(toolbar, revision, form);
		fill(undefined);
		const editor = {
			refresh,
			dirty,
			reset() {
				fill(undefined);
			},
			clearSecrets() {
				for (const control of Object.values(controls)) {
					if (control.clearSecrets) control.clearSecrets();
					else if (control.type === "password") control.value = "";
				}
			},
		};
		editors.push(editor);
		return editor;
	}
	function build() {
		resourceEditor({
			title: "工作区",
			description:
				"根目录必须是服务器上已有目录，且不可位于服务数据目录或 agent 目录内部；限制配置不等同于操作系统沙箱。",
			path: "/api/workspaces",
			defaults: { name: "", root: "" },
			fields: [
				{ key: "name", title: "名称", required: true },
				{ key: "root", title: "服务器目录", required: true },
			],
		});
		resourceEditor({
			title: "执行配置",
			description:
				"restricted 只允许实际受保护工具，并遵循批准策略；trusted_host 的每一次工具调用（包括读取）都必须显式批准，不受下方批准策略豁免。",
			path: "/api/execution-profiles",
			defaults: {
				name: "",
				tools: ["read", "write", "edit", "ls", "find", "grep"],
				approval: "writes",
				isolation: "restricted",
				max_model_calls: 32,
				max_concurrent_tasks: 1,
				timeout_ms: 300000,
				approval_timeout_ms: 60000,
			},
			fields: [
				{ key: "name", title: "名称", required: true },
				{ key: "tools", title: "允许的精确工具名", rows: {} },
				{
					key: "approval",
					title: "批准策略",
					choices: [
						["always", "每次批准"],
						["writes", "写操作批准"],
						["never", "受限工具免批准"],
					],
				},
				{
					key: "isolation",
					title: "隔离模式",
					choices: [
						["restricted", "受限"],
						["trusted_host", "信任主机（所有调用逐次批准）"],
					],
				},
				...[
					["max_model_calls", "模型调用上限"],
					["max_concurrent_tasks", "并发任务上限"],
					["timeout_ms", "任务超时（毫秒）"],
					["approval_timeout_ms", "批准超时（毫秒）"],
				].map(([key, title]) => ({ key, title, type: "number", min: 1, required: true })),
			],
		});
		buildTokens();
		buildMcp();
		buildInstalled();
	}
	function buildTokens() {
		const box = section(
			"访问令牌与范围",
			"密钥只显示一次，不写入本地草稿。空范围列表表示无权限；“不限制”表示全部。撤销立即影响 HTTP 与订阅。",
		);
		tokenSection = box;
		box.hidden = !canManageTokens();
		const list = node("div");
		const form = document.createElement("form");
		const grid = node("fieldset", "", "roleplay-grid");
		const name = field(grid, "名称", { required: true });
		const expires = field(grid, "到期时间", { type: "datetime-local", required: true });
		const permissions = {};
		for (const permission of ["read", "chat", "execute", "approve", "manage"])
			permissions[permission] = field(grid, permission, { type: "checkbox" });
		permissions.read.checked = true;
		const sessionsUnrestricted = field(grid, "不限制会话范围", { type: "checkbox" });
		const sessions = rows(grid, "允许的会话 ID");
		const companionsUnrestricted = field(grid, "不限制人格 × 用户范围", { type: "checkbox" });
		const companions = rows(grid, "允许的人格:用户范围");
		const once = node("div", "", "companion-warning");
		secretViews.add(once);
		const submit = node("button", "创建令牌", "primary");
		submit.type = "submit";
		form.append(grid, submit);
		async function refresh() {
			box.hidden = !canManageTokens();
			if (!canManageTokens()) {
				list.replaceChildren();
				once.replaceChildren();
				return;
			}
			const epoch = generation;
			const records = await listAll("/api/tokens");
			if (epoch !== generation || !canManageTokens()) return;
			list.replaceChildren(
				...records.map((record) => {
					const data = record.data;
					const row = node("article", "", "life-record");
					row.append(
						node("strong", data.name),
						node(
							"p",
							`${data.permissions.join("、")} · 到期 ${data.expires_at} · ${data.revoked_at ? "已撤销" : "有效"}`,
							"field-note",
						),
						node(
							"p",
							`会话：${data.session_ids === null ? "不限制" : data.session_ids.join("、") || "无"}；人格:用户：${data.companion_scopes === null ? "不限制" : data.companion_scopes.join("、") || "无"}`,
							"field-note",
						),
					);
					if (!data.revoked_at)
						row.append(
							button(
								"撤销",
								async () => {
									if (!window.confirm("确定撤销此令牌及其活动订阅？")) return;
									try {
										await request(
											`/api/tokens/${encode(record.id)}?expected_revision=${record.revision}`,
											"DELETE",
										);
										await refresh();
										success("令牌已撤销。");
									} catch (failure) {
										report(failure);
									}
								},
								true,
							),
						);
					return row;
				}),
			);
		}
		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			if (!canManage() || !canManageTokens() || !form.reportValidity()) return;
			const chosen = Object.entries(permissions)
				.filter(([, control]) => control.checked)
				.map(([permission]) => permission);
			if (!chosen.length) {
				report(new Error("至少选择一项权限。"));
				return;
			}
			submit.disabled = true;
			const secretEpoch = secretGeneration;
			once.replaceChildren();
			try {
				const result = await request("/api/tokens", "POST", {
					name: name.value.trim(),
					permissions: chosen,
					expires_at: new Date(expires.value).toISOString(),
					session_ids: sessionsUnrestricted.checked ? null : sessions.get(),
					companion_scopes: companionsUnrestricted.checked ? null : companions.get(),
				});
				if (secretEpoch !== secretGeneration || !canManage() || !canManageTokens()) return;
				const token = document.createElement("input");
				token.type = "password";
				token.readOnly = true;
				token.autocomplete = "off";
				token.value = result.token;
				const label = node("label", "新令牌（仅本次显示，请安全保存）");
				label.append(token);
				once.append(
					label,
					button("显示 / 隐藏", () => {
						token.type = token.type === "password" ? "text" : "password";
					}),
					button("清除", () => {
						token.value = "";
						once.replaceChildren();
					}),
				);
				await refresh();
				success("令牌已创建；离开管理页将清除一次性密钥。");
			} catch (failure) {
				report(failure);
			} finally {
				submit.disabled = false;
			}
		});
		box.append(
			list,
			button("刷新令牌", async () => {
				try {
					await refresh();
				} catch (failure) {
					report(failure);
				}
			}),
			form,
			once,
		);
		editors.push({
			refresh,
			dirty: () => false,
			reset() {
				form.reset();
				sessions.set([]);
				companions.set([]);
				list.replaceChildren();
				once.replaceChildren();
			},
			clearSecrets() {
				once.replaceChildren();
			},
		});
	}
	function buildMcp() {
		const box = section(
			"MCP 服务与 OAuth",
			"管理实际连接、服务工具与凭据。已有环境变量、HTTP 头和 OAuth 密钥不会回显；留空保留已配置秘密。",
		);
		const list = node("div");
		const form = document.createElement("form");
		const grid = node("fieldset", "", "roleplay-grid");
		const id = field(grid, "服务 ID", { required: true });
		const transport = field(grid, "传输方式", {
			choices: [
				["stdio", "本地进程"],
				["http", "HTTP"],
			],
		});
		const enabled = field(grid, "启用", { type: "checkbox" });
		enabled.checked = true;
		const command = field(grid, "命令");
		const args = rows(grid, "命令参数（离开页面将清空未保存的秘密输入）", { secret: true });
		const replaceArgs = field(grid, "替换命令参数（已配置的秘密参数不会回显）", { type: "checkbox" });
		const cwd = field(grid, "工作目录（可选）");
		const env = rows(grid, "环境变量（秘密输入）", { pairs: true, secret: true });
		const url = field(grid, "服务 URL", { type: "url" });
		const headers = rows(grid, "HTTP 请求头（秘密输入）", { pairs: true, secret: true });
		const clientId = field(grid, "OAuth Client ID（可选）");
		const clientSecret = field(grid, "OAuth Client Secret（留空保留）", { type: "password" });
		const scope = field(grid, "OAuth scope（可选）");
		const timeout = field(grid, "超时（毫秒）", { type: "number", min: 1 });
		const exposures = [
			["codemode", "仅 Code Mode"],
			["deferred", "按需工具"],
			["direct", "直接工具"],
			["hidden", "隐藏"],
		];
		const exposure = field(grid, "工具默认暴露方式", { choices: exposures });
		const toolExposure = rows(grid, "逐工具暴露方式（工具名或 * 通配符）", { pairs: true, choices: exposures });
		const state = node("p", "新建服务", "field-note");
		let current;
		let baseline = "";
		const snapshot = () =>
			JSON.stringify([
				id.value,
				transport.value,
				enabled.checked,
				command.value,
				args.get(),
				replaceArgs.checked,
				cwd.value,
				env.get(),
				url.value,
				headers.get(),
				clientId.value,
				clientSecret.value,
				scope.value,
				timeout.value,
				exposure.value,
				toolExposure.get(),
			]);
		function fill(record) {
			current = record;
			const config = record?.data.config || {};
			id.value = record?.id || "";
			id.readOnly = Boolean(record);
			transport.value = config.url ? "http" : "stdio";
			enabled.checked = config.enabled !== false;
			command.value = config.command || "";
			args.set(config.args || []);
			cwd.value = config.cwd || "";
			replaceArgs.checked = !record || !record.data.secret_fields?.includes("args");
			exposure.value = config.exposure || "codemode";
			toolExposure.set(config.toolExposure || {});
			env.set(config.env || {});
			headers.set(config.headers || {});
			url.value = config.url || "";
			clientId.value = config.oauth?.clientId || "";
			clientSecret.value = "";
			scope.value = config.oauth?.scope || "";
			timeout.value = config.timeout || "";
			state.textContent = record
				? `编辑版本 ${record.revision} · 已配置秘密字段：${record.data.secret_fields?.join("、") || "无"}`
				: "新建服务";
			baseline = snapshot();
		}
		async function clearConfiguredSecret(kind) {
			if (!current) {
				report(new Error("请先选择已保存的 MCP 服务。"));
				return;
			}
			if (!window.confirm("确定清除服务器已保存的此类秘密？表单中尚未保存的新值仍保留。")) return;
			const config = { ...current.data.config };
			if (kind === "oauth") config.oauth = { ...(config.oauth || {}), clientSecret: "" };
			else config[kind] = null;
			try {
				current = await request(`/api/mcp/servers/${encode(current.id)}`, "PUT", {
					expected_revision: current.revision,
					config,
				});
				state.textContent = `编辑版本 ${current.revision} · 已配置秘密字段：${current.data.secret_fields?.join("、") || "无"} · 表单草稿保留`;
				await refresh();
				success("已清除服务器保存的秘密；可在结构化表单中重新配置。");
			} catch (failure) {
				report(failure);
			}
		}
		grid.append(
			button("清空已保存的全部环境变量", () => clearConfiguredSecret("env"), true),
			button("清空已保存的全部 HTTP 头", () => clearConfiguredSecret("headers"), true),
			button("清除已保存的 OAuth Client Secret", () => clearConfiguredSecret("oauth"), true),
		);
		function action(record, label, suffix, method = "POST", value = {}) {
			return button(label, async () => {
				if (method === "DELETE" && !window.confirm("确定删除此服务或清除其 OAuth 登录？")) return;
				try {
					await request(
						`/api/mcp/servers/${encode(record.id)}${suffix}${method === "DELETE" ? `?expected_revision=${record.revision}` : ""}`,
						method,
						method === "DELETE" ? undefined : value,
					);
					await refresh();
					success("MCP 操作已完成。");
				} catch (failure) {
					report(failure);
				}
			});
		}
		async function refresh() {
			const epoch = generation;
			const records = await listAll("/api/mcp/servers");
			if (epoch !== generation) return;
			list.replaceChildren(
				...records.map((record) => {
					const data = record.data;
					const row = node("article", "", "life-record");
					row.append(
						node(
							"strong",
							`${record.id} · ${typeof data.status === "string" ? data.status : data.status?.state || "状态见服务"}`,
						),
						node(
							"p",
							`工具：${(data.tools || []).map((tool) => tool.name).join("、") || "无"} · OAuth ${data.oauth?.authenticated ? "已认证" : data.oauth?.supported ? "可认证" : "不支持"}`,
							"field-note",
						),
					);
					if (data.error) row.append(node("p", data.error.message, "form-error"));
					row.append(
						button("编辑", () => {
							if (snapshot() !== baseline && !window.confirm("放弃 MCP 表单草稿？")) return;
							fill(record);
						}),
						action(record, "重新连接", "/reconnect"),
						action(record, "删除服务", "", "DELETE"),
					);
					if (data.oauth?.supported) {
						const authorization = node("div");
						const redirect = field(authorization, "完整 OAuth 回调 URL", { type: "url" });
						redirect.dataset.secret = "true";
						const authState = node("p", "", "field-note");
						authState.dataset.secretView = "true";
						function showAuth(auth) {
							authState.replaceChildren(document.createTextNode(auth.status));
							if (auth.authorization_url) {
								const target = new URL(auth.authorization_url);
								if (!["https:", "http:"].includes(target.protocol)) throw new Error("OAuth 授权 URL 无效。");
								const link = node("a", "打开供应商授权页面");
								link.href = target.href;
								link.target = "_blank";
								link.rel = "noopener noreferrer";
								authState.append(" · ", link);
							}
							if (auth.error) authState.append(` · ${auth.error.message}`);
						}
						async function authAction(suffix, method, body) {
							const epoch = secretGeneration;
							try {
								const path = `/api/mcp/servers/${encode(record.id)}/authorization${suffix}`;
								const result = method === "GET" ? await api(path) : await request(path, method, body);
								if (epoch === secretGeneration && canManage()) showAuth(result);
							} catch (failure) {
								report(failure);
							}
						}
						authorization.append(
							button("开始 OAuth", () => authAction("", "POST", {})),
							button("查询 OAuth 状态", () => authAction("", "GET")),
							button("完成 OAuth 回调", async () => {
								if (!redirect.reportValidity() || !redirect.value) return;
								const redirectUrl = redirect.value;
								redirect.value = "";
								await authAction("/complete", "POST", { redirect_url: redirectUrl });
							}),
							action(record, "退出 OAuth", "/authorization", "DELETE"),
							authState,
						);
						row.append(authorization);
					}
					return row;
				}),
			);
		}
		const submit = node("button", "保存 MCP 服务", "primary");
		submit.type = "submit";
		form.append(grid, state, submit);
		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			if (!canManage() || !form.reportValidity()) return;
			const config = {
				...(current?.data.config || {}),
				enabled: enabled.checked,
				exposure: exposure.value,
				toolExposure: toolExposure.get(),
			};
			if (timeout.value) config.timeout = Number(timeout.value);
			if (transport.value === "stdio") {
				delete config.url;
				delete config.headers;
				delete config.oauth;
				config.command = command.value.trim();
				if (replaceArgs.checked) config.args = args.get();
				else delete config.args;
				if (cwd.value.trim()) config.cwd = cwd.value.trim();
				else delete config.cwd;
				const values = env.get();
				if (Object.keys(values).length) config.env = values;
				else delete config.env;
			} else {
				delete config.command;
				delete config.args;
				delete config.cwd;
				delete config.env;
				config.url = url.value.trim();
				const values = headers.get();
				if (Object.keys(values).length) config.headers = values;
				else delete config.headers;
				if (clientId.value || clientSecret.value || scope.value)
					config.oauth = {
						...(config.oauth || {}),
						...(clientId.value ? { clientId: clientId.value } : {}),
						...(clientSecret.value ? { clientSecret: clientSecret.value } : {}),
						...(scope.value ? { scope: scope.value } : {}),
					};
			}
			submit.disabled = true;
			try {
				const record = await request(`/api/mcp/servers/${encode(id.value.trim())}`, "PUT", {
					expected_revision: current?.revision ?? null,
					config,
				});
				fill(record);
				await refresh();
				success("MCP 服务已保存。");
			} catch (failure) {
				report(failure);
			} finally {
				env.clearSecrets();
				headers.clearSecrets();
				clientSecret.value = "";
				submit.disabled = false;
			}
		});
		box.append(
			list,
			button("刷新服务状态", async () => {
				try {
					await refresh();
				} catch (failure) {
					report(failure);
				}
			}),
			button("新建服务", () => {
				if (snapshot() === baseline || window.confirm("放弃 MCP 表单草稿？")) fill(undefined);
			}),
			form,
		);
		fill(undefined);
		editors.push({
			refresh,
			dirty: () => snapshot() !== baseline,
			reset() {
				fill(undefined);
			},
			clearSecrets() {
				env.clearSecrets();
				headers.clearSecrets();
				clientSecret.value = "";
			},
		});
	}
	function buildInstalled() {
		const box = section(
			"已安装扩展与技能",
			"仅管理服务器已发现的受信任安装资源，不支持远程安装。启用状态保存后，显式重载空闲会话；繁忙会话会拒绝重载而不被取消。",
		);
		const list = node("div");
		const drafts = new Map();
		async function refresh() {
			const epoch = generation;
			const catalogs = await Promise.all(
				["extensions", "skills"].map(async (kind) => ({ kind, items: await listAll(`/api/${kind}`) })),
			);
			if (epoch !== generation) return;
			list.replaceChildren();
			for (const { kind, items } of catalogs) {
				list.append(node("h3", kind === "extensions" ? "扩展" : "技能"));
				for (const record of items) {
					const row = node("div", "", "life-record");
					const key = `${kind}/${record.id}`;
					const draft = drafts.get(key);
					const toggle = field(row, `${record.data.name} · ${record.data.path}`, { type: "checkbox" });
					toggle.checked = draft?.enabled ?? record.data.enabled;
					toggle.addEventListener("change", () => {
						if (toggle.checked === record.data.enabled) drafts.delete(key);
						else drafts.set(key, { enabled: toggle.checked, revision: draft?.revision ?? record.revision });
					});
					row.append(
						button("保存启用状态", async () => {
							try {
								await request(`/api/${kind}/${encode(record.id)}`, "PATCH", {
									expected_revision: drafts.get(key)?.revision ?? record.revision,
									enabled: toggle.checked,
								});
								drafts.delete(key);
								await refresh();
								success("资源状态已保存；请显式重载。");
							} catch (failure) {
								report(failure);
							}
						}),
					);
					list.append(row);
				}
				if (!items.length) list.append(node("p", "无已安装资源", "field-note"));
			}
		}
		box.append(
			list,
			button("刷新安装目录", async () => {
				try {
					await refresh();
				} catch (failure) {
					report(failure);
				}
			}),
			button("重载已安装资源", async () => {
				try {
					await request("/api/resources/reload", "POST", {});
					await refresh();
					success("空闲会话资源已重载。");
				} catch (failure) {
					report(failure);
				}
			}),
		);
		editors.push({
			refresh,
			dirty: () => drafts.size > 0,
			reset() {
				drafts.clear();
				list.replaceChildren();
			},
			clearSecrets() {},
		});
	}
	host.replaceChildren(heading, note, error, status, content);
	build();
	window.addEventListener("beforeunload", (event) => {
		if (editors.some((editor) => editor.dirty())) {
			event.preventDefault();
			event.returnValue = "";
		}
	});
	return {
		async load() {
			tokenSection.hidden = !canManageTokens();
			content.hidden = !canManage();
			if (!canManage()) {
				clearSecrets();
				error.textContent = "当前令牌无管理权限。";
				return;
			}
			error.textContent = "";
			if (loaded) return;
			try {
				await Promise.all(editors.map((editor) => editor.refresh()));
				loaded = true;
			} catch (failure) {
				report(failure);
			}
		},
		reset({ discard = false } = {}) {
			tokenSection.hidden = !canManageTokens();
			secretGeneration++;
			clearSecrets();
			for (const editor of editors) editor.clearSecrets();
			if (discard) {
				generation++;
				loaded = false;
				for (const editor of editors) editor.reset();
			}
			content.hidden = !canManage();
		},
	};
}
