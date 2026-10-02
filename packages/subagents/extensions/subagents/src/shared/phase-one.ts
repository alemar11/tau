import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../agents/agents.ts";
import type { TrackedMutationSnapshot, ExtensionConfig } from "./types.ts";

export const PHASE_ONE_DISABLED = ["watchdog", "panes", "missions", "lane-management", "preflight", "lane-metadata", "gates", "external-machines", "extension-bindings"] as const;
export function phaseOneConfig(config: ExtensionConfig): ExtensionConfig {
	for (const key of ["worktree", "worktreeProvider", "worktreeBranchPrefix", "intercomBridge"] as const) {
		if (config[key] !== undefined) throw new Error(`Tau phase 1 does not support config.${key}.`);
	}
	if (config.missions !== undefined || config.scheduledRuns !== undefined) throw new Error("Missions and schedules are deferred to phase 6.");
	return { ...config, disabledFeatures: [...new Set([...PHASE_ONE_DISABLED, ...(config.disabledFeatures ?? [])])], missions: { enabled: false }, scheduledRuns: { enabled: false }, intercomBridge: { mode: "off", resultDelivery: false }, capacity: { abandonedSlotReleaseAfterMs: false } };
}
export function assertNativeAgent(agent: AgentConfig): void {
	if (agent.runner || agent.machine || (agent.defaultAcceptance !== undefined && agent.defaultAcceptance !== false) || agent.mcpDirectTools?.length || agent.permissions !== undefined || agent.tools?.some((tool) => tool.startsWith("mcp:"))) throw new Error(`Agent '${agent.name}' selects a feature deferred beyond Tau phase 1 (runner, machine, acceptance, permissions or MCP).`);
}
/** Also guard low-level native launch APIs, not only the public tool schema. */
export function assertNativeExecution(options: object): void {
	const values = options as Record<string, unknown>;
	for (const key of ["machine", "worktree", "worktreeProvider", "worktreeBranchPrefix", "worktreeSetupHook", "worktreeSetupHookTimeoutMs", "worktreeBaseDir", "baseRef", "isolation", "share", "shareEnabled", "acceptance"])
		if (values[key] !== undefined && values[key] !== false) throw new Error(`Execution option '${key}' is unavailable in Tau phase 1.`);
}
export function unavailableMutationSnapshot(cwd: string): TrackedMutationSnapshot {
	return { source: "tracked-files", trackedOnly: true, cwd, dirtyFiles: [], fingerprints: {}, unavailable: "Git mutation evidence is deferred to Tau phase 2; no repository verification was performed." };
}
export const WEB_TOOLS = new Set(["web_search", "fetch_web_content", "get_cached_web_content"]);
export function tauWebEntry(): string {
	const manifestPath = fileURLToPath(import.meta.resolve("web/package.json"));
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	const entry = "./extensions/web/index.ts";
	if (manifest.name !== "web" || !manifest.pi?.extensions?.includes(entry)) throw new Error("Tau Web package identity/manifest mismatch.");
	return fs.realpathSync(path.resolve(path.dirname(manifestPath), entry));
}
