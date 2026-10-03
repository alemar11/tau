/** Pure runtime constants: importing this API does not load Pi, a socket or a TypeScript loader. */
export const OPENSPACE_EXTENSION_REGISTER_EVENT = "openspace:extension-register";
export const OPENSPACE_EXTENSION_REGISTRY_READY_EVENT = "openspace:extension-registry-ready";
export const OPENSPACE_EXTENSION_FEATURE = "extension-bus-v1";
export const OPENSPACE_OUTBOX_REQUEST_EVENT = "openspace:outbox-request";
export const OPENSPACE_OUTBOX_RESULT_EVENT = "openspace:outbox-result";
export const OPENSPACE_SESSION_IDENTITY_EVENT = "openspace:session-identity";
export const OPENSPACE_OUTBOX_CODES = Object.freeze({
  invalidRequest: "invalid_outbox_request", duplicateRequest: "duplicate_request",
  idCapacity: "outbox_id_capacity", pendingCapacity: "outbox_pending_capacity",
  unavailable: "openspace_unavailable", confirmationUnavailable: "confirmation_unavailable",
  confirmationCancelled: "confirmation_cancelled", sessionEnded: "session_ended",
});
