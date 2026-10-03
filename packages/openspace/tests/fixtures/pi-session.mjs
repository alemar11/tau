import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { installOpenspace } from "../../extensions/openspace/index.ts";
import { loadConfig } from "../../src/config.ts";

let serial = 0;
export async function piSession(fixture, options = {}) {
  const dir = join(fixture.root, `pi-${++serial}`); mkdirSync(dir);
  const requests = [], notifications = [], errors = [];
  const gate = { hold: false };
  const provider = `openspace-fixture-${serial}`;
  let runtime, api;
  const env = { ...fixture.env, ...options.env };
  const config = { ...loadConfig(join(dir, "missing.json")), ...options.config };
  const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noSkills: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: options.extensionPaths, additionalThemePaths: options.themePaths,
    extensionFactories: [(pi) => {
      api = pi;
      pi.registerProvider(provider, { api: "openai-completions", baseUrl: "http://127.0.0.1:1/not-used", apiKey: "fixture-not-a-secret",
        models: [{ id: "local", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
        streamSimple(model, context, options) {
          const stream = createAssistantMessageEventStream();
          const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: "fixture complete" }],
            usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
          const call = gate.calls?.shift();
          if (call) { output.content = [{ type: "toolCall", ...call }]; output.stopReason = "toolUse"; }
          let done = false;
          const release = () => {
            if (done) return; done = true; options?.signal?.removeEventListener("abort", abort);
            stream.push({ type: "start", partial: output });
            if (gate.fail) stream.push({ type: "error", reason: "error", error: { ...output, stopReason: "error", errorMessage: "fixture provider failure" } });
            else stream.push({ type: "done", reason: output.stopReason, message: output });
            stream.end();
          };
          const abort = () => { if (done) return; done = true; stream.push({ type: "error", reason: "aborted", error: { ...output, stopReason: "aborted" } }); stream.end(); };
          options?.signal?.addEventListener("abort", abort, { once: true });
          requests.push({ context: structuredClone(context), release });
          if (options?.signal?.aborted) abort(); else if (!gate.hold) queueMicrotask(release);
          return stream;
        },
      });
      installOpenspace(pi, { env, config, onRuntime: (next) => { runtime = next; } });
      options.extend?.(pi);
    }, ...(options.factories ?? [])] });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const manager = options.manager ?? SessionManager.inMemory(dir);
  const services = { cwd: options.cwd ?? dir, agentDir: dir, modelRuntime, settingsManager: settings, resourceLoader: loader, diagnostics: [] };
  const created = await createAgentSession({ ...services, sessionManager: manager, sessionStartEvent: options.sessionStartEvent, tools: ["openspace"] });
  const { session } = created;
  await session.setModel(modelRuntime.getModel(provider, "local"));
  session.subscribe((event) => { if (event.type === "extension_error") errors.push(event); });
  const mode = options.mode ?? "tui";
  await session.bindExtensions({ mode, uiContext: mode === "tui" || mode === "rpc" ? { notify: (text, kind) => notifications.push({ text, kind }),
    confirm: options.confirm ?? (async () => { throw new Error("Unexpected confirmation"); }), ...options.ui } : undefined, onError: (error) => errors.push(error) });
  await runtime.controller.ensureConnected();
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await session.abort(); session.dispose();
  };
  if (options.cleanup !== false) fixture.cleanup(close);
  return { result: { ...created, services, diagnostics: [] }, session, manager, get runtime() { return runtime; }, get api() { return api; }, requests, gate, notifications, errors, env, config, close,
    tool: (params, signal = new AbortController().signal) => session.agent.state.tools.find((tool) => tool.name === "openspace").execute("test", params, signal),
    history: () => session.messages.filter((message) => message.role === "custom" && message.customType === "openspace_message") };
}
