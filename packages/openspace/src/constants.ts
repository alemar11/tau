export const OPENSPACE_NAMESPACE = "openspace";
export const OPENSPACE_PROTOCOL_VERSION = 1;
export const STATUS_NOTE_MAX_BYTES = 1024;

export const OPENSPACE_ENV = {
  stableId: "PI_OPENSPACE_STABLE_ID",
  workgroups: "PI_OPENSPACE_WORKGROUPS",
  askTimeoutMs: "PI_OPENSPACE_ASK_TIMEOUT_MS",
  livenessIntervalMs: "PI_OPENSPACE_LIVENESS_INTERVAL_MS",
  livenessTimeoutMs: "PI_OPENSPACE_LIVENESS_TIMEOUT_MS",
} as const;
