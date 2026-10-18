import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../vitest.base.ts";

export default mergeConfig(base, defineConfig({
	test: { environment: "node", testTimeout: 30000, env: { PI_OFFLINE: "1" } },
}));
