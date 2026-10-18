const definitions = {
	routine: {
		title: "虚构日程",
		add: "添加日程",
		max: 24,
		columns: [
			{ key: "start", label: "开始时间", type: "time", required: true },
			{ key: "end", label: "结束时间", type: "time", required: true },
			{ key: "activity", label: "活动", max: 200, required: true, placeholder: "例如：图书馆阅读" },
			{ key: "location", label: "地点（可选）", max: 100, placeholder: "例如：图书馆" },
		],
	},
	dates: {
		title: "重要日期",
		add: "添加重要日期",
		max: 32,
		columns: [
			{ key: "date", label: "每年日期", type: "month-day", required: true },
			{ key: "label", label: "日期名称", max: 200, required: true, placeholder: "例如：生日、相识纪念日" },
		],
	},
	goals: {
		title: "角色目标",
		add: "添加目标",
		max: 24,
		columns: [
			{
				key: "text",
				label: "目标内容",
				type: "textarea",
				max: 500,
				required: true,
				placeholder: "例如：读完一本书",
			},
			{
				key: "status",
				label: "状态",
				options: [
					["active", "进行中"],
					["paused", "暂停"],
					["done", "已完成"],
				],
			},
			{ key: "id", label: "目标 ID（自动生成，可修改）", max: 100, required: true, pattern: "[A-Za-z0-9_-]{1,100}" },
		],
	},
};

export function createRecordEditor(host, kind) {
	const definition = definitions[kind];
	const heading = document.createElement("div");
	heading.className = "record-editor-heading";
	const title = document.createElement("h3");
	title.textContent = definition.title;
	const count = document.createElement("span");
	count.className = "field-note";
	count.setAttribute("aria-live", "polite");
	heading.append(title, count);
	const list = document.createElement("div");
	list.className = "record-editor-list";
	const empty = document.createElement("p");
	empty.className = "field-note";
	empty.textContent = "暂无条目，点击下方按钮添加。";
	const add = document.createElement("button");
	add.type = "button";
	add.className = "text-button record-editor-add";
	add.textContent = `+ ${definition.add}`;
	host.classList.add("record-editor");
	host.setAttribute("role", "group");
	host.setAttribute("aria-label", definition.title);
	host.replaceChildren(heading, list, empty, add);
	let rows = [];
	let sequence = 0;
	const notify = () => host.dispatchEvent(new Event("input", { bubbles: true }));
	function update() {
		count.textContent = `${rows.length} / ${definition.max} 项`;
		empty.hidden = rows.length !== 0;
		add.disabled = rows.length >= definition.max;
		rows.forEach((row, index) => {
			row.title.textContent = `${definition.title} ${index + 1}`;
			row.remove.setAttribute("aria-label", `删除${definition.title}第 ${index + 1} 项`);
		});
	}
	function append(value) {
		const card = document.createElement("div");
		card.className = "record-editor-row";
		const header = document.createElement("div");
		header.className = "record-editor-heading";
		const rowTitle = document.createElement("strong");
		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "text-button danger";
		remove.textContent = "删除";
		header.append(rowTitle, remove);
		const grid = document.createElement("div");
		grid.className = "record-editor-grid";
		const row = { card, title: rowTitle, remove, fields: {} };
		for (const column of definition.columns) {
			const label = document.createElement("label");
			const caption = document.createElement("span");
			caption.textContent = column.label;
			label.append(caption);
			const id = `${host.id}-row-${sequence++}-${column.key}`;
			if (column.type === "month-day") {
				const box = document.createElement("div");
				box.className = "record-date-parts";
				const parts = String(value.date ?? "").split("-");
				const controls = [12, 31].map((max, index) => {
					const select = document.createElement("select");
					select.id = `${id}-${index}`;
					select.required = true;
					select.setAttribute("aria-label", index === 0 ? "月份" : "日期");
					select.append(new Option(index === 0 ? "选择月份" : "选择日期", ""));
					for (let n = 1; n <= max; n++)
						select.append(new Option(`${n}${index === 0 ? " 月" : " 日"}`, String(n).padStart(2, "0")));
					select.value = parts[index] || "";
					box.append(select);
					return select;
				});
				label.htmlFor = controls[0].id;
				label.append(box);
				row.fields[column.key] = { controls, getValue: () => controls.map((field) => field.value).join("-") };
			} else {
				const field = document.createElement(
					column.options ? "select" : column.type === "textarea" ? "textarea" : "input",
				);
				field.id = id;
				label.htmlFor = id;
				if (column.options) for (const [value, label] of column.options) field.append(new Option(label, value));
				else if (column.type === "textarea") {
					field.rows = 2;
					label.classList.add("record-editor-wide");
				} else field.type = column.type || "text";
				if (column.max) field.maxLength = column.max;
				if (column.pattern) field.pattern = column.pattern;
				if (column.placeholder) field.placeholder = column.placeholder;
				field.required = Boolean(column.required);
				field.value = value[column.key] ?? "";
				label.append(field);
				row.fields[column.key] = { controls: [field], getValue: () => field.value };
			}
			grid.append(label);
		}
		card.append(header, grid);
		rows.push(row);
		list.append(card);
		remove.addEventListener("click", () => {
			rows = rows.filter((item) => item !== row);
			card.remove();
			update();
			notify();
			(add.disabled ? rows.at(-1)?.remove : add)?.focus();
		});
		return row;
	}
	function validate() {
		const values = rows.map((row) =>
			Object.fromEntries(Object.entries(row.fields).map(([key, field]) => [key, field.getValue()])),
		);
		for (const row of rows)
			for (const field of Object.values(row.fields))
				for (const control of field.controls) control.setCustomValidity("");
		rows.forEach((row, index) => {
			const value = values[index];
			for (const column of definition.columns) {
				if (column.required && column.type !== "month-day" && !value[column.key].trim())
					row.fields[column.key].controls[0].setCustomValidity(`请填写${column.label}。`);
			}
			if (kind === "dates") {
				const [month, day] = value.date.split("-").map(Number);
				if (month && day && day > new Date(Date.UTC(2000, month, 0)).getUTCDate())
					row.fields.date.controls[1].setCustomValidity("此月份没有该日期；2 月可选择 29 日。");
			} else if (kind === "goals") {
				if (values.some((other, i) => i !== index && other.id === value.id))
					row.fields.id.controls[0].setCustomValidity("目标 ID 不能重复，请为此目标填写不同 ID。");
			} else if (kind === "routine") {
				const minutes = (time) => {
					const [hour, minute] = time.split(":").map(Number);
					return hour * 60 + minute;
				};
				const start = minutes(value.start),
					end = minutes(value.end);
				if (value.start && value.end && start === end)
					row.fields.end.controls[0].setCustomValidity("结束时间不能与开始时间相同；跨午夜可选择次日的结束时间。");
				if (
					value.start &&
					value.end &&
					values.some((other, i) => {
						if (i === index || !other.start || !other.end) return false;
						const a = minutes(other.start),
							b = minutes(other.end);
						const segments =
							start < end
								? [[start, end]]
								: [
										[start, 1440],
										[0, end],
									];
						const otherSegments =
							a < b
								? [[a, b]]
								: [
										[a, 1440],
										[0, b],
									];
						return segments.some(([s, e]) => otherSegments.some(([os, oe]) => s < oe && os < e));
					})
				)
					row.fields.start.controls[0].setCustomValidity("此日程与其他条目的时间重叠，请调整开始或结束时间。");
			}
		});
		return rows.every((row) =>
			Object.values(row.fields).every((field) => field.controls.every((control) => control.checkValidity())),
		);
	}
	host.addEventListener("input", validate);
	host.addEventListener("change", validate);
	add.addEventListener("click", () => {
		if (rows.length >= definition.max) return;
		const row = append(kind === "goals" ? { id: `goal-${crypto.randomUUID()}`, text: "", status: "active" } : {});
		update();
		notify();
		Object.values(row.fields)[0].controls[0].focus();
	});
	update();
	return {
		getValue: () =>
			rows.map((row) =>
				Object.fromEntries(Object.entries(row.fields).map(([key, field]) => [key, field.getValue()])),
			),
		setValue(value) {
			rows = [];
			list.replaceChildren();
			for (const item of value || []) append(item);
			update();
		},
		validate,
	};
}
