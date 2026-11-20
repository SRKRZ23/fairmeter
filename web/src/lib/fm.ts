"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { ReceiptCheck, SignedReceipt } from "@fairmeter/sdk";

/**
 * Browser-side state for the demo app.
 *
 * Agent session keys live in this browser's localStorage. That is deliberate and safe *for this design*: a session
 * key can only spend from its own mandate, only at that mandate's provider, within the caps, until expiry or
 * revocation. The owner's wallet key never leaves the wallet. Clearing site data forgets the session key; the money
 * stays safe in the mandate and the owner can revoke it to get it back.
 */

const KEYS = "fairmeter:session-keys";
const MANDATES = "fairmeter:mandates";
const HISTORY = "fairmeter:history";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new Event("fairmeter:storage"));
  } catch {
    // Storage blocked (private mode, previews): the app still works for this page view.
  }
}

/** Re-render when any FairMeter storage changes (this tab or another). */
function useStorageTick() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener("fairmeter:storage", bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener("fairmeter:storage", bump);
      window.removeEventListener("storage", bump);
    };
  }, []);
  return tick;
}

// ---------- session keys ----------

export function newSessionKey(): Address {
  const pk = generatePrivateKey();
  const address = privateKeyToAccount(pk).address;
  write(KEYS, { ...read<Record<string, Hex>>(KEYS, {}), [address.toLowerCase()]: pk });
  return address;
}

export function sessionAccount(agent: Address) {
  const pk = read<Record<string, Hex>>(KEYS, {})[agent.toLowerCase()];
  return pk ? privateKeyToAccount(pk) : null;
}

// ---------- mandates this browser holds a key for ----------

export interface LocalMandate {
  id: string;
  agent: Address;
  owner: Address;
  label: string;
  openedAt: number;
  tx?: Hex;
}

export function useLocalMandates() {
  const tick = useStorageTick();
  const [list, setList] = useState<LocalMandate[]>([]);
  useEffect(() => setList(read<LocalMandate[]>(MANDATES, [])), [tick]);
  const add = useCallback((m: LocalMandate) => {
    const cur = read<LocalMandate[]>(MANDATES, []).filter((x) => x.id !== m.id);
    write(MANDATES, [m, ...cur]);
  }, []);
  const remove = useCallback((id: string) => write(MANDATES, read<LocalMandate[]>(MANDATES, []).filter((x) => x.id !== id)), []);
  return { list, add, remove };
}

// ---------- request history (receipts kept in this browser) ----------

export interface HistoryItem {
  at: number;
  prompt: string;
  answer: string;
  signed: SignedReceipt;
  check: ReceiptCheck;
  settleTx?: Hex;
}

export function useHistory() {
  const tick = useStorageTick();
  const [items, setItems] = useState<HistoryItem[]>([]);
  useEffect(() => setItems(read<HistoryItem[]>(HISTORY, [])), [tick]);
  const push = useCallback((h: HistoryItem) => write(HISTORY, [h, ...read<HistoryItem[]>(HISTORY, [])].slice(0, 50)), []);
  const patch = useCallback((requestId: Hex, p: Partial<HistoryItem>) => {
    write(
      HISTORY,
      read<HistoryItem[]>(HISTORY, []).map((h) => (h.signed.receipt.requestId === requestId ? { ...h, ...p } : h)),
    );
  }, []);
  const clear = useCallback(() => write(HISTORY, []), []);
  return { items, push, patch, clear };
}

// ---------- gateway discovery ----------

export interface GatewayInfo {
  protocol: string;
  chainId: number;
  meter: Address;
  token: Address;
  provider: Address;
  rates: string;
  pqPublicKeyHash: Hex;
  pqKeyPublishedOnChain: boolean;
}

export function useGateway() {
  return useQuery({
    queryKey: ["gateway"],
    queryFn: async () => {
      const res = await fetch("/api/v1/chat");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Gateway offline");
      return json as GatewayInfo;
    },
    staleTime: 60_000,
    retry: 1,
  });
}

export const short = (a: string, n = 6) => (a.length > 2 * n + 2 ? `${a.slice(0, n)}…${a.slice(-4)}` : a);
