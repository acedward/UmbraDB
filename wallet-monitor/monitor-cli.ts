import { pathToFileURL } from "node:url";
import { runArchiveSync } from "../chain-archive-sync/sync-cli.js";
import { jsonLog } from "./log.js";
import { runWalletMonitor } from "./monitor.js";

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = (signal: string): void => {
    jsonLog("monitor", "signal", { signal });
    controller.abort();
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  jsonLog("monitor", "start");
  try {
    await Promise.all([runArchiveSync(controller.signal), runWalletMonitor(controller.signal)]);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    jsonLog("monitor", "stop");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
