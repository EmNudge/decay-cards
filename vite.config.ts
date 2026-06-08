import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { protoJson } from "./vite-plugins/proto-json";
import { renderShellSubstitution } from "./vite-plugins/render-shell";

export default defineConfig({
	build: {
		target: "es2020",
	},
	resolve: {
		alias: {
			"~": new URL("./src", import.meta.url).pathname,
		},
	},
	plugins: [vue(), tailwindcss(), protoJson(), renderShellSubstitution()],
});
