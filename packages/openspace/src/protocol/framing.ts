export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** The limit includes all JSON escaping and envelope fields, but not the header. */
export function encodeFrame(message: unknown): Buffer {
  const json = JSON.stringify(message);
  if (json === undefined) throw new Error("Message is not JSON serializable");
  const size = Buffer.byteLength(json);
  if (size === 0 || size > MAX_FRAME_BYTES) throw new Error("Frame exceeds the 1 MiB payload limit");
  const frame = Buffer.allocUnsafe(4 + size);
  frame.writeUInt32BE(size, 0);
  frame.write(json, 4, size, "utf8");
  return frame;
}

/** One bounded payload allocation per frame, regardless of chunk segmentation. */
export class FrameDecoder {
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private payload?: Buffer;
  private payloadBytes = 0;
  private failed = false;
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  push(chunk: Buffer, receive: (message: unknown) => boolean | void): void {
    if (this.failed) throw new Error("Decoder is closed");
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (!this.payload) {
          const count = Math.min(4 - this.headerBytes, chunk.length - offset);
          chunk.copy(this.header, this.headerBytes, offset, offset + count);
          offset += count;
          this.headerBytes += count;
          if (this.headerBytes < 4) continue;
          const size = this.header.readUInt32BE(0);
          if (size === 0 || size > MAX_FRAME_BYTES) throw new Error("Invalid frame length");
          this.payload = Buffer.allocUnsafe(size);
        }
        const count = Math.min(this.payload.length - this.payloadBytes, chunk.length - offset);
        chunk.copy(this.payload, this.payloadBytes, offset, offset + count);
        offset += count;
        this.payloadBytes += count;
        if (this.payloadBytes !== this.payload.length) continue;
        const message: unknown = JSON.parse(this.utf8.decode(this.payload));
        this.payload = undefined;
        this.payloadBytes = 0;
        this.headerBytes = 0;
        if (receive(message) === false) { this.failed = true; return; }
      }
    } catch (error) {
      this.payload = undefined;
      this.failed = true;
      throw error;
    }
  }
}

export interface FrameSink {
  readonly destroyed: boolean;
  readonly writableLength: number;
  write(buffer: Buffer): boolean;
}

/** Node owns the write queue; never enqueue past the per-peer budget. */
export function writeFrame(socket: FrameSink, message: unknown, budget = MAX_OUTPUT_BYTES): boolean {
  const frame = encodeFrame(message);
  if (socket.destroyed || socket.writableLength + frame.length > budget) {
    throw new Error("Peer output budget exceeded or connection closed");
  }
  return socket.write(frame);
}
