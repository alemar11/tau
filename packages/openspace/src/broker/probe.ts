import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { FrameDecoder, writeFrame } from "../protocol/framing.ts";
import { envelope, isHealth, type Health } from "../protocol/messages.ts";

export type ProbeResult = { status: "ready"; health: Health } | { status: "absent" }
  | { status: "occupied"; reason: string };

/** Absence is positive OS evidence, not a timeout or an unexpected response. */
export function probeBroker(socketPath: string, timeoutMs = 300): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const id = randomUUID();
    const decoder = new FrameDecoder();
    let settled = false;
    const timer = setTimeout(() => finish({ status: "occupied", reason: "health timeout" }), timeoutMs);
    function finish(result: ProbeResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    }
    socket.on("connect", () => {
      try { writeFrame(socket, envelope("health", id)); }
      catch { finish({ status: "occupied", reason: "health write failed" }); }
    });
    socket.on("data", (bytes: Buffer) => {
      try {
        decoder.push(bytes, (message) => {
          finish(isHealth(message, id) ? { status: "ready", health: message }
            : { status: "occupied", reason: "incompatible Openspace health response" });
          return false;
        });
      } catch { finish({ status: "occupied", reason: "malformed health response" }); }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? { status: "absent" }
        : { status: "occupied", reason: `health connection failed (${error.code ?? "unknown"})` });
    });
    socket.on("close", () => finish({ status: "occupied", reason: "health connection closed" }));
  });
}
