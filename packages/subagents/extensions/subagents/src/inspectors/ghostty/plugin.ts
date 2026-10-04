import { ghosttyBindingPath, openGhosttyInspector, statusGhosttyInspector, type GhosttyRunner } from "./actions.ts";
import { bindingExists } from "../binding-store.ts";
import type { InspectorPlugin } from "../types.ts";

/** Only the standalone app owns this AppleScript API. */
const GHOSTTY_BUNDLE_ID = "com.mitchellh.ghostty";

export interface GhosttyPluginDeps {
	platform?: NodeJS.Platform;
	runner?: GhosttyRunner;
}

export function createGhosttyInspectorPlugin(deps: GhosttyPluginDeps = {}): InspectorPlugin {
	const platform = deps.platform ?? process.platform;
	return {
		name: "ghostty",
		available: (context) => {
			// Embedded Ghostty hosts do not confer authority over the standalone app.
			if (platform !== "darwin") return false;
			if (context.env.TERM_PROGRAM?.toLowerCase() !== "ghostty") return false;
			return context.env.__CFBundleIdentifier?.trim() === GHOSTTY_BUNDLE_ID;
		},
		owns: (context) => bindingExists(ghosttyBindingPath(context)),
		open: (context, launch, params) => openGhosttyInspector(context, launch, params, deps.runner),
		status: (context) => statusGhosttyInspector(context, deps.runner),
	};
}
