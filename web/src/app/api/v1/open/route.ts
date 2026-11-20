import { NextResponse } from "next/server";
import { createPublicClient, createWalletClient, http, isAddress, isHex, parseSignature, type Hex } from "viem";
import { fairMeterAbi } from "@fairmeter/sdk";
import { gatewayConfig } from "@/lib/gateway/config";

/**
 * Gasless mandate opening. The owner signs one EIP-3009 ReceiveWithAuthorization whose nonce is
 * FairMeter.openNonce(terms); the provider submits openWithAuthorization and pays the gas, so a new user needs
 * tUSD8 but no tQDAY. The nonce binds the signature to the exact terms, so this relay cannot change the agent,
 * provider, caps or expiry.
 *
 * Rails: only openWithAuthorization on our FairMeter; only mandates that pay THIS provider (we sponsor our own
 * customers, nobody else's); amount and window limits; simulate first; per-IP and per-owner rate limits.
 */
export const runtime = "nodejs";

const MAX_AMOUNT = 10_000_000n; // 10 tUSD8 per mandate on testnet
const MAX_DAYS = 90;
const hits = new Map<string, number[]>();
function limited(bucket: string, max: number): boolean {
  const now = Date.now();
  const recent = (hits.get(bucket) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(bucket, recent);
  return recent.length > max;
}
const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });
const uint = (v: unknown): v is string => typeof v === "string" && /^\d{1,30}$/.test(v);

export async function POST(req: Request) {
  const cfg = gatewayConfig();
  if (!cfg) return fail("Gasless opening is offline. Use Standard mode.", 503);
  const ip = req.headers.get(process.env.TRUSTED_IP_HEADER?.toLowerCase() || "x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (limited(`ip:${ip}`, 5)) return fail("Too many requests. Wait a minute.", 429);

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return fail("Invalid JSON.");
  }
  const t = b.terms as Record<string, unknown> | undefined;
  if (
    !t ||
    typeof t.owner !== "string" || !isAddress(t.owner) ||
    typeof t.agent !== "string" || !isAddress(t.agent) ||
    typeof t.provider !== "string" || !isAddress(t.provider) ||
    !uint(t.amount) || !uint(t.cap) || !uint(t.perRequestMax) || !uint(t.expiresAt) ||
    typeof t.salt !== "string" || !isHex(t.salt) || t.salt.length !== 66 ||
    !uint(b.validBefore) || typeof b.signature !== "string" || !isHex(b.signature)
  ) {
    return fail("Malformed request.");
  }
  if (t.provider.toLowerCase() !== cfg.provider.address.toLowerCase()) return fail("This relay only opens mandates for its own provider.", 403);
  const amount = BigInt(t.amount);
  if (amount === 0n || amount > MAX_AMOUNT) return fail("Amount must be between 0 and 10 tUSD8 on testnet.");
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(t.expiresAt) > now + BigInt(MAX_DAYS * 86400)) return fail(`Expiry must be within ${MAX_DAYS} days.`);
  if (BigInt(b.validBefore) > now + 3600n) return fail("Signature window is too long (max 1 hour).");
  if (limited(`owner:${t.owner.toLowerCase()}`, 3)) return fail("Too many mandates from this address. Wait a minute.", 429);

  let v: bigint | undefined, r: Hex, s: Hex, yParity: number | undefined;
  try {
    ({ v, r, s, yParity } = parseSignature(b.signature));
  } catch {
    return fail("Invalid signature.");
  }
  const terms = {
    owner: t.owner,
    agent: t.agent,
    provider: t.provider,
    amount,
    cap: BigInt(t.cap),
    perRequestMax: BigInt(t.perRequestMax),
    expiresAt: BigInt(t.expiresAt),
    salt: t.salt,
  } as const;
  const auth = { validAfter: 0n, validBefore: BigInt(b.validBefore), v: v !== undefined ? Number(v) : 27 + (yParity ?? 0), r, s };

  const client = createPublicClient({ chain: cfg.net.chain, transport: http() });
  const wallet = createWalletClient({ account: cfg.provider, chain: cfg.net.chain, transport: http() });
  try {
    const call = {
      account: cfg.provider,
      address: cfg.meter,
      abi: fairMeterAbi,
      functionName: "openWithAuthorization",
      args: [terms, auth],
    } as const;
    const { result } = await client.simulateContract(call);
    const hash = await wallet.writeContract({ ...call, type: "legacy" });
    return NextResponse.json({ hash, mandateId: result.toString() });
  } catch (e) {
    const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);
    return fail(`Could not open the mandate: ${msg}`, 422);
  }
}
