import { defineConfig } from "vitest/config";
import path from "path";
import { protoJson } from "./vite-plugins/proto-json";

export default defineConfig({
	plugins: [protoJson()],
	test: {
		globals: true,
		environment: "node",
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/e2e/**",
			"**/realFile.test.ts",
			"**/deckParsing.test.ts",
			"**/geographyDeck.test.ts",
		],
	},
	resolve: {
		alias: {
			"~": path.resolve(__dirname, "./src"),
		},
	},
});
