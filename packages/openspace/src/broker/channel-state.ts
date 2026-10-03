import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ChannelState, JsonValue } from "../../extension-api.mjs";
import { CHANNEL_LIMITS, channelGroup, channelKey, channelState, jsonPayload, namespace, revision } from "../protocol/channels.ts";
import { atomicLeaseWrite } from "../registry/leases.ts";
import { keys, object, RegistryError } from "../registry/session.ts";
import { identity, sameFile, unlinkOwned } from "./runtime-files.ts";

export const STATE_LIMITS = { records: 1024, bytes: 32 * 1024 * 1024, fileBytes: CHANNEL_LIMITS.stateBytes + 8 * 1024 } as const;
export const stateHash = (workgroup: string, ns: string): string => createHash("sha256").update(channelKey(workgroup, ns)).digest("hex");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function encodeState(workgroup: string, namespace: string, state: ChannelState): string {
  const body = { version: 1, workgroup, namespace, ...state };
  return JSON.stringify({ body, checksum: digest(JSON.stringify(body)) });
}
const FILE = /^([a-f0-9]{64})\.(json|bak)$/;
const TEMP = /^[a-f0-9]{64}\.(json|bak)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/;
interface Stored { workgroup: string; namespace: string; state: ChannelState; data: string; primaryBytes: number; backupBytes: number }
interface ReadFile { data?: string; bytes: number }
export interface StateOptions { now?: () => number; maxRecords?: number; maxBytes?: number; write?: (path: string, data: string) => void }
export class StateStorageError extends Error {}

/** Bounded atomic state plus one previous version. Unlike ownership leases, backup recovery may lose the latest revision. */
export class ChannelStateStore {
  private readonly directory: string;
  private readonly directoryId: NonNullable<ReturnType<typeof identity>>;
  private readonly options: StateOptions;
  private readonly records = new Map<string, Stored>();
  private bytes = 0;
  private failed = false;
  constructor(runtimeDir: string, options: StateOptions = {}) {
    this.options = options;
    for (const [value, maximum] of [[options.maxRecords ?? STATE_LIMITS.records, STATE_LIMITS.records], [options.maxBytes ?? STATE_LIMITS.bytes, STATE_LIMITS.bytes]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Invalid channel state capacity");
    }
    this.directory = join(runtimeDir, "state"); mkdirSync(this.directory, { mode: 0o700, recursive: true });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!()) throw new StateStorageError("Unsafe Openspace state directory");
    chmodSync(this.directory, 0o700); this.directoryId = identity(this.directory)!;
    const names = readdirSync(this.directory);
    if (names.length > STATE_LIMITS.records * 4) throw new StateStorageError("Openspace state directory exceeds capacity");
    const hashes = new Set<string>();
    for (const name of names) {
      const match = FILE.exec(name);
      if (match) hashes.add(match[1]!);
      else if (TEMP.test(name)) {
        const path = join(this.directory, name), file = lstatSync(path);
        if (!file.isFile() || file.uid !== process.getuid!() || (file.mode & 0o077) !== 0 || file.size > STATE_LIMITS.fileBytes) throw new StateStorageError("Unsafe Openspace state temporary file");
        unlinkOwned(path, file);
      } else throw new StateStorageError("Unknown file in Openspace state directory; inspect it manually");
    }
    if (hashes.size > (options.maxRecords ?? STATE_LIMITS.records)) throw new StateStorageError("Openspace state record capacity exceeded");
    for (const hash of hashes) this.load(hash);
  }
  private guard(): void {
    try {
      const stat = lstatSync(this.directory);
      if (this.failed || !stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || !sameFile(stat, this.directoryId)) throw new Error("Unsafe state directory");
    } catch (cause) { this.failed = true; throw new StateStorageError("Openspace state storage requires restart", { cause }); }
  }
  private read(path: string): ReadFile {
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: 0 }; throw new StateStorageError("Cannot safely read Openspace state", { cause: error }); }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new StateStorageError("Unsafe Openspace state file");
      if (stat.size > STATE_LIMITS.fileBytes) throw new StateStorageError("Openspace state file exceeds capacity");
      const buffer = Buffer.alloc(STATE_LIMITS.fileBytes + 1), length = readSync(fd, buffer, 0, buffer.length, 0);
      if (length > STATE_LIMITS.fileBytes) throw new StateStorageError("Openspace state file exceeds capacity");
      try { return { data: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)), bytes: length }; }
      catch { return { bytes: length }; }
    } finally { closeSync(fd); }
  }
  private decode(file: ReadFile, hash: string): Stored | undefined {
    if (file.data === undefined) return undefined;
    try {
      const envelope: unknown = JSON.parse(file.data);
      if (!object(envelope) || !object(envelope.body)) throw new Error();
      keys(envelope, ["body", "checksum"]);
      const body = envelope.body;
      keys(body, ["version", "workgroup", "namespace", "revision", "updatedAt", "payload", "recovered"]);
      if (body.version !== 1 || digest(JSON.stringify(body)) !== envelope.checksum) throw new Error();
      const workgroup = channelGroup(body.workgroup), ns = namespace(body.namespace);
      if (stateHash(workgroup, ns) !== hash) throw new Error();
      const state = channelState({ revision: body.revision, updatedAt: body.updatedAt, payload: body.payload, recovered: body.recovered })!;
      return { workgroup, namespace: ns, state, data: file.data, primaryBytes: file.bytes, backupBytes: 0 };
    } catch { return undefined; }
  }
  private load(hash: string): void {
    const path = join(this.directory, `${hash}.json`), primary = this.read(path), backup = this.read(join(this.directory, `${hash}.bak`));
    let entry = this.decode(primary, hash);
    const previous = this.decode(backup, hash), recover = !entry;
    if (!entry) {
      if (!previous) throw new StateStorageError("Corrupt Openspace channel state and no valid backup; refusing to discard state");
      const state: ChannelState = { ...previous.state, recovered: true }, data = encodeState(previous.workgroup, previous.namespace, state);
      entry = { ...previous, state, data, primaryBytes: Buffer.byteLength(data) };
    } else if (previous && previous.state.revision > entry.state.revision) throw new StateStorageError("Inconsistent Openspace state revisions");
    const nextBytes = this.bytes + entry.primaryBytes + backup.bytes;
    if (entry.primaryBytes > STATE_LIMITS.fileBytes) throw new StateStorageError("Openspace state file exceeds capacity");
    if (nextBytes > (this.options.maxBytes ?? STATE_LIMITS.bytes)) throw new StateStorageError("Openspace state storage capacity exceeded");
    if (recover) this.write(path, entry.data);
    entry.backupBytes = backup.bytes;
    this.records.set(hash, entry); this.bytes = nextBytes;
  }
  private write(path: string, data: string): void {
    this.guard();
    try { (this.options.write ?? atomicLeaseWrite)(path, data); }
    catch (cause) { this.failed = true; throw new StateStorageError("Cannot persist Openspace channel state; broker must stop", { cause }); }
  }
  get(workgroup: string, ns: string): ChannelState | undefined {
    this.guard(); channelGroup(workgroup); namespace(ns);
    const entry = this.records.get(stateHash(workgroup, ns)); return entry && structuredClone(entry.state);
  }
  commit(workgroup: string, ns: string, payload: JsonValue, expectedRevision?: number): ChannelState {
    this.guard(); channelGroup(workgroup); namespace(ns);
    const captured = jsonPayload(payload, CHANNEL_LIMITS.stateBytes), hash = stateHash(workgroup, ns), old = this.records.get(hash);
    if (expectedRevision !== undefined && revision(expectedRevision) !== (old?.state.revision ?? 0)) throw new RegistryError("revision_conflict");
    const nextRevision = (old?.state.revision ?? 0) + 1;
    if (!Number.isSafeInteger(nextRevision)) throw new RegistryError("revision_exhausted");
    const updatedAt = revision((this.options.now ?? Date.now)());
    const state: ChannelState = { revision: nextRevision, updatedAt, payload: captured.value };
    const data = encodeState(workgroup, ns, state), bytes = Buffer.byteLength(data);
    const nextBytes = this.bytes - (old?.backupBytes ?? 0) + bytes;
    // A crash after replacing the backup can leave two copies of the old primary. That intermediate durable layout must also fit.
    const backupStageBytes = this.bytes - (old?.backupBytes ?? 0) + (old?.primaryBytes ?? 0);
    if (bytes > STATE_LIMITS.fileBytes || Math.max(nextBytes, backupStageBytes) > (this.options.maxBytes ?? STATE_LIMITS.bytes)
      || !old && this.records.size >= (this.options.maxRecords ?? STATE_LIMITS.records)) throw new RegistryError("state_capacity");
    // Publish a verified old primary as backup, never copy a possibly corrupted file over the valid backup.
    if (old) this.write(join(this.directory, `${hash}.bak`), old.data);
    this.write(join(this.directory, `${hash}.json`), data);
    this.records.set(hash, { workgroup, namespace: ns, state, data, primaryBytes: bytes, backupBytes: old?.primaryBytes ?? 0 }); this.bytes = nextBytes;
    return structuredClone(state);
  }
}
