import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, RequestListener } from "node:http";
import type { ApiAuth } from "./api-auth.ts";
import { ExecutorError, errorPayload } from "./errors.ts";
import { createHttpRoutes, type HttpContext, requestFingerprint } from "./http-api.ts";
import { MAX_MESSAGE_BYTES } from "./protocol.ts";
import type { ExecutorService } from "./service.ts";

interface ManagementOptions {
	service: ExecutorService;
	auth: ApiAuth;
	allowOrigin: (origin: string) => boolean;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")
		throw new ExecutorError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
	const declared = Number(request.headers["content-length"] ?? 0);
	if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_MESSAGE_BYTES)
		throw new ExecutorError("PAYLOAD_TOO_LARGE", "Request exceeds the body limit");
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
		bytes += buffer.length;
		if (bytes > MAX_MESSAGE_BYTES) throw new ExecutorError("PAYLOAD_TOO_LARGE", "Request exceeds the body limit");
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new ExecutorError("INVALID_PAYLOAD", "Request must contain valid JSON");
	}
}

function errorStatus(error: unknown): number {
	if (!(error instanceof ExecutorError)) return 500;
	if (["UNAUTHORIZED", "AUTH_FAILED", "AUTH_REQUIRED"].includes(error.code)) return 401;
	if (["FORBIDDEN", "ORIGIN_REJECTED", "WORKSPACE_ACCESS_DENIED", "TOOL_NOT_ALLOWED"].includes(error.code)) return 403;
	if (error.code === "NOT_FOUND" || error.code.endsWith("_NOT_FOUND")) return 404;
	if (error.code === "PAYLOAD_TOO_LARGE") return 413;
	if (error.code === "UNSUPPORTED_MEDIA_TYPE") return 415;
	if (error.code === "CURSOR_EXPIRED") return 410;
	if (
		/CONFLICT|REVISION_MISMATCH|BUSY|TRANSITIONING|IDEMPOTENCY_|ALREADY_|NOT_CANCELLABLE|NOT_RESUMABLE|RUN_PAUSED|SOURCE_CHANGED|TOKEN_ALREADY_ISSUED/.test(
			error.code,
		)
	)
		return 409;
	if (/STORE_INVALID|STORE_FAILED|SAVE_FAILED|DELETE_FAILED|INTERNAL_ERROR|API_RESPONSE_INVALID/.test(error.code))
		return 500;
	if (["SERVER_CLOSING", "SERVICE_UNAVAILABLE"].includes(error.code)) return 503;
	return 400;
}

/** All business mutations use HTTP; WebSocket carries durable subscriptions only. */
export function createManagementHandler(options: ManagementOptions): RequestListener {
	const assets = new Map<string, { body: Buffer; contentType: string }>(
		[
			["/", "index.html", "text/html; charset=utf-8"],
			["/app.js", "app.js", "text/javascript; charset=utf-8"],
			["/model-settings.js", "model-settings.js", "text/javascript; charset=utf-8"],
			["/persona-settings.js", "persona-settings.js", "text/javascript; charset=utf-8"],
			["/companion-settings.js", "companion-settings.js", "text/javascript; charset=utf-8"],
			["/life-settings.js", "life-settings.js", "text/javascript; charset=utf-8"],
			["/admin-settings.js", "admin-settings.js", "text/javascript; charset=utf-8"],
			["/record-editor.js", "record-editor.js", "text/javascript; charset=utf-8"],
			["/style.css", "style.css", "text/css; charset=utf-8"],
		].map(([path, file, contentType]): [string, { body: Buffer; contentType: string }] => [
			path,
			{ body: readFileSync(new URL(`../web/${file}`, import.meta.url)), contentType },
		]),
	);
	const routes = createHttpRoutes(options.service, options.auth).map((route) => ({
		...route,
		parts: route.path.split("/").slice(1),
	}));
	return async (request, response) => {
		const requestId = randomUUID();
		response.setHeader("X-Request-Id", requestId);
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("X-Frame-Options", "DENY");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
		);
		const json = (status: number, value: unknown) => {
			if (response.destroyed || response.writableEnded) return;
			response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
			response.end(request.method === "HEAD" ? undefined : JSON.stringify(value ?? null));
		};
		try {
			const url = new URL(request.url ?? "/", "http://dw-agent.local");
			if ([...url.searchParams.keys()].some((key) => /token|authorization|api_key/i.test(key)))
				throw new ExecutorError("INVALID_PAYLOAD", "Credentials are not accepted in URLs");
			for (const key of url.searchParams.keys())
				if (url.searchParams.getAll(key).length !== 1)
					throw new ExecutorError("INVALID_PAYLOAD", "Repeated query parameters are not accepted");
			if (!url.pathname.startsWith("/api/")) {
				const page = ["/models", "/personas", "/companion", "/life", "/admin"].includes(url.pathname);
				const asset = assets.get(page ? "/" : url.pathname);
				if (!asset) {
					json(404, {
						error: { code: "NOT_FOUND", message: "Not found", retryable: false },
						request_id: requestId,
					});
					return;
				}
				if (request.method !== "GET" && request.method !== "HEAD") {
					response.setHeader("Allow", "GET, HEAD");
					json(405, {
						error: { code: "METHOD_NOT_ALLOWED", message: "Read-only resource", retryable: false },
						request_id: requestId,
					});
					return;
				}
				response.writeHead(200, { "Content-Type": asset.contentType });
				response.end(request.method === "HEAD" ? undefined : asset.body);
				return;
			}
			if (request.headers.origin) {
				if (!options.allowOrigin(request.headers.origin))
					throw new ExecutorError("ORIGIN_REJECTED", "Origin is not allowed");
				response.setHeader("Access-Control-Allow-Origin", request.headers.origin);
				response.setHeader("Vary", "Origin");
				response.setHeader("Access-Control-Expose-Headers", "X-Request-Id, Allow");
			}
			const path = url.pathname.slice(4);
			if ((path === "/health/live" || path === "/health/ready") && ["GET", "HEAD"].includes(request.method ?? "")) {
				json(200, { status: path.endsWith("live") ? "live" : "ready", api_version: "1" });
				return;
			}
			let parts: string[];
			try {
				parts = path.split("/").slice(1).map(decodeURIComponent);
			} catch {
				throw new ExecutorError("INVALID_PAYLOAD", "Invalid path encoding");
			}
			const modelIdentifier = parts.length === 4 && parts[0] === "providers" && parts[2] === "models";
			if (
				parts.some(
					(part, index) =>
						/[\u0000-\u001f\u007f\\]/.test(part) ||
						(part.includes("/") && !(modelIdentifier && index === 3)) ||
						part === "." ||
						part === "..",
				)
			)
				throw new ExecutorError("INVALID_PAYLOAD", "Invalid resource identifier");
			const candidates = routes.filter(
				(route) =>
					route.parts.length === parts.length &&
					route.parts.every((part, index) => part.startsWith(":") || part === parts[index]),
			);
			const allowed = [
				...new Set(candidates.flatMap((route) => (route.method === "GET" ? ["GET", "HEAD"] : [route.method]))),
			];
			if (request.method === "OPTIONS") {
				if (!candidates.length) throw new ExecutorError("NOT_FOUND", "Resource was not found");
				response.setHeader("Access-Control-Allow-Methods", allowed.join(", "));
				response.setHeader(
					"Access-Control-Allow-Headers",
					"Authorization, Content-Type, Idempotency-Key, X-Request-Id",
				);
				response.writeHead(204);
				response.end();
				return;
			}
			const bearer = request.headers.authorization;
			if (!bearer?.startsWith("Bearer ")) throw new ExecutorError("UNAUTHORIZED", "A Bearer token is required");
			const principal = options.auth.authenticate(bearer.slice(7));
			if (!candidates.length) throw new ExecutorError("NOT_FOUND", "Resource was not found");
			const method = request.method === "HEAD" ? "GET" : request.method;
			const route = candidates.find((item) => item.method === method);
			if (!route) {
				response.setHeader("Allow", allowed.join(", "));
				json(405, {
					error: {
						code: "METHOD_NOT_ALLOWED",
						message: "Method is not supported for this resource",
						retryable: false,
					},
					request_id: requestId,
				});
				return;
			}
			options.auth.authorize(principal, route.permission);
			if (
				(method === "GET" || method === "DELETE") &&
				(request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) !== 0)
			)
				throw new ExecutorError("INVALID_PAYLOAD", "This method does not accept a request body");
			const body = ["POST", "PUT", "PATCH"].includes(method ?? "") ? await readJson(request) : undefined;
			options.auth.authorize(options.auth.authenticate(bearer.slice(7)), route.permission);
			const keyHeader = request.headers["idempotency-key"];
			const idempotencyKey = typeof keyHeader === "string" ? keyHeader : "";
			if (method === "POST" && !/^[A-Za-z0-9_.:-]{1,200}$/.test(idempotencyKey))
				throw new ExecutorError("INVALID_PAYLOAD", "POST requires a valid Idempotency-Key");
			const params = Object.fromEntries(
				route.parts.flatMap((part, index) => (part.startsWith(":") ? [[part.slice(1), parts[index]]] : [])),
			);
			const fingerprint = requestFingerprint(method ?? "", path, url.searchParams, body);
			const context: HttpContext = { principal, params, query: url.searchParams, body, idempotencyKey, fingerprint };
			const perform = async () => {
				const value = await route.handler(context);
				return value === undefined ? null : value;
			};
			let result: unknown;
			if (method === "POST" && !route.oneTimeSecret && route.replay) {
				let executed = false;
				let original: unknown;
				const reference = await options.service.api.store.once(
					principal.id,
					idempotencyKey,
					fingerprint,
					async () => {
						original = await perform();
						executed = true;
						const id = original && typeof original === "object" && "id" in original ? original.id : params.id;
						if (typeof id !== "string")
							throw new ExecutorError("API_RESPONSE_INVALID", "Operation did not return a resource identifier");
						return { resource_id: id };
					},
				);
				result = executed ? original : await route.replay(context, reference.resource_id);
			} else {
				result =
					method === "POST" && !route.oneTimeSecret
						? await options.service.api.store.once(principal.id, idempotencyKey, fingerprint, perform)
						: await perform();
			}
			options.auth.authorize(options.auth.authenticate(bearer.slice(7)), route.permission);
			json(route.status, result);
		} catch (error) {
			json(errorStatus(error), { error: errorPayload(error), request_id: requestId });
		}
	};
}
