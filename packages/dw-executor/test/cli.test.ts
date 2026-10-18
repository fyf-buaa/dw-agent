import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { fixture } from "./helpers.ts";

it("starts the source CLI and authenticates without invoking a real model", async () => {
	const f = await fixture();
	const root = fileURLToPath(new URL("../../../", import.meta.url));
	const child = spawn(
		process.execPath,
		["--import", "./packages/coding-agent/src/experimental/source-resolver.ts", "./packages/dw-executor/src/cli.ts"],
		{
			cwd: root,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				DW_DATA_DIR: join(f.directory, "cli"),
				DW_TOKEN: "cli-test-token-at-least-16-characters",
				DW_HOST: "127.0.0.1",
				DW_PORT: "0",
				DW_PROVIDER: "",
				DW_MODEL: "",
			},
		},
	);
	let stderr = "";
	child.stderr.on("data", (data: Buffer) => {
		stderr += data.toString();
	});
	let socket: WebSocket | undefined;
	try {
		const address = await new Promise<string>((resolve, reject) => {
			let output = "";
			const timer = setTimeout(() => reject(new Error(`CLI startup timed out: ${stderr}`)), 10000);
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				reject(new Error(`CLI exited with ${code}: ${stderr}`));
			});
			child.stdout.on("data", (data: Buffer) => {
				output += data.toString();
				const match = /dw-agent listening at (ws:\/\/[^\r\n]+)/.exec(output);
				if (match) {
					clearTimeout(timer);
					resolve(match[1]);
				}
			});
		});
		socket = new WebSocket(address);
		await once(socket, "open");
		const response = once(socket, "message");
		socket.send(
			JSON.stringify({
				v: 1,
				type: "hello",
				id: "hello",
				payload: { client_id: "cli-test", token: "cli-test-token-at-least-16-characters", versions: [1] },
			}),
		);
		const [data] = await response;
		expect(JSON.parse(String(data))).toMatchObject({ type: "hello.accepted", payload: { version: 1 } });
		expect(f.faux.state.callCount).toBe(0);
	} finally {
		if (socket && socket.readyState !== WebSocket.CLOSED) {
			const closed = once(socket, "close");
			socket.close();
			await closed;
		}
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			await exited;
		}
		await f.cleanup();
	}
});
