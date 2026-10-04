import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import * as path from "node:path";
import { bindingExists, readInspectorBinding, withInspectorBindingLock } from "../binding-store.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details } from "../../shared/types.ts";
import type { InspectorContext, InspectorLaunch, InspectorParams } from "../types.ts";

/** Static Ghostty 1.3 AppleScript; dynamic values arrive as `on run argv` arguments. */
export const GHOSTTY_APPLESCRIPT = `on run argv
  set launchCommand to item 1 of argv
  set launchCwd to item 2 of argv
  set shouldFocus to item 3 of argv
  set sourceId to item 4 of argv
  tell application "Ghostty"
    set previousTerminal to focused terminal of selected tab of front window
    set sourceTerminal to terminal id sourceId
    set surfaceConfiguration to new surface configuration
    set initial working directory of surfaceConfiguration to launchCwd
    set command of surfaceConfiguration to launchCommand
    set newTerminal to split sourceTerminal direction right with configuration surfaceConfiguration
    if shouldFocus is "true" then
      focus newTerminal
    else
      focus previousTerminal
    end if
    return id of newTerminal
  end tell
end run`;

export type GhosttyRunner = (args: readonly string[], options: ExecFileOptionsWithStringEncoding) => Promise<{ stdout: string; stderr: string }>;

function defaultRunner(args: readonly string[], options: ExecFileOptionsWithStringEncoding): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile("/usr/bin/osascript", [...args], options, (error, stdout, stderr) => {
			if (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				reject(failure);
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

function result(text: string, isError = false): AgentToolResult<Details> {
	const response: AgentToolResult<Details> = {
		content: [{ type: "text", text }],
		details: { mode: "management", results: [] },
	};
	if (isError) response.isError = true;
	return response;
}

const failureHint = "Ghostty inspector requires its AppleScript terminal API and Automation permission for osascript. Reconcile possible terminal effects before retrying.";

export function ghosttyBindingPath(context: InspectorContext): string {
	return path.join(context.target.asyncDir, "inspectors", `ghostty${context.target.index === undefined ? "" : `-${context.target.index}`}.json`);
}

interface GhosttyBinding {
	schemaVersion: 1;
	kind: "ghostty-inspector";
	runId: string;
	state: "opening" | "started";
	sourceTerminalId: string;
	terminalId?: string;
}

function readBinding(context: InspectorContext): GhosttyBinding | undefined {
	try {
		const binding = readInspectorBinding(ghosttyBindingPath(context)) as GhosttyBinding;
		if (binding.schemaVersion !== 1 || binding.kind !== "ghostty-inspector" || binding.runId !== context.target.runId
			|| !["opening", "started"].includes(binding.state) || typeof binding.sourceTerminalId !== "string"
			|| (binding.terminalId !== undefined && !/^[a-zA-Z0-9-]{1,128}$/.test(binding.terminalId))) return undefined;
		return binding;
	} catch { return undefined; }
}

export const GHOSTTY_STATUS_APPLESCRIPT = `on run argv
  if application "Ghostty" is not running then return "not-running"
  tell application "Ghostty"
    return exists terminal id (item 1 of argv)
  end tell
end run`;

export async function statusGhosttyInspector(context: InspectorContext, runner: GhosttyRunner = defaultRunner): Promise<AgentToolResult<Details>> {
	const binding = readBinding(context);
	if (!binding || binding.state !== "started" || !binding.terminalId) return result("Ghostty binding is incomplete or invalid. Reconcile manually; do not repeat the launch.", true);
	try {
		const output = await runner(["-e", GHOSTTY_STATUS_APPLESCRIPT, "--", binding.terminalId], { signal: context.signal, timeout: 5_000, encoding: "utf8", maxBuffer: 64 * 1024 });
		const state = output.stdout.trim();
		if (!["true", "false", "not-running"].includes(state)) return result("Ghostty returned an unrecognized status; binding retained.", true);
		return result(`Ghostty inspector ${binding.terminalId}: ${state === "true" ? "present" : "absent"}. Run state: ${context.target.status.state}. The binding is retained; close/reconcile manually. Terminal presence is not writer-settlement evidence.`);
	} catch (cause) {
		return result(`Ghostty status unavailable: ${cause instanceof Error ? cause.message : String(cause)}. Binding retained.`, true);
	}
}

export async function openGhosttyInspector(
	context: InspectorContext,
	launch: InspectorLaunch,
	params: InspectorParams,
	runner: GhosttyRunner = defaultRunner,
): Promise<AgentToolResult<Details>> {
	const file = ghosttyBindingPath(context);
	return withInspectorBindingLock(file, async (assertCurrent) => {
		if (context.signal?.aborted) return result("Ghostty inspector opening aborted before launch.", true);
		if (bindingExists(file)) return statusGhosttyInspector(context, runner);
		const sourceTerminalId = context.env.TAU_SUBAGENTS_GHOSTTY_TERMINAL_ID;
		if (!sourceTerminalId || !/^[a-zA-Z0-9-]{1,128}$/.test(sourceTerminalId)) return result("Set TAU_SUBAGENTS_GHOSTTY_TERMINAL_ID to an explicitly selected live Ghostty terminal ID. The front window is not assumed to belong to this session.", true);
		const binding: GhosttyBinding = { schemaVersion: 1, kind: "ghostty-inspector", runId: context.target.runId, state: "opening", sourceTerminalId };
		writeAtomicJson(file, binding);
		try {
			const output = await runner(["-e", GHOSTTY_APPLESCRIPT, "--", launch.displayCommand, context.target.status.cwd ?? context.cwd, params.focus === true ? "true" : "false", sourceTerminalId], {
				signal: context.signal, timeout: 15_000, encoding: "utf8", maxBuffer: 64 * 1024,
			});
			assertCurrent();
			const id = output.stdout.trim();
			if (!/^[a-zA-Z0-9-]{1,128}$/.test(id) || id === sourceTerminalId) return result(`Ghostty returned no distinct valid terminal identity; the opening binding is retained. ${failureHint}`, true);
			try { writeAtomicJson(file, { ...binding, terminalId: id, state: "started" }); } catch (cause) {
				return result(`Ghostty returned terminal ${id}, but binding finalization failed: ${cause instanceof Error ? cause.message : String(cause)}. Retain this identity and reconcile manually.`, true);
			}
			return result(`Opened Ghostty inspector terminal ${id} for async run ${context.target.runId}. Binding retained. Closing this viewer does not stop the run; automatic close is unsupported.`);
		} catch (cause) {
			return result(`Ghostty inspector error: ${cause instanceof Error ? cause.message : String(cause)}. Opening binding retained. ${failureHint}`, true);
		}
	});
}
