"use client";

import { erc20Abi, TUSD8_ADDRESS } from "@aevum-kit/aevum";
import { fairMeterAbi } from "@fairmeter/sdk";
import type { Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { useNetwork } from "@/lib/network";

/** The payment token: FairMeter.token() when FairMeter is configured (MockUSD8 on a local chain), else tUSD8. */
export function useToken() {
  const { net } = useNetwork();
  const fromMeter = useReadContract({
    address: net.fairmeter,
    abi: fairMeterAbi,
    functionName: "token",
    chainId: net.chain.id,
    query: { enabled: Boolean(net.fairmeter) },
  });
  const address: Address | undefined = fromMeter.data ?? (net.key === "local" ? undefined : TUSD8_ADDRESS);
  const meta = useReadContracts({
    contracts: address
      ? [
          { address, abi: erc20Abi, functionName: "decimals", chainId: net.chain.id },
          { address, abi: erc20Abi, functionName: "symbol", chainId: net.chain.id },
        ]
      : [],
    query: { enabled: Boolean(address) },
  });
  const decimals = (meta.data?.[0]?.result as number | undefined) ?? 6;
  const symbol = (meta.data?.[1]?.result as string | undefined) ?? "tUSD8";
  return { address, decimals, symbol, isLoading: fromMeter.isLoading || meta.isLoading };
}
