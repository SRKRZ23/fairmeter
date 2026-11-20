import { isHex, type Address, type Hex } from "viem";
import { nonceManager, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { pqKeyFromSeed } from "@fairmeter/sdk";
import { defaultNetwork, type Network } from "@/lib/env";

/**
 * Server-side gateway settings. All secrets come from environment variables and never reach the browser:
 *   PROVIDER_PRIVATE_KEY  settlement key (a TEST wallet with a little tQDAY for gas)
 *   PQ_SEED               32-byte hex seed of the ML-DSA-65 receipt key
 *   QUOTE_SECRET          32-byte hex secret that binds quotes to request ids (stateless quotes)
 *   GROQ_API_KEY          model provider key
 */
export interface GatewayConfig {
  net: Network;
  meter: Address;
  provider: PrivateKeyAccount;
  pq: { publicKey: Hex; secretKey: Uint8Array };
  secret: Hex;
}

const hex32 = (v: string | undefined): Hex | undefined => {
  const s = v?.trim();
  if (!s) return undefined;
  const h = (s.startsWith("0x") ? s : `0x${s}`) as Hex;
  return isHex(h) && h.length === 66 ? h : undefined;
};

let cached: GatewayConfig | null | undefined;

export function gatewayConfig(): GatewayConfig | null {
  if (cached !== undefined) return cached;
  const net = defaultNetwork;
  const key = hex32(process.env.PROVIDER_PRIVATE_KEY);
  const seed = hex32(process.env.PQ_SEED);
  const secret = hex32(process.env.QUOTE_SECRET);
  if (!net.fairmeter || !key || !seed || !secret || !process.env.GROQ_API_KEY) {
    cached = null;
    return null;
  }
  cached = {
    net,
    meter: net.fairmeter,
    provider: privateKeyToAccount(key, { nonceManager }),
    pq: pqKeyFromSeed(seed),
    secret,
  };
  return cached;
}

/** Which settings are missing, for a helpful message in development. */
export function missingSettings(): string[] {
  const m: string[] = [];
  if (!defaultNetwork.fairmeter) m.push(`NEXT_PUBLIC_FAIRMETER_${defaultNetwork.key.toUpperCase()}`);
  if (!hex32(process.env.PROVIDER_PRIVATE_KEY)) m.push("PROVIDER_PRIVATE_KEY");
  if (!hex32(process.env.PQ_SEED)) m.push("PQ_SEED");
  if (!hex32(process.env.QUOTE_SECRET)) m.push("QUOTE_SECRET");
  if (!process.env.GROQ_API_KEY) m.push("GROQ_API_KEY");
  return m;
}
