import { describe, expect, it } from "vitest";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";

describe("ChainArchiveSyncService options", () => {
  it.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects replayCheckpointInterval=%s at the service boundary (T6a)",
    (replayCheckpointInterval) => {
      // Construct the reusable service directly. Running these values through the CLI first would
      // let CLI parsing reject them even if constructor validation were deleted -- the audited
      // evidence gap. No method is invoked, so neither the SQL placeholder nor node URL is used.
      expect(() => new ChainArchiveSyncService({
        sql: {} as never,
        net: "constructor-validation",
        node: { url: "http://unused.invalid" },
        replayCheckpointInterval,
      })).toThrow(/replayCheckpointInterval must be a whole number >= 1/);
    },
  );

  it.each([1, 1000])("accepts positive integer replayCheckpointInterval=%s", (value) => {
    // Counterweight: a constructor that rejects every explicit interval would satisfy the table
    // above but make the option unusable.
    expect(() => new ChainArchiveSyncService({
      sql: {} as never,
      net: "constructor-validation",
      node: { url: "http://unused.invalid" },
      replayCheckpointInterval: value,
    })).not.toThrow();
  });
});
