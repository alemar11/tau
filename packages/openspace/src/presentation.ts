import type { SessionInfo } from "./registry/session.ts";

/** Display escaping only; never mutate message content or routing identity. No Pi runtime imports. */
export const terminalSafe = (text: string): string => text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\ud800-\udfff]/gu,
  (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
export const singleLine = (text: string): string => terminalSafe(text).replace(/\n/g, "\\n");
export function shortId(id: string, peers: Pick<SessionInfo, "id">[]): string {
  let length = Math.min(8, id.length);
  while (length < id.length && peers.some((peer) => peer.id !== id && peer.id.startsWith(id.slice(0, length)))) length++;
  if (length < id.length && /[\ud800-\udbff]/.test(id[length - 1]) && /[\udc00-\udfff]/.test(id[length])) length++;
  return id.slice(0, length);
}
