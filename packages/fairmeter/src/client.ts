import { createPublicClient, http, type Address, type Chain, type Hex, type LocalAccount } from "viem";
import { fairMeterAbi } from "./abi";
import { AUTH_HEADER, encodeAuthorization, PROTOCOL, type Quote } from "./protocol";
import { formatTusd8 } from "./pricing";
import { hashText, verifyReceipt, type ReceiptCheck, type SignedReceipt } from "./receipt";
import { signUsage } from "./usage";

export interface AgentPolicy {
  /** Refuse any quote above this, in base units, even if the mandate would allow it. */
  maxPerRequest: bigint;
  /** Refuse quotes whose deadline is further away than this many seconds. */
  maxDeadlineSeconds?: number;
}

export interface AgentConfig {
  endpoint: string;
  chain: Chain;
  meter: Address;
  mandateId: bigint;
  agent: LocalAccount;
  policy: AgentPolicy;
  /** Only accept quotes from this provider address (recommended). */
  provider?: Address;
  fetch?: typeof fetch;
}

export type AskStep = "quote" | "policy" | "sign" | "serve" | "verify";

export interface AskResult {
  answer: string;
  quote: Quote;
  signed: SignedReceipt;
  check: ReceiptCheck;
}

export class FairMeterError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

/**
 * An agent that pays per request. It never signs a blank cheque: each quote is checked against the agent's own
 * policy and the exact prompt it sent, and each receipt is verified (both signatures, charge <= authorized maximum)
 * before the answer is returned.
 */
export function createAgent(cfg: AgentConfig) {
  const f = cfg.fetch ?? fetch;
  const client = createPublicClient({ chain: cfg.chain, transport: http() });

  function vet(q: Quote, prompt: string, maxTokens: number) {
    const now = Math.floor(Date.now() / 1000);
    const bad = (why: string) => {
      throw new FairMeterError(`Quote refused: ${why}`, "QUOTE_REFUSED", q);
    };
    if (q.protocol !== PROTOCOL) bad(`unknown protocol ${q.protocol}`);
    if (q.chainId !== cfg.chain.id) bad("wrong chain");
    if (q.meter.toLowerCase() !== cfg.meter.toLowerCase()) bad("wrong contract");
    if (BigInt(q.mandateId) !== cfg.mandateId) bad("wrong mandate");
    if (cfg.provider && q.provider.toLowerCase() !== cfg.provider.toLowerCase()) bad("unexpected provider");
    if (q.promptHash !== hashText(prompt)) bad("quote is for a different prompt");
    if (q.maxTokens !== maxTokens) bad("quote is for a different token budget");
    if (BigInt(q.maxPrice) > cfg.policy.maxPerRequest)
      bad(`price ceiling ${formatTusd8(q.maxPrice)} is above this agent's limit ${formatTusd8(cfg.policy.maxPerRequest)}`);
    if (q.deadline <= now || q.deadline - now > (cfg.policy.maxDeadlineSeconds ?? 900)) bad("deadline out of range");
  }

  async function ask(
    prompt: string,
    opts: { maxTokens?: number; onStep?: (step: AskStep, detail?: unknown) => void } = {},
  ): Promise<AskResult> {
    const maxTokens = opts.maxTokens ?? 512;
    const step = opts.onStep ?? (() => {});
    step("quote");
    const body = JSON.stringify({ mandateId: cfg.mandateId.toString(), prompt, maxTokens });
    const headers = { "content-type": "application/json" };

    const first = await f(cfg.endpoint, { method: "POST", headers, body });
    if (first.status !== 402) {
      const err = await first.json().catch(() => ({}));
      throw new FairMeterError(err.error ?? `Expected 402, got ${first.status}`, err.code ?? "NO_QUOTE", err);
    }
    const { quote } = (await first.json()) as { quote: Quote };
    step("policy", quote);
    vet(quote, prompt, maxTokens);
    step("sign", quote);

    const signature: Hex = await signUsage(cfg.agent, cfg.chain.id, cfg.meter, {
      mandateId: BigInt(quote.mandateId),
      requestId: quote.requestId,
      maxPrice: BigInt(quote.maxPrice),
      deadline: BigInt(quote.deadline),
    });
    const auth = encodeAuthorization({
      mandateId: quote.mandateId,
      requestId: quote.requestId,
      maxPrice: quote.maxPrice,
      deadline: quote.deadline,
      nonce: quote.nonce,
      signature,
    });
    step("serve", quote);
    const paid = await f(cfg.endpoint, { method: "POST", headers: { ...headers, [AUTH_HEADER]: auth }, body });
    const out = await paid.json();
    if (!paid.ok) throw new FairMeterError(out.error ?? `Request failed (${paid.status})`, out.code ?? "FAILED", out);

    const signed = out.receipt as SignedReceipt;
    step("verify", signed);
    const pqKeyHash = (await client.readContract({
      address: cfg.meter,
      abi: fairMeterAbi,
      functionName: "receiptKeyHash",
      args: [quote.provider],
    })) as Hex;
    const check = await verifyReceipt(signed, /^0x0+$/.test(pqKeyHash) ? undefined : pqKeyHash);
    const r = signed.receipt;
    if (r.requestId !== quote.requestId || r.mandateId !== quote.mandateId || r.maxPrice !== quote.maxPrice)
      throw new FairMeterError("Receipt does not match the quote", "BAD_RECEIPT", signed);
    if (r.responseHash !== hashText(out.answer ?? ""))
      throw new FairMeterError("Receipt does not match the answer", "BAD_RECEIPT", signed);
    if (!check.ok) throw new FairMeterError("Receipt failed verification", "BAD_RECEIPT", { check, signed });
    return { answer: out.answer, quote, signed, check };
  }

  /** Wait until the provider's settlement for `requestId` is on-chain; returns the transaction hash. */
  async function waitSettled(requestId: Hex, { timeoutMs = 60_000, fromBlock }: { timeoutMs?: number; fromBlock?: bigint } = {}) {
    const start = Date.now();
    const from = fromBlock ?? (await client.getBlockNumber()) - 500n;
    while (Date.now() - start < timeoutMs) {
      const logs = await client.getContractEvents({
        address: cfg.meter,
        abi: fairMeterAbi,
        eventName: "Settled",
        args: { mandateId: cfg.mandateId, requestId },
        fromBlock: from < 0n ? 0n : from,
      });
      if (logs.length) return { txHash: logs[0].transactionHash, receiptHash: logs[0].args.receiptHash as Hex };
      await new Promise((r) => setTimeout(r, 1500));
    }
    return null;
  }

  return { ask, waitSettled };
}
