import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../agents/agents.ts";
import { isCodeOwnedExternalCliAdapterId } from "../runs/shared/external-cli-contract.ts";
import type { TrackedMutationSnapshot, ExtensionConfig } from "./types.ts";

export const PHASE_ONE_DISABLED = ["watchdog", "panes", "missions", "preflight", "gates", "external-machines", "extension-bindings"] as const;
export function phaseOneConfig(config: ExtensionConfig): ExtensionConfig {
	if (config.worktreeProvider !== undefined && config.worktreeProvider !== "native") throw new Error("Only the native Git worktree provider is supported; other allocators are excluded.");
	for (const key of ["worktreeSetupHook", "worktreeSetupHookTimeoutMs", "intercomBridge"] as const) {
		if (config[key] !== undefined) throw new Error(`Tau phase 1 does not support config.${key}.`);
	}
	if (config.missions !== undefined || config.scheduledRuns !== undefined) throw new Error("Missions and schedules are deferred to phase 6.");
	return { ...config, worktreeProvider: "native", disabledFeatures: [...new Set([...PHASE_ONE_DISABLED, ...(config.disabledFeatures ?? [])])], missions: { enabled: false }, scheduledRuns: { enabled: false }, intercomBridge: { mode: "off", resultDelivery: false }, capacity: { abandonedSlotReleaseAfterMs: false } };
}
export function assertNativeAgent(agent: AgentConfig, allowExternalCli = false): void {
	const supportedRunner = allowExternalCli && agent.runner?.type === "external-cli" && isCodeOwnedExternalCliAdapterId(agent.runner.adapter);
	if ((agent.runner && !supportedRunner) || agent.machine || (agent.defaultAcceptance !== undefined && agent.defaultAcceptance !== false) || agent.mcpDirectTools?.length || agent.permissions !== undefined || agent.tools?.some((tool) => tool.startsWith("mcp:"))) throw new Error(`Agent '${agent.name}' selects a feature deferred beyond Tau phase 1 (runner, machine, acceptance, permissions or MCP).`);
}
/** Also guard low-level native launch APIs, not only the public tool schema. */
export function assertNativeExecution(options: object, allowWorktree = false): void {
	const values = options as Record<string, unknown>;
	if (values.share === true || values.shareEnabled === true) throw new Error("Session sharing through Gist is excluded from Tau.");
	for (const key of ["machine", "worktreeSetupHook", "worktreeSetupHookTimeoutMs", "share", "shareEnabled", "acceptance"])
		if (values[key] !== undefined && values[key] !== false) throw new Error(`Execution option '${key}' is unavailable in Tau phase 1.`);
	if (values.worktreeProvider !== undefined && values.worktreeProvider !== "native") throw new Error("Only the native Git worktree provider is supported; other allocators are excluded.");
	if (values.worktree !== undefined && typeof values.worktree !== "boolean") throw new Error("worktree must be true or false.");
	if (!allowWorktree && ["worktree", "worktreeProvider", "worktreeBranchPrefix", "worktreeBaseDir", "baseRef"].some((key) => values[key] !== undefined && values[key] !== false)) throw new Error("Worktree allocation requires the subagent executor, not the low-level session API.");
	if (values.isolation !== undefined) throw new Error("Normalize isolation through the public subagent executor before launching a native session.");
}
export function unavailableMutationSnapshot(cwd: string): TrackedMutationSnapshot {
	return { source: "tracked-files", trackedOnly: true, cwd, dirtyFiles: [], fingerprints: {}, unavailable: "Git mutation evidence was not collected for this launch; no source repository or index verification is implied." };
}
export const WEB_TOOLS = new Set(["web_search", "fetch_web_content", "get_cached_web_content"]);
export function tauWebEntry(): string {
	const manifestPath = fileURLToPath(import.meta.resolve("web/package.json"));
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	const entry = "./extensions/web/index.ts";
	if (manifest.name !== "web" || !manifest.pi?.extensions?.includes(entry)) throw new Error("Tau Web package identity/manifest mismatch.");
	return fs.realpathSync(path.resolve(path.dirname(manifestPath), entry));
}
