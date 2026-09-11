import type { ArchiveRouterOptions } from "../../archive-read-api/server.js";
import { HttpMonitorStore } from "../../shielded-monitor/storage-http-client.js";
import type { ShieldedMonitorStore } from "../../shielded-monitor/store.js";
import {
  DEFAULT_STORAGE_MAX_BLOCKS_PER_PAGE,
  DEFAULT_STORAGE_MAX_BODY_BYTES,
  DEFAULT_STORAGE_SSE_HEARTBEAT_MS,
  type StorageApiConfig,
} from "../../storage-api/config.js";
import { createStorageApi, type StorageApi } from "../../storage-api/server.js";

/**
 * Shared fixtures for the storage-API suites (sub-plan 00009-08 v2).
 *
 * Not a test file: no `describe`, no `it`. It exists so every suite starts the same server the
 * same way — port 0 on loopback, because this is a shared host and a fixed port would collide
 * with a parallel suite or with something else on the box.
 */

export function storageConfig(overrides: Partial<StorageApiConfig> = {}): StorageApiConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    net: "undeployed",
    archiveSchema: "chain_archive",
    monitorSchema: "shielded_monitor",
    maxBlocksPerPage: DEFAULT_STORAGE_MAX_BLOCKS_PER_PAGE,
    sseHeartbeatMs: DEFAULT_STORAGE_SSE_HEARTBEAT_MS,
    maxBodyBytes: DEFAULT_STORAGE_MAX_BODY_BYTES,
    bootstrap: false,
    ...overrides,
  };
}

export interface StartedStorageApi {
  readonly api: StorageApi;
  readonly baseUrl: string;
  readonly client: HttpMonitorStore;
  close(): Promise<void>;
}

/** Starts a storage API over `store` on a kernel-chosen loopback port and returns a client. */
export async function startStorageApi(
  store: ShieldedMonitorStore,
  options: {
    config?: Partial<StorageApiConfig>;
    archive?: StartedArchiveOptions;
  } = {},
): Promise<StartedStorageApi> {
  const config = storageConfig(options.config);
  const api = createStorageApi({
    config,
    store,
    ...(options.archive === undefined
      ? {}
      : {
          archive: {
            archive: options.archive.archive,
            config: {
              host: config.host,
              port: config.port,
              net: config.net,
              schema: config.archiveSchema,
              maxBlocksPerPage: config.maxBlocksPerPage,
              sseHeartbeatMs: config.sseHeartbeatMs,
            },
            ...(options.archive.events === undefined ? {} : { events: options.archive.events }),
          },
        }),
  });
  const address = await api.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    api,
    baseUrl,
    client: new HttpMonitorStore(baseUrl, { requestTimeoutMs: 20_000 }),
    close: async () => {
      await api.close();
    },
  };
}

export interface StartedArchiveOptions {
  readonly archive: ArchiveRouterOptions["archive"];
  readonly events?: ArchiveRouterOptions["events"];
}
