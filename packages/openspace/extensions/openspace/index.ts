import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, loadEnvironment } from "../../src/config.ts";
import { resolvePaths } from "../../src/paths.ts";

export default function openspace(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const env = { ...process.env };
    const paths = resolvePaths(env);
    const config = loadConfig(paths.configPath);
    if (!config.enabled) return;
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new Error("Openspace supports macOS and Linux only");
    }
    // Foundation only: validate startup inputs, without claiming a live broker or tools.
    loadEnvironment(env);
  });
}
