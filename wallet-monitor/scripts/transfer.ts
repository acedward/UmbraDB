import * as ledger from "@midnightntwrk/ledger-v9";
import { MidnightBech32m, UnshieldedAddress } from "@midnightntwrk/wallet-sdk-address-format";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { HDWallet, Roles } from "@midnightntwrk/wallet-sdk-hd";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import { createKeystore, PublicKey, UnshieldedWallet } from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import { jsonLog } from "../log.js";

const ALICE_SEED = "0".repeat(63) + "1";
const BOB_SEED = "0".repeat(63) + "2";

const noopTxHistoryStorage = {
  gotPending: async () => undefined,
  gotFinalized: async () => undefined,
  gotRejected: async () => undefined,
  getAll: async () => [] as unknown[],
  get: async () => undefined,
  serialize: async () => "[]",
};

function deriveKeys(seedHex: string) {
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, "hex"));
  if (hd.type !== "seedOk") throw new Error("invalid wallet seed");
  try {
    const result = hd.hdWallet
      .selectAccount(0)
      .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
      .deriveKeysAt(0);
    if (result.type !== "keysDerived") throw new Error("wallet key derivation failed");
    return result.keys;
  } finally {
    hd.hdWallet.clear();
  }
}

function wsRelayUrl(nodeUrl: string): string {
  const url = new URL(nodeUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function main(): Promise<void> {
  const networkId = process.env.NET ?? "undeployed";
  const nodeUrl = process.env.NODE_URL ?? "http://127.0.0.1:10000";
  const indexerHttp = process.env.INDEXER_URL ?? "http://127.0.0.1:10001/api/v4/graphql";
  const indexerWs = process.env.INDEXER_WS ?? "ws://127.0.0.1:10001/api/v4/graphql/ws";
  const proofUrl = process.env.PROOF_URL ?? "http://127.0.0.1:10002";
  const amount = BigInt(process.env.TRANSFER_AMOUNT ?? "1000000");
  if (amount <= 0n) throw new Error("TRANSFER_AMOUNT must be positive");

  const aliceKeys = deriveKeys(process.env.FROM_SEED ?? ALICE_SEED);
  const bobKeys = deriveKeys(process.env.TO_SEED ?? BOB_SEED);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(aliceKeys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(aliceKeys[Roles.Dust]);
  const aliceKeystore = createKeystore(
    { kind: "schnorr", secret: aliceKeys[Roles.NightExternal] },
    networkId,
  );
  const bobKeystore = createKeystore(
    { kind: "schnorr", secret: bobKeys[Roles.NightExternal] },
    networkId,
  );

  const configuration = {
    networkId,
    indexerClientConnection: { indexerHttpUrl: indexerHttp, indexerWsUrl: indexerWs },
    provingServerUrl: new URL(proofUrl),
    relayURL: new URL(wsRelayUrl(nodeUrl)),
    costParameters: { feeBlocksMargin: Number(process.env.FEE_BLOCKS_MARGIN ?? "100") },
    txHistoryStorage: noopTxHistoryStorage,
  };
  const wallet = await WalletFacade.init({
    configuration: configuration as never,
    shielded: (config: unknown) => ShieldedWallet(config as never).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (config: unknown) =>
      UnshieldedWallet(config as never).startWithPublicKey(PublicKey.fromKeyStore(aliceKeystore)),
    dust: (config: unknown) => DustWallet(config as never).startWithSecretKey(
      dustSecretKey,
      ledger.LedgerParameters.initialParameters().dust,
    ),
  } as never);

  try {
    await wallet.start(shieldedSecretKeys, dustSecretKey);
    await wallet.waitForSyncedState();
    // Avoid the early isSynced true/false flap observed on young local chains.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await wallet.waitForSyncedState();

    const receiver = MidnightBech32m.parse(bobKeystore.getBech32Address().asString())
      .decode(UnshieldedAddress, networkId);
    const ttl = new Date(Date.now() + 30 * 60 * 1000);
    const recipe = await wallet.transferTransaction([
      {
        type: "unshielded",
        outputs: [{ type: ledger.nativeToken().raw, receiverAddress: receiver, amount }],
      },
    ], { shieldedSecretKeys, dustSecretKey }, { ttl, payFees: true });
    const signed = await wallet.signRecipe(recipe, (payload) => aliceKeystore.signDataAsync(payload));
    const finalized = await wallet.finalizeRecipe(signed);
    const identifier = await wallet.submitTransaction(finalized);
    jsonLog("wallet-transfer", "submitted", {
      identifier,
      amount: amount.toString(),
      from: aliceKeystore.getBech32Address().asString(),
      to: bobKeystore.getBech32Address().asString(),
    });
  } finally {
    await wallet.stop();
    shieldedSecretKeys.clear();
    dustSecretKey.clear();
  }
}

await main();
