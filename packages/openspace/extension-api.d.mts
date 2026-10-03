export type SessionStatus = { state: "idle" | "thinking"; note?: string }
  | { state: "tool"; toolName: string; note?: string };
export interface ContextUsage { tokens: number | null; contextWindow: number; percent: number | null }
export interface SessionInfo {
  id: string; endpointEpoch: string; revision: number; membershipRevision: number;
  workgroups: string[]; name?: string; runtimeFallbackAlias?: string;
  cwd: string; model: string; pid: number; startedAt: number; lastActivity: number;
  status?: SessionStatus; contextUsage?: ContextUsage; tmuxPane?: string; trustedLocal: true;
}
export declare const OPENSPACE_EXTENSION_REGISTER_EVENT: "openspace:extension-register";
export declare const OPENSPACE_EXTENSION_REGISTRY_READY_EVENT: "openspace:extension-registry-ready";
export declare const OPENSPACE_EXTENSION_FEATURE: "extension-bus-v1";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface ChannelOwner { id: string; endpointEpoch: string; epoch: string }
export interface ChannelState { revision: number; updatedAt: number; payload: JsonValue; recovered?: true }
export interface ChannelSnapshot { connected: boolean; supported: boolean; owner?: ChannelOwner; state?: ChannelState }
export interface PublishResult { written: number; failed: number; unknown: number }
export type ChannelEvent =
  | { type: "connection"; snapshot: ChannelSnapshot; code?: string }
  | { type: "owner"; owner?: ChannelOwner }
  | { type: "state"; state: ChannelState }
  | { type: "message"; sender: SessionInfo; payload: JsonValue }
  | { type: "peer"; change: "joined" | "updated" | "left"; session: SessionInfo }
  | { type: "state_result"; requestId: string; status: "committed" | "rejected" | "unknown"; state?: ChannelState; code?: string }
  | { type: "error"; code: string };
export interface ExtensionChannel {
  readonly namespace: string;
  readonly workgroup: string;
  snapshot(): ChannelSnapshot;
  /** Non-durable, no replay. Audience capable includes this sender: avoid echo loops. */
  publish(payload: JsonValue, options: { audience: "owner" | "capable"; ownerOnly?: boolean }): Promise<PublishResult>;
  /** A returned ID correlates state_result; it is not an acknowledgement of persistence. */
  commitState(payload: JsonValue, expectedRevision?: number): string;
  listSessions(): Promise<SessionInfo[]>;
}
export interface ExtensionRegistration {
  namespace: string;
  workgroup?: string;
  ownerEligible: boolean;
  onReady(channel: ExtensionChannel): void;
  onEvent(event: ChannelEvent): void;
}
export interface ExtensionRegistryReady { version: 1 }

export declare const OPENSPACE_OUTBOX_REQUEST_EVENT: "openspace:outbox-request";
export declare const OPENSPACE_OUTBOX_RESULT_EVENT: "openspace:outbox-result";
export declare const OPENSPACE_SESSION_IDENTITY_EVENT: "openspace:session-identity";
export declare const OPENSPACE_OUTBOX_CODES: Readonly<{
  invalidRequest: "invalid_outbox_request"; duplicateRequest: "duplicate_request";
  idCapacity: "outbox_id_capacity"; pendingCapacity: "outbox_pending_capacity";
  unavailable: "openspace_unavailable"; confirmationUnavailable: "confirmation_unavailable";
  confirmationCancelled: "confirmation_cancelled"; sessionEnded: "session_ended";
}>;
export interface OutboxRequest {
  version: 1;
  /** Unique across all producers in this runtime. Reuse is an error, never an idempotent retry. */
  requestId: string;
  extensionId: string;
  extensionName: string;
  to: string;
  workgroup?: string;
  message: string;
}
export interface OutboxResult {
  version: 1; requestId: string; status: "sent" | "rejected" | "blocked" | "failed";
  code?: string; detail?: string; extensionId?: string; extensionName?: string;
  messageId?: string; to?: string; workgroup?: string;
  delivery?: "socket_delivered" | "queued" | "failed" | "unknown";
  outcomeKnown?: boolean;
}
export interface SessionIdentityRequest {
  version: 1;
  /** First valid synchronous claim wins. Calls after emit returns have no effect. Does not change the session name. */
  claim(id: string): boolean;
}
