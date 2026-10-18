import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, path);
	} finally {
		await unlink(temp).catch(() => undefined);
	}
}
