# @lilitoweiwei/dsh-web-search-tavily

Minimal **Tavily-backed `WebSearchProvider`** for the DeepSeek Harness (DSH) web
capability seam (`ctx.web`). It does exactly one thing: register a single search
provider so DSH's native `web_search` tool can run through the [Tavily Search
API](https://docs.tavily.com/documentation/api-reference/endpoint/search).

This is intentionally tiny — no settings card, no key rotation, no usage
dashboard, no standalone tool. Those belong to other plugins; this package only
fills the provider slot the native web seam already has.

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

## API key resolution

Order of precedence:

1. **`credentials` service** — `TAVILY_API_KEY` in `~/.dsh/.credentials.yaml`
   (recommended; owner-only file, key never enters `cordis.yml` or Git).
2. **`config.apiKey`** — fallback field in the plugin's cordis config (use only
   when a shared/managed environment makes this acceptable).

## Config

All plugin-config fields are optional; the key should come from credentials.

- `baseURL` — default `https://api.tavily.com`
- `searchDepth` — `advanced` (default) / `basic` / `fast` / `ultra-fast`
- `chunksPerSource` — default `3`
- `maxResults` — default `5` (overridden per request by the seam bound)
- `apiKey` — fallback key (normally left blank)

## Test

Standalone proof (no DSH runtime needed):

```sh
# mapping + availability (no key required)
node test/search.test.mjs

# + one live Tavily search
TAVILY_API_KEY=... node test/search.test.mjs
```

The test resolves `@deepseek-ai/dsh-web` from a local `node_modules` symlink to
the harness's hoisted package; in the profile the same package resolves from the
shared fallback.

## Layout

```
src/index.js       function plugin: name/inject/apply, key resolution
src/provider.js    TavilySearchProvider: id/available/search + response mapping
src/invariant.js   DSH invariant companion (no-op)
test/search.test.mjs  standalone proof
package.json       @lilitoweiwei/dsh-web-search-tavily
```

## License

MIT
