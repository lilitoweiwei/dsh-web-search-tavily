/**
 * `@lilitoweiwei/dsh-web-search-tavily`: registers a Tavily-backed
 * `WebSearchProvider` with `ctx.web`. A function/namespace plugin (NOT a
 * default-export service): it registers INTO the seam's provider registry,
 * exactly as `@deepseek-ai/dsh-web-search-exa` does. This package owns no
 * runtime state beyond the single registered provider.
 *
 * Key resolution is LAZY, at search time — never at plugin load. The loader
 * inits entries in parallel, so the `credentials` service may not be ready
 * when this plugin's `apply` runs; a load-time probe would silently lose the
 * key and leave the provider permanently "registered but unavailable".
 * Precedence per search: the `credentials` service's `TAVILY_API_KEY` entry
 * first, then `config.apiKey`, then the `TAVILY_API_KEY` environment
 * variable. Config is meant for non-secret defaults (`baseURL`,
 * `searchDepth`, ...); the key itself should live in
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
 * directly and defaulted here. The provider's key is resolved per search, so
 * a credentials service that is not ready at load time is never fatal: the
 * provider stays available and picks the key up on the first search.
 */
export async function apply(ctx, config) {
  const literalApiKey = typeof config?.apiKey === 'string' && config.apiKey.length > 0
    ? config.apiKey
    : undefined

  ctx.web.registerSearchProvider(new TavilySearchProvider({
    // Lazy, per-search key source: the credentials store may mount after this
    // plugin's apply runs (loader inits entries in parallel), and a rotated
    // key must reach the next search without a restart.
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        try {
          const hit = await credentials.resolve('TAVILY_API_KEY')
          if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) {
            return hit.value
          }
        } catch (error) {
          ctx.logger.warn('web-search-tavily: credential resolution failed (%s); falling back to config/env',
            error instanceof Error ? error.message : String(error))
        }
      }
      return ambientApiKey()
    },
    baseURL: config?.baseURL ?? TAVILY_DEFAULT_BASE_URL,
    searchDepth: config?.searchDepth ?? TAVILY_DEFAULT_SEARCH_DEPTH,
    chunksPerSource: config?.chunksPerSource ?? TAVILY_DEFAULT_CHUNKS_PER_SOURCE,
    maxResults: config?.maxResults ?? TAVILY_DEFAULT_MAX_RESULTS,
  }))
}

/** `TAVILY_API_KEY` from the process environment, or `undefined` when unset/blank. */
function ambientApiKey() {
  const value = process.env.TAVILY_API_KEY
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
