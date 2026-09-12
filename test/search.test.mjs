/**
 * Standalone proof-of-correctness for `@lilitoweiwei/dsh-web-search-tavily`.
 *
 * Run with real keys (kept out of Git):
 *   TAVILY_API_KEY=... TAVILY_API_KEY_2=... node test/search.test.mjs
 *
 * Covers: source/response mapping, provider availability gating, the key-pool
 * rotation and quarantine rules, single-search failover across keys with a
 * scripted fetch, and a live search against the Tavily API (skipped when no key
 * is set). No test framework: every check is a bare `node:assert`.
 */

import assert from 'node:assert/strict'
import { TavilyKeyPool, keyFingerprint, tavilyConventionRefs } from '../src/keys.js'
import { TavilySearchProvider, classifyTavilyFailure, mapTavilyResult, mapTavilyResponse } from '../src/provider.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

// ── failure classification (the rotation rule) ─────────────────────────────

assert.equal(classifyTavilyFailure(432, null).rotate, true, 'an exhausted plan quota rotates')
assert.equal(classifyTavilyFailure(401, null).rotate, true, 'an unauthorized key rotates')
assert.equal(classifyTavilyFailure(403, null).rotate, true, 'a forbidden key rotates')
assert.equal(classifyTavilyFailure(429, null).rotate, true, 'a rate limit rotates')
assert.equal(classifyTavilyFailure(400, null).rotate, false, 'a bad request does not rotate')
assert.equal(classifyTavilyFailure(500, null).rotate, false, 'a server fault does not rotate')
assert.equal(classifyTavilyFailure(200, null).rotate, false, 'a success is not a rotation verdict')
// `retry-after` is honored in seconds and clamped.
assert.equal(classifyTavilyFailure(429, '120').cooldownMs, 120_000, 'retry-after seconds are honored')
assert.equal(classifyTavilyFailure(429, 'not-a-number').cooldownMs, 60_000, 'an unusable retry-after falls back')
assert.equal(classifyTavilyFailure(429, '99999').cooldownMs, 300_000, 'retry-after is clamped')

// ── credential reference convention ────────────────────────────────────────

assert.deepEqual(
  tavilyConventionRefs(3),
  ['TAVILY_API_KEY', 'TAVILY_API_KEY_2', 'TAVILY_API_KEY_3'],
  'the convention scan names the primary key first, then numeric suffixes',
)
assert.equal(tavilyConventionRefs().length, 12, 'the default scan probes twelve references')
assert.deepEqual(tavilyConventionRefs(1), ['TAVILY_API_KEY'], 'a one-reference cap keeps only the primary')
assert.deepEqual(tavilyConventionRefs(0), tavilyConventionRefs(), 'a non-positive cap falls back to the default')

// A fingerprint names a key without carrying it, and identical keys collapse.
assert.equal(keyFingerprint('tvly-abc'), keyFingerprint('tvly-abc'), 'a fingerprint is stable')
assert.notEqual(keyFingerprint('tvly-abc'), keyFingerprint('tvly-abd'), 'different keys differ')
assert.equal(keyFingerprint('tvly-abc').includes('tvly-abc'), false, 'a fingerprint never contains the key')

// ── key pool: rotation order and quarantine ────────────────────────────────

{
  const pool = new TavilyKeyPool()
  pool.update(['k1', 'k2', 'k3'])
  assert.equal(pool.size, 3)
  assert.deepEqual(pool.candidates().map((entry) => entry.key), ['k1', 'k2', 'k3'], 'a fresh pool starts at the first key')

  pool.noteServed(keyFingerprint('k1'))
  assert.deepEqual(pool.candidates().map((entry) => entry.key), ['k2', 'k3', 'k1'], 'serving a key rotates past it')

  pool.noteServed(keyFingerprint('k2'))
  assert.deepEqual(pool.candidates().map((entry) => entry.key), ['k3', 'k1', 'k2'], 'rotation keeps advancing')

  // A refused key is parked but stays in the pool, last, so an all-parked pool still searches.
  pool.noteRefused(keyFingerprint('k3'), { status: 432, reason: 'exhausted its plan quota', cooldownMs: 60_000 })
  assert.deepEqual(pool.candidates().map((entry) => entry.key), ['k1', 'k2', 'k3'], 'a parked key is tried last')
  assert.equal(pool.describe()[2].reason, 'exhausted its plan quota')
  assert.ok(pool.describe()[2].parkedForMs > 0, 'a parked key reports its remaining park time')

  // A success clears the park: the key is usable again immediately.
  pool.noteServed(keyFingerprint('k3'))
  assert.equal(pool.describe()[2].parkedForMs, 0, 'serving a key releases it from quarantine')
}

{
  // An expired park returns the key to the rotation instead of the tail.
  const pool = new TavilyKeyPool()
  pool.update(['a', 'b'])
  pool.noteRefused(keyFingerprint('a'), { status: 401, reason: 'is not authorized', cooldownMs: 10 })
  assert.deepEqual(pool.candidates().map((entry) => entry.key), ['b', 'a'], 'the parked key waits at the tail')
  await sleep(25)
  assert.deepEqual(pool.candidates().map((entry) => entry.key), ['a', 'b'], 'an expired park rejoins the rotation')
}

{
  // The cursor is positional: a key that moves keeps its quarantine.
  const pool = new TavilyKeyPool()
  pool.update(['x', 'y', 'z'])
  pool.noteRefused(keyFingerprint('y'), { status: 432, reason: 'exhausted its plan quota', cooldownMs: 60_000 })
  pool.update(['y', 'x', 'z'])
  assert.deepEqual(pool.candidates().map((entry) => entry.key), ['x', 'z', 'y'], 'quarantine is keyed by fingerprint, not position')
}

// ── availability gating (cheap, no network) ────────────────────────────────

assert.equal(new TavilySearchProvider({ apiKey: '' }).available(), false, 'empty key → unavailable')
assert.equal(
  new TavilySearchProvider({ apiKey: 'tvly-secret' }).available(),
  true,
  'a configured key makes the provider available',
)
assert.equal(new TavilySearchProvider({ apiKey: 42 }).available(), false, 'non-string key → unavailable')
// A lazy per-search key source alone must keep the provider available: the
// seam calls available() before search(), and credentials may not be ready at
// plugin load, so availability must not depend on a load-time key snapshot.
assert.equal(
  new TavilySearchProvider({ resolveApiKey: async () => 'tvly-lazy' }).available(),
  true,
  'a lazy key source keeps the provider available without a literal key',
)
assert.equal(
  new TavilySearchProvider({ resolveApiKeys: async () => ['tvly-a', 'tvly-b'] }).available(),
  true,
  'a lazy multi-key source keeps the provider available without a literal key',
)

// ── missing key at search time (no network: rejects before any fetch) ──────

await assert.rejects(
  new TavilySearchProvider({}).search({ query: 'no-key probe' }),
  (error) => error?.code === 'WEB_PROVIDER_ERROR',
  'a search without any key source fails as WEB_PROVIDER_ERROR',
)

// ── rotation across keys, with a scripted fetch ────────────────────────────

/**
 * Replace `globalThis.fetch` with a scripted responder for the duration of one
 * check. Routes answer by attempt number (the last route repeats), and every
 * call is recorded with the key it carried.
 */
function scriptFetch(routes) {
  const calls = []
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, key: init.headers.authorization.replace(/^Bearer /, ''), body: JSON.parse(init.body) })
    const route = routes[calls.length - 1] ?? routes[routes.length - 1]
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status,
      ...route.headers === undefined ? {} : { headers: route.headers },
    })
  }
  return { calls, restore: () => { globalThis.fetch = previous } }
}

const PLAN_LIMIT = { status: 432, body: { detail: { error: "This request exceeds your plan's set usage limit." } } }
const UNAUTHORIZED = { status: 401, body: { detail: { error: 'Unauthorized: missing or invalid API key.' } } }
const oneSource = (url) => ({ status: 200, body: { results: [{ url, title: 'OK' }] } })

{
  // The exhausted-first-key case this feature exists for: fail over, then stay on the live key.
  const provider = new TavilySearchProvider({ resolveApiKeys: async () => ['tvly-exhausted', 'tvly-live'] })
  const first = scriptFetch([PLAN_LIMIT, oneSource('https://ok.example')])
  const result = await provider.search({ query: 'failover' })
  first.restore()

  assert.deepEqual(first.calls.map((call) => call.key), ['tvly-exhausted', 'tvly-live'], 'an exhausted key hands over to the next')
  assert.deepEqual(result.sources, [{ url: 'https://ok.example', title: 'OK' }], 'the live key result comes back')
  for (const call of first.calls) {
    assert.equal(call.url, 'https://api.tavily.com/search', 'every attempt hits the configured endpoint')
    assert.equal(call.body.query, 'failover', 'every attempt carries the same query')
  }

  // The exhausted key is parked, so the very next search goes straight to the live key.
  const second = scriptFetch([oneSource('https://ok2.example')])
  await provider.search({ query: 'after failover' })
  second.restore()
  assert.deepEqual(second.calls.map((call) => call.key), ['tvly-live'], 'a parked key is skipped on the next search')
}

{
  // Healthy keys rotate: consecutive searches do not reuse one key.
  const provider = new TavilySearchProvider({ resolveApiKeys: async () => ['k1', 'k2'] })
  const stub = scriptFetch([oneSource('https://one.example')])
  await provider.search({ query: 'first' })
  await provider.search({ query: 'second' })
  await provider.search({ query: 'third' })
  stub.restore()
  assert.deepEqual(stub.calls.map((call) => call.key), ['k1', 'k2', 'k1'], 'healthy keys rotate per search')
}

{
  // Every key refused: the error names each key's verdict rather than hiding it.
  const provider = new TavilySearchProvider({ resolveApiKeys: async () => ['dead-1', 'dead-2'] })
  const stub = scriptFetch([PLAN_LIMIT, UNAUTHORIZED])
  let failure
  try {
    await provider.search({ query: 'all dead' })
  } catch (error) {
    failure = error
  }
  stub.restore()
  assert.equal(failure?.code, 'WEB_PROVIDER_ERROR', 'an all-refused search fails as WEB_PROVIDER_ERROR')
  assert.match(failure.message, /all 2 configured API keys/, 'the message counts the keys tried')
  assert.match(failure.message, /#1 \([0-9a-f]{12}\) HTTP 432/, 'the message names the refusing key by fingerprint')
  assert.match(failure.message, new RegExp(`#2 \\(${keyFingerprint('dead-2')}\\) HTTP 401`), 'each key is named in attempt order')
  assert.match(failure.message, /HTTP 432/, 'the message names the exhausted key verdict')
  assert.match(failure.message, /HTTP 401/, 'the message names the unauthorized key verdict')
  assert.match(failure.message, /Last error: Unauthorized/, "the message keeps the API's own wording")
  assert.equal(failure.message.includes('dead-1'), false, 'the message never leaks a key value')
  assert.equal(stub.calls.length, 2, 'each configured key is attempted once')
  console.log('all-refused message: %s', failure.message)
}

{
  // A single-key pool says so, instead of claiming "all 1 keys".
  const provider = new TavilySearchProvider({ resolveApiKeys: async () => ['only'] })
  const stub = scriptFetch([PLAN_LIMIT])
  let failure
  try {
    await provider.search({ query: 'only key' })
  } catch (error) {
    failure = error
  }
  stub.restore()
  assert.match(failure.message, /the only configured API key/, 'a single-key failure reads correctly')
}

{
  // A non-key-specific refusal fails the search on the first response.
  for (const route of [{ status: 400, body: { detail: { error: 'Invalid request parameters.' } } }, { status: 500, body: {} }]) {
    const provider = new TavilySearchProvider({ resolveApiKeys: async () => ['a', 'b', 'c'] })
    const stub = scriptFetch([route])
    let failure
    try {
      await provider.search({ query: 'not key specific' })
    } catch (error) {
      failure = error
    }
    stub.restore()
    assert.equal(failure?.code, 'WEB_PROVIDER_ERROR', `HTTP ${route.status} fails the search`)
    assert.equal(stub.calls.length, 1, `HTTP ${route.status} does not rotate`)
  }
}

{
  // A rate limit parks the key for the header's duration and rotates immediately.
  const provider = new TavilySearchProvider({ resolveApiKeys: async () => ['limited', 'live'] })
  const stub = scriptFetch([{ status: 429, body: { error: 'excessive requests' }, headers: { 'retry-after': '120' } }, oneSource('https://ok.example')])
  await provider.search({ query: 'rate limited' })
  stub.restore()
  const [limited] = provider.pool.describe()
  assert.ok(limited.parkedForMs > 110_000 && limited.parkedForMs <= 120_000, 'retry-after sets the park duration')
  assert.equal(limited.status, 429, 'the park records the refusing status')
}

{
  // Keys are trimmed (a YAML paste commonly carries a newline) and deduplicated.
  const provider = new TavilySearchProvider({ resolveApiKeys: async () => [' tvly-a\n', 'tvly-a', '', '   ', 'tvly-b'] })
  const stub = scriptFetch([oneSource('https://one.example')])
  await provider.search({ query: 'trim' })
  await provider.search({ query: 'trim again' })
  stub.restore()
  assert.deepEqual(stub.calls.map((call) => call.key), ['tvly-a', 'tvly-b'], 'blank and duplicate keys are dropped, values are trimmed')
}

{
  // A literal config key is attempted before the lazy source (unchanged precedence).
  const provider = new TavilySearchProvider({ apiKey: 'literal', resolveApiKeys: async () => ['lazy'] })
  const stub = scriptFetch([PLAN_LIMIT, oneSource('https://ok.example')])
  await provider.search({ query: 'literal first' })
  stub.restore()
  assert.deepEqual(stub.calls.map((call) => call.key), ['literal', 'lazy'], 'the literal config key goes first')
}

{
  // Cancellation surfaces as WEB_ABORTED and never rotates: it is not a key problem.
  const provider = new TavilySearchProvider({ resolveApiKeys: async () => ['a', 'b'] })
  let calls = 0
  const previous = globalThis.fetch
  globalThis.fetch = async () => {
    calls += 1
    throw new DOMException('aborted', 'AbortError')
  }
  let failure
  try {
    await provider.search({ query: 'abort' })
  } catch (error) {
    failure = error
  }
  globalThis.fetch = previous
  assert.equal(failure?.code, 'WEB_ABORTED', 'an aborted attempt surfaces as WEB_ABORTED')
  assert.equal(calls, 1, 'an aborted attempt does not rotate')
}

{
  // An already-aborted signal stops before sending anything.
  const provider = new TavilySearchProvider({ resolveApiKeys: async () => ['a'] })
  const stub = scriptFetch([oneSource('https://one.example')])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    provider.search({ query: 'pre-aborted' }, controller.signal),
    (error) => error?.code === 'WEB_ABORTED',
    'a pre-aborted signal fails as WEB_ABORTED',
  )
  stub.restore()
  assert.equal(stub.calls.length, 0, 'a pre-aborted signal sends no request')
}

// ── live call ──────────────────────────────────────────────────────────────

const liveKeys = [process.env.TAVILY_API_KEY, process.env.TAVILY_API_KEY_2]
  .filter((key) => typeof key === 'string' && key.trim().length > 0)

if (liveKeys.length > 0) {
  // Exercise the lazy multi-key path end to end: the resolver supplies the
  // pool per search, exactly as the credentials store does in the harness.
  const provider = new TavilySearchProvider({
    resolveApiKeys: async () => liveKeys,
    maxResults: 3,
  })
  console.log('live search (provider id=%s, available=%s, keys=%d)…', provider.id, provider.available(), liveKeys.length)
  const result = await provider.search({ query: 'DeepSeek Harness', maxResults: 3 })
  console.log('live result sources: %d, truncated=%s', result.sources.length, result.truncated)
  assert.ok(Array.isArray(result.sources), 'sources is an array')
  assert.ok(result.sources.length > 0, 'expected at least one source')
  for (const source of result.sources) {
    assert.ok(source.url.length > 0, 'every source has a url')
    console.log('  - %s | %O', source.title ?? new URL(source.url).hostname, source.snippet)
  }
  console.log('pool after the live search: %O', provider.pool.describe())

  // A second search must still be served — by rotation, whatever the first one used.
  const again = await provider.search({ query: 'Tavily API rate limits', maxResults: 2 })
  assert.ok(again.sources.length > 0, 'a follow-up search is served')
  console.log('pool after the follow-up search: %O', provider.pool.describe())
  console.log('PASS: live Tavily search returned %d source(s)', result.sources.length)
} else {
  console.log('SKIP: no TAVILY_API_KEY in the environment; live call not exercised')
}

console.log('PASS: all mapping, classification, key-pool, rotation, and availability checks')
