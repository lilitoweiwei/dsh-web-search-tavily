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
 * keys and leave the provider permanently "registered but unavailable".
 * Precedence per search: the `credentials` service's references first, then
 * `config.apiKey`, then the `TAVILY_API_KEY` environment variable. Config is
 * meant for non-secret defaults (`baseURL`, `searchDepth`, ...); keys
 * themselves should live in `~/.dsh/.credentials.yaml` so they never enter a
 * `cordis.yml` or Git.
 *
 * Several keys rotate: the credentials store is scanned for `TAVILY_API_KEY`,
 * then `TAVILY_API_KEY_2`, `TAVILY_API_KEY_3`, … (see
 * {@link tavilyConventionRefs}), and the provider spreads searches across them
 * and moves on when one is exhausted.
 *
 * @module @lilitoweiwei/dsh-web-search-tavily
 */

import {
  TAVILY_DEFAULT_MAX_KEY_REFS,
  TAVILY_DEFAULT_SCAN_GAP,
  tavilyConventionRefs,
} from './keys.js'
import { TavilySearchProvider, TAVILY_DEFAULT_BASE_URL, TAVILY_DEFAULT_CHUNKS_PER_SOURCE, TAVILY_DEFAULT_MAX_RESULTS, TAVILY_DEFAULT_SEARCH_DEPTH, TAVILY_PROVIDER_ID } from './provider.js'

export {
  TAVILY_DEFAULT_AUTH_COOLDOWN_MS,
  TAVILY_DEFAULT_MAX_KEY_REFS,
  TAVILY_DEFAULT_QUOTA_COOLDOWN_MS,
  TAVILY_DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  TAVILY_DEFAULT_SCAN_GAP,
  TAVILY_FIRST_KEY_SUFFIX,
  TAVILY_PRIMARY_KEY_REF,
  TavilyKeyPool,
  keyFingerprint,
  tavilyConventionRefs,
} from './keys.js'
export {
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_CHUNKS_PER_SOURCE,
  TAVILY_DEFAULT_MAX_RESULTS,
  TAVILY_DEFAULT_SEARCH_DEPTH,
  TAVILY_PROVIDER_ID,
  TavilySearchProvider,
  classifyTavilyFailure,
  mapTavilyResult,
  mapTavilyResponse,
} from './provider.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-tavily'

/** The web seam this provider registers into. */
export const inject = ['web']

/**
 * Register the Tavily search provider with `ctx.web`. No `Config` schema is
 * declared (matching minimal external plugins): config fields are read
 * directly and defaulted here. The provider's keys are resolved per search, so
 * a credentials service that is not ready at load time is never fatal — the
 * provider stays available and picks the keys up on the first search.
 */
export async function apply(ctx, config) {
  const literalApiKey = typeof config?.apiKey === 'string' && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  const maxKeyRefs = Number.isInteger(config?.maxKeyRefs) && config.maxKeyRefs > 0
    ? config.maxKeyRefs
    : TAVILY_DEFAULT_MAX_KEY_REFS

  ctx.web.registerSearchProvider(new TavilySearchProvider({
    // Lazy, per-search key source: the credentials store may mount after this
    // plugin's apply runs (loader inits entries in parallel), and a rotated,
    // added, or removed key must reach the next search without a restart.
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKeys: async () => resolveCredentialsKeys(ctx, maxKeyRefs),
    baseURL: config?.baseURL ?? TAVILY_DEFAULT_BASE_URL,
    searchDepth: config?.searchDepth ?? TAVILY_DEFAULT_SEARCH_DEPTH,
    chunksPerSource: config?.chunksPerSource ?? TAVILY_DEFAULT_CHUNKS_PER_SOURCE,
    maxResults: config?.maxResults ?? TAVILY_DEFAULT_MAX_RESULTS,
  }))
}

/**
 * Collect the keys the credentials store holds, in rotation order: the
 * `TAVILY_API_KEY` reference, then `TAVILY_API_KEY_2`, `TAVILY_API_KEY_3`, …
 * The scan stops after {@link TAVILY_DEFAULT_SCAN_GAP} consecutive missing
 * references, so a gap left by a removed key costs a couple of lookups rather
 * than ending the scan. A key the launching environment supplies is the
 * last resort, used only when the store yields none.
 *
 * @param {object} ctx - the plugin context, read for the optional credentials service.
 * @param {number} maxKeyRefs - cap on how many references the scan probes.
 * @returns {Promise<string[]>} the non-empty key values found, in scan order.
 */
async function resolveCredentialsKeys(ctx, maxKeyRefs) {
  const keys = []
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    let misses = 0
    for (const ref of tavilyConventionRefs(maxKeyRefs)) {
      let hit
      try {
        hit = await credentials.resolve(ref)
      } catch (error) {
        diagnose(`credential resolution failed for ${ref} ` +
          `(${error instanceof Error ? error.message : String(error)}); using the keys found so far`)
        break
      }
      const value = typeof hit?.value === 'string' ? hit.value.trim() : ''
      if (value.length === 0) {
        misses += 1
        if (misses > TAVILY_DEFAULT_SCAN_GAP) break
        continue
      }
      misses = 0
      if (!keys.includes(value)) keys.push(value)
    }
  }
  const ambient = ambientApiKey()
  if (keys.length === 0 && ambient !== undefined) keys.push(ambient)
  return keys
}

/**
 * Write one diagnostic line to stderr, where the operator actually sees it:
 * the service unit captures stderr in the journal. Not `ctx.logger`, because
 * cordis's always-present built-in exporter only buffers messages in memory and
 * the `dsh` web profile mounts no console sink on top of it.
 *
 * @param {string} message - the diagnostic, without the plugin prefix.
 */
function diagnose(message) {
  process.stderr.write(`web-search-tavily: ${message}\n`)
}

/** `TAVILY_API_KEY` from the process environment, or `undefined` when unset/blank. */
function ambientApiKey() {
  const value = process.env.TAVILY_API_KEY
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}
