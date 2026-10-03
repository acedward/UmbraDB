import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ledger from "@midnightntwrk/ledger-v9";
import { describe, expect, it } from "vitest";
import { loadTape } from "./fixtures/stagenet-archive/fake-chain-server.js";

/**
 * Project 00026, sub-plan A2 / spec FR-005 (Q13: "the ledger-v9 / compact-runtime versions that
 * decode current Stagenet"): the pinned `@midnightntwrk/ledger-v9` decodes every recorded Stagenet
 * transaction of the MIP-0018 reference cases (00013, heights 714485–715433) -- hash recomputed
 * equal to the indexer's, every action classified, mint effects read -- and its `rawTokenType`
 * reproduces exactly the colors the reference's IDX scan and the wallet observed. No
 * `@midnight-ntwrk/compact-runtime` is needed: the color comes from ledger-v9 itself.
 *
 * Fixtures: `fixtures/stagenet-archive/{c04-714637-714663,cases-sparse}.tape.json` (recorded with
 * `record-tape.ts`). The same tapes drive the archive sync tests.
 */

const LEDGER_VERSION = "1.0.0-rc.3";

/** Colors of the reference IDX scan of 714485–715183 (`deployments/stagenet/cases/IDX/index/index-state.json`
 *  of midnight-experiments/mip-0018 @ daec1f1) plus U1's (715409, `cases/U1/index/index-state.json`),
 *  keyed by `<height>:<kind>`. */
const EXPECTED_MINTS: Record<string, { color: string; contract: string; domainSep: string }> = {
  "714557:shielded": { color: "be34ef4b78717b031040bf625e04ee033106efae4c766915d3cac2b7fda8f11b", contract: "0ee5f31961f9df197055c49dda8f87275af50c3554ba701ffa1837537735e532", domainSep: "6d69702d303031383a6578616d706c653a736869656c64656400000000000000" },
  "714617:unshielded": { color: "8e01e39293a9e21ee2685da06ce487fffafbc1a982d53fcb1a72520f18518484", contract: "a3df52605d8b7210aa3e5cdc82de4bb2911975bc42c1a68be77044723b705f21", domainSep: "6d69702d303031383a6578616d706c653a756e736869656c6465640000000000" },
  "714643:shielded": { color: "042399246139df031a4780c684df8eaecd48b7e03a195bfe986cf22766bcbc16", contract: "86acf80ff386abb610aadbea0406039e7fe39893f440794c3c2bad86dd48570f", domainSep: "6d69702d303031383a6578616d706c653a6d756c74692d6b696e640000000000" },
  "714649:unshielded": { color: "042399246139df031a4780c684df8eaecd48b7e03a195bfe986cf22766bcbc16", contract: "86acf80ff386abb610aadbea0406039e7fe39893f440794c3c2bad86dd48570f", domainSep: "6d69702d303031383a6578616d706c653a6d756c74692d6b696e640000000000" },
  "714683:shielded": { color: "81db4eef83089c5403c6af29d926d57ee6b6359ff7dc291dd19cb4c3e9cf7aa1", contract: "f2d1b6ebfea446cf2624cd498fc585eeb86dddf94e33229ce47107038d2251d6", domainSep: "6d69702d303031383a6578616d706c653a66616d696c793a676f6c6400000000" },
  "714689:shielded": { color: "8c74ec4a937d296f8234a2373812c2df3d962dba06dfe98cda390f9dea38491d", contract: "f2d1b6ebfea446cf2624cd498fc585eeb86dddf94e33229ce47107038d2251d6", domainSep: "6d69702d303031383a6578616d706c653a66616d696c793a73696c7665720000" },
  "714802:shielded": { color: "e5afe273bcb1252cfbc81ad6ca1caaafe22312c8c29f9b104a2fe3ead980bb2d", contract: "7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637", domainSep: "953ecfdd939bcb9df7bb4ddb9deeb4ebfa2447563c08f7973576c7ac492f9600" },
  "715409:shielded": { color: "89a5559202e2d7c111150d84bbcae4c4beb56733373e1935ac74ce565f17ffb0", contract: "11010832a39954d9ccce48f6b5fce25fc789abb1d700ee45b26b69af3e5dd63b", domainSep: "6d69702d303031383a6578616d706c653a757067726164650000000000000000" },
};

interface LooseTranscript {
  program: unknown[];
  effects: { shieldedMints: Map<string, bigint>; unshieldedMints: Map<string, bigint> };
}

const norm = (h: string): string => (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();

describe("ledger-v9 decodes current Stagenet (00026 A2, FR-005 / Q13)", () => {
  it("[[archive.ledger.stagenet-decode]] the pinned ledger-v9 decodes every recorded 00013 case transaction and reproduces the IDX/U1 colors", () => {
    const installed = JSON.parse(readFileSync(join(process.cwd(), "node_modules/@midnightntwrk/ledger-v9/package.json"), "utf8")) as { version: string };
    expect(installed.version).toBe(LEDGER_VERSION);

    const tapes = [loadTape("c04-714637-714663.tape.json"), loadTape("cases-sparse.tape.json")];
    const actionKinds: Record<string, string[]> = {};
    const mints: Record<string, { color: string; contract: string; domainSep: string; phase: string }> = {};
    let transactions = 0;
    let logOps = 0;
    for (const tape of tapes) {
      expect(tape.genesisHash).toBe("0x2f76825abc239fecf6107c9df99016de57037b451ae57a4394b76c8cf53a9491");
      for (const block of tape.blocks) {
        const extrinsics = block.nodeBlock.block.extrinsics.map(norm);
        for (const t of block.indexerBlock.transactions) {
          transactions++;
          expect(t.__typename).toBe("RegularTransaction");
          expect(extrinsics.some((e) => e.includes(norm(t.raw)))).toBe(true); // the archive's CONTAINS cross-check
          const tx = ledger.Transaction.deserialize("signature", "proof", "binding", Buffer.from(t.raw, "hex")) as unknown as {
            transactionHash(): string;
            intents?: Map<number, { actions: unknown[] }>;
          };
          expect(norm(String(tx.transactionHash()))).toBe(norm(t.hash));
          for (const [, intent] of [...(tx.intents ?? new Map())].sort(([a], [b]) => a - b)) {
            for (const action of intent.actions) {
              const kind = action instanceof ledger.ContractCall ? "call"
                : action instanceof ledger.ContractDeploy ? "deploy"
                : action instanceof ledger.MaintenanceUpdate ? "maintenance"
                : "unknown";
              (actionKinds[String(block.height)] ??= []).push(kind);
              if (!(action instanceof ledger.ContractCall)) continue;
              const address = norm(String(action.address));
              for (const [phase, transcript] of [
                ["guaranteed", action.guaranteedTranscript], ["fallible", action.fallibleTranscript],
              ] as const) {
                if (transcript === undefined) continue;
                const tr = transcript as unknown as LooseTranscript;
                logOps += tr.program.filter((op) => op === "log").length;
                for (const [mintKind, map] of [["shielded", tr.effects.shieldedMints], ["unshielded", tr.effects.unshieldedMints]] as const) {
                  for (const [domainSep] of map) {
                    const color = norm(String(ledger.rawTokenType(Buffer.from(norm(domainSep), "hex") as never, address)));
                    mints[`${block.height}:${mintKind}`] = { color, contract: address, domainSep: norm(domainSep), phase };
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(transactions).toBe(20);
    expect(Object.values(actionKinds).flat().filter((k) => k === "unknown")).toEqual([]);
    expect(actionKinds["714637"]).toEqual(["deploy"]); // C04 deploy
    expect(actionKinds["715183"]).toEqual(["maintenance"]); // C10 VerifierKeyRemove
    expect(actionKinds["715428"]).toEqual(["maintenance"]); // U1 VerifierKeyInsert
    expect(logOps).toBe(11); // observed on these 20 transactions (events are sub-plan B2's subject)

    expect(Object.keys(mints).sort()).toEqual(Object.keys(EXPECTED_MINTS).sort());
    for (const [key, expected] of Object.entries(EXPECTED_MINTS)) {
      expect(mints[key]!.color, key).toBe(expected.color);
      expect(mints[key]!.contract, key).toBe(expected.contract);
      expect(mints[key]!.domainSep, key).toBe(expected.domainSep);
      expect(mints[key]!.phase, key).toBe("guaranteed");
    }
    // The reference IDX scan of 714485–715183 found exactly six colors; kinds 1 and 2 of C04 share one.
    const idxColors = new Set(Object.entries(mints).filter(([k]) => Number(k.split(":")[0]) <= 715183).map(([, m]) => m.color));
    expect(idxColors.size).toBe(6);
  });
});
