import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import { DefaultPackageManager } from "../../coding-agent/src/core/package-manager.ts";
import { SettingsManager } from "../../coding-agent/src/core/settings-manager.ts";
import type { ApiStore, Stored } from "./api-store.ts";
import { ExecutorError } from "./errors.ts";

export type InstalledResourceKind = "extensions" | "skills";
export interface InstalledResource {
	kind: InstalledResourceKind;
	name: string;
	path: string;
	enabled: boolean;
}

function within(root: string, path: string): boolean {
	const child = relative(root, path);
	return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

/** Discovery only: never installs packages and never reads project settings or executes extensions. */
export class InstalledResourceCatalog {
	private readonly store: ApiStore;
	private readonly agentDir: string;
	private readonly installed = new Map<InstalledResourceKind, Map<string, string>>();

	constructor(store: ApiStore, agentDir: string) {
		this.store = store;
		this.agentDir = agentDir;
	}

	async discover(): Promise<void> {
		const settings = SettingsManager.create(this.agentDir, this.agentDir, { projectTrusted: false });
		const errors = settings.drainErrors();
		if (errors.length > 0)
			throw new ExecutorError("INTEGRATION_CONFIG_INVALID", "Global resource settings are invalid");
		const packages = new DefaultPackageManager({
			cwd: this.agentDir,
			agentDir: this.agentDir,
			settingsManager: settings,
		});
		const resolved = await packages.resolve(async () => "skip");
		for (const kind of ["extensions", "skills"] as const) {
			const installed = new Map<string, string>();
			for (const resource of resolved[kind]) {
				if (resource.metadata.scope !== "user" || !existsSync(resource.path)) continue;
				const path = realpathSync(resource.path);
				// Automatically found symlinks may not escape their trusted global root. Explicit global
				// paths and configured package roots are administrator trust decisions, not request input.
				const root = realpathSync(
					resource.metadata.packageRoot ?? resource.metadata.baseDir ?? dirname(resource.path),
				);
				if (!within(root, path)) continue;
				const id = createHash("sha256").update(`${kind}\0${path}`).digest("hex").slice(0, 32);
				installed.set(id, path);
				const existing = this.store.get<InstalledResource>(`integration-${kind}`, id);
				if (!existing) {
					this.store.put<InstalledResource>(
						`integration-${kind}`,
						id,
						{
							kind,
							name: basename(path),
							path,
							enabled: resource.enabled,
						},
						null,
					);
				}
			}
			this.installed.set(kind, installed);
		}
	}

	list(kind: InstalledResourceKind): { items: Stored<InstalledResource>[]; next_cursor: null } {
		return {
			items: [...(this.installed.get(kind)?.keys() ?? [])].map((id) => this.get(kind, id)),
			next_cursor: null,
		};
	}

	private get(kind: InstalledResourceKind, id: string): Stored<InstalledResource> {
		const path = this.installed.get(kind)?.get(id);
		if (!path) throw new ExecutorError("NOT_FOUND", "The installed resource was not found");
		// Reject a removed/replaced symlink even between discovery and resource reload.
		if (!existsSync(path) || realpathSync(path) !== path) {
			throw new ExecutorError(
				"RESOURCE_CHANGED",
				"The installed resource changed; reload the catalog before using it",
			);
		}
		return this.store.require<InstalledResource>(`integration-${kind}`, id);
	}

	update(kind: InstalledResourceKind, id: string, value: unknown): Stored<InstalledResource> {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new ExecutorError("INVALID_REQUEST", "Resource settings must be an object");
		}
		const input = value as Record<string, unknown>;
		if (
			Object.keys(input).some((key) => key !== "enabled" && key !== "expected_revision") ||
			typeof input.enabled !== "boolean" ||
			!Number.isSafeInteger(input.expected_revision) ||
			typeof input.expected_revision !== "number" ||
			input.expected_revision < 1
		) {
			throw new ExecutorError("INVALID_REQUEST", "Resource settings require enabled and expected_revision");
		}
		const current = this.get(kind, id);
		return this.store.put(
			`integration-${kind}`,
			id,
			{ ...current.data, enabled: input.enabled },
			input.expected_revision,
		);
	}

	settings(): { extensions: string[]; skills: string[] } {
		const paths = (kind: InstalledResourceKind) =>
			this.list(kind)
				.items.filter((item) => item.data.enabled)
				.map((item) => item.data.path);
		return { extensions: paths("extensions"), skills: paths("skills") };
	}
}
