import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

async function body(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

/** Real loopback MCP + OAuth server. No provider, external service, fixed port or clock sleeps. */
export async function localMcpFixture(oauth = false) {
	let origin = "";
	let initializations = 0;
	let tokenRequests = 0;
	let authorizationChallenge: string | null = null;
	const toolCalls: Record<string, unknown>[] = [];
	const respond = (response: ServerResponse, value: unknown, status = 200) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(value));
	};
	const handle = async (request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", origin);
		if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
			respond(response, {
				resource: `${origin}/mcp`,
				authorization_servers: [origin],
				scopes_supported: ["fixture:read"],
			});
			return;
		}
		if (url.pathname === "/.well-known/oauth-authorization-server") {
			respond(response, {
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				registration_endpoint: `${origin}/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				token_endpoint_auth_methods_supported: ["none"],
				code_challenge_methods_supported: ["S256"],
			});
			return;
		}
		if (url.pathname === "/register") {
			const metadata = JSON.parse(await body(request)) as Record<string, unknown>;
			respond(response, { ...metadata, client_id: "fixture-client" }, 201);
			return;
		}
		if (url.pathname === "/authorize") {
			authorizationChallenge = url.searchParams.get("code_challenge");
			const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
			callback.searchParams.set("state", url.searchParams.get("state") ?? "");
			callback.searchParams.set("code", "fixture-code");
			response.writeHead(302, { location: callback.href }).end();
			return;
		}
		if (url.pathname === "/token") {
			tokenRequests++;
			const params = new URLSearchParams(await body(request));
			const challenge = createHash("sha256")
				.update(params.get("code_verifier") ?? "")
				.digest("base64url");
			if (
				params.get("grant_type") !== "authorization_code" ||
				params.get("code") !== "fixture-code" ||
				challenge !== authorizationChallenge
			) {
				respond(response, { error: "invalid_grant" }, 400);
				return;
			}
			respond(response, {
				access_token: "fixture-access-secret",
				refresh_token: "fixture-refresh-secret",
				token_type: "Bearer",
				scope: "fixture:read",
			});
			return;
		}
		if (url.pathname !== "/mcp") {
			response.writeHead(404).end();
			return;
		}
		if (request.method === "GET") {
			response.writeHead(405).end();
			return;
		}
		if (request.method === "DELETE") {
			response.writeHead(200).end();
			return;
		}
		const input = await body(request);
		if (oauth && request.headers.authorization !== ["Bearer", "fixture-access-secret"].join(" ")) {
			response
				.writeHead(401, {
					"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
				})
				.end();
			return;
		}
		const message = JSON.parse(input) as Record<string, unknown>;
		if (!("id" in message)) {
			response.writeHead(202).end();
			return;
		}
		let result: unknown;
		if (message.method === "initialize") {
			initializations++;
			result = {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {}, resources: {} },
				serverInfo: { name: "dw-local-fixture", version: "1.0.0" },
			};
		} else if (message.method === "tools/list") {
			result = {
				tools: [
					{
						name: "echo",
						description: "Echo fixture text",
						inputSchema: {
							type: "object",
							properties: { text: { type: "string" } },
							required: ["text"],
							additionalProperties: false,
						},
					},
				],
			};
		} else if (message.method === "tools/call") {
			const params = message.params as Record<string, unknown>;
			toolCalls.push(params);
			const args = params.arguments as Record<string, unknown>;
			result = { content: [{ type: "text", text: args.text }] };
		} else if (message.method === "resources/list") {
			result = { resources: [{ uri: "fixture://readme", name: "README", mimeType: "text/plain" }] };
		} else if (message.method === "resources/templates/list") {
			result = { resourceTemplates: [] };
		} else if (message.method === "resources/read") {
			result = { contents: [{ uri: "fixture://readme", text: "local resource", mimeType: "text/plain" }] };
		} else {
			respond(response, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
			return;
		}
		respond(response, { jsonrpc: "2.0", id: message.id, result });
	};
	const server = createServer((request, response) => {
		void handle(request, response).catch(() => {
			response.writeHead(500).end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("The MCP fixture did not bind a loopback port");
	origin = `http://127.0.0.1:${address.port}`;
	return {
		url: `${origin}/mcp`,
		toolCalls,
		get initializations() {
			return initializations;
		},
		get tokenRequests() {
			return tokenRequests;
		},
		async redirect(authorizationUrl: string): Promise<string> {
			const response = await fetch(authorizationUrl, { redirect: "manual" });
			const redirect = response.headers.get("location");
			if (response.status !== 302 || !redirect)
				throw new Error("The fixture authorization endpoint did not redirect");
			return redirect;
		},
		async close(): Promise<void> {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}
