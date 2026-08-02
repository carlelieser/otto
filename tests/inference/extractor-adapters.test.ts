import { describe, expect, it, vi } from "vitest";
import { AnthropicExtractor } from "../../src/infrastructure/llm/anthropic-extractor.js";
import { InMemoryExtractor } from "../../src/infrastructure/llm/in-memory-extractor.js";
import { LocalExtractor } from "../../src/infrastructure/llm/local-extractor.js";
import { OpenAiExtractor } from "../../src/infrastructure/llm/openai-extractor.js";
import type { Extractor } from "../../src/ports/extractor.js";

/**
 * The three real adapters and the stub, against a faked transport.
 *
 * What is tested here is the adapter's own work — how structured output is
 * requested, what it records on its result, and how it fails — not whether a
 * model is any good, which is the eval set's job and is measured rather than
 * asserted (`qa.md` §2).
 */

const REQUEST = { text: "Coffee with Sarah.", capturedAt: "2026-08-03T09:00:00.000Z" };

const MENTIONS = {
  mentions: [{ text: "Sarah", entity_type: "Person", confidence: 0.9, fields: [] }],
};

/** A `fetch` returning one canned response, capturing what it was called with. */
function fakeFetch(body: unknown, ok = true) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(body), {
        status: ok ? 200 : 500,
        statusText: ok ? "OK" : "Boom",
      }),
  );
}

type FakeFetch = ReturnType<typeof fakeFetch>;

/** The JSON body an adapter posted, so a test can assert how it asked. */
function postedBody<T>(call: FakeFetch): T {
  return JSON.parse(String(call.mock.calls[0]?.[1]?.body)) as T;
}

/** The prompt an adapter sent, which all three take from the shared template. */
function postedPrompt(call: FakeFetch): string {
  return postedBody<{ messages: { content: string }[] }>(call).messages[0]!.content;
}

function chatResponse(payload: unknown) {
  return { choices: [{ message: { content: JSON.stringify(payload) } }] };
}

describe("the local adapter", () => {
  it("records `local` and the model on everything it produces", async () => {
    const extractor = new LocalExtractor(
      { model: "qwen2.5-7b-instruct" },
      fakeFetch(chatResponse(MENTIONS)),
    );

    const extraction = await extractor.extract(REQUEST);

    expect(extraction).toMatchObject({ provider: "local", modelVersion: "qwen2.5-7b-instruct" });
    expect(extraction.mentions.map(({ text }) => text)).toEqual(["Sarah"]);
  });

  /**
   * Schema-constrained output at temperature 0 (`add.md` §5.2). Sampling
   * variety in a reading task is noise the eval set would measure as model
   * error.
   */
  it("requests a grammar at temperature 0", async () => {
    const call = fakeFetch(chatResponse(MENTIONS));

    await new LocalExtractor({}, call).extract(REQUEST);

    const body = postedBody<Record<string, unknown>>(call);
    expect(body.temperature).toBe(0);
    expect(String(body.grammar)).toContain("mention-person");
  });

  it("names the runtime it could not reach", async () => {
    const extractor = new LocalExtractor(
      { baseUrl: "http://127.0.0.1:9/v1" },
      fakeFetch({}, false),
    );

    await expect(extractor.extract(REQUEST)).rejects.toThrow(/local at http:\/\/127\.0\.0\.1:9/);
  });

  /**
   * An unparseable response is "extraction did not happen", which the pipeline
   * handles by leaving Captures accumulating (`add.md` §11). Returning an empty
   * extraction instead would durably record that the note said nothing.
   */
  it("throws rather than returning an empty extraction when the output is not JSON", async () => {
    const extractor = new LocalExtractor(
      {},
      fakeFetch({ choices: [{ message: { content: "I'm afraid I can't do that" } }] }),
    );

    await expect(extractor.extract(REQUEST)).rejects.toThrow(/not JSON/);
  });
});

describe("the Anthropic adapter", () => {
  function toolResponse(payload: unknown) {
    return { content: [{ type: "tool_use", name: "record_mentions", input: payload }] };
  }

  it("records `anthropic` and the model", async () => {
    const extractor = new AnthropicExtractor({ apiKey: "k" }, fakeFetch(toolResponse(MENTIONS)));

    expect(await extractor.extract(REQUEST)).toMatchObject({
      provider: "anthropic",
      modelVersion: "claude-sonnet-4-5",
    });
  });

  /**
   * Pinning `tool_choice` is what makes the response shape predictable. An
   * unpinned choice lets the model answer in prose when it judges the tool
   * unnecessary — and "no entities in this note" is exactly the case where it
   * would, turning a valid empty extraction into a parse failure.
   */
  it("pins tool_choice to the one tool", async () => {
    const call = fakeFetch(toolResponse(MENTIONS));

    await new AnthropicExtractor({ apiKey: "k" }, call).extract(REQUEST);

    const body = postedBody<{
      tool_choice: { type: string; name: string };
      temperature: number;
    }>(call);
    expect(body.tool_choice).toEqual({ type: "tool", name: "record_mentions" });
    expect(body.temperature).toBe(0);
  });

  it("throws when the model answered without calling the tool", async () => {
    const extractor = new AnthropicExtractor(
      { apiKey: "k" },
      fakeFetch({ content: [{ type: "text", text: "no entities here" }] }),
    );

    await expect(extractor.extract(REQUEST)).rejects.toThrow(/no record_mentions tool call/);
  });
});

describe("the OpenAI adapter", () => {
  it("records `openai` and the model", async () => {
    const extractor = new OpenAiExtractor({ apiKey: "k" }, fakeFetch(chatResponse(MENTIONS)));

    expect(await extractor.extract(REQUEST)).toMatchObject({ provider: "openai" });
  });

  /** `strict: true` is this provider's constrained decoding, not an instruction. */
  it("requests a strict JSON schema", async () => {
    const call = fakeFetch(chatResponse(MENTIONS));

    await new OpenAiExtractor({ apiKey: "k" }, call).extract(REQUEST);

    const body = postedBody<{ response_format: { json_schema: { strict: boolean } } }>(call);
    expect(body.response_format.json_schema.strict).toBe(true);
  });
});

describe("every adapter", () => {
  /**
   * ADR-0008's mitigation, checked: three providers means three copies of the
   * prompt drifting apart, and the shared template is what keeps that from
   * happening. If these three bodies stopped carrying the same prompt text, the
   * eval set would be comparing three different questions.
   */
  it("sends the same shared prompt", async () => {
    const local = fakeFetch(chatResponse(MENTIONS));
    const anthropic = fakeFetch({
      content: [{ type: "tool_use", name: "record_mentions", input: MENTIONS }],
    });
    const openai = fakeFetch(chatResponse(MENTIONS));

    await new LocalExtractor({}, local).extract(REQUEST);
    await new AnthropicExtractor({ apiKey: "k" }, anthropic).extract(REQUEST);
    await new OpenAiExtractor({ apiKey: "k" }, openai).extract(REQUEST);

    const prompts = [local, anthropic, openai].map(postedPrompt);

    expect(new Set(prompts).size).toBe(1);
  });

  /** The Capture timestamp is the one piece of context beyond the text (`schema.md` §8). */
  it("gives the model the Capture timestamp to resolve dates against", async () => {
    const call = fakeFetch(chatResponse(MENTIONS));

    await new LocalExtractor({}, call).extract(REQUEST);

    expect(postedPrompt(call)).toContain(REQUEST.capturedAt);
  });
});

describe("the in-memory adapter", () => {
  /**
   * `add.md` §9's warning, made structural: Slice 0's fake and its real adapter
   * silently disagreed because each was only compared against itself. Routing
   * canned output through the same parser is what keeps a fixture that claims
   * an impossible field from passing here and failing against a model.
   */
  it("parses canned output through the same parser the real adapters use", async () => {
    const extractor: Extractor = new InMemoryExtractor({
      responses: [
        [
          REQUEST.text,
          {
            mentions: [
              {
                text: "Sarah",
                entity_type: "Person",
                confidence: 0.9,
                fields: [{ field: "shoe_size", value: "44" }],
              },
            ],
          },
        ],
      ],
    });

    const extraction = await extractor.extract(REQUEST);

    expect(extraction.mentions[0]!.fields).toEqual([]);
    expect(extraction.violations).toEqual([
      { reason: "unknown_field", field: "shoe_size", entityType: "Person" },
    ]);
  });

  it("returns an empty extraction for a note it has no answer for", async () => {
    const extraction = await new InMemoryExtractor().extract(REQUEST);

    expect(extraction.mentions).toEqual([]);
  });

  /**
   * Deliberately not `local`. A stub claiming to be the local model would put
   * unattributable rows in the correction log that triage's per-model
   * thresholds later key on (ADR-0008).
   */
  it("records a provider that is not the local model's", async () => {
    expect((await new InMemoryExtractor().extract(REQUEST)).provider).toBe("in-memory");
  });
});
