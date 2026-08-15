# ChatGPT Web MCP

[中文说明](README.md)

An unofficial local MCP server that lets Codex and other MCP clients operate `chatgpt.com` through a dedicated persistent browser profile. It does not use the ChatGPT API, read a user's regular browser profile, or place login credentials in MCP configuration.

> [!IMPORTANT]
> This project is not affiliated with or endorsed by OpenAI. It depends on the ChatGPT web UI, which may change without notice. Account permissions, region, and workspace policy may also affect behavior. Do not use this project to bypass access controls, usage limits, or safety systems.

## Features

- Create normal and temporary chats and select chat history
- Write prompts, upload explicitly selected files, send messages, and read responses
- Discover models, reasoning levels, and answer tiers from the visible UI
- Keep the dedicated browser and ChatGPT page open between MCP calls
- Serialize browser control across MCP processes and apply conservative delays
- Stop on rate-limit text or HTTP 429 without dismissing, retrying, or reloading
- Route Pro requests through a configurable temporary identity probe and reuse a reliable result for the full lifetime of the same page session
- Store only sanitized network error metadata

## Requirements

- Node.js 20+
- Google Chrome, Chromium, or Microsoft Edge
- A local stdio MCP client such as Codex
- A ChatGPT account that can be logged in manually

Common browser locations are detected on macOS, Windows, and Linux. Set `CHATGPT_WEB_CHROME` when auto-detection does not find your browser.

## Install

```bash
git clone https://github.com/Goudu666/chatgpt-web-mcp.git
cd chatgpt-web-mcp
npm ci
npm run doctor
npm link
```

Log in through the dedicated browser:

```bash
chatgpt-web-mcp login
```

The browser profile is stored in `~/.chatgpt-web-mcp/chrome-profile` by default. Never commit or share that directory.

Add the server to Codex:

```bash
codex mcp add chatgpt-web -- chatgpt-web-mcp serve
codex mcp get chatgpt-web
```

If the Codex process cannot resolve the linked command, use an absolute project path:

```bash
codex mcp add chatgpt-web -- node /absolute/path/to/chatgpt-web-mcp/src/index.js
```

See the [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) for Codex MCP configuration concepts.

## CLI

```text
chatgpt-web-mcp serve    Start the stdio MCP server (default)
chatgpt-web-mcp login    Open the dedicated browser for manual login
chatgpt-web-mcp status   Inspect local browser state
chatgpt-web-mcp doctor   Check Node.js, browser detection, and local paths
chatgpt-web-mcp help     Show command help
```

## Configurable routing policy

The bundled defaults preserve the original strict policy:

- Normal requests use the `极高` answer tier.
- Pro requests first use a temporary Pro chat and ask `你是什么模型？`.
- A GPT-5.6 Pro match allows a normal Pro chat.
- A GPT-5.5 mini match falls back to the default tier.
- Any other answer stops the route.

A reliable result does not expire while the same dedicated browser and ChatGPT page remain open. If either is closed, the result remains reusable for a three-hour grace period; the next Pro request after that period performs one new verification. Ending a normal MCP call only disconnects local control and does not start this timer. When the exact time of a manual close cannot be known, the grace period starts when the interrupted session is first detected.

These values can be changed without editing source code:

| Variable | Default |
| --- | --- |
| `CHATGPT_WEB_DEFAULT_TIER` | `极高` |
| `CHATGPT_WEB_PRO_TIER` | `Pro` |
| `CHATGPT_WEB_PROBE_PROMPT` | `你是什么模型？` |
| `CHATGPT_WEB_PROBE_ACCEPT_ID` | `gpt-5.6-pro` |
| `CHATGPT_WEB_PROBE_FALLBACK_ID` | `gpt-5.5-mini` |
| `CHATGPT_WEB_PROBE_ACCEPT_PATTERN` | GPT-5.6 Pro regular expression |
| `CHATGPT_WEB_PROBE_FALLBACK_PATTERN` | GPT-5.5 mini regular expression |
| `CHATGPT_WEB_PRO_RECHECK_AFTER_CLOSE_MS` | `10800000` (3 hours) |

See [.env.example](.env.example). The project does not automatically load `.env`; inject variables through the MCP client, shell, or operating system.

## Conservative rate-limit policy

- Page interactions: at least 1 second apart
- High-level site actions: at least 5 seconds apart
- Message sends: at least 30 seconds apart
- Conversation changes: at least 30 seconds apart
- Conversation changes after a completed answer: at least 30 seconds
- First site action after clearing a breaker: 5 minutes
- Independent history quiet period after a history rate limit: 5 minutes

The server does not automatically clear the breaker, dismiss rate-limit messages, retry failed requests, or close the persistent browser. Do not lower these defaults in a public contribution merely to make the server faster.

## Privacy and limitations

- Login state, runtime state, and sanitized diagnostics live under `~/.chatgpt-web-mcp` by default.
- Upload tools only accept explicit absolute file paths.
- Diagnostics omit query strings, cookies, request and response bodies, and conversation identifiers.
- Response waiting uses in-page mutation events rather than page polling.
- Failed in-page navigation stops instead of repeatedly reloading ChatGPT.
- The ChatGPT web UI is not a stable API and selectors may require maintenance.
- A model's self-description is a routing signal, not cryptographic proof of the serving model.

## Development

```bash
npm ci
npm test
npm run smoke
npm pack --dry-run
```

CI performs offline unit tests and package checks only. It never logs in to ChatGPT or sends live requests. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
