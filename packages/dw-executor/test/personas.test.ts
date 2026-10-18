import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { FilePersonaProvider } from "../src/providers.ts";
import { ExecutorService } from "../src/service.ts";
import { fixture, tagged } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "dw-personas-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "personas");
	return { root, directory, provider: new FilePersonaProvider(directory) };
}

describe("file persona management", () => {
	it("inherits the built-in default without a file and preserves load's missing-persona error", async () => {
		const { directory, provider } = await setup();
		const builtin = await provider.describe("default");
		expect(builtin.builtin).toBe(true);
		expect(builtin.persona.id).toBe("default");
		expect(await provider.load("default")).toEqual(builtin.persona);
		expect(await provider.list()).toEqual({
			personas: [
				{
					id: "default",
					revision: builtin.persona.revision,
					preview: expect.any(String),
					builtin: true,
				},
			],
			errors: [],
		});
		builtin.persona.system_prompt = "a caller must not mutate the built-in default";
		expect((await provider.load("default")).system_prompt).not.toBe(builtin.persona.system_prompt);
		await expect(provider.describe("missing")).rejects.toMatchObject({ code: "PERSONA_NOT_FOUND" });
		await expect(provider.load("missing")).rejects.toMatchObject({ code: "INVALID_PERSONA" });
		await expect(readFile(join(directory, "default.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("persists new personas atomically, returns short previews, and reads them after a restart", async () => {
		const { directory, provider } = await setup();
		const system_prompt = `  Guide persona\n${"private instructions ".repeat(30)}  `;
		const saved = await provider.save("guide_1-test", { system_prompt, expected_revision: null });
		expect(saved.builtin).toBe(false);
		expect(saved.persona).toMatchObject({ id: "guide_1-test", system_prompt });
		expect(JSON.parse(await readFile(join(directory, "guide_1-test.json"), "utf8"))).toEqual(saved.persona);
		expect(await readdir(directory)).toEqual(["guide_1-test.json"]);
		const restarted = new FilePersonaProvider(directory);
		expect(await restarted.load("guide_1-test")).toEqual(saved.persona);
		expect(await restarted.describe("guide_1-test")).toEqual(saved);
		const listed = await restarted.list();
		expect(listed.errors).toEqual([]);
		expect(listed.personas.map((persona) => persona.id)).toEqual(["default", "guide_1-test"]);
		const summary = listed.personas.find((persona) => persona.id === "guide_1-test")!;
		expect(summary).toMatchObject({ revision: saved.persona.revision, builtin: false });
		expect(summary).not.toHaveProperty("system_prompt");
	});

	it("requires the inherited revision to override default and keeps the prior snapshot unchanged", async () => {
		const { directory, provider } = await setup();
		const original = await provider.load("default");
		const originalCopy = { ...original };
		await expect(
			provider.save("default", { system_prompt: "replacement default", expected_revision: null }),
		).rejects.toMatchObject({ code: "PERSONA_REVISION_MISMATCH" });
		await expect(readFile(join(directory, "default.json"))).rejects.toMatchObject({ code: "ENOENT" });
		const saved = await provider.save("default", {
			system_prompt: "replacement default",
			expected_revision: original.revision,
		});
		expect(saved.builtin).toBe(false);
		expect(saved.persona.revision).not.toBe(original.revision);
		expect(original).toEqual(originalCopy);
		expect(await new FilePersonaProvider(directory).describe("default")).toEqual(saved);
		expect((await provider.list()).personas.find((persona) => persona.id === "default")?.builtin).toBe(false);
	});

	it("leaves files unchanged on revision conflicts and permits only one competing save", async () => {
		const { directory, provider } = await setup();
		const first = await provider.save("guide", { system_prompt: "first", expected_revision: null });
		const path = join(directory, "guide.json");
		const originalBytes = await readFile(path, "utf8");
		for (const expected_revision of [null, "stale-revision"]) {
			await expect(
				provider.save("guide", { system_prompt: "must not persist", expected_revision }),
			).rejects.toMatchObject({
				code: "PERSONA_REVISION_MISMATCH",
			});
			expect(await readFile(path, "utf8")).toBe(originalBytes);
		}
		await expect(
			provider.save("absent", { system_prompt: "must not create", expected_revision: first.persona.revision }),
		).rejects.toMatchObject({ code: "PERSONA_REVISION_MISMATCH" });
		const outcomes = await Promise.allSettled([
			provider.save("guide", { system_prompt: "winner", expected_revision: first.persona.revision }),
			provider.save("guide", { system_prompt: "loser", expected_revision: first.persona.revision }),
		]);
		expect(outcomes[0]).toMatchObject({ status: "fulfilled" });
		expect(outcomes[1]).toMatchObject({ status: "rejected", reason: { code: "PERSONA_REVISION_MISMATCH" } });
		const saved = await provider.load("guide");
		expect(saved.system_prompt).toBe("winner");
		expect(saved.revision).not.toBe(first.persona.revision);
		expect(await readdir(directory)).toEqual(["guide.json"]);
	});

	it("rejects unsafe IDs and invalid prompts before creating or changing files", async () => {
		const { root, directory, provider } = await setup();
		const outside = join(root, "outside.json");
		await writeFile(outside, "unchanged sentinel");
		for (const id of ["", "../outside", "..\\outside", "/outside", "a/b", "a\\b", "with space", "a".repeat(101)]) {
			await expect(provider.load(id)).rejects.toMatchObject({ code: "INVALID_PERSONA" });
			await expect(provider.describe(id)).rejects.toMatchObject({ code: "INVALID_PERSONA" });
			await expect(
				provider.save(id, { system_prompt: "must not write", expected_revision: null }),
			).rejects.toMatchObject({
				code: "INVALID_PERSONA",
			});
		}
		for (const value of [
			null,
			{},
			{ system_prompt: "valid but no expected revision" },
			{ system_prompt: 42, expected_revision: null },
			{ system_prompt: "", expected_revision: null },
			{ system_prompt: " \n\t\u3000", expected_revision: null },
			{ system_prompt: "x".repeat(65537), expected_revision: null },
			{ system_prompt: "valid", expected_revision: 1 },
		]) {
			await expect(provider.save("safe", value)).rejects.toMatchObject({ code: "INVALID_PERSONA" });
		}
		expect(await readFile(outside, "utf8")).toBe("unchanged sentinel");
		await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
		const maximum = await provider.save("safe", { system_prompt: "x".repeat(65536), expected_revision: null });
		expect((await provider.load("safe")).system_prompt).toBe(maximum.persona.system_prompt);
	});

	it("reports corrupt files independently, hides their contents, and never overwrites them", async () => {
		const { directory, provider } = await setup();
		await mkdir(directory, { recursive: true });
		const invalidFiles: Record<string, string> = {
			broken: '{"secret prompt": "DO_NOT_EXPOSE_PARSE_CONTENT",',
			mismatched: JSON.stringify({ id: "other", revision: "1", system_prompt: "DO_NOT_EXPOSE_SCHEMA_CONTENT" }),
			"bad name": JSON.stringify({ id: "bad name", revision: "1", system_prompt: "invalid ID" }),
		};
		for (const [id, bytes] of Object.entries(invalidFiles)) await writeFile(join(directory, `${id}.json`), bytes);
		await writeFile(join(directory, "notes.txt"), "unrelated file");
		await provider.save("valid", { system_prompt: "valid persona", expected_revision: null });
		const listed = await provider.list();
		expect(listed.personas.map((persona) => persona.id)).toEqual(["default", "valid"]);
		expect(listed.errors.map((error) => error.id)).toEqual(["bad name", "broken", "mismatched"]);
		expect(JSON.stringify(listed.errors)).not.toContain("DO_NOT_EXPOSE");
		for (const [id, bytes] of Object.entries(invalidFiles)) {
			await expect(provider.describe(id)).rejects.toMatchObject({ code: "INVALID_PERSONA" });
			await expect(
				provider.save(id, { system_prompt: "must not replace", expected_revision: null }),
			).rejects.toMatchObject({
				code: "INVALID_PERSONA",
			});
			expect(await readFile(join(directory, `${id}.json`), "utf8")).toBe(bytes);
		}
		expect(await readFile(join(directory, "notes.txt"), "utf8")).toBe("unrelated file");
	});

	it("does not silently fall back when a default file exists but is corrupt", async () => {
		const { directory, provider } = await setup();
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "default.json"), "invalid default JSON");
		await expect(provider.load("default")).rejects.toMatchObject({ code: "INVALID_PERSONA" });
		const listed = await provider.list();
		expect(listed.personas).toEqual([]);
		expect(listed.errors).toEqual([{ id: "default", message: expect.any(String) }]);
		await expect(
			provider.save("default", { system_prompt: "must not overwrite", expected_revision: "1" }),
		).rejects.toMatchObject({ code: "INVALID_PERSONA" });
		expect(await readFile(join(directory, "default.json"), "utf8")).toBe("invalid default JSON");
	});
});

describe("persona session snapshots", () => {
	it("keeps open and restored sessions on their original prompt while new sessions use the saved prompt", async () => {
		const base = await fixture();
		cleanups.push(base.cleanup);
		await base.service.close();
		const directory = join(base.directory, "personas");
		const provider = new FilePersonaProvider(directory);
		const inherited = await provider.load("default");
		const first = await provider.save("default", {
			system_prompt: "ORIGINAL_PERSONA_SENTINEL: retain this original persona.",
			expected_revision: inherited.revision,
		});
		const options = { ...base.settings, personaProvider: provider };
		const service = new ExecutorService(options);
		cleanups.push(() => service.close());
		await service.initialize();
		const [oldOpened] = await service.handle(
			"client",
			base.command("session.open", { cwd: base.directory, persona_id: "default", mode: "chat" }),
		);
		const oldSession = service.getSession(oldOpened.session_id!);
		const oldFile = oldSession.manager.getSessionFile()!;
		const oldBytes = await readFile(oldFile, "utf8");
		const second = await provider.save("default", {
			system_prompt: "UPDATED_PERSONA_SENTINEL: use this newly saved persona.",
			expected_revision: first.persona.revision,
		});
		expect(await readFile(oldFile, "utf8")).toBe(oldBytes);
		expect(oldSession.metadata.persona).toEqual(first.persona);
		const [newOpened] = await service.handle(
			"client",
			base.command("session.open", { cwd: base.directory, persona_id: "default", mode: "chat" }),
		);
		const newSession = service.getSession(newOpened.session_id!);
		expect(newSession.metadata.persona).toEqual(second.persona);
		const prompts: string[] = [];
		base.faux.setResponses([
			(context) => {
				prompts.push(JSON.stringify(context));
				return fauxAssistantMessage(tagged("old session reply"));
			},
			(context) => {
				prompts.push(JSON.stringify(context));
				return fauxAssistantMessage(tagged("new session reply"));
			},
		]);
		for (const session of [oldSession, newSession]) {
			await service.handle(
				"client",
				base.command("input.submit", { text: "use your persona" }, { session_id: session.id, mode_revision: 0 }),
			);
			await session.waitForIdle();
			expect(session.eventsAfter(0).at(-1)?.type).toBe("run.completed");
		}
		expect(prompts[0]).toContain(first.persona.system_prompt);
		expect(prompts[0]).not.toContain(second.persona.system_prompt);
		expect(prompts[1]).toContain(second.persona.system_prompt);
		expect(prompts[1]).not.toContain(first.persona.system_prompt);
		expect(base.faux.state.callCount).toBe(2);
		await service.close();
		const restarted = new ExecutorService({ ...options, personaProvider: new FilePersonaProvider(directory) });
		cleanups.push(() => restarted.close());
		await restarted.initialize();
		const restored = restarted.getSession(oldSession.id);
		expect(restored.metadata.persona).toEqual(first.persona);
		expect(restarted.getSession(newSession.id).metadata.persona).toEqual(second.persona);
		base.faux.setResponses([
			(context) => {
				prompts.push(JSON.stringify(context));
				return fauxAssistantMessage(tagged("restored original persona reply"));
			},
		]);
		await restarted.handle(
			"client",
			base.command("input.submit", { text: "continue" }, { session_id: restored.id, mode_revision: 0 }),
		);
		await restored.waitForIdle();
		expect(restored.eventsAfter(0).at(-1)?.type).toBe("run.completed");
		expect(prompts[2]).toContain(first.persona.system_prompt);
		expect(prompts[2]).not.toContain(second.persona.system_prompt);
		expect(base.faux.state.callCount).toBe(3);
	});
});
