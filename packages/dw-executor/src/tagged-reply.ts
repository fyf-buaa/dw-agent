import { Check } from "typebox/value";
import { ExecutorError } from "./errors.ts";
import { ExpressionSchema, type ReplySegment } from "./protocol.ts";

export const OUTPUT_GRAMMAR = `Every user-visible reply must be one or more complete segments, with no text or Markdown fences outside them:
<segment><expression>{"description":"轻轻点头","language":"zh-CN"}</expression><speech>"你好。"</speech></segment>
expression is a required JSON object with exactly description and language. Write a nonempty, natural character expression description of at most 1000 characters in the stated language, using a language tag such as zh-CN, ja, or en. Do not wrap the description in parentheses, or put ASCII or fullwidth parentheses anywhere inside it. Do not include markup, code, tool calls, or private reasoning.
speech is a JSON string containing only the character's conversational speech. Escape quotes and newlines using JSON syntax.
Each segment contains one short complete sentence or a short self-contained utterance. Close each segment immediately before starting the next one.
Do not put identifiers, task references, timestamps, skeleton data, audio, or private reasoning in these tags. Native tool calls remain native tool calls.`;

type Stage =
	| "segment"
	| "expression_open"
	| "expression"
	| "expression_close"
	| "speech_open"
	| "speech"
	| "speech_close"
	| "segment_close";
export interface ParsedSegment {
	segment: ReplySegment;
	warning?: string;
}
export interface TaggedReplyOptions {
	start_index?: number;
	max_bytes?: number;
	allow_companion?: boolean;
	task_refs?: readonly string[];
}

const COMPANION_OPEN = "<companion>";
const COMPANION_CLOSE = "</companion>";
const MAX_COMPANION_BYTES = 32 * 1024;

/** Locate control tags only outside JSON strings; quoted speech remains byte-for-byte intact. */
export function stripCompanionControl(text: string): string {
	let quoted = false;
	let escaped = false;
	let hasSegment = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quoted) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
		} else if (char === '"') quoted = true;
		else if (text.startsWith("</segment>", index)) hasSegment = true;
		else if (hasSegment && text.startsWith(COMPANION_OPEN, index)) return text.slice(0, index).trimEnd();
	}
	return text;
}

/** Delimiters are recognized only outside JSON strings, including across arbitrary delta boundaries. */
export class TaggedReplyParser {
	private buffer = "";
	private stage: Stage = "segment";
	private expression: ReplySegment["expression"] | undefined;
	private speech = "";
	private index: number;
	private readonly messageId: string;
	private readonly maxBytes: number;
	private readonly taskRefs: string[];
	private scanOffset = 0;
	private quoted = false;
	private escaped = false;
	private readonly allowCompanion: boolean;
	private companionRaw: string | undefined;
	private segmentCount = 0;
	metadata: unknown;
	warning: string | undefined;

	constructor(messageId: string, options: TaggedReplyOptions = {}) {
		this.messageId = messageId;
		this.index = options.start_index ?? 0;
		this.maxBytes = options.max_bytes ?? 512 * 1024;
		this.allowCompanion = options.allow_companion ?? false;
		this.taskRefs = [...new Set(options.task_refs ?? [])];
	}

	push(delta: string, onSegment?: (value: ParsedSegment) => void): ParsedSegment[] {
		if (this.companionRaw !== undefined) {
			this.appendCompanion(delta);
			return [];
		}
		this.buffer += delta;
		const result: ParsedSegment[] = [];
		while (this.consume(result)) {
			if (onSegment && result.length > 0) {
				for (const parsed of result.splice(0)) onSegment(parsed);
			}
		}
		if (Buffer.byteLength(this.buffer) > this.maxBytes) throw this.invalid("Segment exceeds its size limit");
		return result;
	}

	finish(): void {
		if (this.companionRaw !== undefined) {
			this.finishCompanion();
			return;
		}
		if (
			this.allowCompanion &&
			this.segmentCount > 0 &&
			this.stage === "segment" &&
			this.buffer.trim().length > 0 &&
			COMPANION_OPEN.startsWith(this.buffer.trim())
		) {
			this.warning = "Invalid companion metadata was omitted";
			return;
		}
		if (this.stage !== "segment" || this.buffer.trim()) throw this.invalid("Incomplete tagged reply");
	}

	private appendCompanion(delta: string): void {
		if (this.warning) return;
		if (Buffer.byteLength(this.companionRaw ?? "") + Buffer.byteLength(delta) > MAX_COMPANION_BYTES) {
			this.companionRaw = "";
			this.warning = "Invalid companion metadata was omitted";
		} else this.companionRaw = (this.companionRaw ?? "") + delta;
	}

	private finishCompanion(): void {
		if (this.warning) return;
		const raw = this.companionRaw ?? "";
		let quoted = false;
		let escaped = false;
		for (let index = 0; index < raw.length; index++) {
			const char = raw[index];
			if (quoted) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === '"') quoted = false;
			} else if (char === '"') quoted = true;
			else if (raw.startsWith(COMPANION_CLOSE, index)) {
				try {
					const value: unknown = JSON.parse(raw.slice(0, index));
					if (
						!value ||
						typeof value !== "object" ||
						Array.isArray(value) ||
						raw.slice(index + COMPANION_CLOSE.length).trim()
					)
						break;
					this.metadata = value;
					return;
				} catch {
					break;
				}
			}
		}
		this.warning = "Invalid companion metadata was omitted";
	}

	private invalid(message: string): ExecutorError {
		return new ExecutorError("OUTPUT_FORMAT_ERROR", message);
	}

	private consume(result: ParsedSegment[]): boolean {
		if (this.companionRaw !== undefined) return false;
		if (this.stage === "expression" || this.stage === "speech") {
			const closing = this.stage === "expression" ? "</expression>" : "</speech>";
			for (let i = this.scanOffset; i < this.buffer.length; i++) {
				const char = this.buffer[i];
				if (this.quoted) {
					if (this.escaped) this.escaped = false;
					else if (char === "\\") this.escaped = true;
					else if (char === '"') this.quoted = false;
				} else if (char === '"') this.quoted = true;
				else if (char === "<") {
					if (closing.startsWith(this.buffer.slice(i))) {
						this.scanOffset = i;
						return false;
					}
					if (this.buffer.startsWith(closing, i)) {
						const raw = this.buffer.slice(0, i).trim();
						if (Buffer.byteLength(raw) > this.maxBytes) throw this.invalid("Segment exceeds its size limit");
						let value: unknown;
						try {
							value = JSON.parse(raw);
						} catch {
							throw this.invalid(`${this.stage} must be valid JSON`);
						}
						if (this.stage === "expression") {
							if (!Check(ExpressionSchema, value))
								throw this.invalid("Invalid expression description or language");
							this.expression = value;
							this.stage = "expression_close";
						} else {
							if (typeof value !== "string") throw this.invalid("speech must be a JSON string");
							this.speech = value;
							this.stage = "speech_close";
						}
						this.buffer = this.buffer.slice(i);
						this.scanOffset = 0;
						return true;
					}
				}
			}
			this.scanOffset = this.buffer.length;
			return false;
		}
		const expected: Record<Exclude<Stage, "expression" | "speech">, string> = {
			segment: "<segment>",
			expression_open: "<expression>",
			expression_close: "</expression>",
			speech_open: "<speech>",
			speech_close: "</speech>",
			segment_close: "</segment>",
		};
		this.buffer = this.buffer.trimStart();
		if (this.allowCompanion && this.segmentCount > 0 && this.stage === "segment") {
			if (COMPANION_OPEN.startsWith(this.buffer) && this.buffer.length < COMPANION_OPEN.length) return false;
			if (this.buffer.startsWith(COMPANION_OPEN)) {
				this.companionRaw = "";
				this.appendCompanion(this.buffer.slice(COMPANION_OPEN.length));
				this.buffer = "";
				return false;
			}
		}
		const token = expected[this.stage];
		if (token.startsWith(this.buffer) && this.buffer.length < token.length) return false;
		if (!this.buffer.startsWith(token)) throw this.invalid(`Expected ${token}`);
		this.buffer = this.buffer.slice(token.length);
		const next: Record<Exclude<Stage, "expression" | "speech">, Stage> = {
			segment: "expression_open",
			expression_open: "expression",
			expression_close: "speech_open",
			speech_open: "speech",
			speech_close: "segment_close",
			segment_close: "segment",
		};
		if (this.stage === "segment_close") {
			const expression = this.expression;
			if (!expression) throw this.invalid("Missing expression");
			const text = `（${expression.description}）${this.speech}`;
			if (Buffer.byteLength(JSON.stringify({ expression, speech: this.speech, text })) > this.maxBytes) {
				throw this.invalid("Segment exceeds its size limit");
			}
			this.segmentCount++;
			result.push({
				segment: {
					message_id: this.messageId,
					segment_id: `${this.messageId}:segment_${this.index}`,
					index: this.index++,
					expression,
					speech: this.speech,
					text,
					task_refs: [...this.taskRefs],
				},
			});
			this.expression = undefined;
			this.speech = "";
		}
		this.stage = next[this.stage];
		return true;
	}
}
