/**
 * Package-owned invariant companion for `@lilitoweiwei/dsh-web-search-tavily`.
 * @module @lilitoweiwei/dsh-web-search-tavily/invariant
 */

const PACKAGE_NAME = '@lilitoweiwei/dsh-web-search-tavily'

/** Cordis companion plugin name. */
const name = 'web-search-tavily-invariant'

/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/** No runtime invariant: this package exposes no independent event sequence or mutable data relation beyond the provider-registry contract of the web seam. */
const install = () => {}

/** Register this package's invariant companion. */
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

export { apply, inject, name }
