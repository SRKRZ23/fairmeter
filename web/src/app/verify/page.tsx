"use client";

import { getLogsChunked, txUrl } from "@aevum-kit/aevum";
import { costOf, fairMeterAbi, formatTusd8, TIERS, verifyReceipt, type SignedReceipt } from "@fairmeter/sdk";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { getAbiItem, keccak256, type Hex, type PublicClient } from "viem";
import { usePublicClient } from "wagmi";
import { CheckIcon } from "@/components/Icons";
import { short, useHistory } from "@/lib/fm";
import { useNetwork } from "@/lib/network";

const tierByModel = Object.values(TIERS).reduce<Record<string, (typeof TIERS)[keyof typeof TIERS]>>((a, t) => ({ ...a, [t.model]: t }), {});

function Verifier() {
  const params = useSearchParams();
  const { net } = useNetwork();
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;
  const history = useHistory();
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [signed, setSigned] = useState<SignedReceipt | null>(null);

  useEffect(() => {
    const want = params.get("request");
    const h = want ? history.items.find((x) => x.signed.receipt.requestId === want) : undefined;
    if (h && !signed) {
      setSigned(h.signed);
      setText(JSON.stringify(h.signed, null, 2));
    }
  }, [params, history.items, signed]);

  function load(raw: string) {
    setText(raw);
    setParseError(null);
    try {
      const s = JSON.parse(raw) as SignedReceipt;
      if (!s?.receipt || !s.receiptHash || !s.ecdsa || !s.mldsa) throw new Error("Not a FairMeter receipt.");
      setSigned(s);
    } catch (e) {
      setSigned(null);
      if (raw.trim()) setParseError(e instanceof Error ? e.message : "Invalid JSON.");
    }
  }

  const result = useQuery({
    // Key on the whole receipt, not its claimed hash: an edited receipt keeps the old receiptHash field.
    queryKey: ["verify", signed ? JSON.stringify(signed) : null],
    enabled: Boolean(signed && client),
    queryFn: async () => {
      const s = signed!;
      const r = s.receipt;
      const keyHash = (await client!.readContract({ address: r.meter, abi: fairMeterAbi, functionName: "receiptKeyHash", args: [r.provider] })) as Hex;
      const check = await verifyReceipt(s, /^0x0+$/.test(keyHash) ? undefined : keyHash);
      const lineCostsOk = r.usage.every((u) => {
        const t = tierByModel[u.model];
        return t ? costOf(t, u.inputTokens, u.outputTokens).toString() === u.cost : false;
      });
      const sum = r.usage.reduce((a, u) => a + BigInt(u.cost), 0n);
      const chargeOk = BigInt(r.charge) === (sum > BigInt(r.maxPrice) ? BigInt(r.maxPrice) : sum);
      const head = await client!.getBlockNumber();
      const logs = await getLogsChunked(client!, {
        address: r.meter,
        event: getAbiItem({ abi: fairMeterAbi, name: "Settled" }),
        args: { mandateId: BigInt(r.mandateId), requestId: r.requestId },
        fromBlock: net.deployBlock ?? (head > 20_000n ? head - 20_000n : 0n),
        toBlock: head,
      });
      const ev = logs[0];
      return {
        check,
        keyHash,
        lineCostsOk,
        chargeOk,
        settled: ev
          ? {
              tx: ev.transactionHash,
              block: ev.blockNumber,
              hashMatches: ev.args.receiptHash === s.receiptHash,
              chargeMatches: ev.args.charge?.toString() === r.charge,
            }
          : null,
      };
    },
  });

  const d = result.data;
  const rows: { ok: boolean | null; title: string; detail: string }[] = d && signed
    ? [
        { ok: d.check.hashOk, title: "Receipt body matches its hash", detail: `keccak256(canonical JSON) = ${short(signed.receiptHash, 10)}` },
        { ok: d.check.ecdsaOk, title: "Signed by the provider (ECDSA)", detail: `recovers to ${short(signed.receipt.provider)}, the address that settles on-chain` },
        { ok: d.check.mldsaOk, title: "Post-quantum signature valid (ML-DSA-65, FIPS 204)", detail: `${(signed.mldsa.signature.length - 2) / 2}-byte signature, ${(signed.mldsa.publicKey.length - 2) / 2}-byte public key` },
        { ok: d.check.pqKeyOnChain, title: "Post-quantum key is the one the provider published on Aevum", detail: d.check.pqKeyOnChain === null ? "provider has not published a key" : `FairMeter.receiptKeyHash = ${short(d.keyHash, 10)}` },
        { ok: d.lineCostsOk, title: "Every line follows the published rates", detail: "tokens × rate per 1k, rounded up" },
        { ok: d.chargeOk && d.check.withinMax, title: "Charge = sum of lines, never above the authorized maximum", detail: `charged ${formatTusd8(signed.receipt.charge)} of ${formatTusd8(signed.receipt.maxPrice)} authorized` },
        {
          ok: d.settled ? d.settled.hashMatches && d.settled.chargeMatches : null,
          title: "Settled on Aevum with this exact receipt",
          detail: d.settled ? `Settled event in block ${d.settled.block.toLocaleString("en-US")}: receipt hash and charge ${d.settled.hashMatches && d.settled.chargeMatches ? "match" : "DIFFER"}` : "no settlement found yet",
        },
      ]
    : [];

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">Step 3 · anyone</p>
          <h1>Verify a receipt</h1>
          <p className="lede">
            Every paid request comes with a receipt signed twice: with the provider&apos;s Ethereum key and with a post-quantum
            ML-DSA-65 key whose hash is published on-chain. Paste one, or pick one from this browser.
          </p>
        </div>
      </div>
      <div className="row">
        <section className="card stack" style={{ flex: "1 1 420px" }}>
          {history.items.length > 0 && (
            <select className="field" value="" onChange={(e) => e.target.value && load(JSON.stringify(history.items[Number(e.target.value)].signed, null, 2))}>
              <option value="">Pick a recent request…</option>
              {history.items.map((h, i) => (
                <option key={h.signed.receiptHash} value={i}>
                  {new Date(h.at).toLocaleTimeString()} · {formatTusd8(h.signed.receipt.charge)} tUSD8 · {h.prompt.slice(0, 40)}
                </option>
              ))}
            </select>
          )}
          <textarea className="field" rows={18} value={text} onChange={(e) => load(e.target.value)} placeholder="Paste a receipt JSON" aria-label="Receipt JSON" />
          {parseError && <p className="fine" style={{ color: "var(--bad)" }}>{parseError}</p>}
          <p className="fine">Try changing one digit of the charge: the hash check and both signatures fail.</p>
        </section>
        <section className="card flush" style={{ flex: "1 1 420px" }}>
          {!signed && <p className="empty">No receipt loaded.</p>}
          {signed && result.isLoading && <p className="empty">Checking signatures and reading Aevum…</p>}
          {rows.map((row) => (
            <div key={row.title} className="check">
              <div className={`chip ${row.ok === null ? "idle" : row.ok ? "ok" : "bad"}`}>{row.ok ? <CheckIcon /> : row.ok === null ? "–" : "✗"}</div>
              <div className="check-body">
                <div className="check-title">{row.title}</div>
                <div className="check-detail">{row.detail}</div>
              </div>
            </div>
          ))}
          {d?.settled && (
            <div className="check">
              <div className="check-body">
                <a href={txUrl(d.settled.tx)} target="_blank" rel="noreferrer">
                  Open the settlement transaction in the explorer →
                </a>
                <p className="fine">Public key fingerprint: {short(keccak256(signed!.mldsa.publicKey), 12)}</p>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={<main className="shell" />}>
      <Verifier />
    </Suspense>
  );
}
