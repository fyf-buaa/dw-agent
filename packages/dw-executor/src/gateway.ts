import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { ApiAuth, type Principal } from "./api-auth.ts";
import type { ApiEvent } from "./api-store.ts";
import { ExecutorError, errorPayload } from "./errors.ts";
import { authorizeStream } from "./http-api.ts";
import { createManagementHandler } from "./management.ts";
import { type Envelope, MAX_MESSAGE_BYTES, parseEnvelope, SOCKET_PATH } from "./protocol.ts";
import type { ExecutorService } from "./service.ts";

export interface TransportAdapter {
	start(): Promise<string>;
	close(): Promise<void>;
}
export interface GatewayOptions {
	service: ExecutorService;
	token: string;
	host?: string;
	port?: number;
	allowedOrigins?: string[];
	heartbeatMs?: number;
	idleTimeoutMs?: number;
	maxBufferedBytes?: number;
}

/** HTTP admits work; sockets are independently authorized, replayable event subscribers. */
export class WebSocketGateway implements TransportAdapter {
	private readonly options: GatewayOptions;
	private readonly http: Server;
	private readonly sockets: WebSocketServer;
	private readonly auth: ApiAuth;
	private heartbeat: NodeJS.Timeout | undefined;
	private closePromise: Promise<void> | undefined;
	private readonly connections = new Map<WebSocket, { lastPong: number; principal?: Principal }>();
	private readonly unsubscribeRevocation: () => void;

	constructor(options: GatewayOptions) {
		if (options.token.length < 16) throw new Error("Access token must contain at least 16 characters");
		this.options = options;
		this.auth = new ApiAuth(options.service.api.store, options.token);
		this.http = createServer(
			createManagementHandler({
				service: options.service,
				auth: this.auth,
				allowOrigin: (origin) => this.allowOrigin(origin),
			}),
		);
		this.sockets = new WebSocketServer({
			server: this.http,
			path: SOCKET_PATH,
			maxPayload: MAX_MESSAGE_BYTES,
			perMessageDeflate: false,
			verifyClient: ({ origin, req }: { origin: string; req: { url?: string } }) => {
				const url = new URL(req.url ?? SOCKET_PATH, "http://dw-agent.local");
				return !url.search && (!origin || this.allowOrigin(origin));
			},
		});
		this.sockets.on("connection", (socket) => this.connect(socket));
		this.unsubscribeRevocation = this.auth.subscribeRevocation((id) => {
			for (const [socket, connection] of this.connections)
				if (connection.principal?.id === id) socket.close(4001, "Authorization expired or revoked");
		});
	}

	private allowOrigin(origin: string): boolean {
		if (this.options.allowedOrigins?.includes(origin)) return true;
		const address = this.http.address();
		if (!address || typeof address === "string") return false;
		const host = this.options.host ?? "127.0.0.1";
		const hosts = [host];
		if (["127.0.0.1", "::1", "localhost"].includes(host)) hosts.push("127.0.0.1", "::1", "localhost");
		return hosts.some((name) => origin === `http://${name.includes(":") ? `[${name}]` : name}:${address.port}`);
	}

	async start(): Promise<string> {
		await new Promise<void>((resolve, reject) => {
			this.http.once("error", reject);
			this.http.listen(this.options.port ?? 17850, this.options.host ?? "127.0.0.1", () => {
				this.http.off("error", reject);
				resolve();
			});
		});
		this.heartbeat = setInterval(() => {
			for (const [socket, connection] of this.connections) {
				if (Date.now() - connection.lastPong > (this.options.idleTimeoutMs ?? 60000)) socket.terminate();
				else if (socket.readyState === WebSocket.OPEN) socket.ping();
			}
		}, this.options.heartbeatMs ?? 20000);
		this.heartbeat.unref();
		const address = this.http.address() as AddressInfo;
		return `ws://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}${SOCKET_PATH}`;
	}

	private connect(socket: WebSocket): void {
		const connection: { lastPong: number; principal?: Principal } = { lastPong: Date.now() };
		this.connections.set(socket, connection);
		const subscriptions = new Map<string, number>();
		let accessToken: string | undefined;
		const handshake = setTimeout(() => socket.close(1008, "hello required"), 5000);
		handshake.unref();
		const send = (value: unknown): boolean => {
			if (socket.readyState !== WebSocket.OPEN) return false;
			const encoded = JSON.stringify(value);
			if (Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES) {
				socket.close(1009, "Event exceeds message limit");
				return false;
			}
			if (
				socket.bufferedAmount + Buffer.byteLength(encoded) >
				(this.options.maxBufferedBytes ?? 4 * MAX_MESSAGE_BYTES)
			) {
				socket.close(1013, "Reconnect from saved event cursors");
				return false;
			}
			socket.send(encoded);
			return true;
		};
		const ack = (type: string, command: Envelope | undefined, payload: Record<string, unknown>) =>
			send({ v: 1, type, ...(command ? { reply_to: command.id } : {}), payload });
		const authenticated = (): Principal => {
			if (!accessToken) throw new ExecutorError("AUTH_REQUIRED", "Send hello before subscribing");
			return this.auth.authenticate(accessToken);
		};
		const deliver = (event: ApiEvent) => {
			const cursor = subscriptions.get(event.stream_id);
			if (cursor === undefined || event.seq <= cursor) return;
			try {
				authorizeStream(this.options.service, this.auth, authenticated(), event.stream_id);
				if (send(event)) subscriptions.set(event.stream_id, event.seq);
			} catch {
				socket.close(4001, "Subscription authorization ended");
			}
		};
		const unsubscribe = this.options.service.api.store.subscribe(deliver);
		socket.on("message", (data, binary) => {
			if (socket.readyState !== WebSocket.OPEN) return;
			let command: Envelope | undefined;
			try {
				if (binary) throw new ExecutorError("INVALID_MESSAGE", "Only UTF-8 JSON text messages are accepted");
				let parsed: unknown;
				try {
					parsed = JSON.parse(data.toString());
				} catch {
					throw new ExecutorError("INVALID_MESSAGE", "Message must contain valid JSON");
				}
				command = parseEnvelope(parsed);
				if (command.type === "hello") {
					if (accessToken)
						throw new ExecutorError("ALREADY_AUTHENTICATED", "This socket is already authenticated");
					if (!(command.payload.versions as number[]).includes(1))
						throw new ExecutorError("VERSION_MISMATCH", "Supported protocol version is 1");
					const token = command.payload.token as string;
					connection.principal = this.auth.authenticate(token);
					accessToken = token;
					clearTimeout(handshake);
					ack("hello.accepted", command, {
						version: 1,
						capabilities: ["events.replay", "events.multisubscriber"],
						max_message_bytes: MAX_MESSAGE_BYTES,
					});
					return;
				}
				const principal = authenticated();
				const streamId = command.payload.stream_id as string;
				authorizeStream(this.options.service, this.auth, principal, streamId);
				if (command.type === "unsubscribe") {
					subscriptions.delete(streamId);
					ack("subscription.removed", command, { stream_id: streamId });
					return;
				}
				if (subscriptions.size >= 128 && !subscriptions.has(streamId))
					throw new ExecutorError("SUBSCRIPTION_LIMIT", "At most 128 streams can be subscribed per socket");
				const after = command.payload.after_seq as number;
				let page = this.options.service.api.store.events(streamId, after, 100);
				subscriptions.set(streamId, after);
				// Synchronous replay + publication subscription have no asynchronous gap.
				while (true) {
					for (const event of page.items) deliver(event);
					if (!page.has_more || socket.readyState !== WebSocket.OPEN) break;
					const cursor = subscriptions.get(streamId)!;
					if (!page.items.length) throw new ExecutorError("INVALID_CURSOR", "Event replay did not advance");
					page = this.options.service.api.store.events(streamId, cursor, 100);
				}
				ack("subscription.accepted", command, {
					stream_id: streamId,
					after_seq: after,
					latest_seq: page.latest_seq,
				});
			} catch (error) {
				ack("command.rejected", command, { error: errorPayload(error) });
				if (!connection.principal) socket.close(1008, "Authentication required");
			}
		});
		socket.on("pong", () => {
			connection.lastPong = Date.now();
		});
		socket.on("error", () => {
			/* close releases subscriptions; never transmit transport internals */
		});
		socket.on("close", () => {
			clearTimeout(handshake);
			unsubscribe();
			subscriptions.clear();
			accessToken = undefined;
			this.connections.delete(socket);
		});
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closePromise = (async () => {
			clearInterval(this.heartbeat);
			this.unsubscribeRevocation();
			this.auth.close();
			for (const socket of this.sockets.clients) socket.terminate();
			await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
			if (this.http.listening)
				await new Promise<void>((resolve, reject) =>
					this.http.close((error) => (error ? reject(error) : resolve())),
				);
		})();
		return this.closePromise;
	}
}
