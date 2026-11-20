/** E2E check of POST /api/v1/open: the owner signs only EIP-3009, the provider relays and pays gas. */
import { createPublicClient, http, parseEventLogs, toHex, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { aevumTestnet, checkoutTypedData, TUSD8_ADDRESS } from "@aevum-kit/aevum";
import { fairMeterAbi } from "@fairmeter/sdk";

const owner = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY as Hex);
const meter = process.env.FAIRMETER as Hex;
const provider = process.env.PROVIDER as Hex;
const client = createPublicClient({ chain: aevumTestnet, transport: http() });
const agent = privateKeyToAccount(generatePrivateKey()).address;
const terms = {
  owner: owner.address, agent, provider, amount: 300000n, cap: 300000n, perRequestMax: 100000n,
  expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3 * 86400), salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
};
const nonce = await client.readContract({ address: meter, abi: fairMeterAbi, functionName: "openNonce", args: [terms] });
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
const signature = await owner.signTypedData(checkoutTypedData(aevumTestnet.id, TUSD8_ADDRESS, { from: owner.address, to: meter, value: terms.amount, validAfter: 0n, validBefore, nonce }));
const gasBefore = await client.getBalance({ address: owner.address });
const res = await fetch("http://localhost:3000/api/v1/open", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ terms: { ...terms, amount: terms.amount.toString(), cap: terms.cap.toString(), perRequestMax: terms.perRequestMax.toString(), expiresAt: terms.expiresAt.toString() }, validBefore: validBefore.toString(), signature }),
});
const json = await res.json();
console.log("relay:", res.status, json);
if (!res.ok) process.exit(1);
const rc = await client.waitForTransactionReceipt({ hash: json.hash });
const ev = parseEventLogs({ abi: fairMeterAbi, logs: rc.logs, eventName: "MandateOpened" })[0];
console.log(`mandate #${ev.args.mandateId} opened, status=${rc.status}; owner gas spent: ${gasBefore - (await client.getBalance({ address: owner.address }))} wei`);
// Tamper: same signature, different agent -> must be refused
const bad = await fetch("http://localhost:3000/api/v1/open", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ terms: { ...terms, agent: provider, amount: terms.amount.toString(), cap: terms.cap.toString(), perRequestMax: terms.perRequestMax.toString(), expiresAt: terms.expiresAt.toString() }, validBefore: validBefore.toString(), signature }),
});
console.log("tampered terms:", bad.status, (await bad.json()).error?.slice(0, 120));
