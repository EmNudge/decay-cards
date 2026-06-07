import type { Plugin } from "vite";
import { readFile } from "node:fs/promises";
import protobuf from "protobufjs";

// Compiles `*.proto?proto-json` imports to a static JSON tree at build time, so
// the client bundle can use `protobufjs/light` (no `.proto` parser, no `fs` shim).
export function protoJson(): Plugin {
	return {
		name: "proto-json",
		async load(id) {
			const [filename, query] = id.split("?");
			if (query !== "proto-json") return;
			this.addWatchFile(filename);
			const source = await readFile(filename, "utf8");
			const root = protobuf.parse(source).root;
			return `export default ${JSON.stringify(root.toJSON())};`;
		},
	};
}
