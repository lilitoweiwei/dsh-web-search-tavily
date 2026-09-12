/**
 * Key-pool mechanics for the Tavily provider: the credential references that
 * name the configured keys, the order one search walks them in, and the
 * per-key quarantine that skips a key whose plan quota or credentials are
 * currently refusing requests.
 *
 * Quarantine state lives in memory only. Dropping it on restart costs one
 * rejected request per dead key before the pool settles again — cheaper than
 * owning a durable write path for state that expires on its own.
 *
 * @module @lilitoweiwei/dsh-web-search-tavily/keys
 */

import { createHash } from 'node:crypto'

/** Credential reference naming the first Tavily key, and the scan's first probe. */
export const TAVILY_PRIMARY_KEY_REF = 'TAVILY_API_KEY'

/** First numeric suffix the convention scan appends (`TAVILY_API_KEY_2`). */
export const TAVILY_FIRST_KEY_SUFFIX = 2

/** Most references the convention scan probes, the primary one included. */
export const TAVILY_DEFAULT_MAX_KEY_REFS = 12

/** Consecutive missing references that end the convention scan. */
export const TAVILY_DEFAULT_SCAN_GAP = 2

/**
 * How long a key that reported an exhausted plan quota stays out of rotation.
 * Tavily resets a free plan monthly and does not return the reset date, so the
 * pool re-probes daily: at most one rejected request per key per day, in
 * exchange for picking a key back up within a day of its quota returning.
 */
export const TAVILY_DEFAULT_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000

/** How long a key the API rejected as unauthorized stays out of rotation. */
export const TAVILY_DEFAULT_AUTH_COOLDOWN_MS = 60 * 60 * 1000

/** Rate-limit quarantine used when the response carries no usable `retry-after`. */
export const TAVILY_DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 1000

/** Upper bound on an honored `retry-after`, so one header cannot park a key for long. */
export const TAVILY_MAX_RETRY_AFTER_MS = 5 * 60 * 1000

/**
 * The credential references the convention scan probes, in preference order:
 * `TAVILY_API_KEY`, then `TAVILY_API_KEY_2`, `_3`, … Reference *names* only —
 * whether a reference holds a value is the credentials service's answer.
 *
 * @param {number} [maxRefs] - cap on the number of references returned.
 * @returns {string[]} reference names, primary first.
 */
export function tavilyConventionRefs(maxRefs = TAVILY_DEFAULT_MAX_KEY_REFS) {
  const limit = Number.isInteger(maxRefs) && maxRefs > 0 ? maxRefs : TAVILY_DEFAULT_MAX_KEY_REFS
  const refs = [TAVILY_PRIMARY_KEY_REF]
  for (let n = TAVILY_FIRST_KEY_SUFFIX; refs.length < limit; n += 1) {
    refs.push(`${TAVILY_PRIMARY_KEY_REF}_${n}`)
  }
  return refs
}

/**
 * Stable public identity for one key: enough to name it in diagnostics and to
 * keep per-key state apart, never enough to recover the key from it. Identical
 * keys collapse to one identity, which is what makes the pool a set.
 *
 * @param {string} key - the API key value.
 * @returns {string} 12 hexadecimal characters of its SHA-256 digest.
 */
export function keyFingerprint(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

/**
 * A pool of interchangeable Tavily keys. It answers two questions per search:
 * which keys are configured (through {@link TavilyKeyPool#update}) and in what
 * order to attempt them ({@link TavilyKeyPool#candidates}); the provider
 * reports each attempt's outcome back, and the pool uses those outcomes to
 * rotate and to park keys.
 *
 * A parked key is never removed from the pool: when every key is parked the
 * candidates are the parked ones, ordered by soonest expiry, so a search still
 * runs and reports the API's real answer instead of refusing on local state.
 */
export class TavilyKeyPool {
  /** @type {{ id: string, key: string }[]} configured keys, in configured order. */
  #keys = []

  /** @type {Map<string, { until: number, status: number, reason: string }>} parked keys by id. */
  #parked = new Map()

  /** @type {Map<string, number>} searches each key served, for diagnostics. */
  #served = new Map()

  /** @type {number} rotation cursor into the usable keys. */
  #cursor = 0

  /**
   * Replace the configured key list. Parked state survives: it is keyed by
   * fingerprint, so a key that merely moved position keeps its quarantine.
   *
   * @param {string[]} keys - the keys this search may use, in configured order.
   */
  update(keys) {
    this.#keys = keys.map((key) => ({ id: keyFingerprint(key), key }))
  }

  /** @returns {number} how many keys are configured. */
  get size() {
    return this.#keys.length
  }

  /**
   * The keys to attempt for one search, in the order to attempt them: usable
   * keys in round-robin order from the cursor, then parked keys by soonest
   * expiry. Rotating per search is what spreads one month's quota across every
   * configured key instead of draining them one at a time.
   *
   * @returns {{ id: string, key: string }[]} attempt order for this search.
   */
  candidates() {
    const now = Date.now()
    const usable = []
    const parked = []
    for (const entry of this.#keys) {
      const park = this.#parked.get(entry.id)
      if (park !== undefined && park.until > now) parked.push({ entry, until: park.until })
      else usable.push(entry)
    }
    parked.sort((a, b) => a.until - b.until)
    return [...rotate(usable, this.#cursor), ...parked.map((entry) => entry.entry)]
  }

  /**
   * Record that a key served a search: it leaves quarantine (a served request
   * is proof the key works now) and the cursor moves past it.
   *
   * @param {string} id - the fingerprint of the key that succeeded.
   */
  noteServed(id) {
    this.#served.set(id, (this.#served.get(id) ?? 0) + 1)
    this.#parked.delete(id)
    const usable = this.#keys.filter((entry) => !this.#isParked(entry.id))
    const index = usable.findIndex((entry) => entry.id === id)
    this.#cursor = index >= 0 ? (index + 1) % usable.length : 0
  }

  /**
   * Record that a key refused a search for a key-specific reason, parking it
   * until `cooldownMs` elapses.
   *
   * @param {string} id - the fingerprint of the key that failed.
   * @param {{ status: number, reason: string, cooldownMs: number }} failure - the refusal.
   */
  noteRefused(id, failure) {
    if (!(failure.cooldownMs > 0)) return
    this.#parked.set(id, {
      until: Date.now() + failure.cooldownMs,
      status: failure.status,
      reason: failure.reason,
    })
  }

  /**
   * Per-key state for diagnostics and tests: masked identity, how much longer
   * it is parked, the status that parked it, and how many searches it served.
   *
   * @returns {{ id: string, parkedForMs: number, status?: number, reason?: string, served: number }[]}
   *   one entry per configured key, in configured order.
   */
  describe() {
    const now = Date.now()
    return this.#keys.map((entry) => {
      const park = this.#parked.get(entry.id)
      const parked = park !== undefined && park.until > now
      return {
        id: entry.id,
        parkedForMs: parked ? park.until - now : 0,
        ...parked ? { status: park.status, reason: park.reason } : {},
        served: this.#served.get(entry.id) ?? 0,
      }
    })
  }

  /** True while `id` is parked. */
  #isParked(id) {
    const park = this.#parked.get(id)
    return park !== undefined && park.until > Date.now()
  }
}

/**
 * Rotate a list so it starts at `cursor`, wrapping. An empty list and a cursor
 * beyond the end both yield the list unchanged in content.
 *
 * @param {object[]} list - the entries to rotate.
 * @param {number} cursor - the index to start from.
 * @returns {object[]} a new rotated array.
 */
function rotate(list, cursor) {
  if (list.length === 0) return []
  const start = ((cursor % list.length) + list.length) % list.length
  return [...list.slice(start), ...list.slice(0, start)]
}
