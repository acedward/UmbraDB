/**
 * The browser engine's worker host in a Node worker thread (run with the `tsx` loader), for tests that need the engine
 * on its own thread, as in a browser: PGlite at `workerData.dataDir`, its saved settings in the file
 * `<dataDir>.engine.json` beside it (as beside an OPFS store), the recorded ranges read from the repository's files. Every message is a protocol request answered with one response, and the host's notices are posted, as
 * `worker.ts` does; one test-only message, `{ test: "slow-statement", seconds }`, runs `select pg_sleep(seconds)` on the
 * store's session (between transactions), which keeps the thread busy as a statement that does not return would.
 */
import { parentPort, workerData } from "node:worker_threads";
import { createWorkerHost } from "../../browser/host.ts";
import { openStore, type Store } from "../../browser/store.ts";
import { loadTape } from "../../browser/tapes.ts";
import { fileFetch, nodeSettingsStore, SUPPORTED } from "./worker-host.ts";

const port = parentPort!;
const { dataDir } = workerData as { dataDir: string };
let store: Store | undefined;

const host = createWorkerHost({
  network: "stagenet",
  dataDir,
  nodeUrl: "https://node.invalid/",
  indexerUrl: "https://indexer.invalid/",
  checkCapabilities: async () => SUPPORTED,
  openStore: async (dir, o) => (store = await openStore(dir, o)),
  settings: nodeSettingsStore(`${dataDir}.engine.json`),
  loadTape: (range) => loadTape(range, fileFetch()),
  log: () => {},
});

port.on("message", (message: unknown) => {
  const m = message as { test?: string; seconds?: number };
  if (m !== null && typeof m === "object" && m.test === "slow-statement") {
    const s = store;
    if (s !== undefined) void s.mip0018`select pg_sleep(${m.seconds ?? 1})`.catch(() => {});
    return;
  }
  void host.receive(message).then((r) => port.postMessage(r));
});
host.onNotice((n) => port.postMessage(n));
void host.boot();
