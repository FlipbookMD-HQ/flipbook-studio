import {
  LlmError,
  type ChatEvent,
  type ChatRequest,
  type LlmProvider,
} from "../../src/server/llm/provider.js";
import { fixtureTokens, nextChatFixture, sleep, type LlmScript } from "./llm-fixtures.js";

/** An in-process LlmProvider answering from the same LlmScript as the HTTP stub (D14). */
export class FakeProvider implements LlmProvider {
  readonly requests: Omit<ChatRequest, "signal">[] = [];
  private chats = 0;
  constructor(public script: LlmScript = {}) {}

  private statusError(status: number): LlmError {
    if (status === 401 || status === 403)
      return new LlmError("unauthorized", "fake: rejected the API key", status);
    if (status === 404) return new LlmError("model_not_found", "fake: no such model", status);
    return new LlmError("unreachable", `fake: answered ${status}`, status);
  }

  async listModels() {
    const models = this.script.models ?? ["stub-model"];
    if (!Array.isArray(models)) throw this.statusError(models.status);
    return models.map((model) => ({ id: typeof model === "string" ? model : model.id }));
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatEvent> {
    const { signal, ...rest } = request;
    this.requests.push(rest);
    const fixture = nextChatFixture(this.script, this.chats++, request);
    const cancelled = () => new LlmError("cancelled", "The request was cancelled.");
    if (fixture.kind === "status") throw this.statusError(fixture.status);
    if (fixture.kind === "hang") {
      await sleep(10 * 60_000, signal).catch(() => {
        throw cancelled();
      });
    }
    for (const token of fixtureTokens(fixture)) {
      if (signal.aborted) throw cancelled();
      if (fixture.kind === "slowTokens")
        await sleep(fixture.ms, signal).catch(() => {
          throw cancelled();
        });
      yield { type: "delta", text: token };
    }
    yield { type: "done", ...(fixture.kind === "text" && fixture.usage ? { usage: fixture.usage } : {}) };
  }
}
