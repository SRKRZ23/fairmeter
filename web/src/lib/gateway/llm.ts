/**
 * Model calls through Groq's OpenAI-compatible API, with a timeout and bounded retries on 429/5xx.
 * Returns the text plus the token counts the provider actually reported (these are what the user pays for).
 */
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export class LlmError extends Error {}

export async function chat(
  model: string,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  opts: { maxTokens?: number; reasoningEffort?: "low" | "medium" | "high"; timeoutMs?: number } = {},
): Promise<LlmResult> {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) throw new LlmError("GROQ_API_KEY is not set on the server.");
  const body: Record<string, unknown> = { model, messages, temperature: 0.2 };
  if (opts.maxTokens !== undefined) body.max_completion_tokens = opts.maxTokens;
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;

  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 429 || res.status >= 500) {
        lastError = json?.error?.message ?? `HTTP ${res.status}`;
        continue;
      }
      if (!res.ok) throw new LlmError(json?.error?.message ?? `HTTP ${res.status}`);
      return {
        text: String(json.choices?.[0]?.message?.content ?? ""),
        inputTokens: Number(json.usage?.prompt_tokens ?? 0),
        outputTokens: Number(json.usage?.completion_tokens ?? 0),
      };
    } catch (e) {
      if (e instanceof LlmError) throw e;
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new LlmError(`Model ${model} unavailable: ${lastError}`);
}
