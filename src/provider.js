/**
 * `TavilySearchProvider`: a `WebSearchProvider` backed by the Tavily Search
 * API (`POST https://api.tavily.com/search`). It maps each result's `title`,
 * `url`, `content` (snippet) and optional `published_date` into the seam's
 * portable `WebSearchSource`, and drops nothing (unlike Exa, Tavily always
 * returns a snippet in `content`). `content` (the LLM-generated answer) is
 * omitted: the provider only sends `include_answer` when requested, so by
 * default Tavily returns no answer and inventing one would lie.
 *
 * @module @lilitoweiwei/dsh-web-search-tavily/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'

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
const USER_AGENT = 'dsh-web-search-tavily/0.1.0'

/** Allowed Tavily `search_depth` values (per official docs). */
const SEARCH_DEPTHS = new Set(['advanced', 'basic', 'fast', 'ultra-fast'])

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
  }

  get id() {
    return TAVILY_PROVIDER_ID
  }

  /** Cheap local usability check; never makes network calls. */
  available() {
    const { apiKey, baseURL, searchDepth, chunksPerSource, maxResults } = this.options
    return typeof apiKey === 'string'
      && apiKey.length > 0
      && URL.canParse(baseURL)
      && SEARCH_DEPTHS.has(searchDepth)
      && isPositiveInteger(chunksPerSource)
      && isPositiveInteger(maxResults)
  }

  /**
   * Run one Tavily search, mapping the response into seam-normalized sources.
   * HTTP redirects fail as `WEB_PROVIDER_ERROR` (no credential forwarding);
   * cancellation surfaces as `WEB_ABORTED`.
   *
   * @param {object} request - the seam `WebSearchRequest`.
   * @param {AbortSignal} [signal] - optional cancellation signal forwarded to fetch.
   * @returns {Promise<object>} a `WebSearchResult`.
   */
  async search(request, signal) {
    // A per-request bound wins over the configured default; either may be absent.
    const maxResults = request.maxResults ?? this.options.maxResults
    let response
    try {
      response = await fetch(`${this.options.baseURL}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          query: request.query,
          search_depth: this.options.searchDepth,
          chunks_per_source: this.options.chunksPerSource,
          ...maxResults !== undefined ? { max_results: maxResults } : {},
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error) {
      if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const message = await providerErrorMessage(response)
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      return mapTavilyResponse(await response.json())
    } catch (error) {
      if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
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
