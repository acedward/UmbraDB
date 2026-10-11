/**
 * Node's JSON-RPC server's recorded answers (`fixtures/node-answers.json`) and how they are taken and compared: each
 * case of `wire-cases.ts` is sent over TCP as raw bytes and its answer kept as the server wrote it — the status line,
 * every header in order (except `Date`), and the body (as text up to {@link BODY_TEXT_BYTES} bytes, else its length,
 * SHA-256 and first characters). `record-node-answers.ts` writes the file; the tests compare Node's server and the
 * browser engine's handler with it.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import type { HttpAnswer } from "../handler.js";

/** Bodies up to this many bytes are recorded as text; longer ones by length and SHA-256. */
export const BODY_TEXT_BYTES = 1_024;

export type RecordedBody = string | { bytes: number; sha256: string; start: string };

export interface RecordedAnswer {
  case: string;
  /** The interim answer Node writes before the answer (`HTTP/1.1 100 Continue`), when it writes one. */
  interim?: string;
  head: string;
  headers: string[];
  body: RecordedBody;
}

export interface Recording {
  about: string;
  answers: RecordedAnswer[];
}

export const FIXTURE = new URL("./fixtures/node-answers.json", import.meta.url);

/** Sends `raw` to 127.0.0.1:`port` and reads the answer until the server closes the connection. */
export function sendRaw(port: number, raw: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect(port, "127.0.0.1", () => socket.end(raw));
    socket.on("data", (d: Buffer) => chunks.push(d));
    socket.on("error", (e) => (chunks.length > 0 ? resolve(Buffer.concat(chunks)) : reject(e)));
    socket.on("close", () => resolve(Buffer.concat(chunks)));
  });
}

/** The body as recorded: text when short, else its length, SHA-256 and first characters. */
export function recordedBody(body: Uint8Array): RecordedBody {
  const text = Buffer.from(body).toString("utf8");
  if (body.length <= BODY_TEXT_BYTES) return text;
  return { bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), start: text.slice(0, 120) };
}

/** A raw HTTP answer as recorded (`name` its case). */
export function parseAnswer(name: string, raw: Buffer): RecordedAnswer {
  let rest = raw;
  let interim: string | undefined;
  const CONTINUE = "HTTP/1.1 100 Continue\r\n\r\n";
  if (rest.subarray(0, CONTINUE.length).toString("latin1") === CONTINUE) {
    interim = CONTINUE.slice(0, -4);
    rest = rest.subarray(CONTINUE.length);
  }
  const end = rest.indexOf("\r\n\r\n");
  const lines = rest.subarray(0, end < 0 ? rest.length : end).toString("latin1").split("\r\n");
  const body = end < 0 ? new Uint8Array(0) : rest.subarray(end + 4);
  return {
    case: name,
    ...(interim === undefined ? {} : { interim }),
    head: lines[0] ?? "",
    headers: lines.slice(1).filter((h) => !/^date:/i.test(h)),
    body: recordedBody(body),
  };
}

/** Headers Node's server adds by itself, outside the handler's answer. */
const NODE_OWN = /^(connection|keep-alive|transfer-encoding):/i;

/** The handler's answer in the recorded form, to compare with a recorded answer of the same case (whose `Connection`
 *  header Node adds by itself). */
export function handlerAnswer(name: string, answer: HttpAnswer, recorded: RecordedAnswer): RecordedAnswer {
  const reason = recorded.head.replace(/^HTTP\/1\.1 \d+ ?/, "");
  return {
    case: name,
    head: `HTTP/1.1 ${answer.status}${reason === "" ? "" : ` ${reason}`}`,
    headers: [...Object.entries(answer.headers).map(([k, v]) => `${k}: ${v}`), ...recorded.headers.filter((h) => NODE_OWN.test(h))],
    body: recordedBody(new TextEncoder().encode(answer.body)),
  };
}

export function loadRecording(): Recording {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as Recording;
}

/** Writes the recording: one answer per line, every character outside printable ASCII written as a JSON escape. */
export function writeRecording(recording: Recording): void {
  const backslash = String.fromCharCode(92);
  const ascii = (json: string): string => json.replace(/[^\x20-\x7e]/g, (c) => `${backslash}u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const lines = recording.answers.map((a) => `    ${ascii(JSON.stringify(a))}`);
  writeFileSync(FIXTURE, `{\n  "about": ${ascii(JSON.stringify(recording.about))},\n  "answers": [\n${lines.join(",\n")}\n  ]\n}\n`);
}

/** An HTTP answer of the server: status, the headers it set in order (Node's own `Date`, `Connection` and
 *  `Keep-Alive` aside) and the body's bytes. */
export interface WireAnswer {
  status: number;
  headers: [string, string][];
  body: Buffer;
}

/**
 * Sends `body` (UTF-8) with `method` to the server at 127.0.0.1:`port` on a connection of its own, closed after the
 * answer: no connection is kept for a later request, so the server closing a kept one (its keep-alive timeout, which a
 * thread busy for seconds lets pass unnoticed) cannot reset a request. A failure names the request and the server.
 */
export function sendToServer(port: number, method: string, body: string): Promise<WireAnswer> {
  const bytes = Buffer.from(body, "utf8");
  const what = `${method} ${JSON.stringify(body.length > 80 ? `${body.slice(0, 80)}…` : body)} to the evm-rpc server at 127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: "/", agent: false, headers: { "content-type": "application/json", "content-length": bytes.length, connection: "close" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("error", (e) => reject(new Error(`the answer to ${what} failed: ${e.message}`, { cause: e })));
      res.on("end", () => {
        const headers: [string, string][] = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          if (!/^(date|connection|keep-alive)$/i.test(res.rawHeaders[i]!)) headers.push([res.rawHeaders[i]!, res.rawHeaders[i + 1]!]);
        }
        resolve({ status: res.statusCode!, headers, body: Buffer.concat(chunks) });
      });
    });
    req.on("error", (e) => reject(new Error(`${what} failed: ${e.message}`, { cause: e })));
    req.end(bytes);
  });
}

