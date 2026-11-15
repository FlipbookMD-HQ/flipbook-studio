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

## Images

A deck's images live in its `assets/` folder (for a single-file deck, the `assets/` folder next to it, shared with the other single-file decks there).

- **Deck screen → Images:** upload PNG, JPEG, GIF, WebP or SVG files of up to 8 MB. A file whose contents don't match its extension is refused. Names become lowercase kebab-case, and a taken name gets `-2`, `-3` and so on; nothing is overwritten. Each image shows its size, dimensions and the slides that use it. Deleting a used image lists those slides and asks first.
- **Slide editor → Insert image:** pick or upload an image, write its alt text, then **Insert** it at the cursor or **Replace image** to swap the slide's first image.
- **Drop or paste** an image into the Markdown editor to upload it and insert it where it lands.

## Start from a file

**New deck → From a file** turns a document you already have into a deck. Pick or drop a Markdown (`.md`), text (`.txt`) or Word (`.docx`) file of up to 25 MB. Text files must be UTF-8; `.doc`, password-protected Word files and PDFs aren't supported.

Studio reads the file first and shows what it found: the title, the number of sections, the images it will keep, and anything it leaves out (for example an EMF picture or an image linked from outside the file). Nothing is created yet. Then pick one:

- **Import as is:** no model needed. Each `#`/`##` section becomes a slide, the words unchanged. Word headings, lists, bold and italic text, links and tables come across as Markdown, and embedded images go into the deck's `assets/` folder under the same rules as uploaded images. With a media kit, the deck opens with its blueprint violations listed, ready to fix.
- **Convert with AI:** your local model reshapes the file into the kit's slide types, keeping its facts, order and language. It may only use the file's own images; any other image it invents is removed, and Studio says so.

Imported decks are always folder decks. An uploaded file is kept in the workspace's `.flipbook-studio-tmp/` folder for 30 minutes, then deleted.

## Undo and redo

**Undo** and **Redo** in the top bar reverse the changes Studio wrote to the open deck, one step at a time, and put back the exact earlier files: slide saves, added, deleted and reordered slides, accepted AI edits, and image uploads and deletes. Each button names the step it affects, for example "Undo: Delete slide 3". Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z do the same when the focus isn't in a text field or editor (there they undo your typing).

- History lasts for this Studio session and is lost when Studio stops. It keeps the last 50 steps (at most 64 MB) per deck.
- If a file was changed outside Studio after a step, Studio won't undo over it and says which file changed.
- While the open slide has unsaved edits, Undo and Redo wait until you save or discard them.
- Theme, template, blueprint and media kit editors aren't part of this history; their editors keep their own text undo.

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

**Draft with AI** (in Kits → Themes, Templates, Blueprints and Media kits) drafts a kit piece from a description. A theme, template or blueprint opens in its editor as an unsaved draft with a live preview; Save writes it like any other edit. A media kit shows its file, plus a file for each new theme it drafts, for review; Accept all writes them and opens the kit. Studio validates every draft with the same rules as `flipbook check` and caps each drafted file at 50 kB; output that fails is sent back to the model once, then shown as an error with Retry, and nothing is written.

**Chat** (under the slide editor) answers questions about the open deck: its slides, media kit, blueprint and current rule problems. When you ask for a change ("split slide 3 into two"), the reply carries edits that you accept or reject one by one; an edit whose slide changed after the reply is marked stale and can't be applied. One reply runs per deck at a time, and the history lasts until Studio stops.

### Review checklist for AI features

- Every AI button is rendered through `<AiAction>` (`src/ui/ai.tsx`), so it is disabled, with a link to Settings, until a model is set up.
- Every AI edit is a proposal shown in `<ProposalReview>` (`src/ui/screens/ProposalReview.tsx`); nothing is written until an op is accepted. Only generate-deck writes directly (into a new deck).
- Model output is data: it goes through a zod schema in `structuredCall` (`src/server/ai/structured.ts`), never into code, and slide IDs in ops are refused when they look like paths.
- Prompts and replies are logged only with `FLIPBOOK_DEBUG=ai`.
- Tests use `FakeProvider` or the HTTP stub in `test/support/` (never a real model). Tests tagged for a real model live in `test/real-llm/` and run in the nightly workflow only.
- An API key never appears in a response, a log line or an error message.
