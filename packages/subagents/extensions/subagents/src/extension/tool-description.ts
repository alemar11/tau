import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";
import type { DisabledFeatureSurface } from "../shared/disabled-features.ts";

// Advertise only enabled features; deferred source is not a capability promise.
export const SUBAGENT_SAFETY_GUIDANCE = `Delegate only when authorized by the operator or applicable instructions.
Background is the default; async:false explicitly waits for native children. Optional CLI adapters require background execution. Dispatch is not completion: consume final results at dependency barriers.
One writer per canonical cwd and root session is admitted FIFO, including nested children. Queue time counts against the deadline. A conflicting descendant writer is rejected. Readers may overlap, without a snapshot or OS sandbox. Uncertain writers retain ownership.
Native model selection is call override, profile override, then the coordinator model at launch. Never silently switch provider, model or runner after a failure.
Use fresh independent reviewers when requested. Oracle prefers a fork; explicit fork needs persisted history. Child questions use contact_supervisor and correlated subagent_supervisor replies.
Inspect status, transcript and artifacts; use steer, interrupt, stop and explicit resume. A steering receipt proves neither compliance nor task completion. Do not retry a failed workflow through another execution mechanism without authorization.`;

export const DEFAULT_SUBAGENT_TOOL_DESCRIPTION = `Tau native Pi delegation. First inspect {action:'list',capabilities:true}.
One child: {agent:'worker',task:'...',async:true}. Management/control: {action:'status',id:'...'}; list/get/models/guide/validate, children.list, debug.run, steer/interrupt/stop/resume/dismiss, and agent create/update/delete/eject/disable/enable/reset/refine.
For coordinated work, write one JavaScript statement body in a fenced js workflow block and call {workflow:true}, or use {workflow:'./workflow.js'}. Named workflow resources are also supported. Validate with action:'validate' before launch. Use stable keys and await runs.run(key,{agent,task}) before reading output; runs.all([{key,agent,task},...]) yields an ordered result array. runs.status, runs.steer, runs.ref, runs.refs, emit, console and frozen args are available. Scripts have no filesystem or shell access. Do not use nested async functions or leave launch promises unobserved. Explicit child async:true returns only a running receipt.
Bind reports with output and structured output with outputSchema, not task prose. Native tools and explicitly configured extensions/skills are resolved before execution. Research uses Tau Web: web_search, fetch_web_content and get_cached_web_content. A fresh auditor must fetch cited URLs itself; another session's cache IDs grant no access.
Use worktree:true (or isolation:'worktree') for native Git isolation, optionally baseRef:'refs/heads/main'. A clean Git source is required; never commit or stash implicitly to satisfy it. Writers on distinct worktrees may overlap. Worktrees and branches are retained by default; no automatic merge, removal or upload. Inspect parallelHandoff for paths and patch evidence. runs.lanes sequences stages within independent lanes; lane.status and lane.recordMerge/lane.recordSupersession inspect or record evidence, never merge. worktree.cleanup only plans; worktree.discard requires explicit authorization and provably settled managed writers. Worktrunk and Gist sharing are excluded. Optional claude-code, codex-exec, cursor-agent and their -writer profiles are background-only one-shot CLIs; all enter writer admission. They require installed/authenticated programs, cannot resume/steer/fork or expose native structured-output/supervisor transports, and are never fallback runners. Claude accepts explicit model/effort overrides; other CLI adapters use their own model configuration. See guide topic:'external-runners'. Explicit inspector.command/open/status/close actions inspect background artifacts through optional Herdr/Ghostty viewers; closing a viewer never stops a child or releases admission. Retain uncertain terminal effects, never blindly retry or close another pane. See guide topic:'terminal-inspectors'; Ghostty close is manual. Project panes and process placement, generic/external-job adapters, optional integrations, missions, scheduler, watchdog, host steps and acceptance gates remain deferred.
Read {action:'guide',topic:'tool-reference'} or topic:'workflows' for details.

${SUBAGENT_SAFETY_GUIDANCE}`;
export const COMPACT_SUBAGENT_TOOL_DESCRIPTION = DEFAULT_SUBAGENT_TOOL_DESCRIPTION;
export const FULL_SUBAGENT_TOOL_DESCRIPTION = DEFAULT_SUBAGENT_TOOL_DESCRIPTION;
export const SUBAGENT_TOOL_PROMPT_SNIPPET = "For authorized delegation, use native subagents and await results at dependency barriers.";
export const SUBAGENT_TOOL_PROMPT_GUIDELINES = ["Do not invoke subagents unless the operator requested delegation directly or through applicable instructions."];
export interface ToolDescriptionOptions {
	cwd?: string;
	agentDir?: string;
	warn?: (message: string) => void;
	disabledFeatures?: DisabledFeatureSurface;
}
export interface SubagentToolPromptMetadata { promptSnippet?: string; promptGuidelines?: string[] }
export function buildSubagentToolPromptMetadata(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}, _disabled?: DisabledFeatureSurface): SubagentToolPromptMetadata {
	return config.toolDescriptionMode === undefined ? { promptSnippet: SUBAGENT_TOOL_PROMPT_SNIPPET, promptGuidelines: SUBAGENT_TOOL_PROMPT_GUIDELINES } : {};
}
export function resolveToolDescriptionMode(config: Pick<ExtensionConfig, "toolDescriptionMode">, options?: ToolDescriptionOptions): ToolDescriptionMode {
	const mode = config.toolDescriptionMode;
	if (mode === undefined || mode === "full") return "full";
	if (mode === "compact" || mode === "custom") return mode;
	(options?.warn ?? console.warn)(`[tau-subagents] Invalid toolDescriptionMode ${JSON.stringify(mode)}; using full.`);
	return "full";
}
export function buildSubagentToolDescription(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}, options?: ToolDescriptionOptions): string {
	if (resolveToolDescriptionMode(config, options) !== "custom") return DEFAULT_SUBAGENT_TOOL_DESCRIPTION;
	const agentDir = options?.agentDir ?? getAgentDir();
	const projectConfigDir = getProjectConfigDir(options?.cwd ?? process.cwd());
	const warn = options?.warn ?? console.warn;
	const substitutions: Record<string, string> = { fullDescription: FULL_SUBAGENT_TOOL_DESCRIPTION, full: FULL_SUBAGENT_TOOL_DESCRIPTION, compactDescription: COMPACT_SUBAGENT_TOOL_DESCRIPTION, compact: COMPACT_SUBAGENT_TOOL_DESCRIPTION, safetyGuidance: SUBAGENT_SAFETY_GUIDANCE, safety: SUBAGENT_SAFETY_GUIDANCE, agentDir, projectConfigDir };
	for (const root of [projectConfigDir, agentDir]) {
		const file = path.join(root, "tau-subagents", "subagent-tool-description.md");
		try {
			const stat = fs.statSync(file);
			if (!stat.isFile() || stat.size > 50 * 1024) { warn(`Ignoring oversized or non-file description: ${file}`); continue; }
			const text = fs.readFileSync(file, "utf8").replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
				if (substitutions[name] !== undefined) return substitutions[name];
				warn(`Unknown description placeholder ${raw}`); return raw;
			}).split(SUBAGENT_SAFETY_GUIDANCE).join("").trim();
			if (text) return `${text}\n\n${SUBAGENT_SAFETY_GUIDANCE}`;
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn(`Cannot read description ${file}: ${String(error)}`); }
	}
	return DEFAULT_SUBAGENT_TOOL_DESCRIPTION;
}
