/*
MIT License

Copyright (c) 2026 Nico Bailon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OPENSPACE_NAMESPACE } from "./constants.ts";

export interface OpenspacePaths {
  readonly agentDir: string;
  readonly runtimeDir: string;
  readonly configPath: string;
  readonly socketPath: string;
}

/** Resolve once per runtime; this function never reads or creates runtime files. */
export function resolvePaths(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  home: string = homedir(),
  cwd: string = process.cwd(),
): OpenspacePaths {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  let location = configured || join(home, ".pi", "agent");
  // Match Pi 0.99.1's agent-directory inputs without importing Pi into the core.
  if (location === "~") location = home;
  else if (location.startsWith("~/")) location = join(home, location.slice(2));
  else if (location.startsWith("file://")) {
    try {
      location = fileURLToPath(location);
    } catch (error) {
      throw new Error("PI_CODING_AGENT_DIR must be a valid local file URL", { cause: error });
    }
  }
  const agentDir = resolve(cwd, location);
  if (agentDir.includes("\0")) throw new Error("PI_CODING_AGENT_DIR must not contain NUL");
  const runtimeDir = join(agentDir, OPENSPACE_NAMESPACE);
  return Object.freeze({
    agentDir,
    runtimeDir,
    configPath: join(runtimeDir, "config.json"),
    socketPath: join(runtimeDir, "broker.sock"),
  });
}
