"use client";

import { addressUrl } from "@aevum-kit/aevum";
import { formatTusd8 } from "@fairmeter/sdk";
import Link from "next/link";
import { useMeterActivity } from "@/lib/activity";
import { short, useGateway } from "@/lib/fm";
import { useNetwork } from "@/lib/network";

const ROLES = [
  {
    who: "Owner",
    title: "Locks a budget, keeps control",
    points: ["One mandate per agent and provider", "Total cap, per-request cap, expiry", "Revoke any time: unspent money returns in the same transaction", "Rotate a leaked agent key in one click"],
  },
  {
    who: "Agent",
    title: "Signs a ceiling, never a blank cheque",
    points: ["Gets a 402 quote bound to its exact prompt", "Refuses quotes above its own limit", "Signs EIP-712 with a session key, no wallet pop-ups", "Verifies every receipt before trusting the answer"],
  },
  {
    who: "Provider",
    title: "Charges what actually ran, proves it",
    points: ["Prompt guard first: an injection costs a fraction of a cent", "Cheap model, self-check, strong model only when needed", "Receipt signed with ECDSA and post-quantum ML-DSA-65", "Settles the actual cost on Aevum right after answering"],
  },
];

export default function Home() {
  const { net } = useNetwork();
  const stats = useMeterActivity().data;
  const gateway = useGateway().data;
  const share = stats && stats.authorized > 0n ? Number((stats.charged * 1000n) / stats.authorized) / 10 : null;

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Pay-per-request AI · settled on QDay Aevum</p>
        <h1>Agents pay for the AI they actually use.</h1>
        <p className="lede">
          An AI agent can&apos;t know in advance what a request will cost, so today it either holds your whole wallet or a prepaid
          API balance. FairMeter gives it a capped, revocable budget instead: the agent authorizes a ceiling per request,
          the provider charges the real cost, and every charge is backed by a receipt anyone can verify, including with
          post-quantum signatures.
        </p>
        <div className="hero-cta">
          <Link className="btn big" href="/mandates">
            Open a mandate
          </Link>
          <Link className="btn big secondary" href="/agent">
            Try the agent console
          </Link>
          <Link className="btn big ghost" href="/verify">
            Verify a receipt
          </Link>
        </div>
      </section>

      <div className="stats">
        <div className="stat">
          <span className="k">Paid requests on Aevum</span>
          <span className="v">{stats?.settlements ?? "…"}</span>
        </div>
        <div className="stat">
          <span className="k">Agents authorized</span>
          <span className="v">{stats ? `${formatTusd8(stats.authorized)} tUSD8` : "…"}</span>
        </div>
        <div className="stat">
          <span className="k">Providers charged</span>
          <span className="v good">{stats ? `${formatTusd8(stats.charged)} tUSD8` : "…"}</span>
        </div>
        <div className="stat">
          <span className="k">Share of ceiling used</span>
          <span className="v">{share !== null ? `${share}%` : "…"}</span>
        </div>
      </div>

      <div className="grid-3">
        {ROLES.map((r) => (
          <section key={r.who} className="card">
            <p className="eyebrow">{r.who}</p>
            <h2>{r.title}</h2>
            <ul>
              {r.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <section className="card info flow" aria-label="Request flow">
        <h2>One request, end to end</h2>
        <ol className="flow-steps">
          <li>
            <strong>POST /api/v1/chat</strong>
            <span>402 · quote: ceiling 0.04 tUSD8, bound to this prompt</span>
          </li>
          <li>
            <strong>Agent signs Usage</strong>
            <span>mandate, requestId, maxPrice, deadline (EIP-712)</span>
          </li>
          <li>
            <strong>FairMeter.check</strong>
            <span>on-chain dry run: right agent, room under the caps</span>
          </li>
          <li>
            <strong>Guard → cheap → check → strong?</strong>
            <span>billed per model call at real token counts</span>
          </li>
          <li>
            <strong>Receipt</strong>
            <span>ECDSA + ML-DSA-65, verified by the agent</span>
          </li>
          <li>
            <strong>FairMeter.settle</strong>
            <span>charges ~0.002, the rest stays in the mandate</span>
          </li>
        </ol>
      </section>

      <section className="card">
        <h2>Contracts and keys</h2>
        <dl className="kv" style={{ marginTop: 12 }}>
          <dt>FairMeter</dt>
          <dd>
            {net.fairmeter ? (
              <a href={addressUrl(net.fairmeter)} target="_blank" rel="noreferrer">
                {net.fairmeter}
              </a>
            ) : (
              "not configured"
            )}
          </dd>
          <dt>Provider</dt>
          <dd>{gateway ? gateway.provider : "…"}</dd>
          <dt>Prices</dt>
          <dd>{gateway ? gateway.rates : "…"}</dd>
          <dt>ML-DSA-65 key</dt>
          <dd>{gateway ? `${short(gateway.pqPublicKeyHash, 10)} · ${gateway.pqKeyPublishedOnChain ? "published on-chain" : "not published"}` : "…"}</dd>
          <dt>Network</dt>
          <dd>
            {net.chain.name} · chain {net.chain.id} · testnet tokens only
          </dd>
        </dl>
        <p className="fine" style={{ marginTop: 12 }}>
          New here? <Link href="/setup">Check your wallet setup</Link> first.
        </p>
      </section>
    </main>
  );
}
