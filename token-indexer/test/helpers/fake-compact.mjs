#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Project 00024-02 task C6 — a STAND-IN for the Compact CLI (`COMPACT_BIN`), for the governed Level 3
// test: CI (`.github/workflows/conformance.yml`, ubuntu-latest) has no Compact compiler, so the real
// Level 3 code (`token-indexer/interface/level3.ts`) is driven against this program, which answers the
// two invocations Level 3 makes exactly as `compact` 0.2.0 does:
//
//   compile +<version> --version            prints <version> if it is "installed", else the CLI's error
//   compile +<version> --trace-search [flags] <src> <out>
//                                           prints the configured trace lines on stderr, then writes the
//                                           configured output tree into <out> (a recorded compile)
//
// Configured by environment variables (never by the bundle):
//   FAKE_COMPACT_VERSIONS   comma-separated installed versions (default "0.34.0")
//   FAKE_COMPACT_OUTPUT     directory copied into <out> (keys/, contract/, compiler/)
//   FAKE_COMPACT_TRACE      JSON array of lines printed on stderr before compiling
//   FAKE_COMPACT_SLEEP_MS   wait this long before answering the compile (deadline tests)
//   FAKE_COMPACT_EXIT       exit with this status after the trace (and FAKE_COMPACT_STDERR)
//   FAKE_COMPACT_LOG        append one JSON line per invocation: argv, cwd, whether COMPACT_PATH was set,
//                           and every file under cwd (Level 3 must give the compiler the listed files only)
//   FAKE_COMPACT_TOUCH      create this file (relative to cwd) before printing the trace
//   FAKE_COMPACT_PROBE_EXIT the exit status of Level 3's PROBE compile (a source named
//                           umbradb-l3-probe.compact; default 0 = the environment works: it writes
//                           keys/probe.verifier), with FAKE_COMPACT_PROBE_STDERR — the probe ignores the
//                           other FAKE_COMPACT_* settings, which describe the bundle's compile
// The real-compiler test (environment-gated) runs the host's `compact` instead.
import { appendFileSync, cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_COMPACT_LOG) {
  const files = readdirSync(process.cwd(), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile()).map((d) => `${d.parentPath}/${d.name}`.slice(process.cwd().length + 1)).sort();
  appendFileSync(process.env.FAKE_COMPACT_LOG, `${JSON.stringify({ args, cwd: process.cwd(), compactPath: process.env.COMPACT_PATH !== undefined, files })}\n`);
}
const [sub, plus, ...rest] = args;
const installed = (process.env.FAKE_COMPACT_VERSIONS ?? '0.34.0').split(',').filter(Boolean);
if (sub !== 'compile' || !plus?.startsWith('+')) {
  process.stderr.write(`fake compact: unsupported invocation ${JSON.stringify(args)}\n`);
  process.exit(2);
}
const version = plus.slice(1);
if (!installed.includes(version)) {
  process.stderr.write(`Error: Failed to run compactc\n\nCaused by:\n    0: Couldn't find compiler for x86_64-unknown-linux-musl (${version})\n`);
  process.exit(1);
}
if (rest[0] === '--version') {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}
const out = rest.at(-1);
if ((rest.at(-2) ?? '').endsWith('umbradb-l3-probe.compact')) {
  const code = Number(process.env.FAKE_COMPACT_PROBE_EXIT ?? 0);
  if (code !== 0) {
    process.stderr.write(`${process.env.FAKE_COMPACT_PROBE_STDERR ?? 'Exception: probe failed'}\n`);
    process.exit(code);
  }
  mkdirSync(`${out}/keys`, { recursive: true });
  writeFileSync(`${out}/keys/probe.verifier`, 'fake verifier key\n');
  process.exit(0);
}
const sleep = Number(process.env.FAKE_COMPACT_SLEEP_MS ?? 0);
if (sleep > 0) await new Promise((resolve) => setTimeout(resolve, sleep));
if (process.env.FAKE_COMPACT_TOUCH) writeFileSync(process.env.FAKE_COMPACT_TOUCH, 'export circuit x(): [] {}\n');
for (const line of JSON.parse(process.env.FAKE_COMPACT_TRACE ?? '[]')) process.stderr.write(`${line}\n`);
if (process.env.FAKE_COMPACT_EXIT) {
  process.stderr.write(`${process.env.FAKE_COMPACT_STDERR ?? 'Exception: compile error'}\n`);
  process.exit(Number(process.env.FAKE_COMPACT_EXIT));
}
mkdirSync(out, { recursive: true });
if (process.env.FAKE_COMPACT_OUTPUT) cpSync(process.env.FAKE_COMPACT_OUTPUT, out, { recursive: true });
process.stdout.write('Compiling (fake)\n');
