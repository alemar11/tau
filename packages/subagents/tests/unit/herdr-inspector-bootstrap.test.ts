import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { handleInspectorAction } from "../../extensions/subagents/src/inspectors/actions.ts";
import { createHerdrInspectorPlugin } from "../../extensions/subagents/src/inspectors/herdr/plugin.ts";
import type { HerdrClient } from "../../extensions/subagents/src/inspectors/herdr/client.ts";

for (const standalone of [false, true]) it(`inspector uses ordinary Node with ${standalone ? "standalone" : "Node-hosted"} Pi`, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tau-inspector-bootstrap-"));
	const originalExecPath = process.execPath;
	try {
		const asyncDir = path.join(root, "run-123");
		fs.mkdirSync(asyncDir);
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "run-123", mode: "single", state: "completed", cwd: root, steps: [{ agent: "worker", status: "completed" }] }));
		if (standalone) process.execPath = path.join(root, process.platform === "win32" ? "pi.exe" : "pi");
		const calls: string[][] = [];
		const client: HerdrClient = {
			run: async <T>(args: string[]) => {
				calls.push(args);
				const data = args[0] === "--version" ? "herdr 0.7.5"
					: args[1] === "get" ? { pane_id: "source", terminal_id: "source-terminal" }
					: args[1] === "split" ? { pane: { pane_id: "viewer", terminal_id: "viewer-terminal" } } : {};
				return { ok: true, data: data as T };
			},
		};
		const opened = await handleInspectorAction("inspector.open", { id: "run-123" }, {
			cwd: root, asyncDirRoot: root, resultsDir: path.join(root, "results"),
			plugins: [createHerdrInspectorPlugin({ client })], env: { HERDR_ENV: "1", HERDR_PANE_ID: "source" },
		});
		assert.equal(opened.isError, undefined, JSON.stringify(opened));
		const command = calls.find((args) => args[1] === "run")?.[3] ?? "";
		const runner = fileURLToPath(new URL("../../extensions/subagents/inspector-runner.mjs", import.meta.url));
		assert.equal(command.startsWith("& "), process.platform === "win32");
		assert.doesNotMatch(command, /--experimental-strip-types/);
		assert.ok(command.includes(runner));
		assert.ok(command.includes("--inspector-token"));
		if (standalone) assert.match(command, process.platform === "win32" ? /& 'node\.exe' / : /^node /);
	} finally {
		process.execPath = originalExecPath;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
