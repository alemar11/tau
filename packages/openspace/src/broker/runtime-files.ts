import { randomBytes } from "node:crypto";
import { constants, closeSync, fstatSync, fchmodSync, lstatSync, linkSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { OpenspacePaths } from "../paths.ts";

export interface Owner {
  protocol: "openspace";
  version: 1;
  pid: number;
  createdAt: number;
  token: string;
}

interface Identity { dev: number; ino: number }
interface OwnerFile { owner: Owner; file: Identity }
export interface Claim {
  owner: Owner;
  previous?: Owner;
  release(): void;
}

export function identity(path: string): Identity | undefined {
  try { const stat = lstatSync(path); return { dev: stat.dev, ino: stat.ino }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function sameFile(a?: Identity, b?: Identity): boolean {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino;
}

export function unlinkOwned(path: string, expected: Identity): void {
  if (sameFile(identity(path), expected)) unlinkSync(path);
}

export function prepareRuntime(paths: OpenspacePaths): void {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Openspace requires macOS or Linux");
  if (!isAbsolute(paths.runtimeDir) || paths.socketPath !== join(paths.runtimeDir, "broker.sock")) {
    throw new Error("Invalid Openspace runtime paths");
  }
  // macOS sockaddr_un reserves 104 bytes, including the trailing NUL.
  if (Buffer.byteLength(paths.socketPath) > 103 || paths.socketPath.includes("\0")) {
    throw new Error("Openspace Unix socket path exceeds 103 UTF-8 bytes; use a shorter PI_CODING_AGENT_DIR");
  }
  mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(paths.runtimeDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!()) {
    throw new Error("Openspace runtime must be a directory owned by the current user, not a symlink");
  }
  chmodSync(paths.runtimeDir, 0o700);
}

export function privateSocket(runtimeDir: string, owner: Owner): string {
  // No longer than broker.sock; the random name is owned by this broker generation.
  return join(runtimeDir, `.${owner.token.slice(0, 10)}`);
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true; // EPERM and unknown failures are not evidence of a dead owner.
  }
}

function readOwner(path: string): OwnerFile | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || stat.uid !== process.getuid!()) throw new Error("Unsafe owner file");
    const bytes = Buffer.alloc(4097);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 4096) throw new Error("Oversized owner file");
    const owner = JSON.parse(bytes.subarray(0, count).toString("utf8")) as Owner;
    if (owner?.protocol !== "openspace" || owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1
      || !Number.isSafeInteger(owner.createdAt) || owner.createdAt < 1 || owner.createdAt > Date.now() + 60_000
      || typeof owner.token !== "string" || !/^[a-f0-9]{32}$/.test(owner.token)) throw new Error("Invalid owner record");
    return { owner, file: { dev: stat.dev, ino: stat.ino } };
  } catch (error) {
    throw new Error(`Cannot safely recover Openspace owner file ${path}; inspect it manually`, { cause: error });
  } finally { closeSync(fd); }
}

/** Live (including reused) PIDs are never evicted on a failed health probe. */
export function acquireClaim(path: string, recoveryDepth = 0): Claim | undefined {
  if (recoveryDepth > 8) throw new Error("Nested Openspace recovery records require manual inspection");
  const existing = readOwner(path);
  if (!existing) return publishClaim(path);
  if (processAlive(existing.owner.pid)) return undefined;
  // Serialize reapers of this generation, not just new claimants. Otherwise a
  // delayed stale unlink could remove the next live owner's freshly made file.
  const reaper = acquireClaim(join(dirname(path), `.reap-${existing.owner.token}`), recoveryDepth + 1);
  if (!reaper) return undefined;
  try {
    const current = readOwner(path);
    if (!current || current.owner.token !== existing.owner.token || !sameFile(current.file, existing.file)
      || processAlive(current.owner.pid)) return undefined;
    return publishClaim(path, current);
  } finally { reaper.release(); }
}

function publishClaim(path: string, previous?: OwnerFile): Claim | undefined {
  const owner: Owner = { protocol: "openspace", version: 1, pid: process.pid, createdAt: Date.now(), token: randomBytes(16).toString("hex") };
  const temporary = `${path}.${owner.token}`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const stat = fstatSync(fd);
  const file = { dev: stat.dev, ino: stat.ino };
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, JSON.stringify(owner));
    // Replacement under the generation's recovery claim is atomic too: no gap
    // in which a fresh claimant could win and lose the stale socket's ownership.
    try {
      if (previous) renameSync(temporary, path);
      else linkSync(temporary, path);
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined; throw error; }
  } finally { closeSync(fd); unlinkOwned(temporary, file); }
  return { owner, previous: previous?.owner, release: () => {
    // Inode numbers can be reused after deletion. Check the generation too.
    let current;
    try { current = readOwner(path); } catch { return; }
    if (current?.owner.token === owner.token && sameFile(current.file, file)) unlinkOwned(path, file);
  } };
}
