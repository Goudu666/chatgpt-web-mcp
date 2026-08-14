# Security Policy

## Sensitive data

The following data must never be committed, pasted into an issue, or attached to a public pull request:

- browser profiles, cookies, local storage, session data, or authentication tokens;
- passwords, verification codes, API keys, or private MCP configuration;
- unredacted screenshots containing account details or chat history;
- runtime-state, browser-state, lock, or raw diagnostic files;
- private prompts, uploaded files, conversation URLs, or conversation identifiers.

The default local data directory is `~/.chatgpt-web-mcp`. Treat the whole directory as sensitive even though the network diagnostic log is designed to be sanitized.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature when it is available for this repository. Do not open a public issue containing an exploit, credential, session artifact, or private user data.

If private reporting is not available, open a public issue containing only a short, fully redacted request for a private reporting channel. Do not include reproduction secrets in that issue.

For ordinary selector breakage, UI changes, installation problems, or non-sensitive bugs, use the public bug report template.

## Security invariants

Contributions must preserve these behaviors:

- the remote debugging endpoint listens only on loopback;
- the project never asks users to put passwords, cookies, or verification codes in configuration;
- HTTP 429 and visible rate-limit messages trip a manual circuit breaker;
- the server does not dismiss rate-limit prompts or automatically retry them;
- network diagnostics exclude query strings, cookies, request and response bodies, and conversation identifiers;
- file upload requires explicit absolute paths from the caller;
- the persistent browser is closed only after an explicit user request.

## Supported versions

Security fixes are applied to the latest released version and the current default branch. Older snapshots may not receive backports.
