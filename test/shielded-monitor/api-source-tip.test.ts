import { describe, expect, it } from "vitest";
import type {
  ArchiveBlockPage,
  ArchiveIdentity,
  ArchiveReadContract,
} from "../../src/interfaces/archive-read-contract.js";
import type { Hex32 } from "../../src/interfaces/chain-archive-store.js";
import { archiveSourceTip, staticSourceTip, unknownSourceTip } from "../../shielded-monitor/api/source-tip.js";

/**
 * `archiveSourceTip` — the provider that closes the one gap the Phase 3 / Phase 4 branch split
 * left open (organizer question Q14, spec FR-011 / FR-020).
 *
 * Q14's resolution says the field is always present, `null` when unobserved, "behind an
 * injectable `SourceTipProvider` seam … Phase 3 supplies a provider backed by the archive read
 * contract and nothing on the wire changes". Phase 3 and Phase 4 were built on separate branches,
 * so nobody ever supplied it: the merged API process would have reported `sourceTip: null`
 * forever, with the archive sitting in the same database. That is not a cosmetic gap — a consumer
 * decides "am I caught up?" by comparing `scannedThrough` with `sourceTip`, and a permanent
 * `null` makes the FR-020 distinction between "scanned and empty" and "not scanned yet"
 * unanswerable.
 *
 * No Docker: the contract is an interface, so the laws below are checked against doubles. What
 * they pin is the behaviour the interface promises — the tip is read, the page is not, and a
 * request that would page real blocks is never issued.
 */
describe("archiveSourceTip (FR-011, FR-020, Q14)", () => {
  class RecordingArchive implements ArchiveReadContract {
    readonly calls: Array<{ net: string; afterHeight: number; maxBlocks: number }> = [];
    constructor(private readonly page: ArchiveBlockPage) {}
    async readBlocksSince(net: string, afterHeight: number, maxBlocks: number): Promise<ArchiveBlockPage> {
      this.calls.push({ net, afterHeight, maxBlocks });
      return this.page;
    }
    async getArchiveIdentity(): Promise<ArchiveIdentity | undefined> {
      throw new Error("the tip provider must not need the archive's identity");
    }
  }

  const tipPage = (height: number): ArchiveBlockPage => ({
    blocks: [],
    sourceTip: { height, hash: "a".repeat(64) as Hex32 },
  });

  it("reports the archive's real tip as a bigint", async () => {
    const archive = new RecordingArchive(tipPage(4_711));
    await expect(archiveSourceTip(archive).sourceTip("undeployed")).resolves.toBe(4711n);
  });

  it("asks for a page that cannot contain a block, so reading the tip never reads history", async () => {
    const archive = new RecordingArchive(tipPage(12));
    await archiveSourceTip(archive).sourceTip("undeployed");
    expect(archive.calls).toHaveLength(1);
    const [call] = archive.calls;
    expect(call?.net).toBe("undeployed");
    // `maxBlocks` must still be >= 1 (the contract refuses 0 — a zero page reads as "caught up"),
    // so the page is kept empty by asking for blocks ABOVE any height the archive can hold.
    expect(call?.maxBlocks).toBe(1);
    expect(call?.afterHeight).toBeGreaterThanOrEqual(Number.MAX_SAFE_INTEGER - 1);
  });

  it("reports undefined — never 0 — for an archive with no blocks at all", async () => {
    const archive = new RecordingArchive({ blocks: [] });
    await expect(archiveSourceTip(archive).sourceTip("undeployed")).resolves.toBeUndefined();
  });

  it("propagates a read failure instead of hiding a broken reader as 'unobserved'", async () => {
    const broken: ArchiveReadContract = {
      readBlocksSince: async () => {
        throw new Error("archive unreachable");
      },
      getArchiveIdentity: async () => undefined,
    };
    // The server degrades a provider fault to "unknown" once, at the call site. Swallowing it
    // here too would make a permanently broken reader indistinguishable from an archive-less
    // deployment.
    await expect(archiveSourceTip(broken).sourceTip("undeployed")).rejects.toThrow(/archive unreachable/);
  });

  it("keeps the two shipped alternatives intact", async () => {
    await expect(unknownSourceTip().sourceTip("undeployed")).resolves.toBeUndefined();
    await expect(staticSourceTip(9n).sourceTip("undeployed")).resolves.toBe(9n);
  });
});
