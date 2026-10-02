import { dirname, resolve } from "node:path";
import { resolvePaths } from "../paths.ts";
import { startBroker, type Broker } from "./server.ts";
import { prepareRuntime } from "./runtime-files.ts";

// A detached broker can outlive the caller that collected startup diagnostics.
process.stderr.on("error", () => {});
let broker: Broker | undefined;
let stopping = false;
const stop = () => { stopping = true; if (broker) void broker.stop(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  const [flag, directory, ...extra] = process.argv.slice(2);
  if (flag !== "--runtime-dir" || !directory || extra.length) throw new Error("Expected --runtime-dir <openspace directory>");
  const paths = resolvePaths({ PI_CODING_AGENT_DIR: dirname(resolve(directory)) });
  if (paths.runtimeDir !== resolve(directory)) throw new Error("Runtime directory must be named openspace");
  prepareRuntime(paths);
  process.chdir(paths.runtimeDir);
  broker = await startBroker(paths);
  if (stopping) await broker.stop();
  await broker.closed;
} catch (error) {
  process.stderr.write(`Openspace broker: ${error instanceof Error ? error.message : "startup failed"}\n`);
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
