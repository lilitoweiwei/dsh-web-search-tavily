/**
 * Standalone proof-of-correctness for `@lilitoweiwei/dsh-web-search-tavily`.
 *
 * Run with a real key (kept out of Git):
 *   TAVILY_API_KEY=... node test/search.test.mjs
 *
 * Covers: source mapping, response mapping, provider availability gating,
 * and one live `search()` against the Tavily API (skipped when no key is set).
 */

import assert from 'node:assert/strict'
import { TavilySearchProvider, mapTavilyResult, mapTavilyResponse } from '../src/provider.js'

const apiKey = process.env.TAVILY_API_KEY ?? ''

// ── mapping (pure) ─────────────────────────────────────────────────────────

// A full result maps every present field; blank fields are omitted.
assert.deepEqual(
  mapTavilyResult({
    title: 'Example',
    url: 'https://example.com',
    content: 'a snippet',
    published_date: '2025-02-09T00:00:00Z',
  }),
  { url: 'https://example.com', title: 'Example', snippet: 'a snippet', publishedAt: '2025-02-09T00:00:00Z' },
)

// Missing optional fields are omitted, never set empty.
assert.deepEqual(
  mapTavilyResult({ url: 'https://example.com', content: 'snippet only' }),
  { url: 'https://example.com', snippet: 'snippet only' },
)

// Empty/all-missing optional fields still yield a url-only source.
assert.deepEqual(
  mapTavilyResult({ url: 'https://example.com' }),
  { url: 'https://example.com' },
)

// Response envelope maps results and reports no truncation (seam owns it).
assert.deepEqual(
  mapTavilyResponse({ results: [{ url: 'https://a.com', title: 'A' }] }),
  { sources: [{ url: 'https://a.com', title: 'A' }], truncated: false },
)

// Missing/empty results array → empty sources.
assert.deepEqual(mapTavilyResponse({}), { sources: [], truncated: false })

// ── availability gating (cheap, no network) ────────────────────────────────

assert.equal(new TavilySearchProvider({ apiKey: '' }).available(), false, 'empty key → unavailable')
assert.equal(
  new TavilySearchProvider({ apiKey: 'tvly-secret' }).available(),
  true,
  'a configured key makes the provider available',
)
assert.equal(new TavilySearchProvider({ apiKey: 42 }).available(), false, 'non-string key → unavailable')

// ── live call ──────────────────────────────────────────────────────────────

if (apiKey.length > 0) {
  const provider = new TavilySearchProvider({ apiKey, maxResults: 3 })
  console.log('live search (provider id=%s, available=%s)…', provider.id, provider.available())
  const result = await provider.search({ query: 'DeepSeek Harness', maxResults: 3 })
  console.log('live result sources: %d, truncated=%s', result.sources.length, result.truncated)
  assert.ok(Array.isArray(result.sources), 'sources is an array')
  assert.ok(result.sources.length > 0, 'expected at least one source')
  for (const source of result.sources) {
    assert.ok(source.url.length > 0, 'every source has a url')
    console.log('  - %s | %O', source.title ?? new URL(source.url).hostname, source.snippet)
  }
  console.log('PASS: live Tavily search returned %d source(s)', result.sources.length)
} else {
  console.log('SKIP: TAVILY_API_KEY not set; live call not exercised')
}

console.log('PASS: all mapping + availability checks')
