/**
 * `@lilitoweiwei/dsh-web-search-tavily`: registers a Tavily-backed
 * `WebSearchProvider` with `ctx.web`. A function/namespace plugin (NOT a
 * default-export service): it registers INTO the seam's provider registry,
 * exactly as `@deepseek-ai/dsh-web-search-exa` does. This package owns no
 * runtime state beyond the single registered provider.
 *
 * Key resolution order: the `credentials` service's `TAVILY_API_KEY` entry
 * first, then `config.apiKey` as fallback. Config is meant for non-secret
 * defaults (`baseURL`, `searchDepth`, ...); the key itself should live in
 * `~/.dsh/.credentials.yaml` so it never enters a `cordis.yml` or Git.
 *
 * @module @lilitoweiwei/dsh-web-search-tavily
 */

import { TavilySearchProvider, TAVILY_DEFAULT_BASE_URL, TAVILY_DEFAULT_CHUNKS_PER_SOURCE, TAVILY_DEFAULT_MAX_RESULTS, TAVILY_DEFAULT_SEARCH_DEPTH, TAVILY_PROVIDER_ID } from './provider.js'

export {
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_CHUNKS_PER_SOURCE,
  TAVILY_DEFAULT_MAX_RESULTS,
  TAVILY_DEFAULT_SEARCH_DEPTH,
  TAVILY_PROVIDER_ID,
  TavilySearchProvider,
} from './provider.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-tavily'

/** The web seam this provider registers into. */
export const inject = ['web']

/**
 * Register the Tavily search provider with `ctx.web`. No `Config` schema is
 * declared (matching minimal external plugins): config fields are read
 * directly and defaulted here.
 */
export async function apply(ctx, config) {
  const resolved = { ...(config ?? {}) }
  // Primary: the credentials service's TAVILY_API_KEY (owner-only local file).
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const hit = await credentials.resolve('TAVILY_API_KEY')
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) {
        resolved.apiKey = hit.value
      }
    } catch (error) {
      ctx.logger.warn('web-search-tavily: credential resolution failed (%s); falling back to config.apiKey',
        error instanceof Error ? error.message : String(error))
    }
  }
  // Fallback: config.apiKey (intended only when no credential is configured).
  resolved.apiKey = resolved.apiKey ?? config?.apiKey ?? ''
  resolved.baseURL = resolved.baseURL ?? TAVILY_DEFAULT_BASE_URL
  resolved.searchDepth = resolved.searchDepth ?? TAVILY_DEFAULT_SEARCH_DEPTH
  resolved.chunksPerSource = resolved.chunksPerSource ?? TAVILY_DEFAULT_CHUNKS_PER_SOURCE
  resolved.maxResults = resolved.maxResults ?? TAVILY_DEFAULT_MAX_RESULTS

  ctx.web.registerSearchProvider(new TavilySearchProvider(resolved))
}
