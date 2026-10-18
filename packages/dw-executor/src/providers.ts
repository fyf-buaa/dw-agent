import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { InlineExtension } from "../../coding-agent/src/core/sdk.ts";
import { createCodemodeExtension } from "../../coding-agent/src/extensions/codemode/index.ts";
import { createMcpExtension } from "../../coding-agent/src/extensions/mcp/index.ts";
import { createToolSearchExtension } from "../../coding-agent/src/extensions/tool-search/index.ts";
import { validateRoleplayConfig } from "./companion-runtime.ts";
import { RoleplaySchema } from "./companion-types.ts";
import { writePrivateJson } from "./config-files.ts";
import { ExecutorError } from "./errors.ts";

export const PersonaSchema = Type.Object({
	id: Type.String({ pattern: "^[A-Za-z0-9_-]{1,100}$" }),
	revision: Type.String({ minLength: 1, maxLength: 100 }),
	system_prompt: Type.String({ minLength: 1, maxLength: 65536 }),
	roleplay: Type.Optional(RoleplaySchema),
});
export type PersonaSnapshot = Static<typeof PersonaSchema>;
export interface PersonaProvider {
	load(id: string): Promise<PersonaSnapshot>;
}
export interface ToolProvider {
	extensions(): InlineExtension[];
}

const builtinDefaultPersona: PersonaSnapshot = {
	id: "default",
	revision: "1",
	system_prompt:
		"你是一位自然、真诚的数字伙伴。使用稳定的人格与用户交流，并记住当前对话中提供的信息。执行任务时保持相同的表达风格。",
};
const PersonaSaveSchema = Type.Object({
	system_prompt: PersonaSchema.properties.system_prompt,
	expected_revision: Type.Union([PersonaSchema.properties.revision, Type.Null()]),
	roleplay: Type.Optional(RoleplaySchema),
});

export class FilePersonaProvider implements PersonaProvider {
	private readonly directory: string;
	private saveQueue: Promise<void> = Promise.resolve();

	constructor(directory: string) {
		this.directory = directory;
	}

	async load(id: string): Promise<PersonaSnapshot> {
		try {
			return (await this.describe(id)).persona;
		} catch (error) {
			if (error instanceof ExecutorError && error.code === "PERSONA_NOT_FOUND")
				throw new ExecutorError("INVALID_PERSONA", "Persona could not be loaded");
			throw error;
		}
	}

	async list(): Promise<{
		personas: { id: string; revision: string; preview: string; builtin: boolean }[];
		errors: { id: string; message: string }[];
	}> {
		let names: string[];
		try {
			names = await readdir(this.directory);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") names = [];
			else throw new ExecutorError("INVALID_PERSONA", "Personas could not be listed");
		}
		const ids = new Set([
			"default",
			...names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)),
		]);
		const personas: { id: string; revision: string; preview: string; builtin: boolean }[] = [];
		const errors: { id: string; message: string }[] = [];
		for (const id of [...ids].sort()) {
			try {
				const { persona, builtin } = await this.describe(id);
				personas.push({
					id,
					revision: persona.revision,
					preview: persona.system_prompt.replace(/\s+/g, " ").trim().slice(0, 160),
					builtin,
				});
			} catch (error) {
				errors.push({
					id,
					message: error instanceof ExecutorError ? error.message : "Persona could not be loaded",
				});
			}
		}
		return { personas, errors };
	}

	async describe(id: string): Promise<{ persona: PersonaSnapshot; builtin: boolean }> {
		if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new ExecutorError("INVALID_PERSONA", "Invalid persona ID");
		let value: unknown;
		try {
			value = JSON.parse(await readFile(join(this.directory, `${id}.json`), "utf8"));
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				if (id === "default") return { persona: { ...builtinDefaultPersona }, builtin: true };
				throw new ExecutorError("PERSONA_NOT_FOUND", "Persona was not found");
			}
			throw new ExecutorError("INVALID_PERSONA", "Persona could not be loaded");
		}
		if (!Check(PersonaSchema, value) || value.id !== id)
			throw new ExecutorError("INVALID_PERSONA", "Invalid persona configuration");
		if (value.roleplay) validateRoleplayConfig(value.roleplay);
		return { persona: value, builtin: false };
	}

	save(id: string, value: unknown): Promise<{ persona: PersonaSnapshot; builtin: boolean }> {
		const operation = this.saveQueue.then(async () => {
			if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new ExecutorError("INVALID_PERSONA", "Invalid persona ID");
			if (!Check(PersonaSaveSchema, value) || !value.system_prompt.trim())
				throw new ExecutorError("INVALID_PERSONA", "Invalid persona configuration");
			let current: PersonaSnapshot | undefined;
			try {
				current = (await this.describe(id)).persona;
			} catch (error) {
				if (!(error instanceof ExecutorError) || error.code !== "PERSONA_NOT_FOUND") throw error;
			}
			if (value.expected_revision !== (current?.revision ?? null))
				throw new ExecutorError("PERSONA_REVISION_MISMATCH", "Persona has changed; reload it before saving");
			if (value.roleplay) validateRoleplayConfig(value.roleplay);
			const roleplay = value.roleplay ?? current?.roleplay;
			const persona: PersonaSnapshot = {
				id,
				revision: randomUUID(),
				system_prompt: value.system_prompt,
				...(roleplay ? { roleplay } : {}),
			};
			try {
				await mkdir(this.directory, { recursive: true, mode: 0o700 });
				await writePrivateJson(join(this.directory, `${id}.json`), persona);
			} catch {
				throw new ExecutorError("PERSONA_SAVE_FAILED", "Persona could not be saved");
			}
			return { persona, builtin: false };
		});
		this.saveQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}
}

export class PiToolProvider implements ToolProvider {
	extensions(): InlineExtension[] {
		return [createCodemodeExtension({ mode: "on" }), createToolSearchExtension(), createMcpExtension()];
	}
}
