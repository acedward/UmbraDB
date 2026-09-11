#!/usr/bin/env node
import { createClient } from "../../src/postgres/client.js";
import { openArchiveSource } from "../archive-source.js";
import { bootstrapShieldedMonitorSchema } from "../bootstrap.js";
import { PgShieldedMonitorStore } from "../store.js";
import { loadApiConfig } from "./config.js";
import { createShieldedMonitorApi, stderrLogger } from "./server.js";
import { archiveSourceTip, unknownSourceTip } from "./source-tip.js";

/**
 * `umbradb-shielded-monitor-api` — the private API as a process (organizer spec FR-026).
 *
 * A separate process from the archive ingester and from the scanner, sharing only the database.
 * Everything is configured through the environment, so the process needs no argument parsing and
 * a container image needs no entrypoint script:
 *
 * | variable | default | meaning |
 * |---|---|---|
 * | `SHIELDED_MONITOR_PG` | `PG*` environment | PostgreSQL connection string |
 * | `SHIELDED_MONITOR_SCHEMA` | `shielded_monitor` | schema project B owns |
 * | `SHIELDED_MONITOR_NET` | `undeployed` | the one network this deployment serves |
 * | `SHIELDED_MONITOR_BOOTSTRAP` | unset | `1` applies the migration lineage at boot |
 * | `ARCHIVE_URL` | unset | base URL of an `umbradb-archive-read-api` — SPLIT topology (00009-08) |
 * | `ARCHIVE_SCHEMA` | `chain_archive` | single-host only: the archive schema whose tip is `sourceTip` |
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
  const connectionString = env.SHIELDED_MONITOR_PG;
  // Project B's OWN database. In the split topology it holds `shielded_monitor` and nothing else.
  const sql = createClient({
    ...(connectionString !== undefined ? { connectionString } : {}),
    schema: config.schema,
  });

  // Opt-in rather than automatic: a service that silently migrates on boot is a service that can
  // migrate a production database because someone started it with the wrong connection string.
  if (env.SHIELDED_MONITOR_BOOTSTRAP === "1") {
    await bootstrapShieldedMonitorSchema(sql, config.schema);
  }

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
    : archiveSourceTip(
        (await openArchiveSource({
          ...(config.archiveUrl === undefined ? {} : { archiveUrl: config.archiveUrl }),
          archiveSchema: config.archiveSchema,
          sql,
          wake: false,
        })).archive,
      );

  const api = createShieldedMonitorApi({
    store: new PgShieldedMonitorStore(sql, config.schema),
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
      schema: config.schema,
      authentication: "none (owner decision Q3) — restrict network access at the deployment",
    })}\n`,
  );

  return async () => {
    await api.close();
    await sql.end({ timeout: 5 });
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
