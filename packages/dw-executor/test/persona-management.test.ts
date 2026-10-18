import { afterEach, describe, expect, it } from "vitest";
import type { Stored } from "../src/api-store.ts";
import type { PersonaSnapshot } from "../src/providers.ts";
import { apiFixture, type Page } from "./api-helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
interface PersonaDetail {
	persona: PersonaSnapshot;
	builtin: boolean;
	editable: boolean;
}

describe("persona resources", () => {
	it("creates once, accepts Unicode prompts, protects revisions and persists edits without inference", async () => {
		const f = await apiFixture(cleanups, true);
		expect((await fetch(`${f.origin}/api/personas`)).status).toBe(401);
		const value = { id: "companion", system_prompt: "设".repeat(65536) };
		expect((await f.post("/api/personas", value, "forbidden", "incorrect")).status).toBe(401);
		expect(
			(
				await f.request("/api/personas", {
					method: "POST",
					headers: { "Idempotency-Key": "origin", Origin: "https://untrusted.example" },
					body: JSON.stringify(value),
				})
			).status,
		).toBe(403);
		expect(
			(
				await f.request("/api/personas", {
					method: "POST",
					headers: { "Idempotency-Key": "invalid" },
					body: "invalid",
				})
			).status,
		).toBe(400);
		const created = await f.post("/api/personas", value, "persona-once");
		expect(created.status).toBe(201);
		const saved = (await created.json()) as Stored<PersonaDetail>;
		expect(saved).toMatchObject({
			id: "companion",
			revision: 1,
			data: { editable: true, builtin: false, persona: { id: "companion", system_prompt: value.system_prompt } },
		});
		expect(await (await f.post("/api/personas", value, "persona-once")).json()).toEqual(saved);
		expect(
			(await f.post("/api/personas", { ...value, system_prompt: "Must not replace" }, "persona-once")).status,
		).toBe(409);
		const session = await f.createSession({ persona_id: "companion" });
		const frozen = await f.read<Stored<{ persona_revision: string }>>(`/api/sessions/${session.id}`);
		const update = { expected_revision: saved.revision, system_prompt: "新的完整人格。" };
		const changedResponse = await f.patch("/api/personas/companion", update);
		expect(changedResponse.status).toBe(200);
		const changed = (await changedResponse.json()) as Stored<PersonaDetail>;
		expect(changed.revision).toBe(saved.revision + 1);
		expect(changed.data.persona.system_prompt).toBe(update.system_prompt);
		expect((await f.patch("/api/personas/companion", update)).status).toBe(409);
		expect(await f.read(`/api/sessions/${session.id}`)).toEqual(frozen);
		expect((await f.request("/api/personas/missing")).status).toBe(404);
		expect((await f.post("/api/personas", { ...value, id: "../escape" })).status).toBe(400);
		expect((await f.request("/api/personas/companion", { method: "DELETE" })).status).toBe(405);
		await f.restart();
		expect(await f.read("/api/personas/companion")).toEqual(changed);
		expect((await f.read<Page<PersonaDetail>>("/api/personas")).items.some((item) => item.id === "companion")).toBe(
			true,
		);
		expect(f.faux.state.callCount).toBe(0);
	});

	it("keeps injected providers usable but never writes file configuration on their behalf", async () => {
		const f = await apiFixture(cleanups);
		expect(await f.read("/api/personas")).toMatchObject({ items: [], editable: false });
		const response = await f.post("/api/personas", { id: "custom", system_prompt: "Do not write." });
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "PERSONA_MANAGEMENT_UNAVAILABLE" } });
		const session = await f.createSession();
		expect(await f.read(`/api/sessions/${session.id}`)).toMatchObject({ data: { persona_revision: "test-1" } });
		expect(f.faux.state.callCount).toBe(0);
	});
});
