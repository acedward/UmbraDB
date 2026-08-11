import { describe, expect, it } from "vitest";
import { MethodRegistry } from "../registry.js";

describe("MethodRegistry", () => {
  it("rejects accidental duplicates and permits explicit replacement", async () => {
    const registry = new MethodRegistry();
    registry.registerMethod("method", async () => "first");
    expect(() => registry.registerMethod("method", async () => "second")).toThrow("already registered");
    registry.registerMethod("method", async () => "replacement", { replace: true });
    await expect(registry.getMethod("method")!(undefined, {} as never)).resolves.toBe("replacement");
  });
});

