import { keccak_256 } from "@noble/hashes/sha3.js";
import { MidnightBech32m } from "@midnightntwrk/wallet-sdk-address-format";
import { HDWallet, Roles } from "@midnightntwrk/wallet-sdk-hd";
import { createKeystore } from "@midnightntwrk/wallet-sdk-unshielded-wallet";

export const DEFAULT_ALICE_SEED = "0".repeat(63) + "1";

function assertSeed(seedHex: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    throw new Error("wallet seed must be exactly 32 bytes of hexadecimal");
  }
}

/** Implements the project-wide HD role selection exactly, even though only NightExternal is read. */
export function deriveUnshieldedAddress(seedHex: string, networkId = "undeployed"): string {
  assertSeed(seedHex);
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, "hex"));
  if (hd.type !== "seedOk") throw new Error("HDWallet rejected seed");
  try {
    const result = hd.hdWallet
      .selectAccount(0)
      .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
      .deriveKeysAt(0);
    if (result.type !== "keysDerived") throw new Error("wallet key derivation failed");
    return createKeystore(
      { kind: "schnorr", secret: result.keys[Roles.NightExternal] },
      networkId,
    ).getBech32Address().asString();
  } finally {
    hd.hdWallet.clear();
  }
}

export function midnightAddressBytes(mnAddress: string): Buffer {
  const parsed = MidnightBech32m.parse(mnAddress);
  if (parsed.type !== "addr") throw new Error(`expected an unshielded mn_addr address, got ${parsed.type}`);
  if (parsed.data.length !== 32) throw new Error(`unshielded address must decode to 32 bytes, got ${parsed.data.length}`);
  return Buffer.from(parsed.data);
}

/** `keccak256(raw bech32m payload)[12:32]`, the shared Parts B/C/E mapping contract. */
export function evmAddressBytes(mnAddress: string): Buffer {
  return Buffer.from(keccak_256(midnightAddressBytes(mnAddress))).subarray(12, 32);
}

export function evmAddressHex(mnAddress: string): `0x${string}` {
  return `0x${evmAddressBytes(mnAddress).toString("hex")}`;
}

export function watchedAddressesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const networkId = env.NET ?? "undeployed";
  const seeds = (env.WATCH_SEEDS ?? DEFAULT_ALICE_SEED).split(",").map((v) => v.trim()).filter(Boolean);
  const explicit = (env.WATCH_ADDRESSES ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const addresses = [...seeds.map((seed) => deriveUnshieldedAddress(seed, networkId)), ...explicit];
  for (const address of addresses) midnightAddressBytes(address);
  return [...new Set(addresses)];
}
