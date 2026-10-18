import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Stored } from "../src/api-store.ts";
import { apiFixture, type EventPage, type Page } from "./api-helpers.ts";
import { tagged } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("HTTP resource management", () => {
	it("serves safe assets and authenticated bootstrap without exposing credentials or arbitrary cwd", async () => {
		const f = await apiFixture(cleanups);
		const page = await fetch(f.origin);
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(page.headers.get("cache-control")).toBe("no-store");
		expect(await page.text()).not.toContain("resource-api-regression-root-token");
		for (const asset of ["/app.js", "/style.css", "/model-settings.js"])
			expect((await fetch(`${f.origin}${asset}`)).status).toBe(200);
		expect((await fetch(`${f.origin}/src/service.ts`)).status).toBe(404);
		expect((await fetch(`${f.origin}/api/sessions`)).status).toBe(401);
		expect((await f.request("/api/bootstrap", { headers: { Origin: "https://untrusted.example" } })).status).toBe(
			403,
		);
		const bootstrap = await f.read<Record<string, unknown>>("/api/bootstrap");
		expect(bootstrap).toMatchObject({
			api_version: "1",
			socket_path: "/dw-agent/v1",
			defaults: { workspace_id: "default", model_profile_id: "default" },
		});
		expect(bootstrap).not.toHaveProperty("cwd");
		expect((await fetch(`${f.origin}/api/health/live`)).status).toBe(200);
		expect(f.faux.state.callCount).toBe(0);
	});

	it("requires idempotency keys, coalesces concurrent creates, checks revisions and scopes cursors", async () => {
		const f = await apiFixture(cleanups);
		const missing = await f.request("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ workspace_id: "fixture" }),
			headers: { "X-Request-Id": "missing-key" },
		});
		expect(missing.status).toBe(400);
		expect(await missing.json()).toMatchObject({
			request_id: missing.headers.get("x-request-id"),
			error: { code: "INVALID_PAYLOAD", retryable: false },
		});
		const responses = await Promise.all([
			f.post("/api/sessions", { workspace_id: "fixture", title: "once" }, "concurrent"),
			f.post("/api/sessions", { workspace_id: "fixture", title: "once" }, "concurrent"),
		]);
		for (const response of responses) expect(response.status).toBe(201);
		const [a, same] = (await Promise.all(responses.map((response) => response.json()))) as Stored<{
			title: string;
		}>[];
		expect(same).toEqual(a);
		expect(
			(await f.post("/api/sessions", { workspace_id: "fixture", title: "different" }, "concurrent")).status,
		).toBe(409);
		const changed = await f.patch(`/api/sessions/${a.id}`, { expected_revision: a.revision, title: "updated" });
		expect(changed.status).toBe(200);
		expect(await changed.json()).toMatchObject({ id: a.id, revision: a.revision + 1, data: { title: "updated" } });
		expect((await f.patch(`/api/sessions/${a.id}`, { expected_revision: a.revision, title: "stale" })).status).toBe(
			409,
		);
		await f.createSession();
		const first = await f.read<Page<unknown>>("/api/sessions?limit=1");
		expect(first.items).toHaveLength(1);
		expect(typeof first.next_cursor).toBe("string");
		const next = await f.read<Page<unknown>>(`/api/sessions?limit=1&cursor=${first.next_cursor}`);
		expect(next.items).toHaveLength(1);
		expect(next.items[0].id).not.toBe(first.items[0].id);
		expect((await f.request(`/api/tasks?cursor=${first.next_cursor}`)).status).toBe(400);
		expect((await f.request("/api/sessions?cursor=not-a-cursor")).status).toBe(400);
		expect(f.faux.state.callCount).toBe(0);
	});

	it("keeps pending approvals scoped, durable and non-repeatable while chat remains independent", async () => {
		const f = await apiFixture(cleanups);
		await writeFile(join(f.workspaceDirectory, "approved.txt"), "approval evidence", "utf8");
		const profile = await f.post("/api/execution-profiles", {
			id: "approval-test",
			name: "Approval test",
			tools: ["read"],
			approval: "always",
			isolation: "restricted",
			max_model_calls: 4,
			max_concurrent_tasks: 1,
			timeout_ms: 300000,
			approval_timeout_ms: 60000,
		});
		expect(profile.status, await profile.clone().text()).toBe(201);
		const session = await f.createSession({ execution_profile_id: "approval-test" });
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "approved.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(tagged("Read completed")),
		]);
		const created = await f.post(`/api/sessions/${session.id}/tasks`, { input: "Read approved.txt" }, "task-once");
		expect(created.status).toBe(202);
		const task = (await created.json()) as Stored<{ status: string }>;
		await f.settle(`/api/tasks/${task.id}`, "awaiting_approval");
		let approval: Stored<{ task_id: string; status: string }> | undefined;
		await vi.waitFor(async () => {
			const page = await f.read<Page<{ task_id: string; status: string }>>("/api/approvals");
			approval = page.items.find((item) => item.data.task_id === task.id);
			expect(approval).toBeDefined();
		});
		const tokenResponse = await f.post("/api/tokens", {
			name: "Unrelated approver",
			permissions: ["read", "approve", "execute", "chat"],
			session_ids: [],
			companion_scopes: [],
			expires_at: new Date(Date.now() + 3600000).toISOString(),
		});
		const outsider = (await tokenResponse.json()) as { token: string };
		expect((await f.request(`/api/approvals/${approval!.id}`, {}, outsider.token)).status).toBe(403);
		expect(await f.read("/api/approvals", outsider.token)).toMatchObject({ items: [] });
		expect(
			(
				await f.post(
					`/api/approvals/${approval!.id}/decision`,
					{ decision: "approve", expected_revision: approval!.revision },
					"outsider",
					outsider.token,
				)
			).status,
		).toBe(403);
		expect((await f.request(`/api/tasks/${task.id}`, {}, outsider.token)).status).toBe(403);
		expect((await f.request(`/api/tasks/${task.id}/tool-calls`, {}, outsider.token)).status).toBe(403);
		expect((await f.post(`/api/tasks/${task.id}/cancel`, {}, "outsider-task", outsider.token)).status).toBe(403);
		expect((await f.read<Page<unknown>>("/api/tasks", outsider.token)).items).toEqual([]);
		expect(
			(await f.read<Stored<{ active_run_id: string | null }>>(`/api/sessions/${session.id}`)).data.active_run_id,
		).toBeNull();
		const decision = { decision: "approve", expected_revision: approval!.revision };
		const approved = await f.post(`/api/approvals/${approval!.id}/decision`, decision, "approval-once");
		expect(approved.status).toBe(200);
		expect((await f.post(`/api/approvals/${approval!.id}/decision`, decision, "approval-once")).status).toBe(200);
		await f.settle(`/api/tasks/${task.id}`);
		expect((await f.post(`/api/approvals/${approval!.id}/decision`, decision, "approval-replay")).status).toBe(409);
		const calls = await f.read<Page<unknown>>(`/api/tasks/${task.id}/tool-calls`);
		expect(calls.items).toHaveLength(1);
		expect(
			await (await f.post(`/api/sessions/${session.id}/tasks`, { input: "Read approved.txt" }, "task-once")).json(),
		).toMatchObject({ id: task.id });
		expect(f.faux.state.callCount).toBe(2);
		f.faux.setResponses([fauxAssistantMessage(tagged("独立聊天。"))]);
		const chat = (await (
			await f.post(`/api/sessions/${session.id}/messages`, { text: "继续聊天" })
		).json()) as Stored<{ status: string }>;
		await f.settle(`/api/runs/${chat.id}`);
		expect((await f.request(`/api/runs/${chat.id}`, {}, outsider.token)).status).toBe(403);
		expect((await f.post(`/api/runs/${chat.id}/cancel`, {}, "outsider-run", outsider.token)).status).toBe(403);
		const eventPage = await f.read<EventPage>(`/api/sessions/${session.id}/events`);
		expect(eventPage.items.some((event) => event.type === "task.awaiting_approval")).toBe(true);
		expect(eventPage.items.some((event) => event.type === "run.completed")).toBe(true);
		await f.restart();
		expect((await f.read<Stored<{ status: string }>>(`/api/tasks/${task.id}`)).data.status).toBe("completed");
		expect((await f.read<Stored<{ status: string }>>(`/api/approvals/${approval!.id}`)).data.status).toBe("consumed");
		expect((await f.read<Page<unknown>>(`/api/tasks/${task.id}/tool-calls`)).items).toHaveLength(1);
		expect(f.faux.state.callCount).toBe(3);
	});
});
