#!/usr/bin/env node
/**
 * Runs the MIP-0018 vectors against any consumer that implements the runner contract (vectors/README.md).
 *
 *   node vectors/tools/run.ts --consumer "<command>" [options]
 *
 * Options:
 *   --consumer <cmd>     command started with `sh -c`; it reads one JSON request per line on stdin and writes one
 *                        JSON response per line on stdout (required)
 *   --dir <path>         vectors folder (default: this package)
 *   --only <ids>         comma-separated vector ids or MIP test ids (e.g. A1,R2,S9a)
 *   --normative-only     skip informative vectors
 *   --notes              also print informative differences (reason codes, offsets)
 *   --json <file>        also write the full report as JSON
 *   --timeout <ms>       per-request timeout (default 10000)
 *   --no-verify          do not check SHA256SUMS first
 *
 * Relative paths (the consumer command, --dir, --json) are resolved against the directory the command was started
 * from — `INIT_CWD` when run through `npm run` (npm runs workspace scripts inside the workspace folder).
 *
 * Exit status: 0 = every normative vector passed; 1 = at least one normative vector failed; 2 = usage, integrity
 * or harness error. Informative failures are reported but do not change the exit status.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { VECTORS_DIR, verifySums } from './common.ts';
import { formatReport, loadVectors, runVectors, type Json } from './runner-core.ts';

/** Where the user started the command (npm sets INIT_CWD; scripts of a workspace otherwise run in its folder). */
const BASE_CWD = process.env.INIT_CWD ?? process.cwd();

interface Args {
  consumer?: string;
  dir: string;
  only: string[];
  normativeOnly: boolean;
  notes: boolean;
  json?: string;
  timeout: number;
  verify: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { dir: VECTORS_DIR, only: [], normativeOnly: false, notes: false, timeout: 10_000, verify: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--consumer':
        a.consumer = next();
        break;
      case '--dir':
        a.dir = resolve(BASE_CWD, next());
        break;
      case '--only':
        a.only.push(...next().split(',').filter(Boolean));
        break;
      case '--normative-only':
        a.normativeOnly = true;
        break;
      case '--notes':
        a.notes = true;
        break;
      case '--json':
        a.json = resolve(BASE_CWD, next());
        break;
      case '--timeout':
        a.timeout = Number(next());
        break;
      case '--no-verify':
        a.verify = false;
        break;
      case '--help':
      case '-h':
        throw new Error('help');
      default:
        throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  return a;
}

/** A consumer process speaking the line protocol. */
class LineConsumer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting: Array<{ resolve: (v: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  private exited: string | undefined;
  private readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    this.timeoutMs = timeoutMs;
    this.child = spawn('sh', ['-c', command], { cwd: BASE_CWD, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', (d: Buffer) => process.stderr.write(d));
    this.child.stdin.on('error', () => undefined);
    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', (line) => {
      const w = this.waiting.shift();
      if (w === undefined) {
        process.stderr.write(`runner: unexpected output from consumer: ${line.slice(0, 200)}\n`);
        return;
      }
      clearTimeout(w.timer);
      try {
        const v = JSON.parse(line) as unknown;
        if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('response is not a JSON object');
        w.resolve(v as Json);
      } catch (e) {
        w.reject(new Error(`invalid JSON response: ${(e as Error).message}`));
      }
    });
    this.child.on('exit', (code, signal) => {
      this.exited = `consumer exited (code ${String(code)}, signal ${String(signal)})`;
      for (const w of this.waiting.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error(this.exited));
      }
    });
    this.child.on('error', (e) => {
      this.exited = `cannot start consumer: ${e.message}`;
    });
  }

  request(req: Json): Promise<Json> {
    if (this.exited !== undefined) return Promise.reject(new Error(this.exited));
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiting.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new Error(`timeout after ${this.timeoutMs} ms`));
        // A late answer would be paired with the wrong request: stop the consumer.
        this.child.kill('SIGKILL');
      }, this.timeoutMs);
      this.waiting.push({ resolve: resolvePromise, reject, timer });
      this.child.stdin.write(`${JSON.stringify(req)}\n`);
    });
  }

  close(): void {
    this.child.stdin.end();
    setTimeout(() => this.child.kill('SIGKILL'), 2000).unref();
  }
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.consumer === undefined) throw new Error('--consumer is required');
  } catch (e) {
    const msg = (e as Error).message;
    if (msg !== 'help') console.error(`run: ${msg}`);
    console.error(
      'usage: node vectors/tools/run.ts --consumer "<command>" [--only ids] [--normative-only] [--notes] [--json file] [--timeout ms] [--no-verify]',
    );
    return 2;
  }
  if (args.verify) {
    const problems = verifySums(args.dir);
    if (problems.length > 0) {
      console.error(`run: SHA256SUMS check failed (${problems.length}):`);
      for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
      return 2;
    }
  }
  const vectors = loadVectors({ dir: args.dir, informative: !args.normativeOnly, only: args.only });
  if (vectors.length === 0) {
    console.error('run: no vectors selected');
    return 2;
  }
  const consumer = new LineConsumer(args.consumer as string, args.timeout);
  const report = await runVectors(vectors, (req) => consumer.request(req));
  consumer.close();
  console.log(formatReport(report, { notes: args.notes }));
  if (args.json !== undefined) writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
  return report.normative.passed === report.normative.total ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`run: ${(e as Error).stack ?? String(e)}`);
    process.exitCode = 2;
  },
);
