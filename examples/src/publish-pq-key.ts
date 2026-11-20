/**
 * Publish the provider's ML-DSA-65 receipt public key on FairMeter (setReceiptKey). Run once per key.
 *   PROVIDER_PRIVATE_KEY=0x... PQ_SEED=0x... FAIRMETER=0x... pnpm example publish-pq-key
 */
import { createPublicClient, createWalletClient, http, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { aevumTestnet } from "@aevum-kit/aevum";
import { fairMeterAbi, pqKeyFromSeed } from "@fairmeter/sdk";

const provider = privateKeyToAccount(process.env.PROVIDER_PRIVATE_KEY as Hex);
const meter = process.env.FAIRMETER as Hex;
const pq = pqKeyFromSeed(process.env.PQ_SEED as Hex);
const client = createPublicClient({ chain: aevumTestnet, transport: http() });
const wallet = createWalletClient({ account: provider, chain: aevumTestnet, transport: http() });

const want = keccak256(pq.publicKey);
const have = await client.readContract({ address: meter, abi: fairMeterAbi, functionName: "receiptKeyHash", args: [provider.address] });
if (have === want) {
  console.log(`already published: ${want}`);
} else {
  const hash = await wallet.writeContract({ address: meter, abi: fairMeterAbi, functionName: "setReceiptKey", args: [pq.publicKey], type: "legacy" });
  const r = await client.waitForTransactionReceipt({ hash });
  console.log(`published ML-DSA-65 key hash ${want}\n  tx ${hash} status=${r.status} gas=${r.gasUsed}`);
}
