import type { AiProvider, Usage, UsageResponse, UsageTotal } from "../../shared/api.js";
import type { ChatEvent, ChatRequest, LlmProvider } from "../llm/provider.js";

type Reported = { prompt: number; completion: number };

/**
 * US-25: the session's token totals per paid provider, in memory only (reset on restart). Two tabs
 * share one meter. Local runs add nothing; no prices or estimates are ever derived from it.
 */
export class UsageMeter {
  /** When this meter (and so this Studio) started. */
  readonly since = new Date().toISOString();
  private readonly totals = new Map<string, UsageTotal>();

  /** Counts one finished or cancelled paid run: its tokens, or `unreported` when it has none. */
  record(provider: AiProvider, usage: Usage | null) {
    if (provider.kind === "local") return;
    const total = this.totals.get(provider.id) ?? {
      providerId: provider.id,
      label: provider.label,
      kind: provider.kind,
      requests: 0,
      input: 0,
      output: 0,
      unreported: 0,
    };
    // A renamed provider keeps its totals under its latest name.
    total.label = provider.label;
    total.requests += 1;
    if (usage) {
      total.input += usage.input;
      total.output += usage.output;
    } else total.unreported += 1;
    this.totals.set(provider.id, total);
  }

  /** GET /api/usage: paid providers only, in the order they were first used. */
  view(): UsageResponse {
    return { since: this.since, totals: [...this.totals.values()].map((total) => ({ ...total })) };
  }
}

/**
 * US-25: one paid AI run's usage. It wraps the run's provider and adds up what each request
 * reports (every repair round is a request). `settle` records the run once in the meter.
 */
export class UsageTally {
  /** The latest usage of each request, in order; null until that request reports any. */
  private readonly requests: (Usage | null)[] = [];
  private listener: ((usage: Usage) => void) | null = null;
  private settled: Usage | null | undefined;

  constructor(
    private readonly provider: AiProvider,
    private readonly meter: UsageMeter,
  ) {}

  /** The provider as the run sees it: every chat request is counted here. */
  wrap(inner: LlmProvider): LlmProvider {
    return {
      listModels: (signal) => inner.listModels(signal),
      chat: (request) => this.chat(inner, request),
    };
  }

  private async *chat(inner: LlmProvider, request: ChatRequest): AsyncIterable<ChatEvent> {
    const slot = this.requests.push(null) - 1;
    const report = (usage: Reported) => {
      const next = { input: usage.prompt, output: usage.completion };
      const last = this.requests[slot];
      if (last && last.input === next.input && last.output === next.output) return;
      this.requests[slot] = next;
      const total = this.current();
      if (total && this.settled === undefined) this.listener?.(total);
    };
    const onUsage = (usage: Reported) => {
      request.onUsage?.(usage);
      report(usage);
    };
    for await (const event of inner.chat({ ...request, onUsage })) {
      if (event.type === "done" && event.usage) report(event.usage);
      yield event;
    }
  }

  /** Called with the run's total each time it grows (the `usage` progress event). */
  onChange(listener: (usage: Usage) => void) {
    this.listener = listener;
  }

  /** The run's usage so far, summed over its requests; null when none reported any. */
  current(): Usage | null {
    const reported = this.requests.filter((usage): usage is Usage => usage != null);
    if (!reported.length) return null;
    return reported.reduce((sum, usage) => ({
      input: sum.input + usage.input,
      output: sum.output + usage.output,
    }));
  }

  /**
   * The run's final usage, recorded in the meter once. A run that never sent a request (it failed
   * before reaching the provider) costs nothing and isn't counted.
   */
  settle(): Usage | null {
    if (this.settled !== undefined) return this.settled;
    this.settled = this.current();
    if (this.requests.length) this.meter.record(this.provider, this.settled);
    return this.settled;
  }
}
