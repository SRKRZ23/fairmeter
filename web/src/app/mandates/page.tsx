"use client";

import { authorizationWindow, checkoutTypedData, erc20Abi, getLogsChunked, TUSD8_ADDRESS, txUrl } from "@aevum-kit/aevum";
import { fairMeterAbi, formatTusd8 } from "@fairmeter/sdk";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { getAbiItem, isAddress, parseEventLogs, parseUnits, toHex, type Address, type Hex, type PublicClient } from "viem";
import { useAccount, useConfig, usePublicClient, useReadContract } from "wagmi";
import { readContract, signTypedData, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { explain } from "@/lib/errors";
import { newSessionKey, sessionAccount, short, useGateway, useLocalMandates } from "@/lib/fm";
import { useNetwork } from "@/lib/network";

type Mode = "gasless" | "standard";

export default function MandatesPage() {
  const { net } = useNetwork();
  const chain = net.chain;
  const meter = net.fairmeter;
  const config = useConfig();
  const client = usePublicClient({ chainId: chain.id }) as PublicClient | undefined;
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === chain.id;
  const gateway = useGateway();
  const local = useLocalMandates();

  const [amount, setAmount] = useState("1");
  const [cap, setCap] = useState("1");
  const [perReq, setPerReq] = useState("0.1");
  const [days, setDays] = useState("7");
  const [agentMode, setAgentMode] = useState<"session" | "external">("session");
  const [externalAgent, setExternalAgent] = useState("");
  const [mode, setMode] = useState<Mode>("gasless");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ id: string; tx: Hex } | null>(null);

  const balance = useReadContract({
    address: TUSD8_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: chain.id,
    query: { enabled: onChain },
  });

  const mine = useQuery({
    queryKey: ["my-mandates", chain.id, meter, address, opened?.id, local.list.length],
    enabled: Boolean(client && meter && address),
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      const from = net.deployBlock ?? (head > 20_000n ? head - 20_000n : 0n);
      const logs = await getLogsChunked(client!, {
        address: meter!,
        event: getAbiItem({ abi: fairMeterAbi, name: "MandateOpened" }),
        args: { owner: address },
        fromBlock: from,
        toBlock: head,
      });
      const ids = [...new Set([...logs.map((l) => l.args.mandateId!.toString()), ...local.list.map((m) => m.id)])];
      const rows = await Promise.all(
        ids.map(async (id) => {
          const [m, spendable] = await Promise.all([
            client!.readContract({ address: meter!, abi: fairMeterAbi, functionName: "mandateOf", args: [BigInt(id)] }),
            client!.readContract({ address: meter!, abi: fairMeterAbi, functionName: "spendable", args: [BigInt(id)] }),
          ]);
          return { id, m, spendable };
        }),
      );
      return rows.filter((r) => address && r.m.owner.toLowerCase() === address.toLowerCase()).sort((a, b) => Number(b.id) - Number(a.id));
    },
  });

  const units = (s: string) => {
    try {
      return parseUnits(s.trim() || "0", 6);
    } catch {
      return -1n;
    }
  };
  const amt = units(amount);
  const capU = units(cap);
  const perU = units(perReq);
  const dayN = Number(days);
  const formError = (() => {
    if (amt <= 0n) return "Enter an amount above 0.";
    if (capU <= 0n || perU <= 0n) return "Cap and per-request limit must be above 0.";
    if (perU > capU) return "The per-request limit can't be above the total cap.";
    if (!Number.isFinite(dayN) || dayN < 1 || dayN > 90) return "Expiry must be 1 to 90 days.";
    if (agentMode === "external" && !isAddress(externalAgent.trim())) return "Enter a valid agent address.";
    if (balance.data !== undefined && amt > balance.data) return `Your wallet has ${formatTusd8(balance.data)} tUSD8.`;
    return null;
  })();

  async function open() {
    if (!address || !meter || !gateway.data) return;
    setError(null);
    setOpened(null);
    try {
      const agent = agentMode === "session" ? newSessionKey() : (externalAgent.trim() as Address);
      const expiresAt = BigInt(Math.floor(Date.now() / 1000) + dayN * 86400);
      const provider = gateway.data.provider;
      let hash: Hex;
      if (mode === "gasless") {
        setBusy("Sign the funding authorization in your wallet…");
        const terms = { owner: address, agent, provider, amount: amt, cap: capU, perRequestMax: perU, expiresAt, salt: toHex(crypto.getRandomValues(new Uint8Array(32))) };
        const nonce = await readContract(config, { address: meter, abi: fairMeterAbi, functionName: "openNonce", args: [terms], chainId: chain.id });
        const { validBefore } = authorizationWindow(600);
        const signature = await signTypedData(config, {
          account: address,
          ...checkoutTypedData(chain.id, TUSD8_ADDRESS, { from: address, to: meter, value: amt, validAfter: 0n, validBefore, nonce }),
        });
        setBusy("The provider is submitting it (it pays the gas)…");
        const res = await fetch("/api/v1/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            terms: { ...terms, amount: amt.toString(), cap: capU.toString(), perRequestMax: perU.toString(), expiresAt: expiresAt.toString() },
            validBefore: validBefore.toString(),
            signature,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "The relay refused the request.");
        hash = json.hash as Hex;
      } else {
        const allowance = await readContract(config, { address: TUSD8_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [address, meter], chainId: chain.id });
        if (allowance < amt) {
          setBusy("Approve exactly this amount in your wallet…");
          const a = await writeContract(config, { address: TUSD8_ADDRESS, abi: erc20Abi, functionName: "approve", args: [meter, amt], chainId: chain.id });
          await waitForTransactionReceipt(config, { hash: a, chainId: chain.id });
        }
        setBusy("Confirm the mandate in your wallet…");
        const { request } = await simulateContract(config, {
          account: address,
          address: meter,
          abi: fairMeterAbi,
          functionName: "open",
          args: [agent, provider, amt, capU, perU, expiresAt],
          chainId: chain.id,
        });
        hash = await writeContract(config, request);
      }
      setBusy("Waiting for Aevum…");
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: chain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted. Nothing was locked.");
      const ev = parseEventLogs({ abi: fairMeterAbi, logs: receipt.logs, eventName: "MandateOpened" })[0];
      const id = ev.args.mandateId.toString();
      local.add({ id, agent, owner: address, label: `Mandate #${id}`, openedAt: Date.now(), tx: hash });
      setOpened({ id, tx: hash });
      balance.refetch();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(null);
    }
  }

  async function ownerAction(id: string, action: "revoke" | "rotate" | "close") {
    if (!address || !meter) return;
    setError(null);
    try {
      setBusy(action === "revoke" ? "Confirm the revocation in your wallet…" : action === "rotate" ? "Confirm the new agent key in your wallet…" : "Confirm in your wallet…");
      const newAgent = action === "rotate" ? newSessionKey() : undefined;
      const { request } = await simulateContract(config, {
        account: address,
        address: meter,
        abi: fairMeterAbi,
        ...(action === "revoke"
          ? { functionName: "revoke" as const, args: [BigInt(id)] as const }
          : action === "close"
            ? { functionName: "closeExpired" as const, args: [BigInt(id)] as const }
            : { functionName: "setAgent" as const, args: [BigInt(id), newAgent!] as const }),
        chainId: chain.id,
      });
      const hash = await writeContract(config, request);
      setBusy("Waiting for Aevum…");
      await waitForTransactionReceipt(config, { hash, chainId: chain.id });
      if (newAgent) local.add({ id, agent: newAgent, owner: address, label: `Mandate #${id}`, openedAt: Date.now(), tx: hash });
      mine.refetch();
      balance.refetch();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(null);
    }
  }

  const now = Math.floor(Date.now() / 1000);

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">Step 1 · the owner</p>
          <h1>Give an agent a budget, not your wallet</h1>
          <p className="lede">
            A mandate locks tUSD8 for one AI provider. Your agent gets its own session key that can only spend from this
            mandate, within your caps, until it expires or you revoke it. Revoking returns the unspent money at once.
          </p>
        </div>
      </div>

      <div className="row">
        <section className="card stack" style={{ flex: "1 1 420px" }} aria-label="Open a mandate">
          <h2>Open a mandate</h2>
          <div className="form-grid">
            <label>
              <span>Lock</span>
              <input className="field" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <small>tUSD8 moved into the mandate</small>
            </label>
            <label>
              <span>Total cap</span>
              <input className="field" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
              <small>most it can ever be charged</small>
            </label>
            <label>
              <span>Per request</span>
              <input className="field" inputMode="decimal" value={perReq} onChange={(e) => setPerReq(e.target.value)} />
              <small>most one request can cost</small>
            </label>
            <label>
              <span>Expires in</span>
              <input className="field" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
              <small>days (1 to 90)</small>
            </label>
          </div>

          <div className="modes" role="radiogroup" aria-label="Agent key">
            <button type="button" role="radio" className="mode" aria-checked={agentMode === "session"} onClick={() => setAgentMode("session")}>
              <span className="mode-top">
                New session key <span className="tag">this browser</span>
              </span>
              <span className="mode-desc">Created now and kept in this browser, for the Agent console.</span>
            </button>
            <button type="button" role="radio" className="mode" aria-checked={agentMode === "external"} onClick={() => setAgentMode("external")}>
              <span className="mode-top">
                Existing agent <span className="tag">address</span>
              </span>
              <span className="mode-desc">An agent running elsewhere (a script, a smart-account session key).</span>
            </button>
          </div>
          {agentMode === "external" && (
            <input className="field" placeholder="0x… agent address" value={externalAgent} onChange={(e) => setExternalAgent(e.target.value)} />
          )}

          <div className="modes" role="radiogroup" aria-label="Funding">
            <button type="button" role="radio" className="mode" aria-checked={mode === "gasless"} onClick={() => setMode("gasless")}>
              <span className="mode-top">
                Gasless <span className="tag">EIP-3009</span>
              </span>
              <span className="mode-desc">One signature. The provider submits it and pays the gas.</span>
            </button>
            <button type="button" role="radio" className="mode" aria-checked={mode === "standard"} onClick={() => setMode("standard")}>
              <span className="mode-top">
                Standard <span className="tag">approve + open</span>
              </span>
              <span className="mode-desc">Two transactions from your wallet. You pay gas in tQDAY.</span>
            </button>
          </div>

          <dl className="kv" style={{ fontSize: 13 }}>
            <dt>Provider</dt>
            <dd>{gateway.data ? short(gateway.data.provider) : gateway.isError ? "gateway offline" : "…"}</dd>
            <dt>Your balance</dt>
            <dd>{balance.data !== undefined ? `${formatTusd8(balance.data)} tUSD8` : "—"}</dd>
          </dl>

          {error && (
            <div className="notice bad" role="alert">
              <strong>Not done</strong>
              <span>{error}</span>
            </div>
          )}
          {opened && (
            <div className="notice good" role="status">
              <div className="row-between">
                <strong>Mandate #{opened.id} is open</strong>
                <span style={{ display: "flex", gap: 16 }}>
                  <a href={txUrl(opened.tx)} target="_blank" rel="noreferrer">
                    Explorer
                  </a>
                  <Link href={`/agent?mandate=${opened.id}`}>Use it in the Agent console →</Link>
                </span>
              </div>
            </div>
          )}

          <button type="button" className="btn big block" disabled={!onChain || !meter || !gateway.data || Boolean(formError) || Boolean(busy)} onClick={open}>
            {!isConnected ? "Connect a wallet" : !onChain ? "Switch to Aevum" : busy ?? (formError || `Lock ${amount} tUSD8 for the agent`)}
          </button>
          <p className="fine">Only the provider can charge it, only up to what your agent signs for each request, and only within these caps.</p>
        </section>

        <section className="card stack" style={{ flex: "1.2 1 460px" }} aria-label="Your mandates">
          <div className="row-between">
            <h2>Your mandates</h2>
            <button type="button" className="btn ghost small" onClick={() => mine.refetch()}>
              Refresh
            </button>
          </div>
          {!address && <p className="empty">Connect a wallet to see your mandates.</p>}
          {address && mine.isLoading && <p className="empty">Reading Aevum…</p>}
          {address && mine.data?.length === 0 && <p className="empty">No mandates yet. Open one on the left.</p>}
          {mine.data?.map(({ id, m, spendable }) => {
            const status = m.revoked ? "closed" : Number(m.expiresAt) <= now ? "expired" : "active";
            const pct = m.cap > 0n ? Number((m.spent * 1000n) / m.cap) / 10 : 0;
            const hasKey = Boolean(sessionAccount(m.agent));
            return (
              <article key={id} className="mandate">
                <div className="row-between">
                  <strong>Mandate #{id}</strong>
                  <span className={`status-pill ${status === "active" ? "good" : "warn"}`}>{status}</span>
                </div>
                <div className="progress" aria-label={`Spent ${pct}% of cap`}>
                  <span style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
                <dl className="kv" style={{ fontSize: 13 }}>
                  <dt>Spent</dt>
                  <dd>
                    {formatTusd8(m.spent)} of {formatTusd8(m.cap)} tUSD8 · {m.requests} requests
                  </dd>
                  <dt>Spendable now</dt>
                  <dd>{formatTusd8(spendable)} tUSD8 (max {formatTusd8(m.perRequestMax)} per request)</dd>
                  <dt>Locked</dt>
                  <dd>{formatTusd8(m.balance)} tUSD8</dd>
                  <dt>Agent key</dt>
                  <dd>
                    {short(m.agent)} {hasKey ? "· in this browser" : ""}
                  </dd>
                  <dt>Expires</dt>
                  <dd>{new Date(Number(m.expiresAt) * 1000).toLocaleString()}</dd>
                </dl>
                <div className="actions">
                  {status === "active" && hasKey && (
                    <Link className="btn small" href={`/agent?mandate=${id}`}>
                      Open in Agent console
                    </Link>
                  )}
                  {status === "active" && (
                    <>
                      <button type="button" className="btn secondary small" disabled={Boolean(busy) || !onChain} onClick={() => ownerAction(id, "rotate")}>
                        Rotate agent key
                      </button>
                      <button type="button" className="btn warn small" disabled={Boolean(busy) || !onChain} onClick={() => ownerAction(id, "revoke")}>
                        Revoke and refund {formatTusd8(m.balance)}
                      </button>
                    </>
                  )}
                  {status === "expired" && (
                    <button type="button" className="btn secondary small" disabled={Boolean(busy) || !onChain} onClick={() => ownerAction(id, "close")}>
                      Refund {formatTusd8(m.balance)}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </section>
      </div>
    </main>
  );
}
