# Flipbook Studio

A self-hosted editor for [Flipbook MD](https://github.com/uminocelo/flipbook-md) decks. Studio runs on your own machine, reads and writes the same deck files as the `flipbook` CLI, and will connect to a local LLM.

This repository is at its first milestone: it lists the decks in a folder and shows their slides.

## Run

```sh
npm install -g @flipbook-md/studio
flipbook-studio ~/decks
```

Studio serves on `127.0.0.1` (port 4321, or a free port when 4321 is busy), prints the URL, and opens your browser.

| Option            | What it does                                                                       |
| ----------------- | ---------------------------------------------------------------------------------- |
| `[workspace]`     | Folder to open. Defaults to the current folder.                                    |
| `--port <n>`      | Port to try first.                                                                 |
| `--no-open`       | Print the URL without opening a browser.                                           |
| `--library <dir>` | Library folder for themes, templates and kits. Defaults to `~/Documents/flipbook`. |

Exit codes: 0 stopped with Ctrl+C · 1 usage error · 2 workspace missing or not a folder · 3 library not writable · 4 no loopback port available.

The HTTP API under `/api` is internal to Studio and is not a public, stable API.

## Develop

```sh
npm install
npm run build      # Vite builds the UI, tsup builds the server
npm test           # Vitest
npm run e2e        # Playwright against fixtures/
npm run lint && npm run typecheck
```

Studio depends on [`@flipbook-md/core`](https://github.com/uminocelo/flipbook-md-core). To develop both together, clone `flipbook-md-core` next to this repository and run `npm link ../flipbook-md-core`.

## Local model (AI features)

Open **Settings** in Studio, pick Ollama, LM Studio or a custom OpenAI-compatible base URL, choose a model and click **Test**. Settings are stored outside your decks, in `settings.json` in your config folder (`~/Library/Application Support/flipbook-studio` on macOS, `$XDG_CONFIG_HOME/flipbook-studio` or `~/.config/flipbook-studio` on Linux). The file is readable only by you, because it can hold an API key. Set `FLIPBOOK_STUDIO_CONFIG_DIR` to use another folder.

In the slide editor, **AI** rewrites the open slide (Shorten, Expand, Translate or a custom instruction). Save your edits first. The answer shows as a diff with any blueprint violations; nothing changes on disk until you accept it.

**New deck → Generate with AI** writes a whole deck from a topic or pasted text with a media kit. Slides appear as they stream in; Studio then repairs the slides that break the kit's blueprint (Settings → Advanced → repair rounds) and opens the deck at the first slide that still fails. The deck is written in `.flipbook-studio-tmp/` inside your workspace and moved into place only at the end, so cancelling leaves nothing behind. Studio adds that folder to the workspace's `.gitignore` when the workspace is a git repository.

### Review checklist for AI features

- Every AI button is rendered through `<AiAction>` (`src/ui/ai.tsx`), so it is disabled, with a link to Settings, until a model is set up.
- Every AI edit is a proposal shown in `<ProposalReview>` (`src/ui/screens/ProposalReview.tsx`); nothing is written until an op is accepted. Only generate-deck writes directly (into a new deck).
- Model output is data: it goes through a zod schema in `structuredCall` (`src/server/ai/structured.ts`), never into code, and slide IDs in ops are refused when they look like paths.
- Prompts and replies are logged only with `FLIPBOOK_DEBUG=ai`.
- Tests use `FakeProvider` or the HTTP stub in `test/support/` (never a real model). Tests tagged for a real model live in `test/real-llm/` and run in the nightly workflow only.
- An API key never appears in a response, a log line or an error message.
