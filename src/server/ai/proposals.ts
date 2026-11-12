import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import {
  FileConflictError,
  KitExistsError,
  KitInvalidError,
  KitNotFoundError,
  hashBytes,
  insertSlide,
  loadPresentation,
  readKit,
  removeSlide,
  reorderSlides,
  resolveKitPath,
  updateSlide,
  writeKit,
} from "@flipbook-md/core";
import {
  ProposalOpSchema,
  type ApplyProposalResponse,
  type Proposal,
  type ProposalOp,
} from "../../shared/api.js";
import { findDeck, deckHashes, slideFileKey, slideIdAt, structureKey } from "../decks.js";
import { StudioError } from "../errors.js";
import { coreRef } from "../kits.js";
import type { DeckEntry } from "../workspace.js";

export const PROPOSAL_LIMIT = 100;

interface Stored extends Proposal {
  applied: Set<string>;
}

/** AI proposals waiting for review: the newest 100, in memory only (lost on restart). */
export class ProposalStore {
  private readonly proposals = new Map<string, Stored>();

  add(proposal: Omit<Proposal, "id" | "createdAt">): Proposal {
    const stored: Stored = {
      ...proposal,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      applied: new Set(),
    };
    this.proposals.set(stored.id, stored);
    while (this.proposals.size > PROPOSAL_LIMIT) this.proposals.delete(this.proposals.keys().next().value!);
    return publicProposal(stored);
  }

  get(id: string): Stored {
    const proposal = this.proposals.get(id);
    if (!proposal)
      throw new StudioError(404, "PROPOSAL_NOT_FOUND", "That proposal no longer exists. Run the AI again.");
    return proposal;
  }

  delete(id: string): void {
    this.get(id);
    this.proposals.delete(id);
  }

  get size() {
    return this.proposals.size;
  }
}

function publicProposal({ id, createdAt, deckId, summary, ops, baseHashes }: Stored): Proposal {
  return { id, createdAt, deckId, summary, ops, baseHashes };
}

/** The baseHashes key of a kit file. */
export const kitKey = (kit: { kind: string; scope: string; name: string; deckId?: string }) =>
  `kit:${kit.kind}:${kit.scope}:${kit.scope === "deck" ? kit.deckId : kit.name}`;

// Updates first, then kit writes, inserts, moves and deletes: an earlier op never shifts a later one's target.
const ORDER: Record<ProposalOp["kind"], number> = {
  updateSlide: 0,
  writeKitFile: 1,
  addSlide: 2,
  moveSlide: 3,
  deleteSlide: 4,
};

type Rejection = ApplyProposalResponse["rejected"][number];
class OpRejected extends Error {
  constructor(
    readonly code: Rejection["code"],
    message: string,
  ) {
    super(message);
  }
}

const stale = (message = "The target changed since the proposal was made. Run the AI again.") =>
  new OpRejected("STALE_PROPOSAL", message);

/** Maps a write failure to a rejection. A missing target counts as stale (it was deleted since). */
function rejection(error: unknown): OpRejected {
  if (error instanceof OpRejected) return error;
  if (error instanceof FileConflictError || error instanceof KitExistsError) return stale();
  if (error instanceof KitInvalidError) return new OpRejected("KIT_INVALID", (error as Error).message);
  const code = (error as { code?: string }).code;
  if (code === "SLIDE_NOT_FOUND" || error instanceof KitNotFoundError)
    return stale("The slide or file no longer exists.");
  if (error instanceof StudioError && error.code === "DECK_NOT_FOUND")
    return stale("The deck no longer exists.");
  // Anything else (a permissions error, a broken deck) rejects this op only.
  return new OpRejected("VALIDATION_FAILED", error instanceof Error ? error.message : String(error));
}

async function currentOrder(deck: DeckEntry): Promise<string[]> {
  const { presentation } = await loadPresentation(deck.absolute, { blueprint: "evaluate" });
  return presentation.slides.map((_, index) => slideIdAt(deck, presentation, index));
}

async function fileHash(file: string): Promise<string | null> {
  try {
    return hashBytes(await fs.readFile(file));
  } catch {
    return null;
  }
}

/**
 * Applies the chosen ops of a proposal. Each op runs on its own through the core writer with the
 * hash recorded when the proposal was made, so a stale op never blocks the others. As ops write a
 * file, the expected hash moves on with them.
 */
export async function applyProposal(
  root: string,
  store: ProposalStore,
  id: string,
  opIds: string[],
): Promise<ApplyProposalResponse> {
  const proposal = store.get(id);
  const wanted = new Set(opIds);
  const expected: Record<string, string | null> = { ...proposal.baseHashes };
  const applied: string[] = [];
  const rejected: Rejection[] = [];
  let deck: DeckEntry | null = null;
  const getDeck = async () => {
    if (!proposal.deckId) throw new OpRejected("VALIDATION_FAILED", "This proposal has no deck.");
    deck ??= await findDeck(root, proposal.deckId);
    return deck;
  };
  const ops = proposal.ops.filter((op) => wanted.has(op.id)).sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  for (const unknown of opIds.filter((opId) => !proposal.ops.some((op) => op.id === opId)))
    rejected.push({
      opId: unknown,
      code: "VALIDATION_FAILED",
      message: "No op with that ID in this proposal.",
    });

  for (const raw of ops) {
    try {
      if (proposal.applied.has(raw.id)) throw stale("This op was already applied.");
      const parsed = ProposalOpSchema.safeParse(raw);
      if (!parsed.success)
        throw new OpRejected(
          "VALIDATION_FAILED",
          parsed.error.issues.map((issue) => issue.message).join(" "),
        );
      const op = parsed.data;
      const need = (key: string) => {
        const hash = expected[key];
        if (hash === undefined) throw stale("No base hash was recorded for this file.");
        return hash;
      };
      switch (op.kind) {
        case "updateSlide": {
          const target = await getDeck();
          const key = slideFileKey(target, op.slideId);
          const result = await updateSlide(target.absolute, op.slideId, op.draft, need(key)!);
          Object.assign(expected, result.hashes);
          break;
        }
        case "addSlide": {
          const target = await getDeck();
          const key = structureKey(target);
          await insertSlide(target.absolute, op.afterSlideId, op.draft, need(key)!);
          expected[key] = await fileHash(structurePath(target));
          break;
        }
        case "moveSlide": {
          const target = await getDeck();
          const key = structureKey(target);
          const order = await currentOrder(target);
          const from = order.indexOf(op.slideId);
          if (from < 0) throw stale("The slide no longer exists.");
          if (op.toIndex >= order.length)
            throw new OpRejected("VALIDATION_FAILED", "toIndex is past the last slide.");
          order.splice(op.toIndex, 0, ...order.splice(from, 1));
          await reorderSlides(target.absolute, order, need(key)!);
          expected[key] = await fileHash(structurePath(target));
          break;
        }
        case "deleteSlide": {
          const target = await getDeck();
          const key = structureKey(target);
          await removeSlide(target.absolute, op.slideId, need(key)!);
          expected[key] = await fileHash(structurePath(target));
          break;
        }
        case "writeKitFile": {
          const ref = await coreRef(root, op.kit.kind, op.kit.name, op.kit.scope, op.kit.deckId);
          const key = kitKey(op.kit);
          const result = await writeKit(ref, { source: op.source }, need(key));
          expected[key] = result.hash;
          break;
        }
      }
      proposal.applied.add(op.id);
      applied.push(op.id);
    } catch (error) {
      const { code, message } = rejection(error);
      rejected.push({ opId: raw.id, code, message });
    }
  }
  const hashes = proposal.deckId
    ? await deckHashes(await findDeck(root, proposal.deckId)).catch(() => ({}))
    : {};
  return { applied, rejected, hashes };
}

function structurePath(deck: DeckEntry): string {
  return deck.kind === "folder" ? `${deck.absolute}/presentation.yml` : deck.absolute;
}

/** The base hash of a kit file for a proposal (null when it doesn't exist yet). */
export async function kitBaseHash(
  root: string,
  kit: ProposalOp & { kind: "writeKitFile" },
): Promise<string | null> {
  const ref = await coreRef(root, kit.kit.kind, kit.kit.name, kit.kit.scope, kit.kit.deckId);
  try {
    return (await readKit(ref)).hash;
  } catch {
    return (await fileHash(resolveKitPath(ref))) ?? null;
  }
}
