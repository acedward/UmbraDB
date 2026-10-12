/**
 * UmbraDB's pure MIP-0018 vector consumer, as functions: the runner contract of the vendored vectors
 * (`token-indexer/vendor/mip0018/vectors/README.md`, "Runner contract") answered in-process, one request at a time,
 * over the vendored codec and UmbraDB's own state module (`./state.ts`), plus the request parsing and response shapes
 * the database consumer (`./vector-consumer-pg.ts`) shares, so the two differ only in where the state lives.
 * Runtime-neutral (no `node:*`, no `Buffer`), and it imports only `.ts` modules, so plain `node` runs the stdin/stdout
 * process over it (`vector-adapter.ts`).
 */
import { type Classification, classifyEvent } from "../vendor/mip0018/codec/src/index.ts";
import { fromHex, type IdentityRef, type IdentityState, MetadataState, type ObservedEvent, type SymbolGroup, toHex } from "./state.ts";

export type Json = Record<string, unknown>;

function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(`${what} must be a string`);
  return v;
}
function int(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error(`${what} must be a non-negative integer`);
  return v;
}

// ── Request parsing and response shapes, shared with the database consumer ──────────────────────────────────────────────────

/** A `decode` request's event. */
export function decodeInput(req: Json): { type: string; name: Uint8Array; payload: Uint8Array } {
  return { type: str(req.type, "type"), name: fromHex(str(req.name_hex, "name_hex")), payload: fromHex(str(req.payload_hex, "payload_hex")) };
}

/** The `decode` response of a classification (payload-vector `expect` shape). */
export function decodeResponse(c: Classification): Json {
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

export type StateStep = { op: "apply"; event: ObservedEvent } | { op: "rollback"; network: string; toBlock: number };
export interface DisplayRequest {
  ref: IdentityRef;
  raw: string;
}

/** A `state` request's steps (in order) and display requests. */
export function stateInput(req: Json): { steps: StateStep[]; display: DisplayRequest[] | undefined } {
  if (!Array.isArray(req.steps)) throw new Error("steps must be an array");
  const steps = (req.steps as Json[]).map((step): StateStep => {
    if (step.op === "apply")
      return {
        op: "apply",
        event: {
          network: str(step.network, "network"),
          position: { block: int(step.block, "block"), tx: int(step.tx, "tx"), event: int(step.event, "event") },
          contractAddress: str(step.contractAddress, "contractAddress"),
          type: str(step.type, "type"),
          name: fromHex(str(step.name_hex, "name_hex")),
          payload: fromHex(str(step.payload_hex, "payload_hex")),
        },
      };
    if (step.op === "rollback") return { op: "rollback", network: str(step.network, "network"), toBlock: int(step.toBlock, "toBlock") };
    throw new Error(`unknown step op ${String(step.op)}`);
  });
  if (!Array.isArray(req.display)) return { steps, display: undefined };
  const display = (req.display as Json[]).map((d) => {
    const raw = str(d.raw, "display.raw");
    if (!/^[0-9]+$/.test(raw)) throw new Error("display.raw must be a decimal string");
    return {
      ref: {
        network: str(d.network, "display.network"),
        contractAddress: str(d.contractAddress, "display.contractAddress"),
        domainSep: str(d.domainSep, "display.domainSep"),
        kind: int(d.kind, "display.kind"),
      },
      raw,
    };
  });
  return { steps, display };
}

/** The `state` response (state-vector `expect` shape) from identities, groups and the displayed amounts. */
export function stateResponse(
  identities: readonly IdentityState[],
  groups: readonly SymbolGroup[],
  display?: ReadonlyArray<DisplayRequest & { shown: { decimals: bigint; text: string } | undefined }>,
): Json {
  const out: Json = {
    identities: identities.map((id) => ({
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
    groups: groups.map((g) => ({ network: g.network, contractAddress: g.contractAddress, symbol_hex: g.symbol, members: g.members })),
  };
  if (display !== undefined)
    out.display = display.map((d) => ({ ...d.ref, raw: d.raw, decimals: d.shown?.decimals.toString() ?? null, text: d.shown?.text ?? null }));
  return out;
}

// ── The pure consumer ────────────────────────────────────────────────────────────────────────────────────────────

function pureDecode(req: Json): Json {
  return decodeResponse(classifyEvent(decodeInput(req)));
}

function pureState(req: Json): Json {
  const s = new MetadataState();
  const { steps, display } = stateInput(req);
  for (const step of steps) {
    if (step.op === "apply") s.apply(step.event);
    else s.rollbackTo(step.network, step.toBlock);
  }
  return stateResponse(s.identities(), s.groups(), display?.map((d) => ({ ...d, shown: s.display(d.ref, BigInt(d.raw)) })));
}

/** Answers one runner request with the pure state module; never throws (a failure is `{id, error}`). */
export function handleRequest(req: unknown): Json {
  const id = typeof req === "object" && req !== null && !Array.isArray(req) ? (req as Json).id : undefined;
  try {
    if (typeof req !== "object" || req === null || Array.isArray(req)) throw new Error("request is not a JSON object");
    const r = req as Json;
    if (r.op === "decode") return { id, ...pureDecode(r) };
    if (r.op === "state") return { id, ...pureState(r) };
    throw new Error(`unknown op ${String(r.op)}`);
  } catch (e) {
    return { id: id ?? null, error: (e as Error).message };
  }
}
