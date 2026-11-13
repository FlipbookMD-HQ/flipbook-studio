import { useEffect, useRef, useState } from "react";
import type { ApiError, ApplyProposalResponse, DeckDetail, Proposal, ProposalOp } from "../../shared/api";
import { ApiRequestError, chatDeck } from "../api";
import { AiAction, useLlmStatus } from "../ai";
import { ProposalReview } from "./ProposalReview";
import { ErrorNotice } from "./Shell";

type Entry =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      notices: string[];
      proposal: Proposal | null;
      /** The proposal was closed (Reject all, or Close after applying). */
      closed?: boolean;
      error: ApiError | null;
      done: boolean;
    };

interface ChatState {
  sessionId: string | null;
  entries: Entry[];
  /** Proposals with an applied op: the server tracks their own hashes, so they aren't marked here. */
  touched: string[];
}

// The panel's history for this page load (the server keeps it for this Studio session).
const memory = new Map<string, ChatState>();
const empty = (): ChatState => ({ sessionId: null, entries: [], touched: [] });

const basename = (file: string) => file.split("/").pop() ?? file;

/** The DeckDetail.hashes key an op writes. */
function opFile(deck: DeckDetail, op: ProposalOp): string | null {
  if (deck.kind === "single") return basename(deck.path);
  if (op.kind === "updateSlide") return op.slideId;
  if (op.kind === "writeKitFile") return null;
  return "presentation.yml";
}

/** Ops whose file changed on disk since the proposal was made. */
function staleOps(deck: DeckDetail, proposal: Proposal): Set<string> {
  const stale = new Set<string>();
  for (const op of proposal.ops) {
    const file = opFile(deck, op);
    if (file && file in proposal.baseHashes && proposal.baseHashes[file] !== deck.hashes[file])
      stale.add(op.id);
  }
  return stale;
}

/**
 * The deck chat (US-15): ask about the open deck; edits come back as proposals reviewed inline.
 * Once the deck changes on disk (an apply here, a save, a reload), older proposals' ops whose
 * files changed show as stale.
 */
export function ChatPanel({
  deck,
  slideId,
  onApplied,
}: {
  deck: DeckDetail;
  slideId: string;
  onApplied: (result: ApplyProposalResponse) => void;
}) {
  const { configured } = useLlmStatus();
  const [open, setOpen] = useState(false);
  const [chat, setChatState] = useState<ChatState>(() => memory.get(deck.id) ?? empty());
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const running = chat.entries.some((entry) => entry.role === "assistant" && !entry.done);

  const setChat = (update: (current: ChatState) => ChatState) =>
    setChatState((current) => {
      const next = update(current);
      memory.set(deck.id, next);
      return next;
    });
  const updateLast = (patch: Partial<Extract<Entry, { role: "assistant" }>>) =>
    setChat((current) => {
      const entries = [...current.entries];
      const last = entries.at(-1);
      if (last?.role === "assistant") entries[entries.length - 1] = { ...last, ...patch };
      return { ...current, entries };
    });

  const closeProposal = (index: number) =>
    setChat((current) => {
      const entries = [...current.entries];
      const entry = entries[index];
      if (entry?.role === "assistant") entries[index] = { ...entry, closed: true };
      return { ...current, entries };
    });

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView?.({ block: "end" });
  }, [chat.entries]);

  const send = async () => {
    const text = message.trim();
    if (!text || running) return;
    const abort = new AbortController();
    controller.current = abort;
    setMessage("");
    let reply = "";
    const notices: string[] = [];
    setChat((current) => ({
      ...current,
      entries: [
        ...current.entries,
        { role: "user", text },
        { role: "assistant", text: "", notices: [], proposal: null, error: null, done: false },
      ],
    }));
    try {
      await chatDeck(
        { deckId: deck.id, sessionId: chat.sessionId, message: text, slideId },
        ({ event, data }) => {
          if (event === "token") {
            reply += data.text;
            updateLast({ text: reply });
          } else if (event === "notice") {
            notices.push(data.message);
            updateLast({ notices: [...notices] });
          } else if (event === "proposal") updateLast({ proposal: data });
          else if (event === "done") {
            updateLast({ done: true });
            if (data.sessionId) setChat((current) => ({ ...current, sessionId: data.sessionId! }));
          } else if (event === "failed")
            updateLast({ done: true, error: data.error.code === "CANCELLED" ? null : data.error });
        },
        abort.signal,
      );
      updateLast({ done: true });
    } catch (error) {
      updateLast({
        done: true,
        error: abort.signal.aborted
          ? null
          : error instanceof ApiRequestError
            ? error.error
            : { code: "INTERNAL", message: String(error) },
      });
    }
  };

  return (
    <aside className={`chat-panel${open ? " open" : ""}`} aria-label="Deck chat">
      <header className="chat-head">
        <AiAction onClick={() => setOpen((value) => !value)} title="Ask about this deck">
          {open ? "Hide chat" : "Chat"}
        </AiAction>
        {open && chat.entries.length ? (
          <button
            type="button"
            disabled={running}
            onClick={() => setChat(() => empty())}
            title="Start a new conversation"
          >
            New chat
          </button>
        ) : null}
      </header>
      {open && configured ? (
        <>
          <ol className="chat-messages" ref={list} aria-live="polite">
            {chat.entries.length === 0 ? (
              <li className="muted">
                Ask about this deck, or ask for a change: “split slide 3 into two”, “make the tone more
                casual”.
              </li>
            ) : null}
            {chat.entries.map((entry, index) =>
              entry.role === "user" ? (
                <li key={index} className="chat-user" data-testid="chat-user">
                  {entry.text}
                </li>
              ) : (
                <li key={index} className="chat-assistant" data-testid="chat-assistant">
                  {entry.text ? <p className="chat-text">{entry.text}</p> : null}
                  {!entry.done && !entry.text ? <p className="muted">Thinking…</p> : null}
                  {entry.notices.map((notice) => (
                    <p key={notice} className="notice" role="status" data-testid="chat-notice">
                      {notice}
                    </p>
                  ))}
                  {entry.error ? <ErrorNotice error={entry.error} /> : null}
                  {entry.proposal && entry.closed ? (
                    <p className="muted" data-testid="chat-closed">
                      Review closed.
                    </p>
                  ) : null}
                  {entry.proposal && !entry.closed ? (
                    <ProposalReview
                      proposal={entry.proposal}
                      staleOpIds={
                        chat.touched.includes(entry.proposal.id) ? undefined : staleOps(deck, entry.proposal)
                      }
                      onApplied={(result) => {
                        if (result.applied.length) {
                          const id = entry.proposal!.id;
                          setChat((current) => ({ ...current, touched: [...current.touched, id] }));
                        }
                        onApplied(result);
                      }}
                      onClose={() => closeProposal(index)}
                    />
                  ) : null}
                </li>
              ),
            )}
          </ol>
          <form
            className="chat-form"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <textarea
              aria-label="Message"
              rows={2}
              value={message}
              maxLength={8000}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            {running ? (
              <button type="button" onClick={() => controller.current?.abort()}>
                Stop
              </button>
            ) : (
              <button type="submit" className="primary" disabled={!message.trim()}>
                Send
              </button>
            )}
          </form>
        </>
      ) : null}
    </aside>
  );
}
