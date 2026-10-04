import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { HerdrMachineReference } from "../../shared/types.ts";
import { HerdrJsonLineDecoder } from "./herdr-wire.ts";
export { decodeHerdrJsonLine } from "./herdr-wire.ts";

const MAX_DISCOVERY_BYTES = 256 * 1024;
const MAX_RPC_BYTES = 4 * 1024 * 1024;
const SUBSCRIPTION_ACK_TIMEOUT_MS = 15_000;
export const HERDR_REMOTE_PATH = "$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
export const HERDR_SSH_BASE = ["-T", "-o", "BatchMode=yes", "-o", "NumberOfPasswordPrompts=0", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1", "-o", "ForwardAgent=no", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "-o", "SendEnv=-*", "-o", "SetEnv=TAU_SUBAGENTS_SSH_GUARD="] as const;
export function hardenedSshEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv { return { PATH: process.platform === "win32" ? source.PATH : "/usr/bin:/bin:/usr/sbin:/sbin", ...(source.SystemRoot ? { SystemRoot: source.SystemRoot } : {}), ...(source.WINDIR ? { WINDIR: source.WINDIR } : {}) }; }
export function herdrSshArgs(source: NodeJS.ProcessEnv = process.env): string[] { return [...HERDR_SSH_BASE, ...(source.SSH_AUTH_SOCK ? ["-o", `IdentityAgent=${source.SSH_AUTH_SOCK}`] : [])]; }

export interface HerdrEndpoint { socket: string; session: string | null; version: string; protocol: number; compatible: boolean; running: boolean }
export interface HerdrRpcClient {
	call<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
	subscribe(subscriptions: unknown[], listener: (event: unknown) => void, onDisconnect?: (error: Error) => void): Promise<() => void>;
}
export class HerdrRpcError extends Error {
	readonly code?: string; readonly requestId: string;
	constructor(message: string, requestId: string, code?: string) { super(message); this.name = "HerdrRpcError"; this.requestId = requestId; this.code = code; }
}
export class HerdrTransportError extends Error { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "HerdrTransportError"; } }
export interface HerdrForwardedConnection { endpoint: HerdrEndpoint; socketPath: string; client: HerdrRpcClient; forwardRemoteSocket(remotePath: string, name: string): Promise<{ socketPath: string; close(): Promise<void> }>; close(): Promise<void> }

export function shellQuoteRemote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
export function remoteShellCommand(script: string, args: string[] = []): string { return `sh -c ${shellQuoteRemote(`PATH="${HERDR_REMOTE_PATH}"; export PATH; ${script}`)} sh${args.map((arg) => ` ${shellQuoteRemote(arg)}`).join("")}`; }
function canonicalHerdrSession(session: string | null | undefined): string | null { return session && session !== "default" ? session : null; }
function sshEnvCommand(session: string | undefined, command: string): string { const selected = canonicalHerdrSession(session), assignment = selected ? ` HERDR_SESSION=${shellQuoteRemote(selected)}` : ""; return `/usr/bin/env -u HERDR_SOCKET_PATH -u HERDR_SESSION${assignment} ${remoteShellCommand(command)}`; }

export function runHerdrRemoteCommand(machine: HerdrMachineReference, command: string, options: { sshBin?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number } = {}) { return spawnSync(options.sshBin ?? "ssh", [...herdrSshArgs(options.env), machine.target, command], { encoding: "utf8", env: hardenedSshEnv(options.env), timeout: options.timeout ?? 15_000, maxBuffer: options.maxBuffer ?? MAX_DISCOVERY_BYTES, windowsHide: true }); }

export function runHerdrRemoteCommandAsync(machine: HerdrMachineReference, command: string, options: { sshBin?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number } = {}): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> {
	return new Promise((resolve) => {
		const child = spawn(options.sshBin ?? "ssh", [...herdrSshArgs(options.env), machine.target, command], { env: hardenedSshEnv(options.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		const stdout: Buffer[] = [], stderr: Buffer[] = [], maxBuffer = options.maxBuffer ?? MAX_DISCOVERY_BYTES; let stdoutBytes = 0, stderrBytes = 0, error: Error | undefined, settled = false, escalation: NodeJS.Timeout | undefined;
		const finish = (status: number | null, spawnError = error) => { if (settled) return; settled = true; clearTimeout(timer); if (escalation) clearTimeout(escalation); resolve({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), ...(spawnError ? { error: spawnError } : {}) }); };
		const terminate = () => { child.kill("SIGTERM"); escalation ??= setTimeout(() => { if (!settled) { child.kill("SIGKILL"); finish(child.exitCode ?? null); } }, 1_000); escalation.unref?.(); };
		const collect = (target: Buffer[], stream: "stdout" | "stderr") => (chunk: Buffer) => { const bytes = stream === "stdout" ? (stdoutBytes += chunk.byteLength) : (stderrBytes += chunk.byteLength); if (bytes > maxBuffer) { error ??= new Error(`${stream} maxBuffer length exceeded`); terminate(); } else target.push(chunk); };
		child.stdout.on("data", collect(stdout, "stdout")); child.stderr.on("data", collect(stderr, "stderr"));
		child.once("error", (spawnError) => finish(null, spawnError));
		child.once("close", (status) => finish(status));
		const timer = setTimeout(terminate, options.timeout ?? 15_000); timer.unref?.();
	});
}

export function parseHerdrEndpoint(value: string, expectedSession?: string): HerdrEndpoint {
	let parsed: unknown;
	try { parsed = JSON.parse(value) as unknown; } catch { throw new Error("Remote Herdr endpoint discovery returned malformed JSON."); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Remote Herdr endpoint discovery returned no endpoint.");
	const p = parsed as Record<string, unknown>;
	if (typeof p.socket !== "string" || !path.posix.isAbsolute(p.socket) || typeof p.version !== "string" || typeof p.protocol !== "number") throw new Error("Remote Herdr endpoint discovery returned incomplete identity.");
	const session = canonicalHerdrSession(typeof p.session === "string" ? p.session : null), expected = canonicalHerdrSession(expectedSession);
	if (expected !== session) throw new Error(`Remote Herdr session identity mismatch: expected ${expected ?? "default"}, received ${session ?? "default"}.`);
	if (p.running !== true || p.compatible !== true || p.endpoint_compatible === false) throw new Error("The selected remote Herdr session is stopped or incompatible.");
	return { socket: p.socket, session, version: p.version, protocol: p.protocol, compatible: true, running: true };
}

export async function discoverHerdrEndpoint(machine: HerdrMachineReference, options: { sshBin?: string; env?: NodeJS.ProcessEnv } = {}): Promise<HerdrEndpoint> {
	const discovery = 'herdr_path=$(command -v herdr) || exit 127; case "$herdr_path" in /*/herdr) ;; *) exit 126;; esac; exec "$herdr_path" status server --json';
	const result = await runHerdrRemoteCommandAsync(machine, sshEnvCommand(machine.session, discovery), { ...options, timeout: 15_000, maxBuffer: MAX_DISCOVERY_BYTES });
	if (result.error) throw new Error(`Remote Herdr discovery failed: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`Remote Herdr discovery failed with code ${result.status}: ${(result.stderr || result.stdout).trim()}`);
	return parseHerdrEndpoint(result.stdout, machine.session);
}

function rpcError(record: Record<string, unknown>): HerdrRpcError | undefined {
	if (typeof record.id !== "string" || Object.hasOwn(record, "result") === Object.hasOwn(record, "error")) throw new Error("Herdr RPC returned an invalid response envelope.");
	if (!Object.hasOwn(record, "error")) return undefined;
	const error = record.error as { message?: unknown; code?: unknown } | null;
	if (!error || typeof error !== "object" || Array.isArray(error) || typeof error.message !== "string" || typeof error.code !== "string") throw new Error("Herdr RPC returned a malformed error envelope.");
	return new HerdrRpcError(error.message, record.id, error.code);
}
function rpcRequest(id: string, method: string, params: Record<string, unknown>): string {
	const request = `${JSON.stringify({ id, method, params })}\n`;
	if (Buffer.byteLength(request) > MAX_RPC_BYTES) throw new Error("Herdr RPC request exceeded its byte bound.");
	return request;
}
function assertRpcTimeout(timeoutMs: number): void {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error("Invalid Herdr RPC timeout.");
}

export class SocketRpcClient implements HerdrRpcClient {
	readonly #socketPath: string;
	readonly #subscriptionAckTimeoutMs: number;
	#next = 0;
	constructor(socketPath: string, subscriptionAckTimeoutMs = SUBSCRIPTION_ACK_TIMEOUT_MS) {
		assertRpcTimeout(subscriptionAckTimeoutMs);
		this.#socketPath = socketPath;
		this.#subscriptionAckTimeoutMs = subscriptionAckTimeoutMs;
	}
	async call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
		assertRpcTimeout(timeoutMs);
		const id = String(++this.#next), request = rpcRequest(id, method, params);
		return new Promise((resolve, reject) => {
			const socket = net.createConnection(this.#socketPath), decoder = new HerdrJsonLineDecoder(MAX_RPC_BYTES);
			let bytes = 0, finished = false;
			const finish = (error?: Error, value?: T) => {
				if (finished) return;
				finished = true; clearTimeout(timer); socket.destroy();
				error ? reject(error) : resolve(value as T);
			};
			const timer = setTimeout(() => finish(new HerdrTransportError(`Herdr RPC '${method}' timed out; remote effects are unknown.`)), timeoutMs);
			socket.on("connect", () => socket.write(request));
			socket.on("data", (chunk: Buffer) => {
				if (finished) return;
				try {
					bytes += chunk.byteLength;
					if (bytes > MAX_RPC_BYTES) throw new Error("Herdr RPC response exceeded its byte bound.");
					const records = decoder.push(chunk);
					if (!records.length) return;
					if (records.length !== 1) throw new Error("Herdr RPC returned multiple responses.");
					decoder.end();
					const record = records[0]!, error = rpcError(record);
					if (record.id !== id && !(record.id === "" && error?.code === "invalid_request")) throw new Error("Herdr RPC response identity mismatch.");
					finish(error, record.result as T);
				} catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
			});
			socket.on("end", () => { try { decoder.end(); } catch (error) { finish(error as Error); } });
			socket.on("error", (error) => finish(new HerdrTransportError(error.message, { cause: error })));
			socket.on("close", () => finish(new HerdrTransportError(`Herdr RPC '${method}' ended before a response; remote effects are unknown.`)));
		});
	}
	async subscribe(subscriptions: unknown[], listener: (event: unknown) => void, onDisconnect?: (error: Error) => void): Promise<() => void> {
		const id = String(++this.#next), request = rpcRequest(id, "events.subscribe", { subscriptions });
		const socket = net.createConnection(this.#socketPath), decoder = new HerdrJsonLineDecoder(MAX_RPC_BYTES);
		let bytes = 0, acknowledged = false, intentional = false, failed = false;
		let resolveAck!: () => void, rejectAck!: (error: Error) => void;
		const acknowledgement = new Promise<void>((resolve, reject) => { resolveAck = resolve; rejectAck = reject; });
		const disconnect = (error: Error) => {
			if (intentional || failed) return;
			failed = true; clearTimeout(timer); socket.destroy();
			if (!acknowledged) rejectAck(error); else onDisconnect?.(error);
		};
		const timer = setTimeout(() => disconnect(new Error("Herdr subscription acknowledgement timed out.")), this.#subscriptionAckTimeoutMs);
		socket.on("data", (chunk: Buffer) => {
			if (intentional || failed) return;
			try {
				bytes += chunk.byteLength;
				if (bytes > MAX_RPC_BYTES * 32) throw new Error("Herdr subscription exceeded its byte bound.");
				for (const record of decoder.push(chunk)) {
					if (intentional || failed) break;
					if (!acknowledged) {
						const error = rpcError(record);
						if (record.id !== id && !(record.id === "" && error?.code === "invalid_request")) throw new Error("Herdr subscription response identity mismatch or event before acknowledgement.");
						if (error) throw error;
						if (!record.result || typeof record.result !== "object" || (record.result as { type?: unknown }).type !== "subscription_started") throw new Error("Herdr subscription returned an invalid acknowledgement.");
						acknowledged = true; clearTimeout(timer); resolveAck();
						continue;
					}
					if (Object.hasOwn(record, "error")) throw rpcError(record);
					if (Object.hasOwn(record, "id") || Object.hasOwn(record, "result") || typeof record.event !== "string" || !record.data || typeof record.data !== "object" || Array.isArray(record.data)) throw new Error("Herdr subscription returned an invalid event envelope.");
					listener(record);
				}
			} catch (error) { disconnect(error instanceof Error ? error : new Error(String(error))); }
		});
		socket.on("end", () => { try { decoder.end(); } catch (error) { disconnect(error as Error); } });
		socket.on("error", (error) => disconnect(error));
		socket.on("close", () => disconnect(new Error("Herdr subscription connection was lost.")));
		socket.on("connect", () => socket.write(request));
		await acknowledgement;
		return () => { intentional = true; clearTimeout(timer); socket.destroy(); };
	}
}

async function waitForSocket(socketPath: string, child: ChildProcess): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (child.exitCode !== null) throw new Error(`SSH StreamLocal forwarding exited with code ${child.exitCode}.`);
		try { const stat = fs.lstatSync(socketPath); if (stat.isSocket()) { fs.chmodSync(socketPath, 0o600); return; } } catch {}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("SSH StreamLocal forwarding did not create its local socket.");
}
async function terminateChild(child: ChildProcess): Promise<void> { const wait = (ms: number) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, ms))]); if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await wait(1_000); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await wait(1_000); } }

export async function connectHerdrMachine(machine: HerdrMachineReference, options: { sshBin?: string; env?: NodeJS.ProcessEnv } = {}): Promise<HerdrForwardedConnection> {
	if (process.platform === "win32") throw new Error("Pane-native Herdr placement requires OpenSSH StreamLocal forwarding and is not supported on Windows.");
	const endpoint = await discoverHerdrEndpoint(machine, options);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tau-subagents-herdr-")); fs.chmodSync(dir, 0o700);
	const children = new Set<ChildProcess>();
	const forward = async (remotePath: string, name: string) => {
		if (!path.posix.isAbsolute(remotePath)) throw new Error("Remote socket path must be absolute.");
		const local = path.join(dir, `${name}.sock`);
		const child = spawn(options.sshBin ?? "ssh", [...herdrSshArgs(options.env), "-N", "-o", "StreamLocalBindUnlink=yes", "-L", `${local}:${remotePath}`, machine.target], { env: hardenedSshEnv(options.env), stdio: "ignore", windowsHide: true }); children.add(child);
		const stop = async () => { await terminateChild(child); children.delete(child); try { fs.rmSync(local, { force: true }); } catch {} };
		try { await waitForSocket(local, child); } catch (error) { await stop(); throw error; }
		return { socketPath: local, close: stop };
	};
	const primary = await forward(endpoint.socket, "herdr").catch((error) => { fs.rmSync(dir, { recursive: true, force: true }); throw error; });
	return { endpoint, socketPath: primary.socketPath, client: new SocketRpcClient(primary.socketPath), forwardRemoteSocket: forward, close: async () => { await Promise.all([...children].map(terminateChild)); children.clear(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
