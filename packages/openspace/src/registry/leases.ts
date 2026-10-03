import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { object, RegistryError } from "./session.ts";

export const ADMISSION_MS = 5 * 60_000;
export const LEASE_RETENTION_MS = 24 * 60 * 60_000;
export const LEASE_CHECKPOINT_MS = 60 * 60_000;
const MAX_STORE_BYTES = 512 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
// JSON escapes lone surrogates instead of collapsing distinct JS IDs to U+FFFD.
const idDigest = (id: string) => digest(JSON.stringify(id));
interface Current { hash: string; admissionUntil: number; retainUntil: number }
interface Ledger { version: 1; clock: number; secret: string; current: Record<string, Current>; retired: Record<string, number> }
interface Ticket { id: string; nonce: string; expires: number }
export class LeaseStorageError extends Error {}
export interface LeaseOptions {
  now?: () => number;
  maxCurrent?: number;
  maxRetired?: number;
  /** Test seam for uncertain writes. Any failure poisons the store until restart. */
  write?: (path: string, data: string) => void;
}

export function atomicLeaseWrite(path: string, data: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try { writeFileSync(fd, data); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(directory); }
    catch (error) {
      if (!["EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    } finally { closeSync(directory); }
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/** Positive ownership survives restart; expired admission tickets cannot become fresh claims. */
export class LeaseStore {
  private ledger: Ledger;
  private failed = false;
  private highWater = 0;
  private readonly path: string;
  private readonly now: () => number;
  private readonly options: LeaseOptions;

  constructor(runtimeDir: string, options: LeaseOptions = {}) {
    this.path = join(runtimeDir, "leases.json");
    this.options = options;
    for (const limit of [options.maxCurrent ?? 1024, options.maxRetired ?? 1024]) {
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1024) throw new Error("Invalid lease store capacity");
    }
    this.now = () => {
      const wall = (options.now ?? Date.now)();
      if (!Number.isSafeInteger(wall) || wall < 0 || wall > Number.MAX_SAFE_INTEGER - LEASE_RETENTION_MS) throw new LeaseStorageError("Invalid lease clock");
      return this.highWater = Math.max(this.highWater, wall);
    };
    this.ledger = this.load() ?? { version: 1, clock: 0, secret: randomBytes(32).toString("hex"), current: {}, retired: {} };
    this.highWater = this.ledger.clock;
    // Persist the signing key before issuing even an unused admission ticket.
    this.commit(this.pruned());
  }
  private load(): Ledger | undefined {
    let fd: number;
    try { fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || stat.size > MAX_STORE_BYTES) throw new Error("Unsafe lease store");
      const buffer = Buffer.alloc(MAX_STORE_BYTES + 1);
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      if (length > MAX_STORE_BYTES) throw new Error("Oversized lease store");
      const { body, checksum } = JSON.parse(buffer.subarray(0, length).toString("utf8"));
      if (!object(body) || body.version !== 1 || !Number.isSafeInteger(body.clock) || (body.clock as number) < 0
        || (body.clock as number) > Number.MAX_SAFE_INTEGER - LEASE_RETENTION_MS || typeof body.secret !== "string" || !HASH.test(body.secret)
        || digest(JSON.stringify(body)) !== checksum || !object(body.current) || !object(body.retired)) throw new Error("Invalid lease store");
      if (Object.keys(body.current).length > 1024 || Object.keys(body.retired).length > 1024) throw new Error("Lease capacity exceeded");
      for (const [id, value] of Object.entries(body.current)) {
        if (!HASH.test(id) || !object(value) || typeof value.hash !== "string" || !HASH.test(value.hash)
          || !Number.isSafeInteger(value.admissionUntil) || !Number.isSafeInteger(value.retainUntil)) throw new Error("Invalid lease owner");
      }
      for (const [hash, expiry] of Object.entries(body.retired)) {
        if (!HASH.test(hash) || !Number.isSafeInteger(expiry)) throw new Error("Invalid retired lease");
      }
      return body as unknown as Ledger;
    } catch (error) {
      throw new LeaseStorageError("Invalid Openspace lease store; refusing to discard fencing state", { cause: error });
    } finally { closeSync(fd); }
  }
  private guard(): void {
    if (this.failed) throw new LeaseStorageError("Openspace lease store requires restart after a write failure");
  }
  private pruned(active: ReadonlySet<string> = new Set()): Ledger {
    this.guard();
    const next = structuredClone(this.ledger);
    const now = this.now();
    for (const [hash, expires] of Object.entries(next.retired)) if (expires <= now) delete next.retired[hash];
    for (const [id, owner] of Object.entries(next.current)) {
      if (owner.retainUntil <= now && !active.has(owner.hash)) delete next.current[id];
    }
    return next;
  }
  private commit(next: Ledger): void {
    this.guard();
    // Persist the time used to collect tombstones: clock rollback, including
    // after restart, must never reopen a revoked ticket's admission window.
    next.clock = this.now();
    if (Object.keys(next.current).length > (this.options.maxCurrent ?? 1024)
      || Object.keys(next.retired).length > (this.options.maxRetired ?? 1024)) throw new RegistryError("lease_capacity");
    const data = JSON.stringify({ body: next, checksum: digest(JSON.stringify(next)) });
    if (Buffer.byteLength(data) > MAX_STORE_BYTES) throw new RegistryError("lease_capacity");
    try { (this.options.write ?? atomicLeaseWrite)(this.path, data); }
    catch (error) {
      this.failed = true;
      throw new LeaseStorageError("Cannot persist Openspace ownership; broker must stop", { cause: error });
    }
    this.ledger = next;
  }
  prepare(id: string): string {
    this.guard();
    const body = Buffer.from(JSON.stringify({ id: idDigest(id), nonce: randomBytes(32).toString("hex"), expires: this.now() + ADMISSION_MS })).toString("base64url");
    const mac = createHmac("sha256", this.ledger.secret).update(body).digest("hex");
    return `${body}.${mac}`;
  }
  private decode(id: string, lease: unknown): { ticket: Ticket; hash: string } {
    this.guard();
    if (typeof lease !== "string" || lease.length > 512) throw new RegistryError("lease_invalid");
    const [body, mac, extra] = lease.split(".");
    const expected = createHmac("sha256", this.ledger.secret).update(body).digest();
    if (extra !== undefined || !mac || !HASH.test(mac) || !timingSafeEqual(expected, Buffer.from(mac, "hex"))) throw new RegistryError("lease_invalid");
    let ticket: Ticket;
    try { ticket = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
    catch { throw new RegistryError("lease_invalid"); }
    if (!object(ticket) || ticket.id !== idDigest(id) || !Number.isSafeInteger(ticket.expires)
      || typeof ticket.nonce !== "string" || !HASH.test(ticket.nonce)) throw new RegistryError("lease_invalid");
    return { ticket, hash: digest(lease) };
  }
  inspect(id: string, lease: unknown, mode: unknown): { hash: string; current: boolean } {
    const { ticket, hash } = this.decode(id, lease);
    if (mode !== "claim" && mode !== "resume") throw new RegistryError("invalid_registration_mode");
    const owner = this.ledger.current[ticket.id];
    if (owner?.hash === hash && owner.retainUntil > this.now()) return { hash, current: true };
    if (this.ledger.retired[hash] !== undefined) throw new RegistryError("endpoint_revoked");
    if (mode === "resume") throw new RegistryError("lease_unknown");
    if (ticket.expires <= this.now()) throw new RegistryError("lease_expired");
    return { hash, current: false };
  }
  accept(id: string, lease: string, mode: "claim" | "resume", active: ReadonlySet<string>): string {
    const checked = this.inspect(id, lease, mode);
    const { ticket } = this.decode(id, lease);
    const next = this.pruned(active);
    const old = next.current[ticket.id];
    if (old && old.hash !== checked.hash && old.admissionUntil > this.now()) next.retired[old.hash] = old.admissionUntil;
    next.current[ticket.id] = { hash: checked.hash, admissionUntil: ticket.expires, retainUntil: this.now() + LEASE_RETENTION_MS };
    this.commit(next);
    return checked.hash;
  }
  release(id: string, hash: string, active: ReadonlySet<string>): void {
    const next = this.pruned(active);
    const key = idDigest(id);
    const owner = next.current[key];
    if (!owner || owner.hash !== hash) throw new RegistryError("endpoint_revoked");
    if (owner.admissionUntil > this.now()) next.retired[hash] = owner.admissionUntil;
    delete next.current[key];
    this.commit(next);
  }
  checkpoint(active: ReadonlySet<string>): void {
    const next = this.pruned(active);
    for (const owner of Object.values(next.current)) {
      if (active.has(owner.hash)) owner.retainUntil = this.now() + LEASE_RETENTION_MS;
    }
    if (JSON.stringify(next) !== JSON.stringify(this.ledger)) this.commit(next);
  }
  owns(id: string, hash: string): boolean {
    this.guard();
    const owner = this.ledger.current[idDigest(id)];
    return owner?.hash === hash && owner.retainUntil > this.now();
  }
}
