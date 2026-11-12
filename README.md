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
