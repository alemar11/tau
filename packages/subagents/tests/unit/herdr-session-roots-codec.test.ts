import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { decodeSessionRoots, encodeSessionRoots } from "../../extensions/subagents/src/inspectors/session-roots-codec.ts";
import { formatShellCommand } from "../../extensions/subagents/src/inspectors/shell-command.ts";

describe("session roots codec", () => {
	it("round-trips an empty array, plain paths, and paths with spaces/quotes", () => {
		for (const roots of [[], ["/tmp/a"], ["C:\\Users\\a b\\.pi", "D:\\work"], ['has "quotes"', "has\\backslashes\\"]]) {
			assert.deepEqual(decodeSessionRoots(encodeSessionRoots(roots)), roots);
		}
	});

	it("rejects malformed input", () => {
		assert.throws(() => decodeSessionRoots("not base64"), /base64-encoded JSON array of strings/);
		assert.throws(() => decodeSessionRoots(Buffer.from(JSON.stringify({ not: "an array" })).toString("base64")), /base64-encoded JSON array of strings/);
		assert.throws(() => decodeSessionRoots(Buffer.from(JSON.stringify([1, 2])).toString("base64")), /base64-encoded JSON array of strings/);
	});

	it("produces plain-ASCII base64 output with no quote, backslash, or space characters for a shell to mangle", () => {
		const encoded = encodeSessionRoots(["C:\\Users\\a b\\.pi\\sessions", 'contains "quotes"', "D:\\work"]);
		assert.match(encoded, /^[A-Za-z0-9+/=]+$/);
	});

	const hasPowerShell = process.platform === "win32" && spawnSync("pwsh", ["-NoProfile", "-Command", "exit ([int]($PSVersionTable.PSVersion -lt [version]'7.3'))"]).status === 0;
	describe("end-to-end through PowerShell 7.3+", { skip: !hasPowerShell }, () => {
		function echoArgvCommand(sessionRootsArg: string): string {
			const script = "process.stdout.write(JSON.stringify(process.argv.slice(1)));";
			return formatShellCommand(process.execPath, ["-e", script, "--", "--session-roots", sessionRootsArg], "win32");
		}

		function runThroughPowerShell(command: string): string[] {
			return JSON.parse(execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf-8" }));
		}

		it("preserves literal JSON, quotes and shell metacharacters", () => {
			const rawJson = JSON.stringify(["C:\\Users\\fixture\\.pi\\sessions", "$(not-a-command)", "it's literal", 'a "quote"']);
			const argv = runThroughPowerShell(echoArgvCommand(rawJson));
			assert.equal(argv[argv.indexOf("--session-roots") + 1], rawJson);
		});

		it("survives base64 encoding byte-for-byte", () => {
			const sessionRoots = ["C:\\Users\\fixture\\.pi\\sessions", "D:\\work\\proj", 'C:\\has "quotes"\\dir'];
			const encoded = encodeSessionRoots(sessionRoots);
			const argv = runThroughPowerShell(echoArgvCommand(encoded));
			const received = argv[argv.indexOf("--session-roots") + 1];
			assert.equal(received, encoded);
			assert.deepEqual(decodeSessionRoots(received ?? ""), sessionRoots);
		});
	});
});
