/**
 * Bech32m (BIP-350) and the Midnight wallet-address form (project 00026, sub-plan C2; owner decision Q3).
 *
 * Vectors: BIP-350 "Test vectors for Bech32m" and "Test vectors for v0-v16 native segregated witness addresses",
 * copied from https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki (fetched 2026-10-03, file SHA-256
 * 63634b06aa8bae88b31929674736e74964c4598684269ac2b0b140c43a7a0dec). Recorded addresses: the MIP-0018 reference's
 * Stagenet wallets (midnight-experiments/mip-0018 @ daec1f1, `deployments/stagenet/README.md` and
 * `cases/C03/wallet-status.json`, read-only) and the `UserAddress` that case C03's recorded mint output pays.
 */
import { Transaction } from "@midnightntwrk/ledger-v9";
import { describe, expect, it } from "vitest";
import { loadRangeTape } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import {
  Bech32mError, convertBits, decodeBech32m, decodeBech32mWords, decodeWalletAddress, encodeBech32m, encodeBech32mWords,
  MIDNIGHT_MAX_LENGTH, unshieldedAddressHrp, walletAddress,
} from "../mip0018/bech32m.ts";

const VALID = [
  "A1LQFN3A",
  "a1lqfn3a",
  "an83characterlonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11sg7hg6",
  "abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx",
  "11llllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllludsr8",
  "split1checkupstagehandshakeupstreamerranterredcaperredlc445v",
  "?1v759aa",
];

const INVALID: Array<[string, string]> = [
  [`${String.fromCharCode(0x20)}1xj0phk`, "char-out-of-range"],
  [`${String.fromCharCode(0x7f)}1g6xzxy`, "char-out-of-range"],
  [`${String.fromCharCode(0x80)}1vctc34`, "char-out-of-range"],
  ["an84characterslonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11d6pts4", "too-long"],
  ["qyrz8wqd2c9m", "no-separator"],
  ["1qyrz8wqd2c9m", "empty-hrp"],
  ["y1b0jsk6g", "invalid-data-char"],
  ["lt1igcx5c0", "invalid-data-char"],
  ["in1muywd", "checksum-too-short"],
  ["mm1crxm3i", "invalid-data-char"],
  ["au1s5cgom", "invalid-data-char"],
  ["M1VUXWEZ", "bad-checksum"],
  ["16plkw9", "empty-hrp"],
  ["1p2gdwpf", "empty-hrp"],
];

/** BIP-350 valid segwit addresses → scriptPubKey hex. v0 uses Bech32 (rejected here), v1+ Bech32m. */
const SEGWIT_VALID: Array<[string, string]> = [
  ["BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", "0014751e76e8199196d454941c45d1b3a323f1433bd6"],
  ["tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", "00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262"],
  ["bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y", "5128751e76e8199196d454941c45d1b3a323f1433bd6751e76e8199196d454941c45d1b3a323f1433bd6"],
  ["BC1SW50QGDZ25J", "6002751e"],
  ["bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs", "5210751e76e8199196d454941c45d1b3a323"],
  ["tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy", "0020000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433"],
  ["tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c", "5120000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433"],
  ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", "512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"],
];

/** BIP-350 invalid segwit addresses whose reason sits at the Bech32m layer (checksum, character, case, padding). */
const SEGWIT_INVALID_CHECKSUM_LAYER: Array<[string, string]> = [
  ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd", "bad-checksum"], // Bech32 instead of Bech32m
  ["tb1z0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqglt7rf", "bad-checksum"],
  ["BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL", "bad-checksum"],
  ["bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4", "invalid-data-char"],
  ["tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq", "mixed-case"],
];

/** Segwit decoding on top of the words layer (BIP-350 reference): version word, then the 8-bit program. */
function segwitScript(address: string): string | undefined {
  const { words } = decodeBech32mWords(address);
  const version = words[0]!;
  const program = convertBits(words.slice(1), 5, 8, false);
  if (program === undefined || version > 16 || program.length < 2 || program.length > 40) return undefined;
  return Buffer.from([version === 0 ? 0 : version + 0x50, program.length, ...program]).toString("hex");
}

const WALLET_1 = "mn_addr_stagenet1vw57646su9y5z6myarm93m6kcn62j97z0yma94lfkhmta6pz5h5q6utr3k";
const WALLET_2 = "mn_addr_stagenet1vmwmprvxd0m7uet2dtasq24rl2u2xecmkss3x5zndvm9vglea40qqgdz2d";
const WALLET_1_SHIELDED = "mn_shield-addr_stagenet1emrpxc3lmnytr5nl9wzkp0agas2egpfup32fmu2swt58tlypctn4lgtpafg22anv2y4f0wf7lqu2s00fg8ndp0qaxnez29xzexmd2qcm9wudk";
const WALLET_1_COIN_PUBLIC_KEY = "cec613623fdcc8b1d27f2b8560bfa8ec1594053c0c549df15072e875fc81c2e7";
const WALLET_1_DUST = "mn_dust_stagenet1wwjujztruwqkkem9mgdl26kx4w4ksdjx7qyrgmcegxve44468ex52wvf9a6";

describe("Bech32m (BIP-350) and Midnight wallet addresses (00026 C2)", () => {
  it("[[mip0018.bech32m.bip350-vectors]] BIP-350's valid strings decode and re-encode, its invalid strings fail for the stated reason, and its segwit vectors hold at the Bech32m layer", () => {
    for (const v of VALID) {
      const { hrp, words } = decodeBech32mWords(v);
      expect(encodeBech32mWords(hrp, words), v).toBe(v.toLowerCase());
    }
    for (const [v, failure] of INVALID) {
      let got: unknown;
      try { decodeBech32mWords(v); } catch (e) { got = e; }
      expect(got, JSON.stringify(v)).toBeInstanceOf(Bech32mError);
      expect((got as Bech32mError).failure, JSON.stringify(v)).toBe(failure);
      expect((got as Bech32mError).message.includes(v.slice(2)), "errors never echo the input").toBe(false);
    }
    // The 90-character cap is BIP's; a caller that allows Midnight lengths can read the 91-character string's words.
    expect(decodeBech32mWords(INVALID[3]![0], { limit: MIDNIGHT_MAX_LENGTH }).hrp).toHaveLength(84);

    for (const [address, script] of SEGWIT_VALID) {
      if (/^(bc|tb)1q/i.test(address)) {
        expect(() => decodeBech32mWords(address), address).toThrow(/bad-checksum/); // v0 = Bech32, not Bech32m
      } else {
        expect(segwitScript(address), address).toBe(script);
      }
    }
    for (const [address, failure] of SEGWIT_INVALID_CHECKSUM_LAYER) {
      expect(() => decodeBech32mWords(address), address).toThrow(new Bech32mError(failure as never).message);
    }
    expect(segwitScript("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf")).toBeUndefined(); // > 4 padding bits
    expect(segwitScript("tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j")).toBeUndefined(); // non-zero padding
    expect(() => decodeBech32m("tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j")).toThrow(/invalid-padding/);

    // Byte layer: every length 0..40 round-trips; the encoder refuses what the decoder would refuse.
    for (let n = 0; n <= 40; n++) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      const s = encodeBech32m("mn_test", data);
      expect(decodeBech32m(s)).toEqual({ hrp: "mn_test", data });
    }
    expect(() => encodeBech32m("MN", new Uint8Array(1))).toThrow(/lowercase/);
    expect(() => encodeBech32m("", new Uint8Array(1))).toThrow(/empty hrp/);
    expect(() => encodeBech32m("a b", new Uint8Array(1))).toThrow(/out of range/);
    expect(() => encodeBech32mWords("a", [32])).toThrow(/5 bits/);
    expect(() => encodeBech32m("a", new Uint8Array(60))).toThrow(/longer than 90/);
  });

  it("[[mip0018.bech32m.recorded]] the recorded Stagenet addresses round-trip; C03's recorded mint output pays wallet 1; HRP rule; never anything but 32 bytes", () => {
    // The UserAddress case C03's mint (block 714617) pays, read from the recorded transaction bytes.
    const block = loadRangeTape("idx").blocks.find((b) => b.height === 714617)!;
    const raw = Buffer.from(block.indexerBlock.transactions[0]!.raw!.replace(/^0x/, ""), "hex");
    const tx = Transaction.deserialize("signature", "proof", "binding", raw);
    const owners = [...tx.intents!.values()].flatMap((i) => i.guaranteedUnshieldedOffer?.outputs ?? []).map((o) => o.owner);
    expect(owners).toEqual(["63a9ed5750e149416b64e8f658ef56c4f4a917c27937d2d7e9b5f6bee822a5e8"]);
    expect(walletAddress("stagenet", owners[0]!)).toBe(WALLET_1);
    expect(walletAddress("stagenet", `0x${owners[0]!.toUpperCase()}`)).toBe(WALLET_1);

    for (const a of [WALLET_1, WALLET_2]) {
      const hex = decodeWalletAddress("stagenet", a);
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
      expect(walletAddress("stagenet", hex)).toBe(a);
      expect(decodeWalletAddress("stagenet", a.toUpperCase())).toBe(hex); // one case only, either case
    }
    expect(decodeWalletAddress("stagenet", WALLET_1)).not.toBe(decodeWalletAddress("stagenet", WALLET_2));

    // Midnight's other wallet encodings use the same Bech32m layer (longer than BIP's 90 characters); they never
    // appear in activity rows (a shielded output is a commitment; DUST has no activity rows).
    expect(() => decodeBech32m(WALLET_1_SHIELDED)).toThrow(/too-long/);
    const shielded = decodeBech32m(WALLET_1_SHIELDED, { limit: MIDNIGHT_MAX_LENGTH });
    expect(shielded.hrp).toBe("mn_shield-addr_stagenet");
    expect(shielded.data).toHaveLength(64);
    expect(Buffer.from(shielded.data.subarray(0, 32)).toString("hex")).toBe(WALLET_1_COIN_PUBLIC_KEY); // coin public key first
    expect(encodeBech32m(shielded.hrp, shielded.data, { limit: MIDNIGHT_MAX_LENGTH })).toBe(WALLET_1_SHIELDED);
    const dust = decodeBech32m(WALLET_1_DUST);
    expect(dust.hrp).toBe("mn_dust_stagenet");
    expect(encodeBech32m(dust.hrp, dust.data)).toBe(WALLET_1_DUST);

    // HRP: `mn_addr_<network>`, no network segment on mainnet.
    expect(unshieldedAddressHrp("stagenet")).toBe("mn_addr_stagenet");
    expect(unshieldedAddressHrp("Preprod")).toBe("mn_addr_preprod");
    expect(unshieldedAddressHrp("mainnet")).toBe("mn_addr");
    expect(walletAddress("mainnet", owners[0]!).startsWith("mn_addr1")).toBe(true);
    expect(() => unshieldedAddressHrp("")).toThrow(/empty network/);
    expect(() => unshieldedAddressHrp("bad net")).toThrow(/out of range/);

    // Refusals: another network's address, a 31-byte payload, non-hex, a corrupted character.
    expect(() => decodeWalletAddress("preprod", WALLET_1)).toThrow(/wrong-hrp/);
    expect(() => decodeWalletAddress("stagenet", encodeBech32m("mn_addr_stagenet", new Uint8Array(31)))).toThrow(/wrong-length/);
    expect(() => walletAddress("stagenet", "00".repeat(31))).toThrow(/32 bytes/);
    expect(() => walletAddress("stagenet", "zz".repeat(32))).toThrow(/32 bytes/);
    const corrupted = `${WALLET_1.slice(0, -1)}${WALLET_1.endsWith("q") ? "p" : "q"}`;
    expect(() => decodeWalletAddress("stagenet", corrupted)).toThrow(/bad-checksum/);
    expect(() => decodeWalletAddress("stagenet", `${WALLET_1.slice(0, 20).toUpperCase()}${WALLET_1.slice(20)}`)).toThrow(/mixed-case/);
  });
});
