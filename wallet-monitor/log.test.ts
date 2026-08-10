import { describe, expect, it } from "vitest";
import { publicEndpoint } from "./log.js";

describe("publicEndpoint", () => {
  it("removes credentials, query tokens, and fragments from logged endpoints", () => {
    expect(publicEndpoint("wss://alice:secret@indexer.example/ws?apiKey=token#private"))
      .toBe("wss://indexer.example/ws");
  });
});
