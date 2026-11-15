# Contributing to Flipbook Studio

## Develop

Studio needs Node.js 20 or newer.

```sh
npm install
npm run build      # Vite builds the UI, tsup builds the server
npm test           # Vitest
npm run e2e        # Playwright against fixtures/
npm run lint && npm run typecheck
```

Run your build with `node bin/flipbook-studio.js ~/decks`, or run `npm link` once to get a `flipbook-studio` command you can use from any folder.

Studio depends on [`@flipbook-md/core`](https://github.com/uminocelo/flipbook-md-core) from npm. To develop both together, clone `flipbook-md-core` next to this repository and run `npm link ../flipbook-md-core`.

The HTTP API under `/api` is internal to Studio and is not a public, stable API.

## Review checklist for AI features

- Every AI button is rendered through `<AiAction>` (`src/ui/ai.tsx`), so it is disabled, with a link to Settings, until a model is set up.
- Every AI edit is a proposal shown in `<ProposalReview>` (`src/ui/screens/ProposalReview.tsx`); nothing is written until an op is accepted. Only generate-deck writes directly (into a new deck).
- Model output is data: it goes through a zod schema in `structuredCall` (`src/server/ai/structured.ts`), never into code, and slide IDs in ops are refused when they look like paths.
- Prompts and replies are logged only with `FLIPBOOK_DEBUG=ai`.
- Tests use `FakeProvider` or the HTTP stub in `test/support/` (never a real model). Tests tagged for a real model live in `test/real-llm/` and run in the nightly workflow only.
- An API key never appears in a response, a log line or an error message.

## Releasing

1. Set the version in `package.json` (`npm version 0.2.0 --no-git-tag-version`), commit and push to `main`, and wait for CI to pass.
2. Tag that commit and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. The **Release** workflow checks the tag matches `package.json`, runs lint, types and unit tests, packs Studio, installs the tarball and starts it once, then creates the GitHub Release with `flipbook-studio.tgz`, its SHA-256 checksum and generated notes. A version with a `-` (such as `0.2.0-beta.1`) becomes a prerelease, which the `latest` download link skips.

npm publishing is separate and manual: run the **Publish** workflow in GitHub Actions once Studio is ready for npm.
