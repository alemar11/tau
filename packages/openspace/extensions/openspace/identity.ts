import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OPENSPACE_SESSION_IDENTITY_EVENT, type SessionIdentityRequest } from "../../extension-api.mjs";
import { MAX_SESSION_BYTES, text } from "../../src/registry/session.ts";

export function claimIdentity(events: ExtensionAPI["events"]): string | undefined {
  let open = true, claimed: string | undefined;
  const request: SessionIdentityRequest = { version: 1, claim(value) {
    if (!open || claimed !== undefined) return false;
    try {
      const id = text(value);
      if (Buffer.byteLength(JSON.stringify(id)) > MAX_SESSION_BYTES) return false;
      claimed = id; return true;
    } catch { return false; }
  } };
  try { events.emit(OPENSPACE_SESSION_IDENTITY_EVENT, Object.freeze(request)); }
  finally { open = false; }
  return claimed;
}
