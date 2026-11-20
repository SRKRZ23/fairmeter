import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, http, keccak256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { aevumTestnet } from "../../aevum/src/chain";
import {
  bindRequestId,
  canonicalJson,
  costOf,
  fairMeterAbi,
  formatTusd8,
  maxPriceFor,
  pqKeyFromSeed,
  signReceipt,
  TIERS,
  usageDigest,
  verifyReceipt,
  type Receipt,
} from "../src/index";

const provider = privateKeyToAccount(generatePrivateKey());
const pq = pqKeyFromSeed(keccak256("0x01"));

function sampleReceipt(): Receipt {
  return {
    v: 1,
    chainId: 44005,
    meter: "0x347bB333a61B804C27B17a949fE763b4BA572380",
    provider: provider.address,
    mandateId: "1",
    requestId: keccak256("0xaa"),
    maxPrice: "400000",
    charge: "12345",
    deadline: 2_000_000_000,
    promptHash: keccak256("0x10"),
    responseHash: keccak256("0x20"),
    route: "cheap",
    reason: "self-check confidence 5/5",
    usage: [{ step: "draft", model: "openai/gpt-oss-20b", inputTokens: 100, outputTokens: 200, cost: "12345" }],
    rates: "test",
    issuedAt: 1_900_000_000,
  };
}

test("canonical JSON ignores key order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: "z" } }), canonicalJson({ a: { c: "z", d: [1, { x: 1, y: 2 }] }, b: 1 }));
});

test("receipt: ECDSA + ML-DSA-65 round trip, and the on-chain key hash check", async () => {
  const s = await signReceipt(sampleReceipt(), provider, pq);
  assert.equal(s.mldsa.publicKey.length, 2 + 1952 * 2);
  assert.equal(s.mldsa.signature.length, 2 + 3309 * 2);
  const ok = await verifyReceipt(s, keccak256(pq.publicKey));
  assert.deepEqual(ok, { hashOk: true, ecdsaOk: true, mldsaOk: true, pqKeyOnChain: true, withinMax: true, ok: true });
  const wrongKey = await verifyReceipt(s, keccak256("0x1234"));
  assert.equal(wrongKey.pqKeyOnChain, false);
  assert.equal(wrongKey.ok, false);
});

test("receipt: a tampered charge is detected", async () => {
  const s = await signReceipt(sampleReceipt(), provider, pq);
  s.receipt.charge = "1";
  const c = await verifyReceipt(s);
  assert.equal(c.hashOk, false);
  assert.equal(c.ok, false);
});

test("receipt: a re-hashed forgery fails both signatures", async () => {
  const { receiptHash } = await import("../src/receipt");
  const s = await signReceipt(sampleReceipt(), provider, pq);
  s.receipt.charge = "999";
  s.receiptHash = receiptHash(s.receipt);
  const c = await verifyReceipt(s);
  assert.equal(c.hashOk, true);
  assert.equal(c.ecdsaOk, false);
  assert.equal(c.mldsaOk, false);
});

test("receipt: charging above the authorized maximum is flagged", async () => {
  const r = sampleReceipt();
  r.charge = "400001";
  const c = await verifyReceipt(await signReceipt(r, provider, pq));
  assert.equal(c.withinMax, false);
  assert.equal(c.ok, false);
});

test("request id binds every quoted term", () => {
  const secret = keccak256("0x5ec7e7") as Hex;
  const base = {
    chainId: 44005,
    meter: "0x347bB333a61B804C27B17a949fE763b4BA572380" as const,
    mandateId: "1",
    promptHash: keccak256("0x10"),
    maxTokens: 512,
    maxPrice: "400000",
    deadline: 2_000_000_000,
    nonce: keccak256("0x99"),
  };
  const id = bindRequestId(secret, base);
  for (const change of [
    { mandateId: "2" },
    { promptHash: keccak256("0x11") },
    { maxTokens: 513 },
    { maxPrice: "400001" },
    { deadline: 2_000_000_001 },
    { nonce: keccak256("0x98") },
  ]) {
    assert.notEqual(bindRequestId(secret, { ...base, ...change }), id, JSON.stringify(change));
  }
  assert.notEqual(bindRequestId(keccak256("0x01"), base), id);
});

test("pricing: ceiling covers the worst case and amounts format cleanly", () => {
  assert.equal(costOf(TIERS.cheap, 1000, 1000), 25_000n);
  assert.equal(costOf(TIERS.cheap, 1, 0), 5n);
  assert.ok(maxPriceFor("hello", 512) > costOf(TIERS.strong, 100, 512));
  assert.ok(maxPriceFor("x".repeat(3000), 512) > maxPriceFor("hello", 512));
  assert.equal(formatTusd8(37000n), "0.037");
  assert.equal(formatTusd8("2000000"), "2");
});

test("EIP-712 usage digest matches the deployed contract on Aevum", { skip: !process.env.ONLINE }, async () => {
  const meter = "0x347bB333a61B804C27B17a949fE763b4BA572380" as const;
  const m = { mandateId: 7n, requestId: keccak256("0x42"), maxPrice: 123456n, deadline: 2_000_000_000n };
  const client = createPublicClient({ chain: aevumTestnet, transport: http() });
  const onchain = await client.readContract({
    address: meter,
    abi: fairMeterAbi,
    functionName: "usageDigest",
    args: [m.mandateId, m.requestId, m.maxPrice, m.deadline],
  });
  assert.equal(usageDigest(44005, meter, m), onchain);
});
