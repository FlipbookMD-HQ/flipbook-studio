# Flipbook Studio

**Make slide decks from Markdown, in an editor that runs on your own computer.**

Studio is the visual editor for [Flipbook MD](https://github.com/uminocelo/flipbook-md). Your decks stay plain files in a folder you choose, so they work with the `flipbook` command line too, and you can keep them in git. Nothing is uploaded anywhere. AI is optional and uses a model on your own machine.

> **Status: preview (v0.1).** Things work, but expect rough edges. [Report a problem](https://github.com/uminocelo/flipbook-studio/issues).

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer. Check with `node --version`.

**1. Install Studio**

```sh
npm install -g https://github.com/uminocelo/flipbook-studio/releases/latest/download/flipbook-studio.tgz
```

**2. Open a folder for your decks**

```sh
mkdir -p ~/decks
flipbook-studio ~/decks
```

Studio opens in your browser. Keep the terminal open while you work, and press **Ctrl+C** in it to stop Studio.

**3. Make your first deck**

Click **New deck**, give it a title, and start writing. Each slide has a form, a Markdown editor and a live preview. Changes are saved as files in `~/decks`.

## What you can do

- **Write slides** with a form or Markdown and see them as you type. Add, reorder and delete slides, and undo any change.
- **Add images and GIFs** by uploading, dropping or pasting them.
- **Start from a document** you already have: a Markdown, text or Word file.
- **Style your decks** with themes, layouts on a 3×3 grid, and media kits that bundle a look with rules (a blueprint) Studio checks while you edit.
- **Present** full screen, or **export** a PNG carousel for Instagram, X or LinkedIn, or an MP4 video.
- **Duplicate** a deck or a kit to try a variation without touching the original.
- **Save versions** of a deck with a short note, and see its past versions (uses git).
- **Use AI, if you want:** rewrite a slide, generate a whole deck, draft a theme or kit, or chat about your deck. Every AI change is shown first, and you accept or reject it.

## Optional setup

### Exporting carousels and videos

Exports need a browser engine, and videos also need ffmpeg. Install them once:

```sh
npx playwright install chromium     # for PNG carousels and videos
brew install ffmpeg                 # for videos (macOS; use your package manager on Linux)
```

If one is missing, Studio tells you when you export.

### AI with a local model

Studio works with [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai), or any server that speaks the OpenAI API. For example, with Ollama:

```sh
ollama pull llama3.1
```

Then in Studio open **Settings**, pick **Ollama**, choose the model and click **Test**. Until a model is set up, AI buttons are turned off and link to Settings.

## Guides

<details>
<summary><strong>Images</strong></summary>

A deck's images live in its `assets/` folder. A single-file deck uses the `assets/` folder next to it, shared with the other single-file decks there.

- **Deck screen → Images:** upload PNG, JPEG, GIF, WebP or SVG files up to 8 MB. Names become lowercase with dashes, and a taken name gets `-2`, `-3` and so on, so nothing is overwritten. Each image shows the slides that use it, and Studio asks before deleting one that's in use.
- **Slide editor → Insert image:** pick or upload an image, write its alt text, then insert it at the cursor or replace the slide's first image.
- **Drop or paste** an image into the Markdown editor to upload and insert it in one step.

</details>

<details>
<summary><strong>Start from a file</strong></summary>

**New deck → From a file** turns a Markdown (`.md`), text (`.txt`) or Word (`.docx`) file of up to 25 MB into a deck. Text files must be UTF-8. Old `.doc` files, password-protected Word files and PDFs aren't supported.

Studio first shows what it found: the title, the sections, the images it will keep and anything it will leave out. Nothing is created until you choose:

- **Import as is:** no AI needed. Each heading becomes a slide with the words unchanged. Lists, bold and italic text, links, tables and images come across.
- **Convert with AI:** your model reshapes the content into the media kit's slide types, keeping the facts, order and language.

</details>

<details>
<summary><strong>Duplicate decks and kits</strong></summary>

- **Decks:** **Duplicate** on a deck's card or screen saves a copy next to the original, named `<name>-copy`, and opens it. Exports in `dist/`, hidden files such as `.git`, and symlinks aren't copied.
- **Kits:** **Duplicate** on a theme, template, blueprint or media kit saves a copy in your library and opens it in its editor. The three built-in templates (`flow`, `cover`, `summary`) can't be duplicated.

</details>

<details>
<summary><strong>Undo and redo</strong></summary>

**Undo** and **Redo** in the top bar reverse the changes Studio made to the open deck, one at a time: slide saves, added, deleted or reordered slides, accepted AI edits, and image changes. Each button names its step, for example "Undo: Delete slide 3". Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z work too, outside text fields.

History keeps the last 50 steps per deck and is cleared when Studio stops. If a file was changed outside Studio, Studio won't undo over it and tells you which file changed. Kit editors keep their own undo.

</details>

<details>
<summary><strong>Version history (git)</strong></summary>

**History** in the deck's top bar saves a version of the deck with an optional note and lists its past versions, newest first, with the note, time, author and how many slides changed. Commits you made outside Studio that touch the deck are listed too. It needs git 2.30 or newer; without it, History is turned off and everything else works.

- **What gets committed:** only the deck's own files. For a folder deck, that's its folder (slides, `presentation.yml`, CSS, `assets/`, and so on) except `dist/`, `exports/`, `node_modules/` and `.flipbook-studio-tmp/`. For a single-file deck, it's the `.slide.md` file plus the images in the shared `assets/` folder that it uses. Your other staged and unstaged changes in the repository stay exactly as they were. If you partly staged a file inside the deck, Studio commits the file as it is on disk.
- **Not in a repository yet?** The first **Save version** offers to run `git init` in the deck's folder or in the workspace, and shows the path. Nothing happens unless you choose one, and no commit is made until you save a version. If the repository is above your workspace (for example, one in your home folder), History shows where versions go.
- **Your git setup applies:** Studio runs your `git` command, so your hooks, signing and other settings run as usual. A failing hook shows git's output. A command that waits for input (such as a signing passphrase prompt) stops after 30 seconds; commit those from a terminal instead.
- **Studio never pushes, pulls, amends or rewrites history,** never creates branches and never changes your git config. If git doesn't know your name and email, Studio asks once and passes them to git for each commit only.
- History isn't available for a deck in a git submodule, a bare repository, a path that's ignored or stored with Git LFS, or a repository git won't open (`safe.directory`). It says why.

</details>

<details>
<summary><strong>AI features</strong></summary>

- **Rewrite a slide:** **AI** in the slide editor can shorten, expand, translate or follow your instruction. Save your edits first. The result shows as a diff, and nothing changes until you accept it.
- **Generate a deck:** **New deck → Generate with AI** writes a whole deck from a topic or pasted text with a media kit. Slides appear as they're written, then Studio fixes the ones that break the kit's rules. Cancelling leaves nothing behind.
- **Draft a kit piece:** **Draft with AI** in Kits drafts a theme, template, blueprint or media kit from a description. You review it before anything is saved.
- **Chat:** the chat panel under the slide editor answers questions about the open deck. Ask for a change ("split slide 3 into two") and accept or reject each proposed edit.
- **A model per task:** **Settings → Model for each task** lets you pick, say, a small fast model for rewrites and a bigger one for whole decks. Each AI button shows the model it will use.

</details>

## Reference

### Command

```
flipbook-studio [folder] [--port <n>] [--no-open] [--library <dir>]
```

| Option            | What it does                                                                        |
| ----------------- | ----------------------------------------------------------------------------------- |
| `[folder]`        | Folder with your decks. Defaults to the current folder.                             |
| `--port <n>`      | Port to try first (default 4321; Studio picks a free one when it's busy).           |
| `--no-open`       | Print the address without opening a browser.                                        |
| `--library <dir>` | Where your themes, templates and kits are kept. Defaults to `~/Documents/flipbook`. |

Studio only listens on `127.0.0.1`, so other computers can't reach it.

### Where things are stored

| What                                       | Where                                                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Your decks                                 | The folder you open                                                                                                              |
| Themes, templates, blueprints and kits     | `~/Documents/flipbook` (or `--library`, or `FLIPBOOK_HOME`)                                                                      |
| Settings, including the AI model           | `~/Library/Application Support/flipbook-studio` on macOS, `~/.config/flipbook-studio` on Linux (or `FLIPBOOK_STUDIO_CONFIG_DIR`) |
| Temporary files during imports and AI runs | `.flipbook-studio-tmp/` in the open folder, cleaned up automatically                                                             |

The settings file is readable only by you, because it can hold an API key.

### Update or uninstall

Run the install command again to update. To uninstall:

```sh
npm uninstall -g @flipbook-md/studio
```

To try a specific version without installing it, use its link from the [releases page](https://github.com/uminocelo/flipbook-studio/releases):

```sh
npx https://github.com/uminocelo/flipbook-studio/releases/download/v0.1.0/flipbook-studio.tgz ~/decks
```

### Troubleshooting

| Studio says                           | What to do                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| The folder is missing or not a folder | Check the path, or create the folder first (exit code 2).                             |
| The library isn't writable            | Pick another one with `--library` (exit code 3).                                      |
| No port is available                  | Close other servers, or try `--port` (exit code 4).                                   |
| An export needs Chromium or ffmpeg    | Install them as shown in [Exporting](#exporting-carousels-and-videos).                |
| An AI button is turned off            | Set up a model in **Settings** (see [AI with a local model](#ai-with-a-local-model)). |
| History is turned off                 | Install git 2.30 or newer, then restart Studio.                                       |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) to build Studio from source, run the tests or cut a release. Studio is built on [`@flipbook-md/core`](https://github.com/uminocelo/flipbook-md-core), the same library as the `flipbook` CLI.
