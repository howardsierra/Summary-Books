# Tests

Two kinds:

- **Unit tests** (`unit/*.test.mjs`): the parsers and other pure logic, in
  plain Node with a stubbed `SillyTavern.getContext()`. No setup needed.
- **Browser suites** (`e2e/*.js`): drive a real SillyTavern in Chromium with
  Playwright, against a fake OpenAI-compatible model (`mock-llm.mjs`) that
  logs every request and answers summaries, leak checks, sheets and so on
  with fixed text. Each check prints ✓ or ✗; any ✗ or page error fails the run.

## Running

```bash
tests/run.sh unit                                   # unit tests only
ST_DIR=~/SillyTavern tests/run.sh                   # everything
ST_DIR=~/SillyTavern tests/run.sh core windows      # chosen suites
```

`ST_DIR` is a SillyTavern checkout with `npm install` done. `run.sh` copies
the extension into it (a copy, not a symlink, so SillyTavern's auto-update
never runs git here), starts SillyTavern on port 8000 if it isn't already
running, and starts the fake models on ports 5005 (main) and 5006 (sidecar).
Playwright with Chromium must be installed (`npm i -D playwright && npx
playwright install chromium`).

The suites create characters and chats in that SillyTavern's data, so use a
throwaway install.

| Suite | Covers |
|---|---|
| core | inline tags, scene entries + keywords, leak checker + regenerate, reveals, who-knows grid, story memory |
| memory | story clock, threads, character sheets, chapters, pins, rewind safety, review queue |
| world | common knowledge: news, rumors, announcements |
| sidecar-profile | AI sidecar through a connection profile, per-task switches, fallback |
| sidecar-model | AI sidecar as another model from the same provider |
| branches | a branch gets its own copy of the lorebook |
| force | redo a range, save secrets now, rebuild, own lorebook on demand |
| budget | prompt preview and memory budget |
| touch | everything by tap on a phone, 40px tap targets |
| windows | settings and Story Memory windows on desktop, iPad, iPhone |
| launcher | the wand-menu launcher and the message action sheet |
| race | simultaneous saves create one lorebook |

Environment variables: `ST_URL`, `MOCK_PORT`, `SIDECAR_PORT`, `PS_TEST_OUT`
(logs and screenshots; default `tests/.out`).
