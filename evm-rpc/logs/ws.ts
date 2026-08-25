/**
 * A minimal RFC 6455 WebSocket **server** on `node:http` + `node:crypto`.
 *
 * WHY HAND-ROLLED: Part C must not add heavy runtime dependencies, and C-G4 requires an actual WS
 * server (`eth_subscribe` on `EVM_RPC_WS_PORT`). Node ships a WebSocket *client* as a global
 * (undici) but no server, so the server side is the one piece that genuinely has to be written.
 * Having written it, the tests reuse it as a fake indexer endpoint too, which is how the ingester
 * can be exercised end-to-end without the Part A stack.
 *
 * SCOPE, deliberately small: text frames, fragmentation, close, ping/pong, subprotocol
 * negotiation. Not implemented, because nothing here needs them: `permessage-deflate`, binary
 * application frames (a binary frame is reported and then ignored), and client-side masking of
 * server frames (RFC 6455 §5.1 requires server frames to be UNmasked, which is what this sends).
 *
 * Interop is not taken on trust: `test/subscribe.test.ts` drives this server with
 * `ethers.WebSocketProvider`, a third-party client implementation.
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";

/** RFC 6455 §1.3 — the fixed GUID concatenated with the client key to form the accept token. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

export interface WsConnection {
  /** Sends one text frame. No-op once the socket is closed, so callers need no liveness dance. */
  send(text: string): void;
  close(code?: number, reason?: string): void
  readonly closed: boolean;
  /** The negotiated subprotocol, if the client offered one this server accepted. */
  readonly protocol: string | undefined;
  /** The HTTP request that opened the connection (path, headers). */
  readonly request: IncomingMessage;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
}

export interface WsServerOptions {
  /**
   * Subprotocols this server will accept, most-preferred first. The indexer speaks
   * `graphql-transport-ws`; an `eth_subscribe` client typically offers none.
   */
  protocols?: readonly string[];
  /** Called for each accepted connection. */
  onConnection: (connection: WsConnection) => void;
  /** Reject the upgrade for a path this server does not serve. Defaults to accepting every path. */
  acceptPath?: (path: string) => boolean;
}

export interface WsServer {
  readonly server: Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
  readonly connections: ReadonlySet<WsConnection>;
}

function acceptToken(key: string): string {
  return createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

/** Encodes one server→client frame. Server frames are never masked (RFC 6455 §5.1). */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    // A 64-bit length; payloads here are JSON messages, so the high word is always zero.
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

interface DecodedFrame {
  opcode: number;
  fin: boolean;
  payload: Buffer;
  /** Bytes consumed from the input buffer. */
  size: number;
}

/**
 * Decodes one frame from `buffer`, or returns `null` when the buffer holds only part of a frame —
 * a TCP read boundary can land anywhere, so "not enough bytes yet" is the normal case, not an
 * error.
 */
function decodeFrame(buffer: Buffer): DecodedFrame | null {
  if (buffer.length < 2) return null;
  const fin = (buffer[0]! & 0x80) !== 0;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    if (high !== 0) throw new Error("ws: frame longer than 4GiB");
    length = low;
    offset += 8;
  }

  let maskKey: Buffer | undefined;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (maskKey !== undefined) {
    for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ maskKey[i % 4]!;
  }
  return { opcode, fin, payload, size: offset + length };
}

export function createWebSocketServer(options: WsServerOptions): WsServer {
  const connections = new Set<WsConnection>();
  const server = createServer((_req, res) => {
    // Anything that is not an upgrade gets a plain rejection; this server serves only WS.
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("upgrade required\n");
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
    const key = request.headers["sec-websocket-key"];
    const path = request.url ?? "/";
    if (typeof key !== "string" || (options.acceptPath !== undefined && !options.acceptPath(path))) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }

    // Subprotocol negotiation: pick the first offered protocol this server accepts.
    const offered = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    let chosen: string | undefined;
    for (const candidate of options.protocols ?? []) {
      if (offered.includes(candidate)) {
        chosen = candidate;
        break;
      }
    }

    const responseLines = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptToken(key)}`,
    ];
    if (chosen !== undefined) responseLines.push(`Sec-WebSocket-Protocol: ${chosen}`);
    socket.write(`${responseLines.join("\r\n")}\r\n\r\n`);

    (socket as Socket).setNoDelay?.(true);

    let buffered = Buffer.alloc(0);
    /** Accumulates a fragmented text message across continuation frames. */
    let fragments: Buffer[] = [];
    let fragmentOpcode = 0;
    let closed = false;
    const messageHandlers: Array<(text: string) => void> = [];
    const closeHandlers: Array<(code: number, reason: string) => void> = [];

    const connection: WsConnection = {
      get closed() {
        return closed;
      },
      protocol: chosen,
      request,
      send(text: string) {
        if (closed) return;
        socket.write(encodeFrame(OPCODE_TEXT, Buffer.from(text, "utf8")));
      },
      close(code = 1000, reason = "") {
        if (closed) return;
        const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
        payload.writeUInt16BE(code, 0);
        payload.write(reason, 2, "utf8");
        socket.write(encodeFrame(OPCODE_CLOSE, payload));
        socket.end();
      },
      onMessage(handler) {
        messageHandlers.push(handler);
      },
      onClose(handler) {
        closeHandlers.push(handler);
      },
    };

    const finish = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      connections.delete(connection);
      for (const handler of closeHandlers) handler(code, reason);
    };

    socket.on("data", (chunk: Buffer) => {
      // `Buffer.concat` unconditionally (rather than aliasing `chunk` when the buffer is empty):
      // the incoming chunk is typed over `ArrayBufferLike`, and concat also gives us a buffer we
      // own, so the later `subarray` slicing cannot alias a stream-internal buffer.
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        let frame: DecodedFrame | null;
        try {
          frame = decodeFrame(buffered);
        } catch {
          connection.close(1009, "frame too large");
          return;
        }
        if (frame === null) return;
        buffered = buffered.subarray(frame.size);

        if (frame.opcode === OPCODE_CLOSE) {
          const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
          const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString("utf8") : "";
          if (!closed) {
            closed = true;
            socket.write(encodeFrame(OPCODE_CLOSE, frame.payload));
            socket.end();
            connections.delete(connection);
            for (const handler of closeHandlers) handler(code, reason);
          }
          return;
        }
        if (frame.opcode === OPCODE_PING) {
          socket.write(encodeFrame(OPCODE_PONG, frame.payload));
          continue;
        }
        if (frame.opcode === OPCODE_PONG) continue;

        if (frame.opcode === OPCODE_CONTINUATION) {
          fragments.push(frame.payload);
        } else {
          fragments = [frame.payload];
          fragmentOpcode = frame.opcode;
        }
        if (!frame.fin) continue;

        const complete = Buffer.concat(fragments);
        fragments = [];
        if (fragmentOpcode === OPCODE_TEXT) {
          const text = complete.toString("utf8");
          for (const handler of messageHandlers) handler(text);
        }
        // A BINARY application frame is intentionally dropped: no protocol Part C speaks uses one,
        // and silently reinterpreting it as text would be worse than ignoring it.
      }
    });

    socket.on("error", () => finish(1006, "socket error"));
    socket.on("close", () => finish(1006, "socket closed"));

    connections.add(connection);
    options.onConnection(connection);
  });

  return {
    server,
    connections,
    listen(port: number, host = "127.0.0.1"): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("ws: server address unavailable after listen"));
            return;
          }
          server.removeListener("error", reject);
          resolve(address.port);
        });
      });
    },
    close(): Promise<void> {
      for (const connection of [...connections]) connection.close(1001, "server shutting down");
      return new Promise((resolve) => {
        server.close(() => resolve());
        // `server.close()` waits for open sockets; the ones above are already ending, but a
        // half-open peer must not hold shutdown forever.
        server.closeAllConnections?.();
      });
    },
  };
}
