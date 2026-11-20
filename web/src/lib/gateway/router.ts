import { costOf, TIERS, type UsageLine } from "@fairmeter/sdk";
import { chat } from "./llm";

/**
 * Confidence routing: screen the prompt, draft with the cheap model, let the cheap model grade its own draft,
 * and pay for the strong model only when the grade is low. Every call is billed at its real token counts.
 */
export const GUARD_THRESHOLD = 0.5;
export const ESCALATE_AT_OR_BELOW = 3;

const SYSTEM = "You are a precise assistant. Answer the user's question directly and correctly. Be concise.";

export interface Routed {
  answer: string;
  usage: UsageLine[];
  route: "cheap" | "escalated" | "blocked";
  reason: string;
}

const line = (step: UsageLine["step"], tier: (typeof TIERS)[keyof typeof TIERS], i: number, o: number): UsageLine => ({
  step,
  model: tier.model,
  inputTokens: i,
  outputTokens: o,
  cost: costOf(tier, i, o).toString(),
});

export async function route(prompt: string, maxTokens: number): Promise<Routed> {
  const usage: UsageLine[] = [];

  // 1. Prompt-injection screen. A blocked request costs only the screen.
  const g = await chat(TIERS.guard.model, [{ role: "user", content: prompt }], { timeoutMs: 15_000 });
  usage.push(line("guard", TIERS.guard, g.inputTokens, g.outputTokens));
  const score = Number.parseFloat(g.text);
  if (Number.isFinite(score) && score >= GUARD_THRESHOLD) {
    return {
      answer:
        "This request was not answered: it looks like a prompt-injection attempt " +
        `(guard score ${score.toFixed(3)}). Only the safety check was charged.`,
      usage,
      route: "blocked",
      reason: `prompt guard score ${score.toFixed(4)} >= ${GUARD_THRESHOLD}`,
    };
  }

  // 2. Cheap draft.
  const d = await chat(
    TIERS.cheap.model,
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt },
    ],
    { maxTokens, reasoningEffort: "low" },
  );
  usage.push(line("draft", TIERS.cheap, d.inputTokens, d.outputTokens));

  // 3. Self-check: the cheap model grades its own draft 1-5.
  const c = await chat(
    TIERS.cheap.model,
    [
      {
        role: "system",
        content:
          "You grade answers. Reply with a single digit from 1 to 5: 5 = certainly complete and correct, " +
          "3 = unsure, 1 = wrong or missing. If the question needs careful multi-step reasoning, math, code or " +
          "facts you cannot verify, do not give more than 3 unless the answer is clearly right.",
      },
      { role: "user", content: `QUESTION:\n${prompt}\n\nANSWER:\n${d.text}\n\nGrade (1-5):` },
    ],
    { maxTokens: 300, reasoningEffort: "low" },
  );
  usage.push(line("check", TIERS.cheap, c.inputTokens, c.outputTokens));
  const grade = Number(c.text.match(/[1-5]/)?.[0] ?? 0);

  if (d.text.trim() && grade > ESCALATE_AT_OR_BELOW) {
    return { answer: d.text, usage, route: "cheap", reason: `self-check grade ${grade}/5, cheap answer kept` };
  }

  // 4. Escalate.
  const s = await chat(
    TIERS.strong.model,
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt },
    ],
    { maxTokens, reasoningEffort: "low" },
  );
  usage.push(line("escalate", TIERS.strong, s.inputTokens, s.outputTokens));
  return {
    answer: s.text || d.text,
    usage,
    route: "escalated",
    reason: grade ? `self-check grade ${grade}/5 <= ${ESCALATE_AT_OR_BELOW}, escalated` : "empty or ungraded draft, escalated",
  };
}
