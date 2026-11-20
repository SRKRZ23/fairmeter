/**
 * End-to-end browser test of the deployed app, with a scripted EIP-1193 wallet instead of MetaMask.
 *
 * A real Chrome (headless, raw CDP) opens the app. A small shim injected before any page script exposes
 * `window.ethereum` (and announces itself via EIP-6963); every wallet request is forwarded over a CDP binding to
 * this process, which signs with OWNER_PRIVATE_KEY (a TEST key) and forwards reads to the Aevum RPC. Then it walks
 * the whole product: connect → open a mandate gaslessly → ask Easy / Hard / Attack → verify a receipt (and a
 * tampered copy) → revoke → activity. Every step is asserted; the run can also be recorded for the demo film.
 *
 *   OWNER_PRIVATE_KEY=0x... APP=https://fairmeter.vercel.app OUT=./e2e-out [RECORD=1] pnpm example e2e
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { aevumTestnet } from "@aevum-kit/aevum";

const APP = (process.env.APP ?? "https://fairmeter.vercel.app").replace(/\/$/, "");
const OUT = process.env.OUT ?? join(tmpdir(), `fairmeter-e2e-${Date.now()}`);
const RECORD = process.env.RECORD === "1";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RPC = aevumTestnet.rpcUrls.default.http[0];
const account = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY as Hex);
const wallet = createWalletClient({ account, chain: aevumTestnet, transport: http() });
mkdirSync(join(OUT, "frames"), { recursive: true });
const T0 = Date.now();
const log = (o: Record<string, unknown>) => appendFileSync(join(OUT, "events.jsonl"), JSON.stringify({ t: (Date.now() - T0) / 1000, ...o }) + "\n");
const say = (step: string, caption: string) => {
  console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${step}: ${caption}`);
  log({ step, caption });
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- wallet shim (runs in the page) ----------------
const SHIM = `(() => {
  let id = 0; const pending = new Map(); const ls = {};
  window.__fmWalletReply = (i, ok, val) => { const p = pending.get(i); if (!p) return; pending.delete(i);
    ok ? p.res(val) : p.rej(Object.assign(new Error(val.message), { code: val.code })); };
  const provider = {
    isMetaMask: true, _fairmeterTest: true,
    request: ({ method, params }) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej });
      window.__fmWallet(JSON.stringify({ i, method, params: params ?? [] })); }),
    on: (e, f) => { (ls[e] ??= []).push(f); return provider; },
    removeListener: (e, f) => { ls[e] = (ls[e] || []).filter((x) => x !== f); return provider; },
  };
  window.ethereum = provider;
  const info = { uuid: "5f2c7a1e-fair-meter-test-wallet00001", name: "Test Wallet", rdns: "app.fairmeter.testwallet",
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAxIDEnLz4=" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce); announce();
})();`;

function toBig(types: Record<string, { name: string; type: string }[]>, type: string, v: unknown): unknown {
  if (/^u?int\d*$/.test(type)) return BigInt(v as string);
  if (type.endsWith("[]")) return (v as unknown[]).map((x) => toBig(types, type.slice(0, -2), x));
  if (types[type]) {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(types[type].map((f) => [f.name, toBig(types, f.type, o[f.name])]));
  }
  return v;
}

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
  return j.result;
}

async function handleWallet(method: string, params: unknown[]): Promise<unknown> {
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts":
      return [account.address];
    case "eth_chainId":
      return `0x${aevumTestnet.id.toString(16)}`;
    case "net_version":
      return String(aevumTestnet.id);
    case "wallet_switchEthereumChain":
    case "wallet_addEthereumChain":
    case "wallet_watchAsset":
      return null;
    case "wallet_requestPermissions":
    case "wallet_getPermissions":
      return [{ parentCapability: "eth_accounts" }];
    case "eth_signTypedData_v4": {
      const td = JSON.parse(params[1] as string);
      const { EIP712Domain: _d, ...types } = td.types;
      log({ wallet: "signTypedData", primaryType: td.primaryType });
      return account.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: toBig(types, td.primaryType, td.message) as Record<string, unknown> });
    }
    case "personal_sign":
      return account.signMessage({ message: { raw: params[0] as Hex } });
    case "eth_sendTransaction": {
      const tx = params[0] as { to: Hex; data?: Hex; value?: Hex };
      log({ wallet: "sendTransaction", to: tx.to });
      return wallet.sendTransaction({ account, to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, type: "legacy" });
    }
    default:
      return rpc(method, params);
  }
}

// ---------------- CDP ----------------
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${join(OUT, "profile")}`, "--hide-scrollbars",
  "--window-size=1440,900", "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: "ignore" });
process.on("exit", () => chrome.kill("SIGKILL"));

let ws: WebSocket;
let seq = 0;
const waiters = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
const handlers: ((m: { method: string; params: Record<string, unknown> }) => void)[] = [];
function send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => waiters.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result as Record<string, unknown>))));
}
async function evaluate<T = unknown>(expression: string): Promise<T> {
  const r = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as { result: { value: T }; exceptionDetails?: unknown };
  if (r.exceptionDetails) throw new Error(`eval failed: ${expression.slice(0, 80)} ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
  return r.result.value;
}
async function waitFor(expr: string, label: string, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await evaluate<boolean>(`!!(${expr})`).catch(() => false)) return;
    await sleep(300);
  }
  await shot(`FAIL-${label}`);
  throw new Error(`timeout waiting for ${label}`);
}
async function go(path: string) {
  await send("Page.navigate", { url: APP + path });
  await waitFor(`document.readyState === "complete" && document.querySelector("main")`, `load ${path}`);
  await sleep(1200);
}
const clickText = (sel: string, text: string) =>
  evaluate<boolean>(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.innerText.trim().startsWith(${JSON.stringify(text)}) && !e.disabled); if (!el) return false; el.scrollIntoView({block:"center"}); el.click(); return true; })()`);
async function click(sel: string, text: string, label = text) {
  await waitFor(`[...document.querySelectorAll(${JSON.stringify(sel)})].some(e => e.innerText.trim().startsWith(${JSON.stringify(text)}) && !e.disabled)`, `clickable ${label}`);
  await clickText(sel, text);
}
async function setInput(sel: string, value: string) {
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
}
let shots = 0;
async function shot(name: string) {
  const r = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
  writeFileSync(join(OUT, `${String(++shots).padStart(2, "0")}-${name}.png`), Buffer.from(r.data, "base64"));
}
const text = () => evaluate<string>("document.querySelector('main').innerText");

async function main() {
  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).then((l) => l.find((t: { type: string }) => t.type === "page")).catch(() => undefined);
  }
  if (!target) throw new Error("Chrome did not start");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && waiters.has(m.id)) {
      waiters.get(m.id)!(m);
      waiters.delete(m.id);
    } else if (m.method) handlers.forEach((h) => h(m));
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Runtime.addBinding", { name: "__fmWallet" });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: SHIM });
  handlers.push(async (m) => {
    if (m.method !== "Runtime.bindingCalled" || m.params.name !== "__fmWallet") return;
    const { i, method, params } = JSON.parse(m.params.payload as string);
    try {
      const v = await handleWallet(method, params);
      await send("Runtime.evaluate", { expression: `window.__fmWalletReply(${i}, true, ${JSON.stringify(v ?? null)})` });
    } catch (e) {
      const err = e as { message?: string; code?: number };
      await send("Runtime.evaluate", { expression: `window.__fmWalletReply(${i}, false, ${JSON.stringify({ message: err.message ?? String(e), code: err.code ?? -32603 })})` });
    }
  });
  if (RECORD) {
    let n = 0;
    handlers.push((m) => {
      if (m.method !== "Page.screencastFrame") return;
      const p = m.params as { data: string; sessionId: number; metadata: { timestamp: number } };
      const f = `${String(++n).padStart(5, "0")}.jpg`;
      writeFileSync(join(OUT, "frames", f), Buffer.from(p.data, "base64"));
      appendFileSync(join(OUT, "frames.jsonl"), JSON.stringify({ f, t: p.metadata.timestamp * 1000 - T0 }) + "\n");
      void send("Page.screencastFrameAck", { sessionId: p.sessionId });
    });
    await send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
  }

  // 1. Overview + connect
  say("overview", "FairMeter: pay-per-request AI for agents, settled in tUSD8 on QDay Aevum");
  await go("/");
  await sleep(2500);
  await shot("overview");
  say("connect", "The owner connects a wallet (a scripted test wallet in this run)");
  await go("/setup");
  await sleep(1500);
  if (await clickText("button", "Connect Wallet")) {
    await sleep(800);
    const picked = (await clickText("button", "Test Wallet")) || (await clickText("button", "Browser Wallet")) || (await clickText("button", "Injected"));
    if (!picked) throw new Error("no wallet option in the connect modal");
  } // else: wagmi already reconnected the injected wallet
  await waitFor(`document.querySelector("main").innerText.includes("Wallet connected") && !document.querySelector("main").innerText.includes("not connected")`, "wallet connected", 30_000);
  await sleep(2500);
  await shot("setup-connected");

  // 2. Open a mandate, gasless
  say("mandate", "Step 1 · the owner locks 0.5 tUSD8 for one provider: cap 0.5, max 0.1 per request, 7 days");
  await go("/mandates");
  await waitFor(`document.querySelector("main").innerText.includes("Your balance") && !/Your balance\\s*—/.test(document.querySelector("main").innerText)`, "balance");
  await setInput(".form-grid label:nth-child(1) input", "0.5");
  await setInput(".form-grid label:nth-child(2) input", "0.5");
  await setInput(".form-grid label:nth-child(3) input", "0.1");
  await sleep(1500);
  say("mandate-sign", "Gasless: one EIP-3009 signature, the provider submits it and pays the gas");
  await click("button", "Lock 0.5 tUSD8");
  await waitFor(`document.querySelector(".notice.good")?.innerText.includes("is open")`, "mandate open", 90_000);
  const mandateId = (await evaluate<string>(`document.querySelector(".notice.good").innerText.match(/#(\\d+)/)[1]`)) as string;
  say("mandate-open", `Mandate #${mandateId} is open on Aevum; the agent got its own session key in this browser`);
  await sleep(2500);
  await shot("mandate-open");

  // 3. Agent: Easy, Hard, Attack
  await go(`/agent?mandate=${mandateId}`);
  const asks = [
    ["Easy", "Step 2 · the agent asks an easy question: it signs a ceiling, the cheap model answers"],
    ["Hard", "A hard question: the cheap model grades its own draft low, so the strong model answers"],
    ["Attack", "A prompt injection: the guard blocks it, and only the safety check is billed"],
  ] as const;
  const results: Record<string, string> = {};
  for (const [preset, caption] of asks) {
    say(`ask-${preset.toLowerCase()}`, caption);
    await click("button", preset);
    await sleep(900);
    const before = await evaluate<number>(`JSON.parse(localStorage.getItem("fairmeter:history") || "[]").length`);
    await click("button", "Ask and pay");
    await waitFor(`JSON.parse(localStorage.getItem("fairmeter:history") || "[]").length > ${before}`, `answer ${preset}`, 120_000);
    await waitFor(`!document.querySelector("button.big")?.innerText.includes("Working")`, `settled ${preset}`, 90_000);
    const h = await evaluate<{ route: string; charge: string; maxPrice: string; settleTx?: string; ok: boolean }>(
      `(() => { const h = JSON.parse(localStorage.getItem("fairmeter:history"))[0]; return { route: h.signed.receipt.route, charge: h.signed.receipt.charge, maxPrice: h.signed.receipt.maxPrice, settleTx: h.settleTx, ok: h.check.ok }; })()`,
    );
    results[preset] = `${h.route}, charged ${Number(h.charge) / 1e6} of ${Number(h.maxPrice) / 1e6}, receipt ${h.ok ? "verified" : "FAILED"}, settled ${h.settleTx ?? "no"}`;
    say(`ask-${preset.toLowerCase()}-done`, `${preset}: ${results[preset]}`);
    if (!h.ok || !h.settleTx) throw new Error(`${preset} not verified/settled`);
    await evaluate(`document.querySelector(".answer")?.scrollIntoView({block: "start"})`);
    await sleep(3500);
    await shot(`ask-${preset.toLowerCase()}`);
    await evaluate(`window.scrollTo(0, 0)`);
  }

  // 4. Verify
  const requestId = await evaluate<string>(`JSON.parse(localStorage.getItem("fairmeter:history"))[1].signed.receipt.requestId`);
  say("verify", "Step 3 · anyone verifies the receipt: hash, ECDSA, ML-DSA-65, key on-chain, rates, settlement");
  await go(`/verify?request=${requestId}`);
  await waitFor(`document.querySelectorAll(".check .chip.ok").length >= 7`, "7 checks", 90_000);
  await sleep(3000);
  await shot("verify-ok");
  say("verify-tamper", "Change one digit of the charge: the hash and both signatures fail");
  await evaluate(`(() => { const el = document.querySelector("textarea"); const v = el.value.replace(/"charge": "(\\d+)"/, (m, d) => '"charge": "' + (Number(d) - 1) + '"');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await waitFor(`document.querySelectorAll(".check .chip.bad").length >= 3`, "tamper detected", 60_000);
  await sleep(3000);
  await shot("verify-tampered");

  // 5. Revoke
  say("revoke", "Step 4 · the owner revokes: the unspent balance returns in the same transaction");
  await go("/mandates");
  await waitFor(`[...document.querySelectorAll(".mandate")].some(m => m.innerText.includes("Mandate #${mandateId}"))`, "mandate card", 60_000);
  await evaluate(`[...document.querySelectorAll(".mandate")].find(m => m.innerText.includes("Mandate #${mandateId}")).scrollIntoView({block: "center"})`);
  await sleep(1500);
  const clicked = await evaluate<boolean>(`(() => { const card = [...document.querySelectorAll(".mandate")].find(m => m.innerText.includes("Mandate #${mandateId}")); const b = [...card.querySelectorAll("button")].find(b => b.innerText.startsWith("Revoke")); if (!b) return false; b.click(); return true; })()`);
  if (!clicked) throw new Error("no revoke button");
  await waitFor(`[...document.querySelectorAll(".mandate")].some(m => m.innerText.includes("Mandate #${mandateId}") && m.innerText.includes("closed"))`, "revoked", 90_000);
  await sleep(2500);
  await shot("revoked");

  // 6. Activity
  say("activity", "Every mandate, charge and refund, read straight from FairMeter events on Aevum");
  await go("/activity");
  await waitFor(`document.querySelectorAll("table.data tbody tr").length > 3`, "activity rows", 90_000);
  await sleep(4000);
  await shot("activity");
  say("end", "done");
  if (RECORD) await send("Page.stopScreencast");
  writeFileSync(join(OUT, "result.json"), JSON.stringify({ app: APP, mandateId, results, seconds: (Date.now() - T0) / 1000 }, null, 2));
  console.log(`\nPASS in ${((Date.now() - T0) / 1000).toFixed(0)} s · mandate #${mandateId}\n${Object.entries(results).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\nout: ${OUT}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("E2E FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
