import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { loadConfig, loadEnvironment } from "../src/config.ts";
import { resolvePaths } from "../src/paths.ts";
import { effectiveWorkgroups, normalizeSpecificWorkgroups, parseWorkgroups } from "../src/workgroups.ts";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "openspace-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  return { root, configPath, config: (value) => {
    writeFileSync(configPath, JSON.stringify(value));
    return loadConfig(configPath);
  } };
}

test("missing config returns independent defaults without creating runtime files", (t) => {
  const { root, configPath } = fixture(t);
  const first = loadConfig(configPath);
  assert.deepEqual(first, {
    brokerCommand: "npx", brokerArgs: ["--no-install", "tsx"], enabled: true,
    replyHint: true, confirmSend: false, inboundTrigger: "always", busyDelivery: "steer",
  });
  first.brokerArgs.push("not-a-default");
  first.enabled = false;
  assert.deepEqual(loadConfig(configPath).brokerArgs, ["--no-install", "tsx"]);
  assert.equal(loadConfig(configPath).enabled, true);
  assert.deepEqual(readdirSync(root), []);
});

test("known fields retain their meaning, strings/args are not silently altered", (t) => {
  const { config } = fixture(t);
  assert.deepEqual(config({
    brokerCommand: " /opt/tool with spaces ", brokerArgs: ["", " two words ", "è"],
    enabled: false, replyHint: false, confirmSend: true, inboundTrigger: "never",
    busyDelivery: "human-first", stableId: " worker-a ", status: " · Eseguo test 🙂 ", unused: true,
  }), {
    brokerCommand: "/opt/tool with spaces", brokerArgs: ["", " two words ", "è"],
    enabled: false, replyHint: false, confirmSend: true, inboundTrigger: "never",
    busyDelivery: "human-first", stableId: "worker-a", status: " · Eseguo test 🙂 ",
  });
  for (const inboundTrigger of ["always", "replies", "never"]) {
    assert.equal(config({ inboundTrigger }).inboundTrigger, inboundTrigger);
  }
  assert.equal(config({ status: "" }).status, "");
  assert.deepEqual(config({ brokerArgs: [] }).brokerArgs, []);
});

test("invalid JSON, roots and each known field fail with source diagnostics", (t) => {
  const { configPath, config } = fixture(t);
  writeFileSync(configPath, "{bad json");
  assert.throws(() => loadConfig(configPath), (e) => e.message.includes(configPath) && e.cause instanceof SyntaxError);
  for (const value of [null, false, 1, "text", []]) {
    assert.throws(() => config(value), (e) => e.message.includes(configPath) && e.message.includes("object"));
  }
  for (const [key, values] of Object.entries({
    enabled: ["false", 0, null], replyHint: ["true", null], confirmSend: [1, null],
    inboundTrigger: ["typo", true, null], busyDelivery: ["idle", true, null],
    brokerCommand: [" ", 1, "node\0"], brokerArgs: ["node", [1], [null], ["\0"]],
    stableId: [" ", false, null, "id\0"], status: [null, 1, [], {}],
  })) {
    for (const value of values) {
      assert.throws(() => config({ [key]: value }), (e) => e.message.includes(configPath) && e.message.includes(`"${key}"`));
    }
  }
});

test("unreadable config is not confused with absent config", (t) => {
  const { root } = fixture(t);
  assert.throws(() => loadConfig(root), (e) => e.message.includes(root) && e.cause.code === "EISDIR");
});

test("status limit counts UTF-8 bytes, accepts the boundary and never truncates", (t) => {
  const { config } = fixture(t);
  for (const status of ["x".repeat(1024), "è".repeat(512), "🙂".repeat(256), "\0".repeat(1024)]) {
    assert.equal(Buffer.byteLength(status), 1024);
    assert.equal(config({ status }).status, status);
    assert.throws(() => config({ status: status + "x" }), /status.*1024.*UTF-8/);
  }
});

test("path snapshots handle relative/Unicode agent directories and do not read neighboring config", (t) => {
  const { root } = fixture(t);
  const env = { PI_CODING_AGENT_DIR: " ./caffè/../agente 🙂 ", PI_OTHER_SCOPE_ID: "unrelated" };
  const paths = resolvePaths(env, root, root);
  assert.deepEqual(paths, {
    agentDir: join(root, "agente 🙂"), runtimeDir: join(root, "agente 🙂", "openspace"),
    configPath: join(root, "agente 🙂", "openspace", "config.json"),
    socketPath: join(root, "agente 🙂", "openspace", "broker.sock"),
  });
  assert.deepEqual(readdirSync(root), []);
  env.PI_CODING_AGENT_DIR = "/other";
  assert.equal(paths.agentDir, join(root, "agente 🙂"));
  const neighbor = join(paths.agentDir, "other-extension");
  mkdirSync(neighbor, { recursive: true });
  writeFileSync(join(neighbor, "config.json"), "invalid unrelated config");
  assert.equal(loadConfig(paths.configPath).enabled, true);
  assert.equal(readFileSync(join(neighbor, "config.json"), "utf8"), "invalid unrelated config");
  assert.deepEqual(readdirSync(paths.agentDir), ["other-extension"]);
  for (const PI_CODING_AGENT_DIR of [undefined, "", "  "]) {
    assert.equal(resolvePaths({ PI_CODING_AGENT_DIR }, root, "/elsewhere").runtimeDir, join(root, ".pi", "agent", "openspace"));
  }
  assert.equal(resolvePaths({ PI_CODING_AGENT_DIR: root }, "/unused", "/elsewhere").agentDir, root);
  assert.equal(resolvePaths({ PI_CODING_AGENT_DIR: "~" }, root, "/elsewhere").agentDir, root);
  assert.equal(resolvePaths({ PI_CODING_AGENT_DIR: "~/agente 🙂" }, root, "/elsewhere").agentDir, paths.agentDir);
  assert.equal(resolvePaths({ PI_CODING_AGENT_DIR: pathToFileURL(paths.agentDir).href }, root, "/elsewhere").agentDir, paths.agentDir);
  assert.throws(() => resolvePaths({ PI_CODING_AGENT_DIR: "file://remote/config" }, root, root), /PI_CODING_AGENT_DIR/);
  assert.throws(() => resolvePaths({ PI_CODING_AGENT_DIR: "bad\0dir" }, root, root), /PI_CODING_AGENT_DIR/);
});

test("environment defaults are independent of unrelated variables and do not mutate the input", () => {
  const env = Object.freeze({
    PI_OTHER_ASK_TIMEOUT_MS: "invalid", PI_OTHER_LIVENESS_INTERVAL_MS: "broken",
    PI_OTHER_SCOPE_ID: "unrelated", PI_OTHER_SESSION_ID: "other-id", PI_OTHER_TRANSPORT: "tcp",
  });
  assert.deepEqual(loadEnvironment(env), {
    workgroups: [], askTimeoutMs: 600_000, livenessIntervalMs: 30_000, livenessTimeoutMs: 5_000,
  });
  const mutableEnv = { PI_OPENSPACE_WORKGROUPS: "review", PI_OPENSPACE_STABLE_ID: " mine " };
  const snapshot = loadEnvironment(mutableEnv);
  mutableEnv.PI_OPENSPACE_WORKGROUPS = "other";
  assert.deepEqual(snapshot.workgroups, ["review"]);
  assert.equal(snapshot.stableId, "mine");
  assert.deepEqual(loadEnvironment({ PI_OPENSPACE_STABLE_ID: " " }).workgroups, []);
  assert.equal(loadEnvironment({ PI_OPENSPACE_STABLE_ID: " " }).stableId, undefined);
});

test("environment timer validation prevents malformed and overflowing Node timers", () => {
  for (const key of ["PI_OPENSPACE_ASK_TIMEOUT_MS", "PI_OPENSPACE_LIVENESS_INTERVAL_MS", "PI_OPENSPACE_LIVENESS_TIMEOUT_MS"]) {
    for (const value of ["0", "-1", "1.5", "100junk", "Infinity", "NaN", "2147483648"]) {
      assert.throws(() => loadEnvironment({ [key]: value }), (e) => e.message.includes(key));
    }
    for (const value of ["", "  "]) assert.doesNotThrow(() => loadEnvironment({ [key]: value }));
  }
  const parsed = loadEnvironment({
    PI_OPENSPACE_ASK_TIMEOUT_MS: " 1200000 ", PI_OPENSPACE_LIVENESS_INTERVAL_MS: "1000",
    PI_OPENSPACE_LIVENESS_TIMEOUT_MS: "2000",
  });
  assert.equal(parsed.askTimeoutMs, 1_200_000);
  assert.equal(parsed.livenessTimeoutMs, 1000);
  assert.equal(loadEnvironment({ PI_OPENSPACE_LIVENESS_INTERVAL_MS: "1" }).livenessTimeoutMs, 1);
  assert.equal(loadEnvironment({ PI_OPENSPACE_ASK_TIMEOUT_MS: "2147483647" }).askTimeoutMs, 2147483647);
});

test("workgroups normalize specific names while default stays an exclusive computed fallback", () => {
  for (const input of [undefined, "", "  "]) {
    assert.deepEqual(parseWorkgroups(input), []);
    assert.deepEqual(effectiveWorkgroups(parseWorkgroups(input)), ["default"]);
  }
  assert.deepEqual(parseWorkgroups(" review, progetto ,review,レビュー,Review "), ["review", "progetto", "レビュー", "Review"]);
  assert.deepEqual(effectiveWorkgroups(["review"]), ["review"]);
  assert.deepEqual(effectiveWorkgroups(["review", "progetto"]), ["review", "progetto"]);
  assert.deepEqual(effectiveWorkgroups(["progetto"]), ["progetto"]);
  assert.deepEqual(effectiveWorkgroups([]), ["default"]);
  for (const input of ["default", "review,default", "review,,test", "review,", ",review", "a, ,b", "re\tview", "a\0b", "a\u0085b"]) {
    assert.throws(() => loadEnvironment({ PI_OPENSPACE_WORKGROUPS: input }), /PI_OPENSPACE_WORKGROUPS/);
  }
  const groups = Object.freeze(["review", "review", "progetto"]);
  assert.deepEqual(normalizeSpecificWorkgroups(groups), ["review", "progetto"]);
  assert.throws(() => normalizeSpecificWorkgroups(["a,b"]), /commas/);
  assert.throws(() => effectiveWorkgroups(["default"]), /reserved/);
});
