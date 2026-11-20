import { hashTypedData, type Address, type Hex, type LocalAccount } from "viem";

/** EIP-712 type of the per-request authorization an agent signs. Must match `FairMeter.USAGE_TYPEHASH`. */
export const usageTypes = {
  Usage: [
    { name: "mandateId", type: "uint256" },
    { name: "requestId", type: "bytes32" },
    { name: "maxPrice", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export function usageDomain(chainId: number, meter: Address) {
  return { name: "FairMeter", version: "1", chainId, verifyingContract: meter } as const;
}

export interface UsageMessage {
  mandateId: bigint;
  requestId: Hex;
  maxPrice: bigint;
  deadline: bigint;
}

export function usageDigest(chainId: number, meter: Address, m: UsageMessage): Hex {
  return hashTypedData({ domain: usageDomain(chainId, meter), types: usageTypes, primaryType: "Usage", message: m });
}

/** Sign one usage authorization with an agent key (a local session key; wallets work through signTypedData too). */
export function signUsage(agent: LocalAccount, chainId: number, meter: Address, m: UsageMessage): Promise<Hex> {
  return agent.signTypedData({ domain: usageDomain(chainId, meter), types: usageTypes, primaryType: "Usage", message: m });
}
