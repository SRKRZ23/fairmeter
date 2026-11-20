"use client";

import { txUrl } from "@aevum-kit/aevum";
import { formatTusd8 } from "@fairmeter/sdk";
import { useMeterActivity } from "@/lib/activity";
import { short } from "@/lib/fm";
import { useNetwork } from "@/lib/network";

export default function ActivityPage() {
  const { net } = useNetwork();
  const q = useMeterActivity();
  const d = q.data;
  const share = d && d.authorized > 0n ? Number((d.charged * 1000n) / d.authorized) / 10 : null;

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">On-chain audit trail</p>
          <h1>Activity on Aevum</h1>
          <p className="lede">Every mandate, every charge and every refund, read straight from FairMeter events. Nothing here comes from our server.</p>
        </div>
      </div>
      <div className="stats">
        <div className="stat">
          <span className="k">Mandates</span>
          <span className="v">{d?.mandates ?? "…"}</span>
        </div>
        <div className="stat">
          <span className="k">Paid requests</span>
          <span className="v">{d?.settlements ?? "…"}</span>
        </div>
        <div className="stat">
          <span className="k">Authorized</span>
          <span className="v">{d ? formatTusd8(d.authorized) : "…"}</span>
        </div>
        <div className="stat">
          <span className="k">Actually charged</span>
          <span className="v good">{d ? `${formatTusd8(d.charged)}${share !== null ? ` (${share}%)` : ""}` : "…"}</span>
        </div>
      </div>
      <section className="card flush">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Block</th>
                <th>Event</th>
                <th>Details</th>
                <th className="right">Tx</th>
              </tr>
            </thead>
            <tbody>
              {q.isLoading && (
                <tr>
                  <td colSpan={4} className="empty">
                    Reading Aevum…
                  </td>
                </tr>
              )}
              {d?.items.map((it) => (
                <tr key={`${it.tx}-${it.text}`}>
                  <td className="num">{it.block.toLocaleString("en-US")}</td>
                  <td>
                    <span className={`status-pill ${it.kind === "settled" ? "good" : "warn"}`}>{it.kind}</span>
                  </td>
                  <td>{it.text}</td>
                  <td className="right">
                    {net.hasExplorer ? (
                      <a href={txUrl(it.tx)} target="_blank" rel="noreferrer">
                        {short(it.tx, 8)}
                      </a>
                    ) : (
                      short(it.tx, 8)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
