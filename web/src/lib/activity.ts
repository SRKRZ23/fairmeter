"use client";

import { getLogsChunked } from "@aevum-kit/aevum";
import { fairMeterAbi, formatTusd8 } from "@fairmeter/sdk";
import { useQuery } from "@tanstack/react-query";
import { getAbiItem, type PublicClient } from "viem";
import { usePublicClient } from "wagmi";
import { short } from "./fm";
import { useNetwork } from "./network";

export interface MeterStats {
  mandates: number;
  settlements: number;
  authorized: bigint;
  charged: bigint;
  refunded: bigint;
  items: { kind: "opened" | "settled" | "closed"; block: bigint; tx: string; text: string; amount?: bigint }[];
}

/** Every FairMeter event since deployment, read in 1,000-block chunks (Aevum's eth_getLogs limit). */
export function useMeterActivity() {
  const { net } = useNetwork();
  const meter = net.fairmeter;
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;
  return useQuery({
    queryKey: ["meter-activity", meter],
    enabled: Boolean(client && meter),
    refetchInterval: 20_000,
    queryFn: async (): Promise<MeterStats> => {
      const head = await client!.getBlockNumber();
      const from = net.deployBlock ?? (head > 20_000n ? head - 20_000n : 0n);
      const range = { address: meter!, fromBlock: from, toBlock: head };
      const [opened, settled, closed] = await Promise.all([
        getLogsChunked(client!, { ...range, event: getAbiItem({ abi: fairMeterAbi, name: "MandateOpened" }) }),
        getLogsChunked(client!, { ...range, event: getAbiItem({ abi: fairMeterAbi, name: "Settled" }) }),
        getLogsChunked(client!, { ...range, event: getAbiItem({ abi: fairMeterAbi, name: "Closed" }) }),
      ]);
      const items: MeterStats["items"] = [];
      for (const l of opened as unknown as { args: { mandateId: bigint; amount: bigint; cap: bigint; perRequestMax: bigint }; blockNumber: bigint; transactionHash: string }[])
        items.push({ kind: "opened", block: l.blockNumber, tx: l.transactionHash, amount: l.args.amount, text: `Mandate #${l.args.mandateId} opened · cap ${formatTusd8(l.args.cap)}, max ${formatTusd8(l.args.perRequestMax)} per request` });
      let authorized = 0n;
      let charged = 0n;
      for (const l of settled as unknown as { args: { mandateId: bigint; requestId: string; maxPrice: bigint; charge: bigint }; blockNumber: bigint; transactionHash: string }[]) {
        authorized += l.args.maxPrice;
        charged += l.args.charge;
        items.push({ kind: "settled", block: l.blockNumber, tx: l.transactionHash, amount: l.args.charge, text: `#${l.args.mandateId} request ${short(l.args.requestId, 8)} · charged ${formatTusd8(l.args.charge)} of ${formatTusd8(l.args.maxPrice)} authorized` });
      }
      let refunded = 0n;
      for (const l of closed as unknown as { args: { mandateId: bigint; refund: bigint; revoked: boolean }; blockNumber: bigint; transactionHash: string }[]) {
        refunded += l.args.refund;
        items.push({ kind: "closed", block: l.blockNumber, tx: l.transactionHash, amount: l.args.refund, text: `Mandate #${l.args.mandateId} ${l.args.revoked ? "revoked" : "closed after expiry"} · ${formatTusd8(l.args.refund)} refunded to the owner` });
      }
      items.sort((a, b) => Number(b.block - a.block));
      return { mandates: opened.length, settlements: settled.length, authorized, charged, refunded, items };
    },
  });
}

