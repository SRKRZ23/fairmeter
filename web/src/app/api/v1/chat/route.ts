import { after, NextResponse } from "next/server";
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Hex } from "viem";
import {
  AUTH_HEADER,
  bindRequestId,
  decodeAuthorization,
  fairMeterAbi,
  formatTusd8,
  hashText,
  maxPriceFor,
  PROTOCOL,
  ratesText,
  signReceipt,
  statusName,
  statusText,
  type Quote,
  type Receipt,
} from "@fairmeter/sdk";
import { TUSD8_ADDRESS } from "@aevum-kit/aevum";
import { gatewayConfig, missingSettings } from "@/lib/gateway/config";
import { route } from "@/lib/gateway/router";

/**
 * POST /api/v1/chat — a pay-per-request AI endpoint settled on Aevum.
 *
 *   no payment header      -> 402 + Quote (the most this request can cost, bound to this exact prompt)
 *   x-fairmeter-authorization (agent-signed Usage) -> answer + dual-signed receipt; the actual cost is settled
 *                                                     on-chain right after the response is sent.
 *
 * Rails: the mandate must name this provider and be able to cover the quoted ceiling before any model runs
 * (checked with FairMeter.check on-chain, which also verifies the agent's signature); each request id is served
 * once per process and settled once on-chain; the charge never exceeds what the agent signed.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

const QUOTE_TTL_SECONDS = 300;
const MIN_TOKENS = 64;
const MAX_TOKENS = 1024;
const MAX_PROMPT = 4000;
const isDev = process.env.NODE_ENV !== "production";

const fail = (error: string, status: number, code: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, code, ...extra }, { status });

// In-memory rails (per server process; use a shared store for multi-instance deployments).
const hits = new Map<string, number[]>();
function limited(bucket: string, max: number): boolean {
  const now = Date.now();
  const recent = (hits.get(bucket) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(bucket, recent);
  return recent.length > max;
}
const served = new Map<string, number>();
function claim(requestId: string): boolean {
  const now = Date.now();
  for (const [k, t] of served) if (now - t > 30 * 60_000) served.delete(k);
  if (served.has(requestId)) return false;
  served.set(requestId, now);
  return true;
}

function clientIp(req: Request): string {
  const trusted = process.env.TRUSTED_IP_HEADER?.trim().toLowerCase();
  if (trusted) return req.headers.get(trusted)?.split(",")[0]?.trim() || "unknown";
  return req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
}

/** GET: discovery — who the provider is, where it settles, its prices and its post-quantum receipt key. */
export async function GET() {
  const cfg = gatewayConfig();
  if (!cfg) return fail(isDev ? `Gateway not configured: ${missingSettings().join(", ")}` : "Gateway offline.", 503, "OFFLINE");
  const client = createPublicClient({ chain: cfg.net.chain, transport: http() });
  const onChainKey = await client
    .readContract({ address: cfg.meter, abi: fairMeterAbi, functionName: "receiptKeyHash", args: [cfg.provider.address] })
    .catch(() => null);
  return NextResponse.json({
    protocol: PROTOCOL,
    chainId: cfg.net.chain.id,
    meter: cfg.meter,
    token: TUSD8_ADDRESS,
    provider: cfg.provider.address,
    rates: ratesText(),
    pqPublicKeyHash: keccak256(cfg.pq.publicKey),
    pqKeyPublishedOnChain: onChainKey === keccak256(cfg.pq.publicKey),
  });
}

export async function POST(req: Request) {
  const cfg = gatewayConfig();
  if (!cfg) return fail(isDev ? `Gateway not configured: ${missingSettings().join(", ")}` : "Gateway offline.", 503, "OFFLINE");
  if (limited(`ip:${clientIp(req)}`, 20)) return fail("Too many requests. Wait a minute.", 429, "RATE_LIMITED");

  let body: { mandateId?: unknown; prompt?: unknown; maxTokens?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON.", 400, "BAD_REQUEST");
  }
  const mandateId = typeof body.mandateId === "string" && /^\d{1,20}$/.test(body.mandateId) ? body.mandateId : null;
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const maxTokens = typeof body.maxTokens === "number" && Number.isInteger(body.maxTokens) ? body.maxTokens : 512;
  if (!mandateId) return fail("mandateId must be a decimal string.", 400, "BAD_REQUEST");
  if (!prompt || prompt.length > MAX_PROMPT) return fail(`prompt must be 1 to ${MAX_PROMPT} characters.`, 400, "BAD_REQUEST");
  if (maxTokens < MIN_TOKENS || maxTokens > MAX_TOKENS)
    return fail(`maxTokens must be ${MIN_TOKENS} to ${MAX_TOKENS}.`, 400, "BAD_REQUEST");

  const chain = cfg.net.chain;
  const client = createPublicClient({ chain, transport: http() });
  const promptHash = hashText(prompt);
  const now = Math.floor(Date.now() / 1000);
  const auth = decodeAuthorization(req.headers.get(AUTH_HEADER));

  // ---------- step 1: quote ----------
  if (!auth) {
    const m = await client.readContract({ address: cfg.meter, abi: fairMeterAbi, functionName: "mandateOf", args: [BigInt(mandateId)] });
    if (m.owner === "0x0000000000000000000000000000000000000000") return fail("Unknown mandate.", 404, "UNKNOWN_MANDATE");
    if (m.provider.toLowerCase() !== cfg.provider.address.toLowerCase())
      return fail("This mandate pays a different provider.", 403, "WRONG_PROVIDER");
    if (m.revoked) return fail("This mandate was revoked by its owner.", 403, "REVOKED");
    if (BigInt(m.expiresAt) <= BigInt(now)) return fail("This mandate has expired.", 403, "EXPIRED");
    const maxPrice = maxPriceFor(prompt, maxTokens);
    const spendable = await client.readContract({ address: cfg.meter, abi: fairMeterAbi, functionName: "spendable", args: [BigInt(mandateId)] });
    if (maxPrice > m.perRequestMax)
      return fail(
        `This request's ceiling (${formatTusd8(maxPrice)} tUSD8) is above the mandate's per-request limit (${formatTusd8(m.perRequestMax)}). Lower maxTokens or shorten the prompt.`,
        402,
        "OVER_PER_REQUEST_MAX",
      );
    if (maxPrice > spendable)
      return fail(`The mandate can spend ${formatTusd8(spendable)} tUSD8 more; this request may cost up to ${formatTusd8(maxPrice)}.`, 402, "INSUFFICIENT");
    const deadline = now + QUOTE_TTL_SECONDS;
    const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const terms = { chainId: chain.id, meter: cfg.meter, mandateId, promptHash, maxTokens, maxPrice: maxPrice.toString(), deadline, nonce };
    const quote: Quote = {
      protocol: PROTOCOL,
      ...terms,
      provider: cfg.provider.address,
      token: TUSD8_ADDRESS,
      requestId: bindRequestId(cfg.secret, terms),
      rates: ratesText(),
    };
    return NextResponse.json({ quote }, { status: 402, headers: { "www-authenticate": `FairMeter realm="${PROTOCOL}"` } });
  }

  // ---------- step 2: paid request ----------
  if (auth.mandateId !== mandateId) return fail("Authorization is for another mandate.", 400, "BAD_AUTH");
  if (!/^\d{1,30}$/.test(auth.maxPrice) || !Number.isInteger(auth.deadline)) return fail("Malformed authorization.", 400, "BAD_AUTH");
  const expected = bindRequestId(cfg.secret, {
    chainId: chain.id,
    meter: cfg.meter,
    mandateId,
    promptHash,
    maxTokens,
    maxPrice: auth.maxPrice,
    deadline: auth.deadline,
    nonce: auth.nonce,
  });
  if (expected !== auth.requestId) return fail("This authorization was not issued for this exact request.", 400, "QUOTE_MISMATCH");
  if (auth.deadline <= now + 5) return fail("The quote expired. Ask for a new one.", 402, "QUOTE_EXPIRED");

  const maxPrice = BigInt(auth.maxPrice);
  const status = await client.readContract({
    address: cfg.meter,
    abi: fairMeterAbi,
    functionName: "check",
    args: [BigInt(mandateId), auth.requestId, maxPrice, BigInt(auth.deadline), maxPrice, cfg.provider.address, auth.signature],
  });
  if (status !== 0) return fail(statusText(status), 402, statusName(status));
  if (!claim(auth.requestId)) return fail("This request was already served.", 409, "ALREADY_SERVED");

  let routed;
  try {
    routed = await route(prompt, maxTokens);
  } catch (e) {
    served.delete(auth.requestId); // nothing was delivered or charged: let the agent retry the same authorization
    return fail(e instanceof Error ? e.message : "Model call failed.", 502, "MODEL_ERROR");
  }

  const total = routed.usage.reduce((a, u) => a + BigInt(u.cost), 0n);
  const charge = total > maxPrice ? maxPrice : total; // the provider absorbs anything above the signed ceiling
  const receipt: Receipt = {
    v: 1,
    chainId: chain.id,
    meter: cfg.meter,
    provider: cfg.provider.address,
    mandateId,
    requestId: auth.requestId,
    maxPrice: maxPrice.toString(),
    charge: charge.toString(),
    deadline: auth.deadline,
    promptHash,
    responseHash: hashText(routed.answer),
    route: routed.route,
    reason: total > maxPrice ? `${routed.reason}; capped at the authorized maximum` : routed.reason,
    usage: routed.usage,
    rates: ratesText(),
    issuedAt: Math.floor(Date.now() / 1000),
  };
  const signed = await signReceipt(receipt, cfg.provider, cfg.pq);

  // Settle after the response is sent: the agent gets its answer at model speed; the chain catches up in ~1 s.
  after(async () => {
    const wallet = createWalletClient({ account: cfg.provider, chain, transport: http() });
    const call = {
      account: cfg.provider,
      address: cfg.meter,
      abi: fairMeterAbi,
      functionName: "settle",
      args: [BigInt(mandateId), auth.requestId, maxPrice, BigInt(auth.deadline), charge, signed.receiptHash, auth.signature as Hex],
    } as const;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await client.simulateContract(call);
        const hash = await wallet.writeContract({ ...call, type: "legacy" });
        const r = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
        console.log(`[fairmeter] settled ${auth.requestId} charge=${charge} tx=${hash} status=${r.status}`);
        return;
      } catch (e) {
        console.error(`[fairmeter] settle attempt ${attempt + 1} failed for ${auth.requestId}:`, e instanceof Error ? e.message : e);
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  });

  return NextResponse.json({ answer: routed.answer, receipt: signed, settlement: "submitting" });
}
