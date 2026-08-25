import { describe, expect, it } from "vitest";
import { publicEndpoint, publicErrorMessage } from "./log.js";

describe("publicEndpoint", () => {
  it("removes credentials, query tokens, and fragments from logged endpoints", () => {
    expect(publicEndpoint("wss://alice:secret@indexer.example/ws?apiKey=token#private"))
      .toBe("wss://indexer.example/ws");
  });

  it("redacts a configured endpoint repeated by a lower-level error", () => {
    const privateUrl = "https://alice:secret@indexer.example/graphql?apiKey=token#private";
    expect(publicErrorMessage(new Error(`fetch ${privateUrl} failed`), [privateUrl]))
      .toBe("fetch https://indexer.example/graphql failed");
  });

  it("redacts normalized and peer-echoed URL variants, not only the exact configured string", () => {
    const privateUrl = "https://alice:secret@indexer.example/graphql?apiKey=token#private";
    expect(publicErrorMessage(
      new Error("fetch https://alice:secret@indexer.example/graphql?apiKey=token failed"),
      [privateUrl],
    )).toBe("fetch https://indexer.example/graphql failed");
    expect(publicErrorMessage(new Error("peer echoed wss://bob:key@other.example/ws?jwt=secret")))
      .toBe("peer echoed wss://other.example/ws");
  });
});
