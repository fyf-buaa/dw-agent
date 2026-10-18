import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { expect, vi } from "vitest";
import { WebSocket } from "ws";
import type { Stored } from "../src/api-store.ts";
import { WebSocketGateway } from "../src/gateway.ts";
import type { Acknowledgement, ApiEvent, Envelope } from "../src/protocol.ts";
import { type ExecutorOptions, ExecutorService } from "../src/service.ts";
import { fixture } from "./helpers.ts";

export const rootToken = "resource-api-regression-root-token";
export interface Page<T> {
	items: Stored<T>[];
	next_cursor: string | null;
}
export interface EventPage {
	items: ApiEvent[];
	has_more: boolean;
	latest_seq: number;
}
export type SocketMessage = Acknowledgement | ApiEvent;

export async function apiFixture(
	cleanups: (() => Promise<void>)[],
	fileBacked = false,
	options: Partial<ExecutorOptions> = {},
) {
	const base = await fixture(options);
	cleanups.push(base.cleanup);
	const workspaceRoot = resolve(dirname(base.directory));
	const workspaceDirectory = await mkdtemp(join(workspaceRoot, "workspace-"));
	cleanups.push(async () => {
		const absolute = resolve(workspaceDirectory);
		if (!absolute.startsWith(`${workspaceRoot}${sep}`) || absolute === resolve(base.directory))
			throw new Error("Workspace cleanup path escaped its isolated root");
		await rm(absolute, { recursive: true, force: true });
	});
	let service = base.service;
	const settings = fileBacked ? { ...base.settings, personaProvider: undefined } : base.settings;
	if (fileBacked) {
		await service.close();
		service = new ExecutorService(settings);
		await service.initialize();
	}
	let gateway = new WebSocketGateway({ service, token: rootToken, port: 0 });
	let socketUrl = await gateway.start();
	let origin = new URL(socketUrl.replace("ws:", "http:")).origin;
	cleanups.push(async () => {
		await gateway.close();
		await service.close();
	});
	const request = (path: string, init: RequestInit = {}, accessToken = rootToken) =>
		fetch(`${origin}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				"X-Request-Id": randomUUID(),
				...init.headers,
			},
		});
	const post = (path: string, body: unknown = {}, key: string = randomUUID(), accessToken = rootToken) =>
		request(
			path,
			{
				method: "POST",
				headers: { "Idempotency-Key": key },
				body: JSON.stringify(body),
			},
			accessToken,
		);
	const patch = (path: string, body: unknown, accessToken = rootToken) =>
		request(path, { method: "PATCH", body: JSON.stringify(body) }, accessToken);
	const read = async <T>(path: string, accessToken = rootToken): Promise<T> => {
		const response = await request(path, {}, accessToken);
		expect(response.status, await response.clone().text()).toBe(200);
		return response.json() as Promise<T>;
	};
	const workspace = await post("/api/workspaces", {
		id: "fixture",
		name: "Isolated fixture",
		root: workspaceDirectory,
	});
	expect(workspace.status, await workspace.clone().text()).toBe(201);
	const createSession = async (fields: Record<string, unknown> = {}, key: string = randomUUID()) => {
		const response = await post("/api/sessions", { workspace_id: "fixture", ...fields }, key);
		expect(response.status, await response.clone().text()).toBe(201);
		return response.json() as Promise<
			Stored<{ persona_id: string; user_id: string; title: string; active_run_id: string | null }>
		>;
	};
	const settle = async <T extends { status: string }>(path: string, status = "completed"): Promise<Stored<T>> => {
		let result: Stored<T> | undefined;
		await vi.waitFor(
			async () => {
				result = await read<Stored<T>>(path);
				expect(result.data.status).toBe(status);
			},
			{ timeout: 5000 },
		);
		return result!;
	};
	return {
		...base,
		workspaceDirectory,
		request,
		post,
		patch,
		read,
		createSession,
		settle,
		settings,
		get service() {
			return service;
		},
		get origin() {
			return origin;
		},
		get socketUrl() {
			return socketUrl;
		},
		async restart() {
			await gateway.close();
			await service.close();
			service = new ExecutorService(settings);
			await service.initialize();
			gateway = new WebSocketGateway({ service, token: rootToken, port: 0 });
			socketUrl = await gateway.start();
			origin = new URL(socketUrl.replace("ws:", "http:")).origin;
		},
	};
}

export async function socketClient(url: string, cleanups: (() => Promise<void>)[], token = rootToken, origin?: string) {
	const socket = new WebSocket(url, origin ? { origin } : {});
	const messages: SocketMessage[] = [];
	const listeners = new Set<() => void>();
	socket.on("message", (bytes) => {
		messages.push(JSON.parse(bytes.toString()) as SocketMessage);
		for (const listener of listeners) listener();
	});
	await once(socket, "open");
	const close = async () => {
		if (socket.readyState === WebSocket.CLOSED) return;
		const closed = once(socket, "close");
		socket.close();
		await closed;
	};
	cleanups.push(close);
	const wait = (predicate: (value: SocketMessage) => boolean): Promise<SocketMessage> => {
		const { promise, resolve, reject } = Promise.withResolvers<SocketMessage>();
		const check = () => {
			const found = messages.find(predicate);
			if (found) {
				clearTimeout(timer);
				listeners.delete(check);
				resolve(found);
			}
		};
		const timer = setTimeout(() => {
			listeners.delete(check);
			reject(new Error(`Socket timeout: ${JSON.stringify(messages)}`));
		}, 5000);
		listeners.add(check);
		check();
		return promise;
	};
	const send = (value: Envelope) => socket.send(JSON.stringify(value));
	const helloId = randomUUID();
	send({ v: 1, id: helloId, type: "hello", payload: { client_id: randomUUID(), token, versions: [1] } });
	const hello = await wait((value) => "reply_to" in value && value.reply_to === helloId);
	const subscribe = async (stream_id: string, after_seq = 0) => {
		const id = randomUUID();
		send({ v: 1, id, type: "subscribe", payload: { stream_id, after_seq } });
		return wait((value) => "reply_to" in value && value.reply_to === id);
	};
	return { socket, messages, close, send, wait, hello, subscribe };
}

export function events(messages: SocketMessage[]): ApiEvent[] {
	return messages.filter((value): value is ApiEvent => "event_id" in value);
}
