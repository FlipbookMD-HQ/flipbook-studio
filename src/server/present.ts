import { startServer, type ServerInstance } from "@flipbook-md/core";
import type { DeckEntry } from "./workspace.js";
import { loadDeck } from "./decks.js";
import { StudioError } from "./errors.js";

/**
 * One core player server per deck, on a free loopback port. The server re-reads the deck on
 * every request, so a saved edit shows after the player reloads. Servers close with Studio.
 */
export class PlayerRegistry {
  private readonly servers = new Map<string, Promise<ServerInstance>>();

  async open(
    id: string,
    deck: DeckEntry,
    slideIndex: number,
  ): Promise<{ url: string; announcerUrl: string }> {
    const { violations } = await loadDeck(deck);
    if (violations.length) {
      throw new StudioError(422, "BLUEPRINT_FAILED", "Fix the blueprint issues before presenting.", {
        details: { violations },
      });
    }
    let server = this.servers.get(id);
    if (!server) {
      server = startServer(async () => (await loadDeck(deck)).presentation);
      this.servers.set(id, server);
      server.catch(() => this.servers.delete(id));
    }
    const { url } = await server;
    return { url: `${url}/?slide=${slideIndex + 1}`, announcerUrl: `${url}/announcer` };
  }

  get size(): number {
    return this.servers.size;
  }

  async closeAll(): Promise<void> {
    const running = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(running.map(async (server) => (await server.catch(() => null))?.close()));
  }
}
