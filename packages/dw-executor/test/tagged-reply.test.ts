import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { type ReplySegment, SegmentSchema } from "../src/protocol.ts";
import { stripCompanionControl, TaggedReplyParser } from "../src/tagged-reply.ts";

const expression = { description: "轻轻点头，微笑👋", language: "zh-CN" };
function segment(speech: string, value: unknown = expression): string {
	return `<segment>\n<expression>${JSON.stringify(value)}</expression>\n<speech>${JSON.stringify(speech)}</speech>\n</segment>`;
}

describe("expression reply stream", () => {
	it("parses every split point and preserves Unicode, escapes, and delimiter-like speech", () => {
		const speech = '你好，"朋友"。正文中的 </speech> 不是标记。\\n\n再见👋';
		const second = { description: "目を細めて笑う", language: "ja" };
		const input = segment(speech) + segment("またね。", second);
		for (let split = 0; split <= input.length; split++) {
			const parser = new TaggedReplyParser("message", { start_index: 4, task_refs: ["task_a", "task_b"] });
			const result = [...parser.push(input.slice(0, split)), ...parser.push(input.slice(split))];
			parser.finish();
			expect(result.map((value) => value.segment)).toEqual([
				{
					message_id: "message",
					segment_id: "message:segment_4",
					index: 4,
					expression,
					speech,
					text: `（${expression.description}）${speech}`,
					task_refs: ["task_a", "task_b"],
				},
				{
					message_id: "message",
					segment_id: "message:segment_5",
					index: 5,
					expression: second,
					speech: "またね。",
					text: "（目を細めて笑う）またね。",
					task_refs: ["task_a", "task_b"],
				},
			]);
			expect(result.every((value) => Check(SegmentSchema, value.segment))).toBe(true);
		}
	});

	it("emits only complete segments while consuming one UTF-16 code unit at a time", () => {
		const parser = new TaggedReplyParser("message");
		const input = segment("欢迎回来！𠮷👋");
		const delivered: ReplySegment[] = [];
		for (let index = 0; index < input.length; index++) {
			parser.push(input[index], ({ segment }) => delivered.push(segment));
			if (index < input.length - 1) expect(delivered).toHaveLength(0);
		}
		parser.finish();
		expect(delivered[0].speech).toBe("欢迎回来！𠮷👋");
		expect(delivered[0].text).toBe("（轻轻点头，微笑👋）欢迎回来！𠮷👋");
		expect(delivered[0].task_refs).toEqual([]);
	});

	it("uses only runtime IDs/task references and isolates emitted reference arrays", () => {
		const refs = ["task_a", "task_a"];
		const parser = new TaggedReplyParser("message_runtime", { task_refs: refs });
		refs.push("task_later");
		const first = parser.push(segment("第一句。"))[0].segment;
		first.task_refs.push("changed_by_consumer");
		const second = parser.push(segment("第二句。"))[0].segment;
		parser.finish();
		expect(second.task_refs).toEqual(["task_a"]);
		expect(second.message_id).toBe("message_runtime");
		expect(second.segment_id).toBe("message_runtime:segment_1");
	});

	it.each([
		null,
		[],
		{},
		{ description: "", language: "zh-CN" },
		{ description: "   ", language: "zh-CN" },
		{ description: "轻轻点头", language: "" },
		{ description: "轻轻点头", language: "中文" },
		{ description: "（轻轻点头）", language: "zh-CN" },
		{ description: "微笑（轻轻点头）", language: "zh-CN" },
		{ description: "smile (and nod)", language: "en" },
		{ description: "点头)", language: "zh-CN" },
		{ description: "<tool>execute</tool>", language: "en" },
		{ description: "`console.log`", language: "en" },
		{ description: "nod", language: "en", private_reasoning: "hidden" },
		{ description: "点".repeat(1001), language: "zh-CN" },
	])("fails invalid required expressions without inventing a fallback: %j", (value) => {
		const parser = new TaggedReplyParser("message");
		const delivered: ReplySegment[] = [];
		expect(() => parser.push(segment("不能以空动作降级。", value), ({ segment }) => delivered.push(segment))).toThrow(
			"Invalid expression",
		);
		expect(delivered).toEqual([]);
	});

	it("accepts the description length boundary without English or renderer binding", () => {
		const parser = new TaggedReplyParser("message");
		const value = { description: "微".repeat(1000), language: "zh-Hans-CN" };
		const [parsed] = parser.push(segment("你好。", value));
		parser.finish();
		expect(parsed.segment.expression).toEqual(value);
		expect(parsed.segment.text).toBe(`（${value.description}）你好。`);
		expect(parsed.segment).not.toHaveProperty("actions");
	});

	it("retains a completed segment when the same delta then contains malformed output", () => {
		const parser = new TaggedReplyParser("message");
		const delivered: ReplySegment[] = [];
		expect(() =>
			parser.push(`${segment("第一句。")}unmarked text`, ({ segment }) => delivered.push(segment)),
		).toThrow("Expected <segment>");
		expect(delivered.map((item) => item.speech)).toEqual(["第一句。"]);
	});

	it.each([
		"<segment>",
		'<segment><expression>{"description":"点头","language":"zh-CN"}</expression><speech>"半句',
		'<segment><expression>{"description":"点头","language":"zh-CN"}</expression><speech>17</speech></segment>',
		'<segment><expression>{broken}</expression><speech>"台词"</speech></segment>',
		'<segment><speech>"缺少表情"</speech></segment>',
		'<segment><actions>[]</actions><speech>"旧语法"</speech></segment>',
		`<segment><expression>${JSON.stringify(expression)}</expression><speech>"台词"</speech>`,
	])("rejects incomplete JSON, invalid speech, missing expression, and removed syntax: %s", (input) => {
		const parser = new TaggedReplyParser("message");
		expect(() => {
			parser.push(input);
			parser.finish();
		}).toThrow();
	});

	it("bounds malformed JSON buffers and completed payloads by UTF-8 bytes", () => {
		const parser = new TaggedReplyParser("message", { max_bytes: 64 });
		expect(() => parser.push(`<segment><expression>"${"点".repeat(100)}`)).toThrow("size limit");
		const complete = new TaggedReplyParser("message", { max_bytes: 180 });
		expect(() => complete.push(segment("你".repeat(40)))).toThrow("size limit");
	});

	it("accepts split companion JSON/evidence without altering full visible segments", () => {
		const speech = 'Literal <companion>{}</companion> and \\\\" quotes.';
		const metadata = {
			memories: [{ content: "喜欢散步", evidence: [{ quote: "一起散步吧👋", source: "user" }] }],
			note: 'quoted </companion> with "quotes" and \\\\slashes',
		};
		const visible = segment(speech) + segment("再见。");
		const input = `${visible}<companion>${JSON.stringify(metadata)}</companion>`;
		for (let split = 0; split <= input.length; split++) {
			const parser = new TaggedReplyParser("message", { allow_companion: true });
			const result = [...parser.push(input.slice(0, split)), ...parser.push(input.slice(split))];
			parser.finish();
			expect(result.map((value) => value.segment.speech)).toEqual([speech, "再见。"]);
			expect(parser.metadata).toEqual(metadata);
			expect(parser.warning).toBeUndefined();
			expect(stripCompanionControl(input)).toBe(visible);
		}
	});

	it.each([
		"<companion>{broken}</companion>",
		'<companion>{"note":"unfinished',
		"<comp",
		"<companion>[]</companion>",
		"<companion>{}</companion><companion>{}</companion>",
		"<companion>{}</companion>trailing junk",
		`<companion>{"note":"${"x".repeat(33000)}"}</companion>`,
	])("omits invalid optional metadata without failing complete speech: %s", (suffix) => {
		const parser = new TaggedReplyParser("message", { allow_companion: true });
		const result = parser.push(segment("Visible speech.") + suffix);
		parser.finish();
		expect(result[0].segment.speech).toBe("Visible speech.");
		expect(result[0].segment.text).toBe("（轻轻点头，微笑👋）Visible speech.");
		expect(parser.metadata).toBeUndefined();
		expect(parser.warning).toBeDefined();
	});

	it("consumes metadata one code unit at a time and keeps disabled grammar strict", () => {
		const input = `${segment("Visible speech.")}<companion>{"memories":[]}</companion>`;
		const parser = new TaggedReplyParser("message", { allow_companion: true });
		const result = [...input].flatMap((char) => parser.push(char));
		parser.finish();
		expect(result).toHaveLength(1);
		expect(parser.metadata).toEqual({ memories: [] });
		expect(() => new TaggedReplyParser("disabled").push(input)).toThrow("Expected <segment>");
		expect(() =>
			new TaggedReplyParser("message", { allow_companion: true }).push("<companion>{}</companion>"),
		).toThrow();
		expect(stripCompanionControl(segment("The <companion>literal</companion> stays."))).toBe(
			segment("The <companion>literal</companion> stays."),
		);
	});
});
