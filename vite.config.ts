import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { protoJson } from "./vite-plugins/proto-json";
import { renderShellSubstitution } from "./vite-plugins/render-shell";

export default defineConfig(({ mode }) => {
	// Load .env, .env.local, .env.[mode], etc. Empty prefix '' would pull
	// every var; we only need VITE_* for our build-time use.
	const env = loadEnv(mode, process.cwd(), "VITE_");

	return {
		build: {
			target: "es2020",
		},
		resolve: {
			alias: {
				"~": new URL("./src", import.meta.url).pathname,
			},
		},
		plugins: [
			vue(),
			tailwindcss(),
			protoJson(),
			renderShellSubstitution({
				parentOrigin: env["VITE_RENDER_SHELL_PARENT_ORIGIN"] ?? "",
			}),
		],
	};
});
