# Contributing

Thanks for helping improve ChatGPT Web MCP. This project controls a user-authenticated web UI, so conservative behavior matters more than raw speed.

## Development setup

```bash
git clone https://github.com/Goudu666/chatgpt-web-mcp.git
cd chatgpt-web-mcp
npm ci
npm test
npm run smoke
```

Node.js 20 or newer is required. `npm run smoke` starts the stdio server and lists its MCP tools without opening ChatGPT.

## Before opening a pull request

Run:

```bash
npm test
npm run smoke
npm pack --dry-run
```

Do not add a live ChatGPT login or message-send test to CI. Live browser verification must be manual, low frequency, and performed with the contributor's own account.

## Project structure

- `src/index.js`: MCP tool registration
- `src/browser.js`: persistent browser control, validation, throttling, and circuit breaking
- `src/config.js`: cross-platform paths, timing defaults, and route policy configuration
- `src/selectors.js`: language-aware UI selectors
- `src/cli.js`: `serve`, `login`, `status`, and `doctor` commands
- `scripts/`: local login, diagnostics, and offline smoke checks
- `test/`: offline unit tests

## Safety requirements

A contribution must not:

- reduce default delays simply to make a test faster;
- add page polling when an event-driven wait is possible;
- automatically clear a circuit breaker, dismiss a rate-limit prompt, or retry HTTP 429;
- fall back to repeated full-page ChatGPT reloads;
- close the persistent browser unless the user explicitly requested it;
- read a user's regular browser profile;
- log cookies, query strings, request bodies, response bodies, prompts, uploaded content, or conversation identifiers;
- require secrets in source code or repository configuration.

## Selector changes

Prefer semantic roles, labels, and visible text over screen coordinates. Support both English and Chinese where the UI exposes stable labels. When a selector cannot be verified, return a clear error and stop.

Bug reports and pull requests must redact account names, conversation titles, URLs, and private page content from screenshots and logs.

## Pull request checklist

- [ ] The change is focused and explained.
- [ ] Offline tests pass.
- [ ] No credentials, browser data, screenshots, or runtime state are included.
- [ ] Rate-limit and browser-persistence invariants remain intact.
- [ ] User-facing behavior and environment variables are documented.
- [ ] Any manual live test was low frequency and is described without private data.
