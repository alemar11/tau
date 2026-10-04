import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  HerdrPlacedRunOwner, herdrPaneAllocationKey, reconcileHerdrPlacedRun, withHerdrPaneAllocationLock,
  type HerdrRunIdentity,
} from "../../extensions/subagents/src/runs/shared/herdr-placed-run.ts";
import { HerdrPlacementJournal, herdrPrivateDirectory } from "../../extensions/subagents/src/runs/shared/herdr-placement-journal.ts";
import {
  createHerdrExternalAdapter, createHerdrExternalAdapterLaunch, HerdrExternalSession, monitorHerdrCodex,
} from "../../extensions/subagents/src/runs/shared/herdr-external-adapters.ts";
import type { HerdrForwardedConnection } from "../../extensions/subagents/src/runs/shared/herdr-connection.ts";
import type { HerdrMachineReference } from "../../extensions/subagents/src/shared/types.ts";
import registerHerdrPiBridge from "../../extensions/subagents/src/extension/herdr-pi-bridge.ts";
import { HERDR_PI_RUN_ENV, HERDR_PI_RUNTIME_DIR_ENV } from "../../extensions/subagents/src/runs/shared/herdr-pi-protocol.ts";

let root: string;
let previousAgentDir: string | undefined;
const machine: HerdrMachineReference = { provider: "herdr", id: "fixture", target: "fixture.invalid", cwd: "/remote/repo", workspaceId: "chosen" };
const endpoint = { socket: "/remote/herdr.sock", session: null, protocol: 22, version: "fixture", compatible: true, running: true };
const currentPane = { pane_id: "new-pane", terminal_id: "new-terminal", tab_id: "new-tab", workspace_id: "chosen", agent: null, agent_session: null };
const created = { type: "tab_created", tab: { tab_id: "new-tab", workspace_id: "chosen" }, root_pane: currentPane };
const snapshot = { workspaces: [{ workspace_id: "chosen", label: "explicit" }], tabs: [], panes: [] };
function records(directory: string): any[] {
  return fs.readdirSync(directory).filter((file) => file.endsWith(".json")).sort().map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")));
}
function journalPath(runId: string): string { return path.join(root, "tau-subagents", "herdr-run-journal", runId); }
function lockPath(key: string): string { return path.join(root, "tau-subagents", "herdr-allocation-locks", `${createHash("sha256").update(key).digest("hex")}.lock`); }
function identity(owner: HerdrPlacedRunOwner): HerdrRunIdentity {
  return { runId: owner.runId, machineId: machine.id, target: machine.target, session: null,
    workspaceId: "chosen", tabId: "new-tab", paneId: "new-pane", terminalId: "new-terminal", agentName: "fixture-agent",
    nativeSessionId: "native-fixture", cwd: owner.machine.cwd, runtimeDir: owner.runtimeDir };
}
async function fixture(runId: string, options: {
  call?: (method: string, params: Record<string, unknown>, fallback: () => unknown) => unknown;
  close?: () => Promise<void>;
  selected?: HerdrMachineReference;
} = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let closes = 0;
  const runtime = path.join(root, `runtime-${runId}`);
  const connection = {
    endpoint, socketPath: "/unused",
    client: {
      async call(method: string, params: Record<string, unknown> = {}) {
        calls.push({ method, params });
        const fallback = () => {
          if (method === "session.snapshot") return { type: "session_snapshot", snapshot };
          if (method === "tab.create") {
            assert.equal(params.workspace_id, "chosen");
            assert.equal(records(journalPath(runId)).at(-1).phase, "pane-intent");
            return created;
          }
          if (method === "pane.get") return { type: "pane_info", pane: currentPane };
          if (method === "agent.start") {
            assert.equal(records(journalPath(runId)).at(-1).phase, "start-intent");
            return { type: "agent_started", agent: { terminal_id: "new-terminal", pane_id: "new-pane" } };
          }
          throw new Error(`Unexpected remote mutation/read: ${method}`);
        };
        return options.call ? options.call(method, params, fallback) : fallback();
      },
      async subscribe() { return () => {}; },
    },
    async forwardRemoteSocket() { throw new Error("No forwarding permitted in this fixture"); },
    async close() { closes++; await options.close?.(); },
  } as unknown as HerdrForwardedConnection;
  const owner = await HerdrPlacedRunOwner.create(options.selected ?? machine, runId, undefined, {
    async createRuntime() {
      assert.equal(records(journalPath(runId))[0].phase, "runtime-intent");
      fs.mkdirSync(runtime);
      fs.writeFileSync(path.join(runtime, "retained-evidence"), "do not delete");
      return runtime;
    },
    async connect() {
      assert.equal(records(journalPath(runId)).at(-1).details.runtimeDir, runtime);
      return connection;
    },
  });
  return { owner, calls, runtime, closes: () => closes };
}

describe("Herdr placement retention foundation (still gated)", { skip: process.platform === "win32" }, () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tau-herdr-retention-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
  });
  afterEach(() => {
    previousAgentDir === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("persists intents before effects, exact receipts, and retains everything on repeated cleanup", async () => {
    const { owner, calls, runtime, closes } = await fixture("run_success");
    await owner.provision();
    await owner.start("pi", "fixture-agent", ["--no-extensions"]);
    owner.journal(identity(owner));
    const before = records(owner.journalPath);
    assert.deepEqual(before.map((record) => record.phase), ["runtime-intent", "runtime-receipt", "endpoint", "pane-intent", "pane-receipt", "start-intent", "start-receipt", "configured"]);
    assert.equal(before[4].details["root_pane.terminal_id"], "new-terminal");
    assert.equal(before[6].details["agent.terminal_id"], "new-terminal");
    assert.deepEqual(before[5].details.argv, ["pi", "--no-extensions"]);
    assert.equal(new Set(before.map((record) => record.token)).size, 1);
    for (const file of fs.readdirSync(owner.journalPath)) assert.equal(fs.statSync(path.join(owner.journalPath, file)).mode & 0o777, 0o600);
    await Promise.all([owner.cleanup(), owner.cleanup(), owner.cleanup()]);
    assert.equal(closes(), 1);
    assert.equal(fs.readFileSync(path.join(runtime, "retained-evidence"), "utf8"), "do not delete");
    assert.equal(owner.snapshot.state, "unknown");
    assert.equal(records(owner.journalPath).at(-1).details.remoteSettlement, "unknown");
    assert.deepEqual(calls.map(({ method }) => method), ["session.snapshot", "tab.create", "pane.get", "agent.start"]);
    await assert.rejects(owner.provision(), /already attempted|transport released/);
    await assert.rejects(owner.start("pi", "fixture-agent", []), /already attempted|transport released/);
    await assert.rejects(fixture("run_success"), /EEXIST/);
  });

  it("requires explicit workspace selection before any remote allocation", async () => {
    let effects = 0;
    await assert.rejects(HerdrPlacedRunOwner.create({ ...machine, workspaceId: undefined }, "run_no_workspace", undefined, {
      async createRuntime() { effects++; return "/remote/runtime"; },
    }), /explicitly selected workspaceId/);
    assert.equal(effects, 0);
    assert.equal(fs.existsSync(path.join(root, "tau-subagents")), false);
  });

  it("does not infer a workspace from cwd or labels, nor create a fallback workspace", async () => {
    const { owner, calls } = await fixture("run_foreign", { call(method, _params, fallback) {
      return method === "session.snapshot" ? { type: "session_snapshot", snapshot: { ...snapshot, workspaces: [{ workspace_id: "foreign", label: "tau-subagents-repo" }] } } : fallback();
    } });
    await assert.rejects(owner.provision(), /missing or ambiguous/);
    assert.deepEqual(calls.map(({ method }) => method), ["session.snapshot"]);
    await owner.cleanup();
  });

  it("retains unacknowledged runtime effects and blocks reuse after a failed creation", async () => {
    let effects = 0;
    const remote = path.join(root, "unacknowledged-runtime");
    const attempt = () => HerdrPlacedRunOwner.create(machine, "run_lost_runtime", undefined, {
      async createRuntime() { effects++; fs.mkdirSync(remote); throw new Error("lost runtime acknowledgement"); },
    });
    await assert.rejects(attempt(), /runtime identity unacknowledged/);
    await assert.rejects(attempt(), /EEXIST/);
    assert.equal(effects, 1);
    assert.equal(fs.statSync(remote).isDirectory(), true);
    assert.deepEqual(records(journalPath("run_lost_runtime")).map((record) => record.phase), ["runtime-intent", "creation-failed"]);
  });

  it("retains the runtime when connection or preflight preparation fails", async () => {
    for (const stage of ["connection", "preflight"]) {
      const runId = `run_fail_${stage}`, runtime = path.join(root, runId);
      let closes = 0;
      await assert.rejects(HerdrPlacedRunOwner.create(machine, runId, async () => { throw new Error("preflight failed"); }, {
        async createRuntime() { fs.mkdirSync(runtime); return runtime; },
        async connect() {
          if (stage === "connection") throw new Error("connection failed");
          return { endpoint, async close() { closes++; } } as HerdrForwardedConnection;
        },
      }), /any remote runtime\/effects are retained/);
      assert.equal(closes, stage === "connection" ? 0 : 1);
      assert.equal(fs.statSync(runtime).isDirectory(), true);
      assert.equal(records(journalPath(runId)).at(-1).details.runtimeDir, runtime);
    }
  });

  it("keeps partial/mismatched allocation identities and never retries or rolls back", async () => {
    const { owner, calls } = await fixture("run_partial", { call(method, _params, fallback) {
      return method === "tab.create" ? { ...created, root_pane: { ...currentPane, workspace_id: "wrong" } } : fallback();
    } });
    await assert.rejects(owner.provision(), /mismatched pane identity/);
    assert.equal(records(owner.journalPath).at(-1).details["root_pane.pane_id"], "new-pane");
    await assert.rejects(owner.provision(), /already attempted/);
    await owner.cleanup();
    assert.deepEqual(calls.map(({ method }) => method), ["session.snapshot", "tab.create"]);
  });

  it("returns received IDs when receipt persistence fails, retaining a blocking operation", async () => {
    const { owner, calls, closes } = await fixture("run_write_failed", { call(method, _params, fallback) {
      if (method === "tab.create") {
        const response = fallback();
        fs.mkdirSync(path.join(journalPath("run_write_failed"), "004.json"));
        return response;
      }
      return fallback();
    } });
    await assert.rejects(owner.provision(), /new-pane.*persistence failed/);
    await assert.rejects(owner.cleanup(), /transport release failed/);
    assert.equal(closes(), 1);
    assert.equal(fs.statSync(path.join(owner.journalPath, "004.json")).isDirectory(), true);
    assert.equal(fs.existsSync(lockPath(herdrPaneAllocationKey(machine.target, null, "chosen"))), true);
    assert.equal(calls.some(({ method }) => /close|start/.test(method)), false);
  });

  it("does not write into a replacement journal directory after an awaited effect", async () => {
    const original = journalPath("run_replaced");
    const { owner, closes } = await fixture("run_replaced", { call(method, _params, fallback) {
      const response = fallback();
      if (method === "tab.create") {
        fs.renameSync(original, `${original}.retained`);
        fs.mkdirSync(original, { mode: 0o700 });
        fs.writeFileSync(path.join(original, "foreign"), "untouched");
      }
      return response;
    } });
    await assert.rejects(owner.provision(), /new-terminal.*persistence failed/);
    await assert.rejects(owner.cleanup(), /transport release failed/);
    assert.equal(closes(), 1);
    assert.deepEqual(fs.readdirSync(original), ["foreign"]);
    assert.equal(records(`${original}.retained`).at(-1).phase, "pane-intent");
  });

  it("does not retry even apparently transient start failures or close the pane", async () => {
    const { owner, calls, runtime } = await fixture("run_start_failure", { call(method, _params, fallback) {
      if (method === "agent.start") throw new Error("is not an available shell");
      return fallback();
    } });
    await owner.provision();
    await assert.rejects(owner.start("codex", "fixture-agent", []), /not an available shell/);
    await assert.rejects(owner.start("codex", "fixture-agent", []), /no automatic retry/);
    await owner.cleanup();
    assert.equal(calls.filter(({ method }) => method === "agent.start").length, 1);
    assert.equal(calls.some(({ method }) => method === "pane.close"), false);
    assert.equal(fs.existsSync(runtime), true);
  });

  for (const field of ["pane_id", "terminal_id", "workspace_id", "tab_id", "agent", "agent_session"]) {
    it(`refuses startup when ${field} changes before dispatch`, async () => {
      const { owner, calls } = await fixture(`run_drift_${field}`, { call(method, _params, fallback) {
        return method === "pane.get" ? { type: "pane_info", pane: { ...currentPane, [field]: "foreign" } } : fallback();
      } });
      await owner.provision();
      await assert.rejects(owner.start("pi", "fixture-agent", []), /identity or occupancy changed/);
      assert.equal(calls.some(({ method }) => method === "agent.start"), false);
      await owner.cleanup();
    });
  }

  it("retains foreign start receipts without granting them ownership", async () => {
    const { owner, calls } = await fixture("run_wrong_start", { call(method, _params, fallback) {
      return method === "agent.start" ? { type: "agent_started", agent: { terminal_id: "foreign-terminal", pane_id: "foreign-pane" } } : fallback();
    } });
    await owner.provision();
    await assert.rejects(owner.start("pi", "fixture-agent", []), /unexpected pane\/terminal/);
    assert.equal(owner.terminalId, undefined);
    assert.equal(records(owner.journalPath).at(-1).details["agent.terminal_id"], "foreign-terminal");
    await owner.cleanup();
    assert.equal(calls.some(({ method }) => /close/.test(method)), false);
  });

  it("preserves transport release failures and never treats disconnect as settlement", async () => {
    const { owner, closes } = await fixture("run_cleanup_failure", { async close() { throw new Error("local close failed"); } });
    const failures = await Promise.allSettled([owner.cleanup(), owner.cleanup()]);
    assert.equal(failures.every((result) => result.status === "rejected"), true);
    assert.equal(closes(), 1);
    assert.equal(owner.snapshot.connection, "unknown");
    assert.equal(owner.snapshot.state, "unknown");
    assert.equal(records(owner.journalPath).at(-1).details.remoteSettlement, "unknown");
  });

  it("uses idle/done as readiness only and ignores foreign pane events", async () => {
    const { owner } = await fixture("run_status");
    await owner.provision(); await owner.start("pi", "fixture-agent", []); owner.journal(identity(owner));
    owner.observeEvent({ data: { pane_id: "new-pane", terminal_id: "foreign", agent_status: "working" } });
    assert.equal(owner.snapshot.state, "ready");
    for (const state of ["idle", "done"]) {
      owner.observeEvent({ data: { pane_id: "new-pane", terminal_id: "new-terminal", agent_status: state } });
      assert.equal(owner.snapshot.state, "ready");
      const result = reconcileHerdrPlacedRun(identity(owner), { endpoint, bridge: {}, agents: [{ terminal_id: "new-terminal", pane_id: "new-pane", agent_status: state }] }, () => ({ ok: true, cursor: 0 }));
      assert.equal(result.ok && result.state, "ready");
    }
    await owner.cleanup();
  });

  it("does not claim that external abort or quiet terminal output proves stopped writers", async () => {
    const { owner, calls } = await fixture("run_external");
    await owner.provision(); await owner.start("codex", "fixture-agent", []);
    const launch = createHerdrExternalAdapterLaunch({ adapter: "codex-exec", remoteRuntimeDir: owner.runtimeDir });
    assert.equal(launch.capabilities.stop, false);
    const session = new HerdrExternalSession(owner, launch, {} as never);
    await assert.rejects(session.abort(), /stop is unverified/);
    await session.dispose();
    assert.equal(calls.some(({ method }) => method === "pane.close"), false);
    let now = 0, stops = 0;
    const sample = { workspaceId: "chosen", paneId: "new-pane", terminalId: "new-terminal", pid: 123 };
    const result = await monitorHerdrCodex({ machineId: machine.id, task: "explain", preSubmitText: "› Ask anything", identity: sample,
      async snapshot() { return { ...sample, at: now, text: "› explain\nResult\n› Ask anything", source: "recent_unwrapped" }; },
      clock: { now: () => now, async wait(ms) { now += ms; } },
      ...{ async stop() { stops++; } },
    });
    assert.equal(stops, 0);
    assert.match(result.output, /Result/);
    const normalized = createHerdrExternalAdapter("codex-exec").normalize({ runId: "r", requestId: "q", task: "explain", cwd: "/remote/repo", nativeSessionId: launch.nativeSessionId }, result.output);
    assert.equal(normalized.outcome, "partial");
    assert.equal(normalized.settlement?.verification, "best-effort/unverified");
  });

  it("does not dispatch a start after transport release wins an awaited identity check", async () => {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const { owner, calls } = await fixture("run_release_race", { async call(method, _params, fallback) {
      if (method === "pane.get") { entered(); await barrier; }
      return fallback();
    } });
    await owner.provision();
    const start = owner.start("pi", "fixture-agent", []);
    await waiting; await owner.cleanup(); release();
    await assert.rejects(start, /transport released before start/);
    assert.equal(calls.some(({ method }) => method === "agent.start"), false);
    assert.throws(() => owner.runRemote("never execute"), /remote commands are blocked/);
    let closes = 0, unsubscribes = 0;
    await assert.rejects(owner.replaceConnection({ connection: { endpoint, async close() { closes++; } } as HerdrForwardedConnection,
      unsubscribe() { unsubscribes++; }, paneId: "new-pane", state: "ready" }), /not adopted/);
    assert.deepEqual({ closes, unsubscribes }, { closes: 1, unsubscribes: 1 });
    assert.equal(owner.snapshot.connection, "closed");
  });

  it("keeps bridge runtime evidence on shutdown and refuses to replace an existing manifest", async () => {
    const runtime = path.join(root, "bridge-runtime"); fs.mkdirSync(runtime);
    const previous = [process.env[HERDR_PI_RUN_ENV], process.env[HERDR_PI_RUNTIME_DIR_ENV]];
    process.env[HERDR_PI_RUN_ENV] = "run_bridge_retained"; process.env[HERDR_PI_RUNTIME_DIR_ENV] = runtime;
    const handlers = new Map<string, Function>();
    const pi = { registerTool() {}, registerCommand() {}, on(name: string, handler: Function) { handlers.set(name, handler); } };
    let shutdown = false;
    try {
      registerHerdrPiBridge(pi as never);
      const deadline = Date.now() + 2_000;
      while (!fs.existsSync(path.join(runtime, "bridge.sock")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(fs.existsSync(path.join(runtime, "bridge.sock")), true);
      fs.writeFileSync(path.join(runtime, "manifest.json"), "retained manifest");
      handlers.get("session_shutdown")!(); shutdown = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(fs.readFileSync(path.join(runtime, "manifest.json"), "utf8"), "retained manifest");
      assert.throws(() => registerHerdrPiBridge(pi as never), /Existing Herdr bridge evidence/);
      assert.equal(fs.readFileSync(path.join(runtime, "manifest.json"), "utf8"), "retained manifest");
    } finally {
      if (!shutdown) handlers.get("session_shutdown")?.();
      for (const [index, key] of [HERDR_PI_RUN_ENV, HERDR_PI_RUNTIME_DIR_ENV].entries()) {
        previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index];
      }
    }
  });

  it("bounds journal records and refuses symlink, legacy and repeated ownership", () => {
    const journal = new HerdrPlacementJournal(machine, "run_journal_bound");
    assert.throws(() => journal.append("oversized", { text: "x".repeat(64 * 1024) }), /byte limit/);
    assert.throws(() => journal.append("retry"), /uncertain/);
    assert.equal(records(journal.directory).length, 1);
    assert.throws(() => new HerdrPlacementJournal(machine, "run_journal_bound"), /EEXIST/);
    const directory = herdrPrivateDirectory("herdr-run-journal");
    fs.writeFileSync(path.join(directory, "run_legacy.json"), "{}");
    assert.throws(() => new HerdrPlacementJournal(machine, "run_legacy"), /manual reconciliation/);
    fs.symlinkSync(root, path.join(directory, "run_symlink"));
    assert.throws(() => new HerdrPlacementJournal(machine, "run_symlink"), /EEXIST/);
    const limited = new HerdrPlacementJournal(machine, "run_journal_limit");
    for (let i = 1; i < 128; i++) limited.append("observation");
    assert.throws(() => limited.append("overflow"), /record limit/);
  });

  it("serializes workspace capacity across different cwds and keeps the original storage namespace", async () => {
    const panes = Array.from({ length: 19 }, (_, index) => ({ workspace_id: "chosen", pane_id: `p${index}`, terminal_id: `term${index}` }));
    let creates = 0;
    const call = async (method: string, _params: Record<string, unknown>, fallback: () => unknown) => {
      if (method === "session.snapshot") return { type: "session_snapshot", snapshot: { ...snapshot, panes: [...panes] } };
      if (method === "tab.create") { creates++; panes.push(currentPane); await new Promise((resolve) => setTimeout(resolve, 15)); return fallback(); }
      return fallback();
    };
    const a = await fixture("run_cap_a", { call });
    const b = await fixture("run_cap_b", { call, selected: { ...machine, cwd: "/remote/other" } });
    const otherRoot = path.join(root, "changed-storage");
    fs.mkdirSync(otherRoot, { mode: 0o700 }); process.env.PI_CODING_AGENT_DIR = otherRoot;
    const results = await Promise.allSettled([a.owner.provision(), b.owner.provision()]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && /pane limit of 20/.test(String(result.reason))).length, 1);
    assert.equal(creates, 1);
    assert.equal(fs.existsSync(path.join(otherRoot, "tau-subagents")), false);
    await a.owner.cleanup(); await b.owner.cleanup();
  });

  it("never reclaims a dead local lock holder and releases a settled holder normally", async (t) => {
    const key = herdrPaneAllocationKey(machine.target, "default", "chosen");
    assert.equal(key, herdrPaneAllocationKey(machine.target, null, "chosen"));
    const child = fork(fileURLToPath(new URL("../support/herdr-allocation-child.mjs", import.meta.url)), [key, "1000"], {
      execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const [ready] = await once(child, "message");
    assert.equal(ready.state, "locked");
    const before = fs.readFileSync(lockPath(key), "utf8");
    const ended = once(child, "exit"); child.kill("SIGKILL"); await ended;
    let entered = false;
    await assert.rejects(withHerdrPaneAllocationLock(key, async () => { entered = true; }, { timeoutMs: 20, pollMs: 5 }), /no PID reclamation/);
    assert.equal(entered, false);
    assert.equal(fs.readFileSync(lockPath(key), "utf8"), before);
    assert.equal(await withHerdrPaneAllocationLock("independent", async () => 42), 42);
    assert.equal(fs.existsSync(lockPath("independent")), false);
  });

  it("refuses malformed, oversized, symlink and interrupted-recovery lock evidence", async () => {
    const directory = herdrPrivateDirectory("herdr-allocation-locks");
    for (const kind of ["malformed", "oversized", "symlink", "recovery"]) {
      const file = lockPath(kind), recovery = file.replace(/\.lock$/, ".recovery");
      if (kind === "symlink") fs.symlinkSync(root, file);
      else if (kind === "recovery") fs.writeFileSync(recovery, "retained");
      else fs.writeFileSync(file, kind === "malformed" ? "{}" : "x".repeat(4097), { mode: 0o600 });
      let entered = false;
      await assert.rejects(withHerdrPaneAllocationLock(kind, async () => { entered = true; }, { timeoutMs: 10, pollMs: 5 }), /unsafe|malformed|reconciliation/);
      assert.equal(entered, false);
      assert.equal(fs.lstatSync(kind === "recovery" ? recovery : file) !== undefined, true);
    }
    assert.equal(fs.readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
  });

  it("does not remove evidence from replacement allocation directories", async () => {
    const directory = herdrPrivateDirectory("herdr-allocation-locks");
    await assert.rejects(withHerdrPaneAllocationLock("directory-replaced", async () => {
      fs.renameSync(directory, `${directory}.retained`);
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.writeFileSync(path.join(directory, "foreign"), "untouched");
    }), /allocation and temporary-link release failed/);
    assert.deepEqual(fs.readdirSync(directory), ["foreign"]);
    assert.equal(fs.existsSync(path.join(`${directory}.retained`, path.basename(lockPath("directory-replaced")))), true);
  });

  it("retains uncertain action locks, falsy errors and foreign replacement generations", async () => {
    let rejected = false;
    try { await withHerdrPaneAllocationLock("falsy", async () => Promise.reject(undefined)); } catch (error) { rejected = true; assert.equal(error, undefined); }
    assert.equal(rejected, true);
    assert.equal(fs.existsSync(lockPath("falsy")), true);
    const failure = new Error("remote effect uncertain");
    await assert.rejects(withHerdrPaneAllocationLock("replacement", async () => {
      fs.unlinkSync(lockPath("replacement"));
      fs.writeFileSync(lockPath("replacement"), JSON.stringify({ pid: process.pid, token: "b".repeat(32) }), { mode: 0o600 });
      throw failure;
    }), (error) => error instanceof AggregateError && error.cause === failure && error.errors[0] === failure && /ownership changed/.test(String(error.errors[1])));
    assert.equal(JSON.parse(fs.readFileSync(lockPath("replacement"), "utf8")).token, "b".repeat(32));
  });
});
