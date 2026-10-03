/**
 * Runs the MIP-0018 scan over an already archived block range:
 *
 *   PG_URL=postgres://… node --import tsx token-indexer/mip0018/scan-cli.ts --network stagenet [--from N] [--to M]
 *     [--max-blocks 100] [--schema mip0018] [--archive-schema chain_archive]
 *
 * The archive is filled first by `chain-archive-sync/sync-cli.ts --from N --to M`. The scan stops when it reaches
 * `--to` or the archive's last height, printing one JSON line per batch and a final summary; exit 0. Re-running
 * resumes at the scan's own cursor.
 */
import { parseArgs } from "node:util";
import { createClient } from "../../src/postgres/client.js";
import { Mip0018Scanner } from "./scan.ts";

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = console.log): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      network: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      "max-blocks": { type: "string", default: "100" },
      schema: { type: "string", default: "mip0018" },
      "archive-schema": { type: "string", default: "chain_archive" },
    },
    strict: true,
  });
  const url = env.PG_URL;
  if (url === undefined || values.network === undefined) throw new Error("usage: PG_URL=… scan-cli.ts --network <net> [--from N] [--to M] [--max-blocks K]");
  const int = (v: string | undefined, what: string): number | undefined => {
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v)) throw new Error(`--${what} must be a non-negative integer`);
    return Number(v);
  };
  const sql = createClient({ connectionString: url, schema: values.schema });
  try {
    const scanner = new Mip0018Scanner({
      sql, network: values.network, schema: values.schema, archiveSchema: values["archive-schema"],
      ...(values.from === undefined ? {} : { fromHeight: int(values.from, "from")! }),
      ...(values.to === undefined ? {} : { toHeight: int(values.to, "to")! }),
    });
    await scanner.bootstrap();
    const maxBlocks = int(values["max-blocks"], "max-blocks")!;
    for (;;) {
      const r = await scanner.scanOnce({ maxBlocks });
      log(JSON.stringify({ event: "batch", ...r }));
      if (r.reachedEnd || r.scannedBlocks === 0) break;
    }
    log(JSON.stringify({ event: "done", cursor: await scanner.getCursor() }));
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1]?.endsWith("scan-cli.ts")) {
  process.exitCode = await main(process.argv.slice(2));
}
