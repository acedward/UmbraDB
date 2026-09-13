#!/usr/bin/env node
import { assertNoDatabaseEnvironment } from "../no-database.js";
import { createBalancer } from "./balancer.js";

/**
 * `umbradb-shielded-monitor-balancer` — the balancer as a process (00009-08 v2, owner question
 * Q25; registration routing added by 00009-09, owner decision Q28).
 *
 * | variable | default | meaning |
 * |---|---|---|
 * | `BALANCER_UPSTREAMS` | — (REQUIRED) | comma-separated base URLs of the monitor-nodes |
 * | `BALANCER_HOST` | `127.0.0.1` | bind address |
 * | `BALANCER_PORT` | `8789` | bind port (`0` asks the kernel for a free one) |
 * | `BALANCER_PROBE_MS` | `5000` | health-probe interval; `0` disables probing |
 * | `BALANCER_TIMEOUT_MS` | `60000` | per-request timeout to an upstream |
 * | `BALANCER_MAX_BODY_BYTES` | `65536` | cap on a registration body it reads in order to route it |
 * | `NET` / `SHIELDED_MONITOR_NET` | `undeployed` | the network whose HRP a viewing key must carry |
 *
 * It is part of project B and therefore has no database either: it refuses to start with a `*_PG`
 * variable in its environment, exactly as the monitor-nodes do. The only state it keeps is a HINT
 * table (`fingerprint → node`) that is never trusted without asking that node, so it can be lost,
 * restarted or wrong without any consequence beyond one extra fan-out.
 */

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8789;
const DEFAULT_PROBE_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export const BALANCER_ENV_DOC = `
Environment (umbradb-shielded-monitor-balancer):

  BALANCER_UPSTREAMS   comma-separated base URLs of umbradb-shielded-monitor-node instances
                       (REQUIRED), e.g. http://node-1:8787,http://node-2:8787
  BALANCER_HOST        bind address (default "${DEFAULT_HOST}").
  BALANCER_PORT        bind port, 0 asks the kernel for a free one (default ${DEFAULT_PORT}).
  BALANCER_PROBE_MS    milliseconds between /v1/health probes; 0 disables (default ${DEFAULT_PROBE_MS}).
  BALANCER_TIMEOUT_MS  per-request timeout to an upstream (default ${DEFAULT_TIMEOUT_MS}).
  BALANCER_MAX_BODY_BYTES  cap on a POST /v1/monitors body (default ${DEFAULT_MAX_BODY_BYTES}).
  NET                  the network a viewing key's HRP must match (default "undeployed").

POST /v1/monitors is ROUTED: the balancer computes the key's fingerprint (Bech32m decode plus
SHA-256 — no ledger WASM), asks the nodes which of them already holds it, and forwards there;
otherwise it places the key on the node with the fewest keys, then the shortest Queue B. Every
other request goes to a uniformly random healthy node. /internal/* is never forwarded (404).
GET /v1/monitors and GET /v1/monitors/<id> are answered with heldBy/keyNeeded filled in from a
fan-out. A GET is retried once on another node; a POST is NEVER retried. Every response carries
X-Upstream naming the node that answered.

The registration body is never logged.
`.trim();

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`invalid ${name}: ${JSON.stringify(raw)} is not a decimal integer`);
  const value = Number(raw.trim());
  if (value < min || value > max) throw new Error(`invalid ${name}: ${value} is outside ${min}..${max}`);
  return value;
}

export function loadBalancerConfig(env: NodeJS.ProcessEnv = process.env): {
  upstreams: string[]; host: string; port: number; net: string; probeMs: number;
  requestTimeoutMs: number; maxBodyBytes: number;
} {
  assertNoDatabaseEnvironment(env, "umbradb-shielded-monitor-balancer");
  const raw = env.BALANCER_UPSTREAMS?.trim();
  if (raw === undefined || raw === "") {
    throw new Error(`BALANCER_UPSTREAMS is required.\n\n${BALANCER_ENV_DOC}`);
  }
  const upstreams = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (upstreams.length === 0) throw new Error("BALANCER_UPSTREAMS names no upstream");
  // Both spellings are honoured, `SHIELDED_MONITOR_NET` winning, because the compose overlay and
  // the demo script have set both since 00009-08.
  const net = (env.SHIELDED_MONITOR_NET?.trim() ?? env.NET?.trim() ?? "").trim() || "undeployed";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(net)) {
    throw new Error('invalid NET: must match /^[A-Za-z0-9_-]{1,64}$/');
  }
  return {
    upstreams,
    host: env.BALANCER_HOST?.trim() || DEFAULT_HOST,
    port: readInt(env, "BALANCER_PORT", DEFAULT_PORT, 0, 65535),
    net,
    probeMs: readInt(env, "BALANCER_PROBE_MS", DEFAULT_PROBE_MS, 0, 600_000),
    requestTimeoutMs: readInt(env, "BALANCER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 100, 600_000),
    maxBodyBytes: readInt(env, "BALANCER_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES, 1, 8 * 1024 * 1024),
  };
}

export async function runBalancer(env: NodeJS.ProcessEnv = process.env): Promise<() => Promise<void>> {
  const config = loadBalancerConfig(env);
  const balancer = createBalancer({
    ...config,
    logger: (line) => process.stderr.write(`${line}\n`),
  });
  const address = await balancer.listen();
  process.stderr.write(
    `${JSON.stringify({
      at: new Date().toISOString(),
      event: "listening",
      host: address.host,
      port: address.port,
      upstreams: config.upstreams,
      net: config.net,
      selection: "uniform random per request; POST /v1/monitors routed to the node holding the key",
      retry: "GET only, once",
      internalRoutes: "never forwarded (404)",
      authentication: "none (owner decision Q3) — restrict network access at the deployment",
    })}\n`,
  );
  return async () => {
    await balancer.close();
  };
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  // eslint-disable-next-line no-console
  console.log(BALANCER_ENV_DOC);
  process.exit(0);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runBalancer().then(
    (shutdown) => {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
          void shutdown().then(
            () => process.exit(0),
            () => process.exit(1),
          );
        });
      }
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
