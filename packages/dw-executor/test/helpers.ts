import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { ModelRuntime } from "../../coding-agent/src/core/model-runtime.ts";
import type { InlineExtension } from "../../coding-agent/src/core/sdk.ts";
import type { Envelope, Mode } from "../src/runtime-protocol.ts";
import { type ExecutorOptions, ExecutorService } from "../src/service.ts";

export function tagged(speech: string): string {
	return `<segment><expression>{"description":"轻轻点头","language":"zh-CN"}</expression><speech>${JSON.stringify(speech)}</speech></segment>`;
}
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	return {
		promise: new Promise<T>((done) => {
			resolve = done;
		}),
		resolve,
	};
}

export async function fixture(options: Partial<ExecutorOptions> & { extensions?: InlineExtension[] } = {}) {
	const root = fileURLToPath(new URL("../../../.local/dw-tests/", import.meta.url));
	mkdirSync(root, { recursive: true });
	const directory = mkdtempSync(resolve(root, "case-"));
	const faux = fauxProvider({
		provider: "dw-test",
		models: [{ id: "model", contextWindow: 131072, maxTokens: 8192 }],
		tokenSize: { min: 1, max: 3 },
	});
	const runtimeFactory: NonNullable<ExecutorOptions["runtimeFactory"]> = async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		runtime.registerNativeProvider(faux.provider);
		await runtime.setRuntimeApiKey("dw-test", "test-key");
		return { runtime, model: faux.getModel() };
	};
	const settings: ExecutorOptions = {
		...options,
		dataDir: directory,
		backgroundMaintenance: options.backgroundMaintenance ?? false,
		runtimeFactory,
		personaProvider: {
			load: async (id) => ({ id, revision: "test-1", system_prompt: "PERSONA_SENTINEL: 用同一人格说话。" }),
		},
		toolProvider: options.toolProvider ?? { extensions: () => options.extensions ?? [] },
	};
	const service = new ExecutorService(settings);
	await service.initialize();
	let counter = 0;
	const command = (type: string, payload: Record<string, unknown> = {}, fields: Partial<Envelope> = {}): Envelope => ({
		v: 1,
		id: `test-${++counter}`,
		type,
		payload,
		...fields,
	});
	const open = async (mode: Mode = "chat") => {
		const [opened] = await service.handle(
			"client",
			command("session.open", { cwd: directory, persona_id: "default", mode }),
		);
		return service.getSession(opened.session_id!);
	};
	return {
		service,
		settings,
		directory,
		faux,
		command,
		open,
		async cleanup() {
			await service.close();
			const absolute = resolve(directory);
			if (!absolute.startsWith(`${resolve(root)}${sep}`)) throw new Error("Test cleanup path escaped its root");
			rmSync(absolute, { recursive: true, force: true });
		},
	};
}
