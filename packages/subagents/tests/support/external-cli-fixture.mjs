import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Local protocol fixtures only: no provider, network, login or installed CLI.
export async function run(adapter) {
  const args = process.argv.slice(2);
  if (args[0] === "--version") {
    console.log(adapter === "codex-exec" ? "codex-cli 0.147.0" : adapter === "claude-code" ? "2.1.150 (Claude Code)" : "2026.08.11-e8db854");
    return;
  }
  if (args.includes("--help")) {
    console.log(adapter === "codex-exec"
      ? "Run Codex non-interactively --json --output-last-message --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check --sandbox read-only workspace-write --config"
      : adapter === "claude-code"
        ? "Claude Code - starts an interactive session --print --input-format text --output-format stream-json --verbose --permission-mode plan acceptEdits --tools --strict-mcp-config --mcp-config --setting-sources --no-session-persistence --disable-slash-commands --no-chrome"
        : "Start the Cursor Agent --print Has access to all tools, including write and shell --output-format stream-json --mode <mode> ask: Q&A read-only --sandbox <mode> enabled --workspace <path-or-name> --add-dir <path>");
    return;
  }
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  if (adapter === "cursor-agent") {
    const match = /^Read the complete handoff from the private file at (.+)\. Follow it and return only the final answer\.$/.exec(args.at(-1) ?? "");
    if (!match || prompt) throw new Error("Invalid private prompt transport");
    prompt = fs.readFileSync(match[1], "utf8");
  }
  const gate = /TAU_FIXTURE_GATE:(\S+)/.exec(prompt)?.[1];
  if (gate) {
    fs.writeFileSync(`${gate}.entered`, JSON.stringify({ cwd: process.cwd(), args, adapter }));
    while (!fs.existsSync(`${gate}.release`)) await delay(20);
  }
  const file = /TAU_FIXTURE_WRITE:(\S+)/.exec(prompt)?.[1];
  if (file) fs.writeFileSync(path.resolve(file), /TAU_FIXTURE_CONTENT:(\S+)/.exec(prompt)?.[1] ?? "external");
  if (prompt.includes("TAU_FIXTURE_MALFORMED")) { console.log("{invalid JSON}"); return; }
  const output = `external fixture complete: ${adapter} ${JSON.stringify(args)}`;
  if (adapter === "codex-exec") {
    fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], output);
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }));
  } else console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: output }));
}
