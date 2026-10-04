import { createHerdrClient, type HerdrClient } from "./client.ts";
import { bindingPath, closeHerdrInspector, openHerdrInspector, statusHerdrInspector } from "./actions.ts";
import { bindingExists } from "../binding-store.ts";
import type { InspectorContext, InspectorPlugin } from "../types.ts";

export interface HerdrPluginDeps {
	client?: HerdrClient;
}

export function createHerdrInspectorPlugin(deps: HerdrPluginDeps = {}): InspectorPlugin {
	const client = (context: InspectorContext) => deps.client ?? createHerdrClient({ env: context.env, bin: context.env.HERDR_BIN ?? "herdr" });
	return {
		name: "herdr",
		available: async (context) => context.env.HERDR_ENV === "1"
			&& Boolean(context.env.HERDR_PANE_ID?.trim()),
		owns: (context) => bindingExists(bindingPath(context.target.asyncDir, context.target.index)),
		open: (context, launch, params) => openHerdrInspector(context, launch, params, client(context)),
		status: (context) => statusHerdrInspector(context, client(context)),
		close: (context) => closeHerdrInspector(context, client(context)),
	};
}
