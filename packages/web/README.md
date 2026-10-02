# Web

Web search, direct page/PDF reading, and branch-scoped caching for Pi. Original implementation for Tau, requiring Node.js 22.19+ and developed against **Pi 0.99.1**. No build step, browser, shell subprocess, or additional summarization model is required.

## Install

From a checkout with dependencies installed (`npm install --ignore-scripts` at the root):

```sh
pi install /path/to/tau/packages/web
```

Or try it for one invocation from the repository root:

```sh
pi -e ./packages/web
```

Restart Pi or run `/reload`. The root Tau bundle includes Web; do not install both overlapping resources. All three tools are available by default, respecting the host's tool selection. There is no activation command. Interactive and headless modes use the same tool behavior.

## Tools

| Tool | Purpose |
| --- | --- |
| `web_search` | Find sources through OpenAI, Exa, or explicitly selected DuckDuckGo. Returns links, provider attempts and a cached `responseId`; does not fetch the pages. |
| `fetch_web_content` | Fetch public HTTP(S) pages or PDFs directly, extract text locally, and return a bounded preview of the cached document. |
| `get_cached_web_content` | Read pages of a cached document or find literal text. Never performs network requests. |

Example arguments:

```json
{ "query": "solar energy production 2025", "provider": "exa", "numResults": 5 }
```

```json
{ "urls": ["https://example.com/report", "https://example.com/report.pdf"], "maxChars": 12000 }
```

```json
{ "responseId": "<returned UUID>", "itemIndex": 0, "offset": 12000, "limit": 12000 }
```

```json
{ "responseId": "<returned UUID>", "findText": "solar", "maxMatches": 5 }
```

Search accepts exactly one of `query` or `queries` (1–8 queries, each up to 2,000 UTF-16 units). Fetch accepts exactly one of `url` or `urls` (1–8 URLs). Duplicate inputs are executed once and retain their input indices. `numResults` is an upper bound, not a promise that a provider will return that many sources.

Search accepts `domainFilter`, a list of hostnames with optional `-` prefixes for exclusions, and `recencyFilter`: `day`, `week`, `month`, or `year`. Hostnames match their subdomains, exclusions win, and results are post-filtered. Hosted OpenAI and some Exa MCP tools treat recency as a preference, not a strict date filter; results disclose this. DuckDuckGo rejects recency filtering rather than ignoring it.

All tools return JSON-shaped data through `structuredContent` and bounded text for the model. Output is limited to 30,000 characters and 50 KiB, including metadata, and does not put full documents in a hidden result field. Preview omissions are explicit. Read the complete cached documents with `itemIndex` and offsets. Search results are cached as JSON; concatenate character pages before parsing.

## Configuration and costs

Optional personal file: `<agent-dir>/web/config.json`, normally `~/.pi/agent/web/config.json`. `PI_CODING_AGENT_DIR` changes the agent directory. Configuration is read on extension load; run `/reload` after edits. Project settings cannot silently change the extension's credential mode.

Defaults:

```json
{
  "version": 1,
  "search": { "provider": "auto", "fallbackToExa": true },
  "openai": { "auth": "pi-oauth", "model": "gpt-5.6-terra" },
  "exa": { "transport": "mcp" },
  "limits": {
    "requestTimeoutMs": 30000,
    "toolTimeoutMs": 120000,
    "concurrency": 3,
    "maxDownloadBytes": 20971520,
    "maxExtractedChars": 2000000,
    "maxOutputChars": 30000
  }
}
```

Missing fields receive defaults. Unknown fields, invalid enum values and out-of-range limits produce `CONFIG_INVALID` without a network request. The tool deadline must be at least the request timeout. Allowed ranges: request 1–120 seconds, tool 1–600 seconds, concurrency 1–4, downloads 1–64 MiB, extracted text 1–4 million UTF-16 units, output 1,000–30,000 characters. Search protocol bodies are capped at 4 MiB.

### OpenAI

Default `pi-oauth` uses Pi's **official Codex OAuth login** (`openai-codex`, `openai-codex-responses`) and the subscription Responses endpoint. It does not start a CLI, copy credentials to a file, or use the conversation's history. Pi resolves/refreshes credentials. A separately configured OAuth login for another OpenAI protocol is not assumed interchangeable: use the compatible Codex login or explicitly select another provider.

The configured model must exist under the selected official provider/API in Pi's registry. The default is in the Pi 0.99.1 catalog; that does not guarantee account entitlement or hosted-search availability. No automatic model upgrade or custom endpoint is permitted. Runtime API-key overrides and custom providers are rejected in OAuth mode.

To opt into separately billed OpenAI API calls:

```json
{ "version": 1, "openai": { "auth": "api-key", "apiKeyEnv": "OPENAI_API_KEY", "model": "gpt-5.6-terra" } }
```

Set the named environment variable before starting Pi. Its presence alone **never enables API billing**. API-key mode uses only that variable and the official API Responses endpoint; there is no subscription/key fallback. Secrets are not accepted as literals in this configuration.

Hosted search is a separate model-backed request. Available token counts are reported in the search result; billing, subscription quotas and search-specific fees are not known. Incomplete accounting is not inserted into Pi's monetary totals as a fabricated zero cost.

### Exa

Default `mcp` uses the public Exa MCP endpoint, without a key. It discovers the advanced or base search capability internally and does not add any other model-facing tools. Missing advanced capability is disclosed via the selected tool name. Authentication errors, rate limits and malformed responses are not mistaken for capability fallback. MCP quotas and availability belong to the service.

To opt into Exa's directly billed API:

```json
{ "version": 1, "exa": { "transport": "api", "apiKeyEnv": "EXA_API_KEY" } }
```

MCP never reads that key or switches to the API on its own. If API mode is configured, an authorized automatic fallback to Exa uses that chosen mode and may incur charges.

### Routing

- `auto` tries OpenAI, then Exa only for transient request/network errors, HTTP 429 or HTTP 5xx, if enabled and before the tool deadline.
- Missing/failed authentication, invalid configuration/model, TLS failures, malformed responses and cancellation do **not** trigger fallback.
- An explicitly selected provider never falls back to another provider.
- DuckDuckGo must be selected explicitly. Its HTML interface can change or return challenges; it is not an official search API. No remote pagination or recency filter is implemented.

## Extraction and security

Content is fetched without provider credentials, browser cookies, JavaScript execution, embedded resource downloads, OCR or remote conversion. PDF extraction uses `unpdf`, with a 200-page maximum. HTML/PDF parsing runs in a terminable worker with a 30-second extraction timeout and bounded JS heap. PDF layout and reading order may differ from the visual page; image-only PDFs return an explicit no-text error. Unsupported media and invalid text encodings fail explicitly.

Requests validate public DNS addresses and pin the connector to those addresses. Private, loopback, link-local, reserved and metadata destinations are blocked, including redirects and IPv4-mapped IPv6. At most five redirects are followed, with no HTTPS downgrade. Authenticated protocol requests do not follow redirects. Stream/decompressed sizes, request deadlines and cancellation are enforced without changing Pi's global networking. Pi owns its OAuth refresh transport; a late refresh result is ignored after the tool is cancelled.

Content remains untrusted: extraction is not a prompt-injection security boundary. The extension, other tools, and local programs run with the user's operating-system permissions.

## Cache and privacy

Files: `<agent-dir>/web/cache/<responseId>.json`. Limits are shared across processes: **one hour from creation, 128 records, 128 MiB serialized**. Oldest records may be evicted before expiry. Reads do not extend the TTL. Files/directories use private POSIX permissions; symlinks, malformed records and checksum mismatches are rejected.

Visibility is reconstructed from custom references on the active session branch. Common ancestors remain visible; abandoned branches and new conversations do not inherit unrelated results. Forks/clones inherit references actually copied into their histories. Compaction does not remove access to raw ancestor references. This is a tool-level rule, not a sandbox against another program of the same user.

Offsets and spans use UTF-16 units with an exclusive end, matching JavaScript `String.slice()`. Pages never split surrogate pairs. The finder is literal and case-sensitive, with nonoverlapping matches; use `nextMatchOffset` to continue. It cannot be combined with `offset`. Missing, expired, corrupt or unauthorized records are explicit errors, never hidden re-downloads.

Previously cached artifacts remain readable until expiry or eviction. Removing a tool does not delete existing cached records or session history.

A filesystem lock serializes commits across Pi processes. A demonstrably dead owner's complete lock is reclaimed; a live, malformed or incomplete lock fails closed with `CACHE_BUSY`. If a crash left an incomplete `.lock`/`.reap` file, **stop all Pi processes using that agent directory** before removing it. No lock is stolen merely because it is old. A failed cache/session commit never claims a recoverable result.

The cache contains queries, URLs and downloaded text, which may be sensitive. Expiry does not erase previews already in session history. No provider secret or raw authenticated request is written to the cache.

## Development and verification

```sh
npm run check --workspace web
npm test --workspace web
```

Tests use isolated storage, synthetic credentials, local HTTP servers, and Pi's SDK/resource loader. They cover authentication/routing, DNS/redirect/stream limits, extraction, branches, cancellation, cache quotas/concurrent writers and compatibility with existing cached records. No ordinary test calls an Internet provider or reads personal credentials.

Live provider compatibility and account entitlement require separate authorized smoke tests. Local fixtures are not evidence that a remote endpoint currently works. A live Codex OAuth search with Pi 0.99.2 and `gpt-5.6-terra` succeeded on 2026-10-02, including recovery of completed streamed items when the final response's output array was empty. This does not verify API-key mode, other providers, other accounts or continued service availability.
