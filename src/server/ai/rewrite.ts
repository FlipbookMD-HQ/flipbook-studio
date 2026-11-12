import { z } from "zod";
import { readSlide, type SlideDraft } from "@flipbook-md/core";
import type { Proposal, RewriteRequest } from "../../shared/api.js";
import { findDeck, loadDeck, slideFileKey, slideIndex } from "../decks.js";
import { StudioError } from "../errors.js";
import type { LlmProvider } from "../llm/provider.js";
import type { LlmSettings } from "../../shared/api.js";
import { contextTokens, fit } from "./budget.js";
import { REWRITE_JSON_SCHEMA, rewriteMessages, rewriteParts } from "./prompts/rewrite.js";
import type { ProposalStore } from "./proposals.js";
import type { SseContext } from "./sse.js";
import { structuredCall } from "./structured.js";

const RewriteOutput = z.object({
  markdown: z.string().trim().min(1, "markdown is empty").max(200_000),
  notes: z.string().max(50_000).optional(),
});

const SUMMARIES: Record<RewriteRequest["instruction"]["kind"], string> = {
  shorten: "Shorten",
  expand: "Expand",
  translate: "Translate",
  custom: "Rewrite",
};

const sameDraft = (a: SlideDraft, b: SlideDraft) => JSON.stringify(a) === JSON.stringify(b);

/** Checks the request before streaming: the slide exists and the editor's hash is current. */
export async function prepareRewrite(root: string, request: RewriteRequest) {
  const deck = await findDeck(root, request.deckId);
  const loaded = await loadDeck(deck);
  const index = slideIndex(deck, loaded.presentation, request.slideId);
  const read = await readSlide(deck.absolute, request.slideId);
  if (read.hash !== request.baseHash) {
    throw new StudioError(
      409,
      "FILE_CONFLICT",
      "The slide changed on disk since you opened it. Reload it first.",
      {
        path: request.slideId,
        details: { currentHash: read.hash },
      },
    );
  }
  return { deck, loaded, index, draft: read.draft, hash: read.hash };
}

/** POST /api/ai/rewrite: streams tokens, then one updateSlide proposal with its violations. */
export async function runRewrite(
  context: SseContext,
  prepared: Awaited<ReturnType<typeof prepareRewrite>>,
  request: RewriteRequest,
  deps: {
    provider: LlmProvider;
    llm: LlmSettings & { model: string };
    store: ProposalStore;
    log?: (line: string) => void;
  },
) {
  const { deck, loaded, index, draft } = prepared;
  const { presentation } = loaded;
  const slide = presentation.slides[index]!;
  const type = draft.type ?? slide.type ?? null;
  const rules =
    (type ? (presentation.blueprint?.types?.[type] as Record<string, unknown> | undefined) : undefined) ??
    null;
  const parts = rewriteParts({
    draft,
    rules,
    template: slide.template,
    deckTitle: presentation.title,
    deckLanguage: (presentation as { lang?: string }).lang ?? null,
    instruction: request.instruction,
    avoid: request.avoid,
  });
  const tokens = await contextTokens(deps.provider, deps.llm.baseUrl, deps.llm.model, context.signal);
  const fitted = fit(parts, tokens);
  if (fitted.trimmed) context.send("notice", { message: "Using a shortened deck context" });

  const output = await structuredCall({
    provider: deps.provider,
    model: deps.llm.model,
    messages: rewriteMessages(fitted.parts),
    schema: RewriteOutput,
    jsonSchema: REWRITE_JSON_SCHEMA,
    temperature: deps.llm.temperature,
    signal: context.signal,
    onToken: (text) => context.send("token", { text }),
    log: deps.log,
  });
  // Output is plain text data: the writer and the sanitizing renderer handle it like typed input.
  const next: SlideDraft = {
    ...draft,
    markdown: output.markdown.trim(),
    notes: output.notes?.trim() ?? draft.notes,
  };
  if (sameDraft(next, draft)) return { noChange: true };

  let violations: { source: string; code: string; message: string }[] = [];
  try {
    const checked = await loadDeck(deck, { slideId: request.slideId, draft: next });
    violations = checked.violations.filter((violation) => violation.source === slide.source);
  } catch (error) {
    violations = [{ source: slide.source, code: "VALIDATION_FAILED", message: (error as Error).message }];
  }
  const proposal: Proposal = deps.store.add({
    deckId: request.deckId,
    summary: `${SUMMARIES[request.instruction.kind]} ${slide.title || request.slideId}`,
    ops: [
      { id: "op-1", kind: "updateSlide", slideId: request.slideId, draft: next, before: draft, violations },
    ],
    baseHashes: { [slideFileKey(deck, request.slideId)]: prepared.hash },
  });
  context.send("proposal", proposal);
  return {};
}
