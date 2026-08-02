/**
 * The message a failed provider call throws with.
 *
 * Shared by the three adapters because it is transport plumbing rather than a
 * per-provider difference — ADR-0008 confines those to how structured output is
 * requested, and an HTTP status is not that.
 *
 * The body is included because the useful part of a provider failure is almost
 * always in it: an expired key, a model name that does not exist, or a context
 * length. The status alone sends someone to a dashboard to find out what a 400
 * meant.
 */
export async function providerFailure(response: Response, provider: string): Promise<Error> {
  const body = await response.text().catch(() => "");
  const status = `${response.status} ${response.statusText}`.trim();
  return new Error(`Extraction via ${provider} failed: ${status} ${body}`.trim());
}

/** Injected so an adapter is testable without a running model or a network. */
export type FetchLike = typeof fetch;

/**
 * The JSON in an OpenAI-compatible chat response's message content.
 *
 * Shared by the local and OpenAI adapters, which speak the same wire format —
 * LMStudio and Ollama both expose `/chat/completions`, which is why one adapter
 * covers both runtimes and why this reader covers all three call sites.
 *
 * ADR-0008 confines per-adapter differences to *how* structured output is
 * requested — a grammar, `response_format`, or tool use. Reading a chat
 * response is not that: it is the same parse in both files, and the two copies
 * this replaces had drifted only in the name of the function.
 *
 * An unreachable runtime and an unparseable response both throw, because both
 * are "extraction did not happen" — a state the pipeline handles by leaving
 * Captures accumulating (`add.md` §11). Returning an empty extraction instead
 * would durably record that the note said nothing.
 */
export function chatResponseJson(response: unknown, model: string): unknown {
  const content = (response as ChatResponse)?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`Extraction from ${model} returned no message content`);
  }
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error(`Extraction from ${model} returned content that is not JSON`);
  }
}

interface ChatResponse {
  readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[];
}
