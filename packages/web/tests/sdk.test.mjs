import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installWeb } from "../extensions/web/index.ts";
import { parseConfig } from "../extensions/web/config.ts";
import { reply, page } from "./helpers.mjs";

const names = ["fetch_web_content", "get_cached_web_content", "web_search"];
for (const relative of ["../", "../../../"]) test(`Pi resource loader discovers exactly the three tools from ${relative === '../' ? 'the standalone package' : 'the root bundle'}`, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tau-web-loader-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir; });
  const path = fileURLToPath(new URL(relative, import.meta.url));
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory({ packages: [path] }), noSkills: true, noPromptTemplates: true, noContextFiles: true });
  await loader.reload();
  const loaded = loader.getExtensions(); assert.deepEqual(loaded.errors, []);
  const web = loaded.extensions.find((e) => e.tools.has("web_search")); assert.ok(web);
  assert.deepEqual([...web.tools.keys()].sort(), names);
  assert.equal(loaded.extensions.filter((e) => e.resolvedPath.includes("packages/web/")).length, 1);
  for (const tool of web.tools.values()) {
    assert.equal(tool.definition.defaultActive, true); assert.equal(tool.definition.exposure, "direct");
  }
});
test("real SDK headless session executes fetch/cache through registered tools and respects host selection", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tau-web-sdk-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let requests = 0;
  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noSkills: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [(pi) => installWeb(pi, { agentDir: dir, config: parseConfig(), transport: async (url) => { requests++; return reply(page, { type: "text/html", url }); } })] });
  await loader.reload();
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, settingsManager: settings, sessionManager: SessionManager.inMemory(dir), resourceLoader: loader });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "json" });
  assert.ok(names.every((name) => session.getActiveToolNames().includes(name)));
  const tool = (name) => session.agent.state.tools.find((t) => t.name === name);
  const fetched = await tool("fetch_web_content").execute("fetch", { url: "https://example.com/doc" }, new AbortController().signal);
  assert.equal(fetched.isError, undefined);
  const id = fetched.structuredContent.data.responseId;
  const cached = await tool("get_cached_web_content").execute("cache", { responseId: id }, new AbortController().signal);
  assert.match(cached.structuredContent.data.text, /Solar energy/); assert.equal(requests, 1);
  session.setActiveToolsByName(["get_cached_web_content"]);
  assert.deepEqual(session.getActiveToolNames(), ["get_cached_web_content"]);
});
