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
