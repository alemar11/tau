import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {} from "./src/types/pi-runtime-compat.d.ts";

const registerExtension = process.env.TAU_SUBAGENT_CHILD === "1"
	? undefined
	: (await import("./src/extension/index.ts")).default;

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	registerExtension?.(pi);
}
