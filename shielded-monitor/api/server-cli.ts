#!/usr/bin/env node
import { openArchiveSource } from "../archive-source.js";
import { HttpMonitorStore } from "../storage-http-client.js";
import { loadApiConfig } from "./config.js";
import { createShieldedMonitorApi, stderrLogger } from "./server.js";
import { archiveSourceTip, unknownSourceTip } from "./source-tip.js";

/**
 * `umbradb-shielded-monitor-api` — the private API as a process (organizer spec FR-026).
 *
 * A separate process from the archive ingester, the storage API and the scanner. Since 00009-08
 * v2 (owner question Q25) it has **no database connection**: every monitor, association and
 * lifecycle record it serves is read through `STORAGE_URL`, and it refuses to start if any `*_PG`
 * variable is present in its environment. Several instances run behind
 * `umbradb-shielded-monitor-balancer`; cursors are monitor-bound, so any instance serves any
 * request.
 *
 * | variable | default | meaning |
 * |---|---|---|
 * | `STORAGE_URL` | — (REQUIRED) | base URL of the `umbradb-storage-api` |
 * | `ARCHIVE_URL` | `STORAGE_URL` | where `/v1/archive/*` is served, for `sourceTip` |
 * | `SHIELDED_MONITOR_NET` | `undeployed` | the one network this deployment serves |
 * | `SOURCE_TIP` | unset | `off` reports `sourceTip: null` (an API with no archive access) |
 * | `API_HOST` | `127.0.0.1` | bind address |
 * | `API_PORT` | `8787` | bind port (`0` asks the kernel for a free one) |
 * | `API_MAX_BODY_BYTES` | `65536` | request body cap |
 * | `API_MAX_PAGE` | `200` | matches page cap |
 * | `API_DEFAULT_PAGE` | `50` | matches page size when the caller does not ask |
 *
 * **This API has no authentication** (owner decision Q3). The default bind is loopback and a
 * deployment that changes it must restrict network access itself — see `README.md` and
 * `docs/shielded-monitor-api.md`.
 */
export async function runApiServer(env: NodeJS.ProcessEnv = process.env): Promise<() => Promise<void>> {
  const config = loadApiConfig(env);
  // Project B's whole persistence surface: one base URL, no pool, no migration, no schema.
  const store = new HttpMonitorStore(config.storageUrl, {
    userAgent: "umbradb-shielded-monitor-api",
  });

  // `sourceTip` (FR-011/FR-020): report the archive's real tip when this deployment can see the
  // archive, and `null` when it cannot. Opt-OUT rather than opt-in, because a permanent
  // `sourceTip: null` would leave a consumer unable to tell "scanned and empty" from "not scanned
  // yet" — the one distinction FR-020 is about. `SOURCE_TIP=off` restores the standalone
  // behaviour for an API deployed without any archive access.
  //
  // 00009-08: WHICH archive implementation is behind it is `openArchiveSource`'s decision, not
  // this file's — `ARCHIVE_URL` selects the HTTP client and no PostgreSQL archive code is loaded
  // at all. Either way it is reached ONLY through the read contract's interface, so Rule B holds.
  // `wake: false`: the API answers requests, it has no loop to wake up.
  const sourceTipProvider = config.sourceTipDisabled
    ? unknownSourceTip()
    : archiveSourceTip(openArchiveSource({ archiveUrl: config.archiveUrl, wake: false }).archive);

  const api = createShieldedMonitorApi({
    store,
    config,
    sourceTipProvider,
    logger: stderrLogger(),
  });
  const address = await api.listen();
  process.stderr.write(
    `${JSON.stringify({
      at: new Date().toISOString(),
      event: "listening",
      host: address.host,
      port: address.port,
      net: config.net,
      storage: config.storageUrl,
      database: "none (owner decision Q25) — all state is reached through STORAGE_URL",
      authentication: "none (owner decision Q3) — restrict network access at the deployment",
    })}\n`,
  );

  return async () => {
    await api.close();
  };
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runApiServer().then(
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
      // The message only: a boot failure is a configuration or connection fault, and a stack
      // trace here is noise in a container log.
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
