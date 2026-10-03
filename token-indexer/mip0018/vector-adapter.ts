#!/usr/bin/env node
/**
 * UmbraDB's pure MIP-0018 vector adapter: the runner contract of the vendored vectors
 * (`token-indexer/vendor/mip0018/vectors/README.md`, "Runner contract") over the vendored codec and UmbraDB's own
 * state module (`./state.ts`). No database — the Postgres adapter (sub-plan B3) answers the same requests through the
 * real store.
 *
 *   node token-indexer/vendor/mip0018/vectors/tools/run.ts --consumer "node token-indexer/mip0018/vector-adapter.ts"
 *
 * One JSON request per stdin line, exactly one JSON response per stdout line, in order.
 */
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { classifyEvent } from "../vendor/mip0018/codec/src/index.ts";
import { fromHex, type IdentityRef, MetadataState, toHex } from "./state.ts";

type Json = Record<string, unknown>;

function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(`${what} must be a string`);
  return v;
}
function int(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error(`${what} must be a non-negative integer`);
  return v;
}

function decode(req: Json): Json {
  const c = classifyEvent({ type: str(req.type, "type"), name: fromHex(str(req.name_hex, "name_hex")), payload: fromHex(str(req.payload_hex, "payload_hex")) });
  if (c.result === "ignore") return { result: "ignore", reason: c.reason };
  if (c.result === "reject") return { result: "reject", reason: c.reason, offset: c.offset };
  return {
    result: "accept",
    header: { domainSep: toHex(c.header.domainSep), kind: c.header.kind },
    records: c.records.map((r) => {
      const out: Json = { offset: r.offset, key_hex: toHex(r.key), valType: r.valType, value_hex: toHex(r.value) };
      if (r.integer !== undefined) out.decoded = r.integer.toString();
      return out;
    }),
    contentEnd: c.contentEnd,
  };
}

function state(req: Json): Json {
  const s = new MetadataState();
  if (!Array.isArray(req.steps)) throw new Error("steps must be an array");
  for (const step of req.steps as Json[]) {
    if (step.op === "apply") {
      s.apply({
        network: str(step.network, "network"),
        position: { block: int(step.block, "block"), tx: int(step.tx, "tx"), event: int(step.event, "event") },
        contractAddress: str(step.contractAddress, "contractAddress"),
        type: str(step.type, "type"),
        name: fromHex(str(step.name_hex, "name_hex")),
        payload: fromHex(str(step.payload_hex, "payload_hex")),
      });
    } else if (step.op === "rollback") {
      s.rollbackTo(str(step.network, "network"), int(step.toBlock, "toBlock"));
    } else {
      throw new Error(`unknown step op ${String(step.op)}`);
    }
  }
  const out: Json = {
    identities: s.identities().map((id) => ({
      network: id.network,
      contractAddress: id.contractAddress,
      domainSep: id.domainSep,
      kind: id.kind,
      visible: true,
      colored: id.kind !== 3,
      fields: Object.fromEntries(
        [...id.fields].map(([keyHex, f]) => {
          const field: Json = { valType: f.valType, value_hex: toHex(f.value) };
          if (f.usable !== undefined) field.usable = f.usable;
          return [keyHex, field];
        }),
      ),
    })),
    groups: s.groups().map((g) => ({ network: g.network, contractAddress: g.contractAddress, symbol_hex: g.symbol, members: g.members })),
  };
  if (Array.isArray(req.display)) {
    out.display = (req.display as Json[]).map((d) => {
      const ref: IdentityRef = {
        network: str(d.network, "display.network"),
        contractAddress: str(d.contractAddress, "display.contractAddress"),
        domainSep: str(d.domainSep, "display.domainSep"),
        kind: int(d.kind, "display.kind"),
      };
      const raw = str(d.raw, "display.raw");
      if (!/^[0-9]+$/.test(raw)) throw new Error("display.raw must be a decimal string");
      const shown = s.display(ref, BigInt(raw));
      return { ...ref, raw, decimals: shown?.decimals.toString() ?? null, text: shown?.text ?? null };
    });
  }
  return out;
}

/** Answers one runner request; never throws (a failure is `{id, error}`). */
export function handleRequest(req: unknown): Json {
  const id = typeof req === "object" && req !== null && !Array.isArray(req) ? (req as Json).id : undefined;
  try {
    if (typeof req !== "object" || req === null || Array.isArray(req)) throw new Error("request is not a JSON object");
    const r = req as Json;
    if (r.op === "decode") return { id, ...decode(r) };
    if (r.op === "state") return { id, ...state(r) };
    throw new Error(`unknown op ${String(r.op)}`);
  } catch (e) {
    return { id: id ?? null, error: (e as Error).message };
  }
}

/** Reads one JSON request per line from stdin and writes one JSON response per line to stdout. */
export function main(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    let req: unknown;
    try {
      req = JSON.parse(line);
    } catch (e) {
      process.stdout.write(`${JSON.stringify({ id: null, error: `invalid JSON: ${(e as Error).message}` })}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(handleRequest(req))}\n`);
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main();
