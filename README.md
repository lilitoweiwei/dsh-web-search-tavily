# @lilitoweiwei/dsh-web-search-tavily

Minimal **Tavily-backed `WebSearchProvider`** for the DeepSeek Harness (DSH) web
capability seam (`ctx.web`). It does exactly one thing: register a single search
provider so DSH's native `web_search` tool can run through the [Tavily Search
API](https://docs.tavily.com/documentation/api-reference/endpoint/search).

This is intentionally tiny — no settings card, no usage dashboard, no standalone
tool. Those belong to other plugins; this package only fills the provider slot
the native web seam already has. What it does own beyond the mapping is the key
pool: several keys rotate from search to search, and a key Tavily refuses for a
key-specific reason parks itself while the search moves on to the next one.

## What it is

A **function plugin** (not a service) that calls
`ctx.web.registerSearchProvider(new TavilySearchProvider(...))`, mirroring the
first-party `@deepseek-ai/dsh-web-search-exa` plugin. It normalizes Tavily
results into the seam's `WebSearchSource` shape:

| Tavily field | seam field |
| --- | --- |
| `results[].title` | `title` |
| `results[].url` | `url` (required) |
| `results[].content` | `snippet` |
| `results[].published_date` | `publishedAt` |

Only `url` is guaranteed; blank optional fields are omitted rather than invented.

## Provider id

`tavily`. After mounting, pin the seam with `searchProvider: tavily` (or let it
auto-select when it is the only usable provider).

## Key resolution

Resolved **lazily, per search** — never at plugin load. The loader inits plugin
entries in parallel, so the `credentials` service may not be ready when this
plugin's `apply` runs; a load-time probe would silently lose the keys and leave
the provider permanently unavailable. A per-search read also picks up rotated,
added, or removed keys without a restart.

Order of precedence:

1. **`config.apiKey`** — a literal key in the plugin's cordis config (use only
   when a shared/managed environment makes this acceptable).
2. **The `credentials` service**, scanned by convention: `TAVILY_API_KEY`, then
   `TAVILY_API_KEY_2`, `TAVILY_API_KEY_3`, … in that order. The scan stops after
   two consecutive missing references, so a gap left by a removed key costs two
   extra lookups rather than ending the scan, and it probes at most `maxKeyRefs`
   references (default 12). Values are trimmed and deduplicated — a key pasted
   into YAML commonly carries a trailing newline, which the API would reject as
   unauthorized.
3. **`TAVILY_API_KEY` environment variable** — last-resort ambient fallback,
   used only when the store yields no key at all.

Recommended placement for real keys is `~/.dsh/.credentials.yaml` (owner-only
file; keys never enter a `cordis.yml` or Git):

```yaml
refs:
  TAVILY_API_KEY: tvly-dev-…first…
  TAVILY_API_KEY_2: tvly-dev-…second…
  TAVILY_API_KEY_3: tvly-dev-…third…
```

A search that ends with no key configured fails as a provider error with a
remediation hint; `available()` accepts the lazy source itself, so the seam never
rejects this provider just because the key store is not ready.

## Rotation and failover

One `search()` may send more than one request. The keys are interchangeable, so
the pool spreads searches across them and steps over the ones that refuse:

- **Which key goes first.** Usable keys are used in **round-robin** order: the
  cursor advances past whatever key served the last search, so a month's quota is
  spread across every configured key instead of draining them one at a time.
- **Key-specific refusals rotate.** The search parks that key and retries with
  the next candidate, up to every configured key:

  | Status | Meaning | Cooldown before the key is used again |
  | --- | --- | --- |
  | `432` | the plan's usage limit is reached (verified against the live API) | 24 h |
  | `401`, `403` | the key is missing, invalid, or revoked | 1 h |
  | `429` | rate limit | the response's `retry-after` seconds, clamped to 5 min, else 60 s |

  A 24 h quota cooldown is deliberate: Tavily resets a free plan monthly and does
  not report the reset date, so re-probing daily costs at most one rejected
  request per key per day and picks a key back up within a day of its quota
  returning.
- **Other failures do not rotate.** A malformed request (`400`), a Tavily-side
  fault (`5xx`), or a transport failure would answer the same way for every key,
  so the search fails on the first response instead of multiplying the delay by
  the number of keys. Cancellation surfaces as `WEB_ABORTED` and stops the
  rotation immediately.
- **A parked key is tried last, never dropped.** When every key is parked the
  candidates are the parked ones, ordered by soonest expiry, so a search still
  runs and reports Tavily's real answer rather than refusing on local state.
- **A success clears the park.** Serving a request is proof the key works now, so
  it returns to normal rotation on the next search.
- **Failure reporting.** When every key refuses, the error is
  `WEB_PROVIDER_ERROR` naming each key's verdict — `Tavily search failed on all 2
  configured API keys — #1 (2d13ac8d96d0) HTTP 432: exhausted its plan quota; #2
  (7bd73976ce13) HTTP 401: is not authorized. Last error: …`. Keys appear only as
  truncated SHA-256 fingerprints.

Every rotation writes one `warn` line through `ctx.logger` (key fingerprint,
reason, status, and which key of how many is next) — rotation is otherwise
invisible, since the model only sees the successful result or the final failure.

Quarantine state lives **in memory only**. A restart re-probes every configured
key once — at most one rejected request per dead key — which is cheaper than
owning a durable write path for state that expires by itself.

## Config

No schemastery `Config` schema is declared (matching minimal external plugins);
config fields are read directly and defaulted in `apply`. All are optional; the
keys should come from credentials.

- `baseURL` — default `https://api.tavily.com`
- `searchDepth` — `advanced` (default) / `basic` / `fast` / `ultra-fast`
- `chunksPerSource` — default `3`
- `maxResults` — default `5` (overridden per request by the seam bound)
- `maxKeyRefs` — default `12`; how many `TAVILY_API_KEY*` references the
  convention scan probes
- `apiKey` — a literal key, attempted before the credentials scan (normally left
  blank)

## Test

Standalone proof (no DSH runtime needed):

```sh
# mapping, failure classification, key-pool rotation/quarantine, and scripted
# failover — no key and no network required
node test/search.test.mjs

# + two live searches against the Tavily API (rotation across both keys)
TAVILY_API_KEY=... TAVILY_API_KEY_2=... node test/search.test.mjs
```

The scripted checks replace `globalThis.fetch`, so the failover path (one key
answering `432`, the next answering `200`, the refused key staying parked on the
following search) is proven without spending quota. The test resolves
`@deepseek-ai/dsh-web` from a local `node_modules` symlink to the harness's
hoisted package; in the profile the same package resolves from the shared
fallback.

## Layout

```
src/index.js       function plugin: name/inject/apply, credential scan, key wiring
src/provider.js    TavilySearchProvider: id/available/search, rotation loop, mapping
src/keys.js        key convention, fingerprints, round-robin order, quarantine
src/invariant.js   DSH invariant companion (no-op)
test/search.test.mjs  standalone proof
package.json       @lilitoweiwei/dsh-web-search-tavily
```

## License

MIT
