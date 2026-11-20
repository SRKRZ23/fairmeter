/** Prices in tUSD8 base units (6 decimals) per 1,000 tokens. Testnet prices, chosen to make amounts readable. */
export interface Rate {
  model: string;
  inPer1k: bigint;
  outPer1k: bigint;
}

export const TIERS = {
  guard: { model: "meta-llama/llama-prompt-guard-2-86m", inPer1k: 500n, outPer1k: 0n },
  cheap: { model: "openai/gpt-oss-20b", inPer1k: 5_000n, outPer1k: 20_000n },
  strong: { model: "openai/gpt-oss-120b", inPer1k: 15_000n, outPer1k: 60_000n },
} as const satisfies Record<string, Rate>;

/** Cost of one call, rounded up to the next base unit. */
export function costOf(rate: Rate, inputTokens: number, outputTokens: number): bigint {
  const raw = rate.inPer1k * BigInt(inputTokens) + rate.outPer1k * BigInt(outputTokens);
  return (raw + 999n) / 1000n;
}

/** A safe upper bound on tokens for a prompt: about 3 characters per token, plus chat overhead. */
export const promptTokenBound = (prompt: string) => Math.ceil(prompt.length / 3) + 64;

export const CHECK_PROMPT_OVERHEAD = 220;
export const CHECK_MAX_OUT = 300;

/**
 * The worst case for one request: guard + cheap draft + self-check + escalation to the strong model, each at the
 * token limit. The agent authorizes this ceiling; the provider charges what actually ran.
 */
export function maxPriceFor(prompt: string, maxTokens: number): bigint {
  const p = promptTokenBound(prompt);
  return (
    costOf(TIERS.guard, p, 0) +
    costOf(TIERS.cheap, p, maxTokens) +
    costOf(TIERS.cheap, p + maxTokens + CHECK_PROMPT_OVERHEAD, CHECK_MAX_OUT) +
    costOf(TIERS.strong, p, maxTokens)
  );
}

const fmt = (x: bigint) => (Number(x) / 1e6).toString();
export const ratesText = () =>
  [TIERS.cheap, TIERS.strong]
    .map((r) => `${r.model.split("/").pop()} in ${fmt(r.inPer1k)} / out ${fmt(r.outPer1k)} tUSD8 per 1k tokens`)
    .join("; ") + `; prompt guard ${fmt(TIERS.guard.inPer1k)} per 1k`;

/** Format base units as tUSD8 with up to 6 decimals, trimming zeros. */
export function formatTusd8(x: bigint | string): string {
  const v = BigInt(x);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
