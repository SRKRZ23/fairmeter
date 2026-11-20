import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/**
 * The FairMeter HTTP protocol (x402-style, settled on Aevum by the FairMeter contract):
 *
 *   1. Client POSTs the request without payment.            -> 402 Payment Required + `Quote`
 *   2. Client checks the quote against its own policy, signs an EIP-712 `Usage` for (mandateId, requestId,
 *      maxPrice, deadline) and POSTs the same body again with the `x-fairmeter-authorization` header.
 *   3. Provider serves, charges the actual cost (<= maxPrice), returns a dual-signed receipt, and settles on-chain.
 */
export const AUTH_HEADER = "x-fairmeter-authorization";
export const PROTOCOL = "fairmeter/1";

export interface Quote {
  protocol: typeof PROTOCOL;
  chainId: number;
  meter: Address;
  provider: Address;
  token: Address;
  mandateId: string;
  requestId: Hex;
  /** The most this request can cost, in tUSD8 base units (6 decimals). The actual charge is usually far lower. */
  maxPrice: string;
  /** Unix seconds. The authorization can be settled until then. */
  deadline: number;
  nonce: Hex;
  promptHash: Hex;
  maxTokens: number;
  /** Human-readable rates, e.g. "gpt-oss-20b in 0.005 / out 0.02 per 1k tokens". */
  rates: string;
}

export interface Authorization {
  mandateId: string;
  requestId: Hex;
  maxPrice: string;
  deadline: number;
  nonce: Hex;
  signature: Hex;
}

/**
 * The request id binds every quoted term to a server secret, so the server stays stateless (no quote database)
 * and a client cannot reuse a cheap quote for a longer prompt, a bigger token budget, another mandate or a later
 * deadline: change any field and the id no longer matches.
 */
export function bindRequestId(
  secret: Hex,
  q: { chainId: number; meter: Address; mandateId: string; promptHash: Hex; maxTokens: number; maxPrice: string; deadline: number; nonce: Hex },
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "bytes32" },
      ],
      [
        keccak256(secret),
        BigInt(q.chainId),
        q.meter,
        BigInt(q.mandateId),
        q.promptHash,
        BigInt(q.maxTokens),
        BigInt(q.maxPrice),
        BigInt(q.deadline),
        q.nonce,
      ],
    ),
  );
}

export const encodeAuthorization = (a: Authorization): string => btoa(JSON.stringify(a));

export function decodeAuthorization(header: string | null): Authorization | null {
  if (!header) return null;
  try {
    const a = JSON.parse(atob(header)) as Authorization;
    if (typeof a.mandateId !== "string" || typeof a.requestId !== "string" || typeof a.signature !== "string") return null;
    return a;
  } catch {
    return null;
  }
}

/** `FairMeter.Status` in contract order, with plain-language explanations for UIs and error messages. */
export const STATUS = [
  ["Ok", "OK"],
  ["UnknownMandate", "This mandate does not exist."],
  ["NotProvider", "Only the mandate's provider can charge it."],
  ["Revoked", "The owner revoked this mandate."],
  ["Expired", "This mandate has expired."],
  ["PastDeadline", "The authorization's deadline has passed."],
  ["AlreadySettled", "This request was already charged."],
  ["OverMaxPrice", "The charge is above what the agent authorized."],
  ["OverPerRequestMax", "The price is above the mandate's per-request limit."],
  ["OverCap", "The mandate's spending cap is reached."],
  ["OverBalance", "The mandate has too little money left."],
  ["BadSignature", "The authorization is not signed by the mandate's agent key."],
] as const;

export const statusName = (code: number) => STATUS[code]?.[0] ?? `Status${code}`;
export const statusText = (code: number) => STATUS[code]?.[1] ?? `Unknown status ${code}`;
