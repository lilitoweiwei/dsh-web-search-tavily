/**
 * `TavilySearchProvider`: a `WebSearchProvider` backed by the Tavily Search
 * API (`POST https://api.tavily.com/search`). It maps each result's `title`,
 * `url`, `content` (snippet) and optional `published_date` into the seam's
 * portable `WebSearchSource`, and drops nothing (unlike Exa, Tavily always
 * returns a snippet in `content`). `content` (the LLM-generated answer) is
 * omitted: the provider only sends `include_answer` when requested, so by
 * default Tavily returns no answer and inventing one would lie.
 *
 * One search may send more than one request: the keys are interchangeable, so
 * a key the API refuses for a key-specific reason (exhausted plan quota, a
 * revoked or invalid key, a rate limit) parks itself and the search moves to
 * the next key, up to every configured key. Refusals that are not key-specific
 * — a malformed request, a Tavily-side outage, a transport failure — fail the
 * search on the first response, because rotating would repeat the same failure
 * once per key.
 *
 * The API keys are NOT baked at construction. `apiKey` holds a literal at load
 * time (config-provided); `resolveApiKeys` is a lazy per-search source that
 * reads the credentials store when each search runs, so a rotated or added key
 * reaches the next search without a restart. `available()` accepts either
 * source so the seam never refuses a provider merely because the credentials
 * service is not ready yet during parallel plugin init.
 *
 * @module @lilitoweiwei/dsh-web-search-tavily/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import {
  TAVILY_DEFAULT_AUTH_COOLDOWN_MS,
  TAVILY_DEFAULT_QUOTA_COOLDOWN_MS,
  TAVILY_DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  TAVILY_MAX_RETRY_AFTER_MS,
  TavilyKeyPool,
} from './keys.js'

/** Stable id this provider registers under with `ctx.web`. */
export const TAVILY_PROVIDER_ID = 'tavily'

/** Default Tavily search endpoint; `/search` is the operation. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'

/** Official agent-grade default: higher relevance, more evidence per source. */
export const TAVILY_DEFAULT_SEARCH_DEPTH = 'advanced'

/** Official default: number of relevant chunks requested per source. */
export const TAVILY_DEFAULT_CHUNKS_PER_SOURCE = 3

/** Official default result count when a request carries no `maxResults`. */
export const TAVILY_DEFAULT_MAX_RESULTS = 5

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'dsh-web-search-tavily/0.2.0'

/** Allowed Tavily `search_depth` values (per official docs). */
const SEARCH_DEPTHS = new Set(['advanced', 'basic', 'fast', 'ultra-fast'])

/**
 * Tavily's `432`: the account's plan quota for the current period is used up.
 * Verified against the live API — the body reads "This request exceeds your
 * plan's set usage limit."
 */
const HTTP_PLAN_LIMIT = 432

/**
 * Resolved provider options (the plugin's `apply` supplies the credentials /
 * config defaults).
 */
export class TavilySearchProvider {
  constructor(options) {
    this.options = {
      baseURL: options.baseURL ?? TAVILY_DEFAULT_BASE_URL,
      searchDepth: options.searchDepth ?? TAVILY_DEFAULT_SEARCH_DEPTH,
      chunksPerSource: options.chunksPerSource ?? TAVILY_DEFAULT_CHUNKS_PER_SOURCE,
      maxResults: options.maxResults ?? TAVILY_DEFAULT_MAX_RESULTS,
      ...options,
    }
    /** Rotation and quarantine state for the configured keys. */
    this.pool = new TavilyKeyPool()
  }

  get id() {
    return TAVILY_PROVIDER_ID
  }

  /** Cheap local usability check; never makes network calls. */
  available() {
    const { apiKey, resolveApiKey, resolveApiKeys, baseURL, searchDepth, chunksPerSource, maxResults } = this.options
    const hasKeySource = (typeof apiKey === 'string' && apiKey.length > 0)
      || resolveApiKey !== undefined
      || resolveApiKeys !== undefined
    return hasKeySource
      && URL.canParse(baseURL)
      && SEARCH_DEPTHS.has(searchDepth)
      && isPositiveInteger(chunksPerSource)
      && isPositiveInteger(maxResults)
  }

  /**
   * Run one Tavily search, mapping the response into seam-normalized sources.
   *
   * The keys are resolved per search (literal config key first, then the lazy
   * source) and attempted in rotation order until one answers or every
   * configured key has refused. A key-specific refusal parks that key and the
   * next key is tried; the search fails as `WEB_PROVIDER_ERROR` when no key
   * answers, naming what each key said, and as `WEB_PROVIDER_ERROR` with a
   * remediation hint when no key is configured at all. HTTP redirects fail as
   * `WEB_PROVIDER_ERROR` (no credential forwarding); cancellation surfaces as
   * `WEB_ABORTED` and stops the rotation.
   *
   * @param {object} request - the seam `WebSearchRequest`.
   * @param {AbortSignal} [signal] - optional cancellation signal forwarded to fetch.
   * @returns {Promise<object>} a `WebSearchResult`.
   */
  async search(request, signal) {
    // A per-request bound wins over the configured default; either may be absent.
    const maxResults = request.maxResults ?? this.options.maxResults
    const keys = await resolveKeys(this.options)
    if (keys.length === 0) {
      throw new WebError(
        'Tavily search requires an API key: set TAVILY_API_KEY in the credentials store (or the plugin config apiKey); add TAVILY_API_KEY_2, TAVILY_API_KEY_3, … to rotate several keys',
        'WEB_PROVIDER_ERROR',
      )
    }
    this.pool.update(keys)

    const candidates = this.pool.candidates()
    const refusals = []
    for (let position = 0; position < candidates.length; position += 1) {
      if (signal?.aborted) throw new WebError('Tavily search aborted', 'WEB_ABORTED')
      const entry = candidates[position]
      const outcome = await attemptSearch(this.options, entry.key, request, maxResults, signal)

      if (outcome.kind === 'ok') {
        this.pool.noteServed(entry.id)
        return outcome.result
      }
      if (outcome.kind === 'aborted') {
        throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: outcome.cause })
      }
      if (outcome.kind === 'failed') throw outcome.error

      this.pool.noteRefused(entry.id, outcome)
      refusals.push({ position: position + 1, id: entry.id, ...outcome })
      const next = position + 2
      this.#log(`key ${entry.id} ${outcome.reason} (HTTP ${outcome.status}); ` +
        (next <= candidates.length ? `trying key ${next} of ${candidates.length}` : 'no key left to try'))
    }

    throw new WebError(allKeysRefused(refusals, candidates.length), 'WEB_PROVIDER_ERROR')
  }

  /**
   * Emit one rotation diagnostic. Rotation is otherwise invisible: the model
   * only ever sees the successful result or the final failure, so this is where
   * an exhausted or revoked key becomes noticeable to the operator.
   *
   * The injected logger is a cordis logger, which drops every message when the
   * composition mounts no exporter — the shipped `web-plus` profile mounts
   * none. `apply` therefore injects a logger only when one is actually
   * listening, and this falls back to stderr, which the service unit captures
   * in the journal either way.
   */
  #log(message) {
    const line = `web-search-tavily: ${message}`
    const logger = this.options.logger
    if (logger !== undefined && typeof logger.warn === 'function') {
      logger.warn(line)
      return
    }
    process.stderr.write(`${line}\n`)
  }
}

/**
 * What one Tavily key's attempt means for the rest of the search. Only
 * key-specific refusals rotate: an exhausted plan quota, a key the API rejects
 * as unauthorized, and a rate limit all clear by using a different key. Any
 * other status — a malformed request, a Tavily-side fault — would answer the
 * same way for every key, so it fails the search instead of multiplying the
 * delay by the number of keys.
 *
 * @param {number} status - the response status code.
 * @param {string|null} retryAfter - the response's `retry-after` header, if any.
 * @returns {{ rotate: boolean, reason?: string, cooldownMs?: number, status?: number }}
 *   the verdict; `rotate: false` means fail the search now.
 */
export function classifyTavilyFailure(status, retryAfter) {
  if (status === HTTP_PLAN_LIMIT) {
    return { rotate: true, status, reason: 'exhausted its plan quota', cooldownMs: TAVILY_DEFAULT_QUOTA_COOLDOWN_MS }
  }
  if (status === 401 || status === 403) {
    return { rotate: true, status, reason: 'is not authorized', cooldownMs: TAVILY_DEFAULT_AUTH_COOLDOWN_MS }
  }
  if (status === 429) {
    return {
      rotate: true,
      status,
      reason: 'is rate limited',
      cooldownMs: retryAfterCooldownMs(retryAfter) ?? TAVILY_DEFAULT_RATE_LIMIT_COOLDOWN_MS,
    }
  }
  return { rotate: false }
}

/**
 * Honor a `retry-after` header as a quarantine length. Tavily documents the
 * value as a number of seconds; anything else (or a non-positive number) is
 * ignored so the caller's default applies. The result is clamped so one header
 * cannot park a key indefinitely.
 *
 * @param {string|null} retryAfter - the raw header value.
 * @returns {number|undefined} milliseconds to park the key, or undefined to fall back.
 */
function retryAfterCooldownMs(retryAfter) {
  if (typeof retryAfter !== 'string') return undefined
  const seconds = Number.parseInt(retryAfter.trim(), 10)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return Math.min(seconds * 1000, TAVILY_MAX_RETRY_AFTER_MS)
}

/**
 * Message for the failure that ends a search every configured key refused.
 * The model reads this, so it names what each key said and keeps the API's own
 * wording; keys appear as fingerprints, never as values.
 *
 * @param {{ position: number, id: string, status: number, reason: string, message: string }[]} refusals
 *   one entry per attempted key, in attempt order.
 * @param {number} total - how many keys the pool held for this search.
 * @returns {string} the failure message.
 */
function allKeysRefused(refusals, total) {
  const scope = total === 1
    ? 'the only configured API key'
    : `all ${total} configured API keys`
  const detail = refusals
    .map((refusal) => `#${refusal.position} (${refusal.id}) HTTP ${refusal.status}: ${refusal.reason}`)
    .join('; ')
  const last = refusals[refusals.length - 1]
  return `Tavily search failed on ${scope} — ${detail}. Last error: ${last.message}`
}

/**
 * Send one search with one key and classify what came back. Never throws: the
 * caller decides between rotating, failing, and propagating cancellation.
 *
 * @param {object} options - the provider's resolved options.
 * @param {string} apiKey - the key to send.
 * @param {object} request - the seam `WebSearchRequest`.
 * @param {number|undefined} maxResults - the resolved result bound.
 * @param {AbortSignal} [signal] - optional cancellation signal forwarded to fetch.
 * @returns {Promise<{kind: 'ok', result: object}
 *   | {kind: 'aborted', cause: unknown}
 *   | {kind: 'failed', error: WebError}
 *   | {kind: 'rotate', status: number, reason: string, cooldownMs: number, message: string}>}
 *   the attempt's outcome.
 */
async function attemptSearch(options, apiKey, request, maxResults, signal) {
  let response
  try {
    response = await fetch(`${options.baseURL}/search`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'accept': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({
        query: request.query,
        search_depth: options.searchDepth,
        chunks_per_source: options.chunksPerSource,
        ...maxResults !== undefined ? { max_results: maxResults } : {},
      }),
      ...signal !== undefined ? { signal } : {},
    })
  } catch (error) {
    if (isAbortError(error)) return { kind: 'aborted', cause: error }
    // A transport failure is not key-specific: the next key would fail the same way.
    return {
      kind: 'failed',
      error: new WebError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error }),
    }
  }

  if (response.ok) {
    try {
      return { kind: 'ok', result: mapTavilyResponse(await response.json()) }
    } catch (error) {
      if (isAbortError(error)) return { kind: 'aborted', cause: error }
      return {
        kind: 'failed',
        error: new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error }),
      }
    }
  }

  let message
  try {
    message = await providerErrorMessage(response)
  } catch (error) {
    // Only an abort mid-body reaches here; the status alone is otherwise enough.
    if (isAbortError(error)) return { kind: 'aborted', cause: error }
    message = `Tavily API error (HTTP ${response.status})`
  }

  const verdict = classifyTavilyFailure(response.status, response.headers.get('retry-after'))
  if (!verdict.rotate) {
    return { kind: 'failed', error: new WebError(message, 'WEB_PROVIDER_ERROR') }
  }
  return {
    kind: 'rotate',
    status: verdict.status,
    reason: verdict.reason,
    cooldownMs: verdict.cooldownMs,
    message,
  }
}

/**
 * Map one Tavily result to a normalized source. `url` is required; blank
 * optional fields are omitted rather than set empty.
 *
 * @param {object} result - one entry of the response `results[]`.
 * @returns {object} the normalized `WebSearchSource`.
 */
export function mapTavilyResult(result) {
  const source = { url: typeof result.url === 'string' ? result.url : '' }
  if (typeof result.title === 'string' && result.title.length > 0) source.title = result.title
  if (typeof result.content === 'string' && result.content.length > 0) source.snippet = result.content
  if (typeof result.published_date === 'string' && result.published_date.length > 0) {
    source.publishedAt = result.published_date
  }
  return source
}

/**
 * Map a Tavily response envelope to a normalized search result. Tavily returns
 * no generated answer by default, so `content` is omitted. The web service
 * owns the final `maxResults` truncation, so this provider reports
 * `truncated: false`.
 *
 * @param {object} response - the parsed `POST /search` response body.
 * @returns {object} the normalized `WebSearchResult`.
 */
export function mapTavilyResponse(response) {
  const sources = Array.isArray(response.results)
    ? response.results.map(mapTavilyResult)
    : []
  return { sources, truncated: false }
}

/**
 * Build a provider-facing error message from a non-2xx Tavily response,
 * preferring the JSON `detail.error` payload when it parses.
 *
 * @param {Response} response - the non-ok fetch response.
 * @returns {Promise<string>} a human-readable error message.
 */
async function providerErrorMessage(response) {
  const status = response.status
  let message = `Tavily API error (HTTP ${status})`
  try {
    const parsed = await response.json()
    if (parsed !== null && typeof parsed === 'object') {
      const detail = parsed.detail
      const detailError = detail !== null && typeof detail === 'object' && typeof detail.error === 'string'
        ? detail.error
        : parsed.error
      if (typeof detailError === 'string' && detailError.length > 0) message = detailError
    }
  } catch (error) {
    // An abort mid-body must surface as WEB_ABORTED, not sink into a generic
    // message — cancellation is not a provider error.
    if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
    // Otherwise the HTTP status already captured in `message` is enough.
  }
  return message
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** True for a positive whole number (a request-limit that can be sent). */
function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

/**
 * Resolve the keys one search may use, in preference order and deduplicated: a
 * non-empty literal `apiKey` wins, then the lazy `resolveApiKeys` (or the
 * legacy singular `resolveApiKey`) source. Values are trimmed — a key pasted
 * into a YAML credentials file commonly carries a trailing newline, which the
 * API would reject as unauthorized.
 *
 * @param {object} options - the provider's resolved options.
 * @returns {Promise<string[]>} the keys to rotate through; empty when none is configured.
 */
async function resolveKeys(options) {
  const keys = []
  const add = (value) => {
    const key = typeof value === 'string' ? value.trim() : ''
    if (key.length > 0 && !keys.includes(key)) keys.push(key)
  }

  add(options.apiKey)
  if (options.resolveApiKeys !== undefined) {
    let resolved
    try {
      resolved = await options.resolveApiKeys()
    } catch (error) {
      throw new WebError(`Tavily key resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (Array.isArray(resolved)) for (const value of resolved) add(value)
    return keys
  }
  if (options.resolveApiKey !== undefined) {
    let resolved
    try {
      resolved = await options.resolveApiKey()
    } catch (error) {
      throw new WebError(`Tavily key resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    add(resolved)
  }
  return keys
}
