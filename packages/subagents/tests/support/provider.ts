import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Deterministic local provider: no sockets, keys, CLI or network. Loaded by the real SDK. */
export default function fixtureProvider(pi: ExtensionAPI) {
	pi.registerProvider("tau-fixture", {
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1/not-used",
		apiKey: "fixture-not-a-secret",
		models: [{ id: "local", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 1000 }],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				const contextText = JSON.stringify(context);
				const gate = contextText.match(/TAU_FIXTURE_GATE:([^\s"\\]+)/)?.[1];
				const writePath = contextText.match(/TAU_FIXTURE_WRITE:([^\s"\\]+)/)?.[1];
				const sendsTool = Boolean(writePath && !context.messages.some((message) => message.role === "toolResult"));
				const tools = getCurrentTools(context.messages);
				const hasWeb = ["web_search", "fetch_web_content", "get_cached_web_content"].every((name) => tools.some((tool) => tool.name === name));
				const output: AssistantMessage = {
					role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
					content: [{ type: "text" as const, text: `fixture complete${contextText.includes("FIXTURE_PROJECT_INSTRUCTION") ? "; project context present" : ""}${gate ? `; gate=${path.basename(gate)}` : ""}${hasWeb ? "; web tools present" : ""}` }],
					usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop" as const, timestamp: Date.now(),
				};
				if (sendsTool) {
					output.content = [{ type: "toolCall", id: "fixture-write", name: "write", arguments: { path: writePath, content: "unauthorized mutation" } }];
					output.stopReason = "toolUse";
				}
				try {
					if (gate) {
						fs.writeFileSync(`${gate}.entered`, String(process.pid));
						while (!fs.existsSync(`${gate}.release`)) await delay(20, undefined, { signal: options?.signal });
					}
					stream.push({ type: "start", partial: output });
					stream.push({ type: "done", reason: sendsTool ? "toolUse" : "stop", message: output });
				} catch (error) {
					const reason = options?.signal?.aborted ? "aborted" as const : "error" as const;
					stream.push({ type: "error", reason, error: { ...output, stopReason: reason, errorMessage: String(error) } });
				} finally { stream.end(); }
			});
			return stream;
		},
	});
}
