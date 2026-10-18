import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocketGateway } from "./gateway.ts";
import { ExecutorService } from "./service.ts";

if (process.argv.includes("--help")) {
	console.log(
		"dw-agent\nConfigure DW_DATA_DIR, DW_PROVIDER, DW_MODEL, DW_TOKEN, DW_HOST, DW_PORT, DW_ALLOWED_ORIGINS.\nSee packages/dw-executor/README.md for credentials, personas and the WebSocket protocol.",
	);
} else {
	const dataDir = resolve(process.env.DW_DATA_DIR ?? join(homedir(), ".dw-agent"));
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	const tokenPath = join(dataDir, "access-token");
	let token = process.env.DW_TOKEN;
	if (!token) {
		try {
			token = (await readFile(tokenPath, "utf8")).trim();
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			token = randomBytes(32).toString("hex");
			await writeFile(tokenPath, `${token}\n`, { mode: 0o600, flag: "wx" });
		}
	}
	const port = Number(process.env.DW_PORT ?? 17850);
	if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid DW_PORT");
	const service = new ExecutorService({
		dataDir,
		agentDir: process.env.DW_PI_AGENT_DIR,
		provider: process.env.DW_PROVIDER,
		model: process.env.DW_MODEL,
	});
	await service.initialize();
	const gateway = new WebSocketGateway({
		service,
		token,
		host: process.env.DW_HOST,
		port,
		allowedOrigins: process.env.DW_ALLOWED_ORIGINS?.split(",")
			.map((origin) => origin.trim())
			.filter(Boolean),
	});
	const address = await gateway.start();
	console.log(
		`dw-agent listening at ${address}\nWebUI: ${address.replace("ws://", "http://").replace("/dw-agent/v1", "/")}\nData directory: ${dataDir}\nAccess token: ${process.env.DW_TOKEN ? "provided through DW_TOKEN" : tokenPath}`,
	);
	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		await gateway.close();
		await service.close();
	};
	process.on("SIGINT", () => {
		void shutdown().catch((error: unknown) => {
			console.error(error);
			process.exitCode = 1;
		});
	});
	process.on("SIGTERM", () => {
		void shutdown().catch((error: unknown) => {
			console.error(error);
			process.exitCode = 1;
		});
	});
}
