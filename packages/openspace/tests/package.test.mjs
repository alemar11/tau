import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const probePath = fileURLToPath(new URL("./fixtures/lifecycle-probe.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "openspace-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function environment(root, extra = {}) {
  // The probe/CLI need no credentials or personal session metadata.
  return {
    PATH: process.env.PATH, HOME: root, TMPDIR: root,
    PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", ...extra,
  };
}

function probe(root, mode, extra = {}) {
  const result = spawnSync(process.execPath, [probePath, mode], {
    cwd: root, env: environment(root, extra), encoding: "utf8", timeout: 15_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null, result.stderr);
  return { status: result.status, ...JSON.parse(result.stdout) };
}

test("factory import does not read config or open resources; disabled startup ignores environment and stays inert", (t) => {
  const root = fixture(t);
  const config = join(root, "agent", "openspace", "config.json");
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, "malformed JSON");
  assert.deepEqual(probe(root, "factory"), { status: 0, ok: true });
  writeFileSync(config, '{"enabled":false}');
  assert.deepEqual(probe(root, "start", { PI_OPENSPACE_WORKGROUPS: "default", PI_OPENSPACE_ASK_TIMEOUT_MS: "invalid" }), { status: 0, ok: true });
  assert.deepEqual(readdirSync(dirname(config)), ["config.json"]);
  assert.equal(readFileSync(config, "utf8"), '{"enabled":false}');
});

test("session_start reports config errors without starting resources or mutating neighboring state", (t) => {
  const root = fixture(t);
  const config = join(root, "agent", "openspace", "config.json");
  const neighbor = join(root, "agent", "other-extension");
  mkdirSync(dirname(config), { recursive: true });
  mkdirSync(neighbor);
  writeFileSync(join(neighbor, "config.json"), '{"neighbor":"untouched"}');
  writeFileSync(config, '{"inboundTrigger":"typo"}');
  const result = probe(root, "start");
  assert.equal(result.status, 1);
  assert.equal(result.ok, false);
  assert.ok(result.error.includes(config));
  assert.match(result.error, /inboundTrigger/);
  assert.deepEqual(readdirSync(dirname(config)), ["config.json"]);
  assert.equal(readFileSync(join(neighbor, "config.json"), "utf8"), '{"neighbor":"untouched"}');
  writeFileSync(config, "{}");
  const badEnv = probe(root, "start", { PI_OPENSPACE_WORKGROUPS: "default" });
  assert.equal(badEnv.status, 1);
  assert.match(badEnv.error, /PI_OPENSPACE_WORKGROUPS.*reserved/);
});

test("Pi 0.99.1 loader discovers exactly the declared extension and no helpers/tests", async (t) => {
  const root = fixture(t);
  const loaded = await discoverAndLoadExtensions([packageDir], root, join(root, "agent"));
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.extensions.map((extension) => extension.path), [join(packageDir, "extensions", "openspace", "index.ts")]);
  assert.equal(loaded.extensions[0].handlers.get("session_start").length, 1);
  assert.equal(existsSync(join(root, "agent", "openspace")), false);
});

test("tarball includes executable runtime, attribution and explicit Pi resources, not development/study files", (t) => {
  const root = fixture(t);
  const env = { ...process.env, npm_config_update_notifier: "false" };
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], {
    cwd: packageDir, env, encoding: "utf8", timeout: 30_000,
  }));
  assert.equal(packed.length, 1);
  assert.equal(manifest.name, "openspace");
  assert.equal(packed[0].name, "openspace");
  assert.equal(packed[0].filename, `openspace-${manifest.version}.tgz`);
  const files = new Set(packed[0].files.map((file) => file.path));
  for (const name of ["cli.mjs", "cli.ts", "src/config.ts", "src/paths.ts", "src/workgroups.ts", "src/broker/main.ts", "src/broker/server.ts", "src/broker/spawn.ts", "src/broker/runtime-files.ts", "src/broker/probe.ts", "src/protocol/framing.ts", "src/protocol/messages.ts", "src/registry/registry.ts", "src/registry/session.ts", "src/registry/leases.ts", "src/clock.ts", "src/client/client.ts", "src/client/controller.ts", "src/client/responses.ts", "src/client/messenger.ts", "src/client/conversation.ts", "src/client/reply-tracker.ts", "src/broker/asks.ts", "src/protocol/delivery.ts", "src/broker/delivery.ts", "extensions/openspace/index.ts", "README.md", "REGISTRY.md", "DELIVERY.md", "ASKS.md", "package.json"]) {
    assert.ok(files.has(name), `missing ${name}`);
  }
  for (const name of files) assert.doesNotMatch(name, /(^|\/)(tests|fixtures|plans|node_modules|dist|coverage|\.pi)(\/|$)|\.test\.|package-lock|tsconfig/);
  assert.equal(packed[0].files.find((file) => file.path === "cli.mjs").mode & 0o111, 0o111);
  assert.deepEqual(manifest.os, ["darwin", "linux"]);
  assert.deepEqual(manifest.pi, { extensions: ["./extensions/openspace/index.ts"] });
  assert.equal(manifest.private, true);
  assert.equal(files.has("LICENSE"), false);
  assert.equal(files.has("THIRD_PARTY_NOTICES.md"), false);
  assert.equal(manifest.exports, undefined);
  assert.deepEqual(Object.keys(manifest.dependencies), ["tsx"]);
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");

  // Inspect the actual archive, not just the manifest's proposed allowlist.
  execFileSync("tar", ["-xzf", join(root, packed[0].filename), "-C", root]);
  const unpacked = join(root, "package");
  for (const name of ["src/config.ts", "src/paths.ts"]) {
    const source = readFileSync(join(unpacked, name), "utf8");
    assert.match(source, /Copyright \(c\) 2026 Nico Bailon/);
    assert.match(source, /Permission is hereby granted, free of charge/);
    assert.match(source, /The above copyright notice and this permission notice shall be included/);
    assert.match(source, /THE SOFTWARE IS PROVIDED "AS IS"/);
  }
  assert.equal(readFileSync(join(unpacked, "cli.mjs"), "utf8").split("\n")[0], "#!/usr/bin/env node");
});

test("launcher runs without Pi imports and refuses unavailable commands without touching the runtime", (t) => {
  const root = fixture(t);
  for (const args of [["--help"], ["--version"], ["list"], ["send", "peer", "text"]]) {
    const result = spawnSync(process.execPath, [join(packageDir, "cli.mjs"), ...args], {
      cwd: root, env: environment(root), encoding: "utf8", timeout: 15_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null, result.stderr);
    if (args[0] === "--help") {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /not implemented/);
    } else if (args[0] === "--version") {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), `openspace ${manifest.version}`);
    } else {
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /not implemented/);
    }
  }
  assert.equal(existsSync(join(root, "agent")), false);
});
