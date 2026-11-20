import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import {
  bytesToHex,
  hexToBytes,
  keccak256,
  recoverMessageAddress,
  toBytes,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";

/** One model call inside a request: which model ran and what it cost. Amounts are tUSD8 base units (6 decimals). */
export interface UsageLine {
  step: "guard" | "draft" | "check" | "escalate";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: string;
}

/** What the provider attests to for one paid request. Everything an auditor needs to recompute the charge. */
export interface Receipt {
  v: 1;
  chainId: number;
  meter: Address;
  provider: Address;
  mandateId: string;
  requestId: Hex;
  maxPrice: string;
  charge: string;
  deadline: number;
  promptHash: Hex;
  responseHash: Hex;
  route: "cheap" | "escalated" | "blocked";
  reason: string;
  usage: UsageLine[];
  rates: string;
  issuedAt: number;
}

export interface SignedReceipt {
  receipt: Receipt;
  /** keccak256 of the canonical JSON of `receipt`. This value is committed on-chain in `Settled.receiptHash`. */
  receiptHash: Hex;
  /** EIP-191 signature of `receiptHash` by the provider's settlement key. */
  ecdsa: Hex;
  /** FIPS 204 ML-DSA-65 signature of the 32 bytes of `receiptHash`, with the provider's post-quantum key. */
  mldsa: { algorithm: "ML-DSA-65"; publicKey: Hex; signature: Hex };
}

/** Deterministic JSON: object keys sorted at every level, no whitespace. Two parties hashing the same receipt agree. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export function receiptHash(receipt: Receipt): Hex {
  return keccak256(toBytes(canonicalJson(receipt)));
}

export const hashText = (text: string): Hex => keccak256(toBytes(text));

/** An ML-DSA-65 key pair from a 32-byte seed (keep the seed secret; the same seed always gives the same keys). */
export function pqKeyFromSeed(seed: Hex) {
  const bytes = hexToBytes(seed);
  if (bytes.length !== 32) throw new Error("PQ seed must be 32 bytes");
  const { publicKey, secretKey } = ml_dsa65.keygen(bytes);
  return { publicKey: bytesToHex(publicKey), secretKey };
}

export async function signReceipt(
  receipt: Receipt,
  provider: LocalAccount,
  pq: { publicKey: Hex; secretKey: Uint8Array },
): Promise<SignedReceipt> {
  const h = receiptHash(receipt);
  const ecdsa = await provider.signMessage({ message: { raw: h } });
  const signature = bytesToHex(ml_dsa65.sign(hexToBytes(h), pq.secretKey));
  return { receipt, receiptHash: h, ecdsa, mldsa: { algorithm: "ML-DSA-65", publicKey: pq.publicKey, signature } };
}

export interface ReceiptCheck {
  /** The hash matches the receipt body. */
  hashOk: boolean;
  /** The ECDSA signature recovers to `receipt.provider`. */
  ecdsaOk: boolean;
  /** The ML-DSA-65 signature verifies against the embedded public key. */
  mldsaOk: boolean;
  /** keccak256 of the embedded public key equals the key hash the provider published on-chain (if given). */
  pqKeyOnChain: boolean | null;
  /** The provider never charged more than the agent authorized. */
  withinMax: boolean;
  ok: boolean;
}

export async function verifyReceipt(s: SignedReceipt, onChainPqKeyHash?: Hex): Promise<ReceiptCheck> {
  const hashOk = receiptHash(s.receipt) === s.receiptHash;
  let ecdsaOk = false;
  try {
    const signer = await recoverMessageAddress({ message: { raw: s.receiptHash }, signature: s.ecdsa });
    ecdsaOk = signer.toLowerCase() === s.receipt.provider.toLowerCase();
  } catch {
    ecdsaOk = false;
  }
  let mldsaOk = false;
  try {
    mldsaOk = ml_dsa65.verify(hexToBytes(s.mldsa.signature), hexToBytes(s.receiptHash), hexToBytes(s.mldsa.publicKey));
  } catch {
    mldsaOk = false;
  }
  const pqKeyOnChain =
    onChainPqKeyHash === undefined ? null : keccak256(s.mldsa.publicKey).toLowerCase() === onChainPqKeyHash.toLowerCase();
  const withinMax = BigInt(s.receipt.charge) <= BigInt(s.receipt.maxPrice);
  return { hashOk, ecdsaOk, mldsaOk, pqKeyOnChain, withinMax, ok: hashOk && ecdsaOk && mldsaOk && withinMax && pqKeyOnChain !== false };
}
