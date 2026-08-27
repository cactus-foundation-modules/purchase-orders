// The portal's own rate limiter. In memory, per instance, and deliberately not
// core's table-backed one: that limiter's list of actions is a closed union in
// core, and a module reaching in to add "po_portal" to it would be module-shaped
// code in core, which this platform does not do.
//
// What it is guarding is worth being honest about. The token is 32 random bytes,
// so this is not what stops somebody guessing a link - nothing guesses a link.
// It stops a supplier's browser, or a badly written integration, hammering the
// page, and it puts a ceiling on how many proposals one token can file in an
// hour. A secondary guard behind a real lock, which is exactly what an
// in-memory, resets-on-cold-start counter is good for.
//
// Nothing here imports the shop module's version of this, which is the same idea
// written for a different set of routes. Purchase Orders never imports another
// module's TypeScript - those directories do not exist on an install without
// them.

type Bucket = { count: number; windowStart: number; expiresAt: number }
const buckets = new Map<string, Bucket>()

// Swept on the write that crosses the mark rather than on a timer, so this stays
// a plain module with no lifecycle. Without it a long-lived instance keeps one
// entry per address it has ever seen.
const SWEEP_EVERY = 512
let writesSinceSweep = 0

/** Reading the order. Generous: a supplier refreshing the page while they work
 *  through it is not an attack. */
export const PORTAL_READ_LIMIT = { max: 120, windowMs: 10 * 60_000 }

/** Saying something back. Tighter, because each one lands in the order's own
 *  history and somebody has to read it. */
export const PORTAL_WRITE_LIMIT = { max: 20, windowMs: 60 * 60_000 }

/** One address, across every token it holds. Higher than the per-token limits:
 *  a supplier's whole sales desk shares one office address. */
export const PORTAL_IP_READ_LIMIT = { max: 300, windowMs: 10 * 60_000 }
export const PORTAL_IP_WRITE_LIMIT = { max: 60, windowMs: 60 * 60_000 }

export function checkPortalRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  if (++writesSinceSweep >= SWEEP_EVERY) {
    writesSinceSweep = 0
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.expiresAt <= now) buckets.delete(bucketKey)
    }
  }
  const bucket = buckets.get(key)
  if (!bucket || now - bucket.windowStart > windowMs) {
    buckets.set(key, { count: 1, windowStart: now, expiresAt: now + windowMs })
    return true
  }
  if (bucket.count >= max) return false
  bucket.count += 1
  return true
}

/** One token, reading. Checked before the address limit, so one busy supplier
 *  trips their own bucket rather than the address bucket everybody behind that
 *  office shares. */
export function allowPortalReadToken(tokenHash: string): boolean {
  return checkPortalRateLimit(`po-portal-read:${tokenHash}`, PORTAL_READ_LIMIT.max, PORTAL_READ_LIMIT.windowMs)
}

/** One address, reading. Also the only limit that applies to a request whose
 *  token turns out to be rubbish, which is exactly the request worth limiting. */
export function allowPortalReadIp(ipKey: string): boolean {
  return checkPortalRateLimit(`po-portal-read-ip:${ipKey}`, PORTAL_IP_READ_LIMIT.max, PORTAL_IP_READ_LIMIT.windowMs)
}

/** One token, saying something back. */
export function allowPortalWriteToken(tokenHash: string): boolean {
  return checkPortalRateLimit(`po-portal-write:${tokenHash}`, PORTAL_WRITE_LIMIT.max, PORTAL_WRITE_LIMIT.windowMs)
}

/** One address, saying something back. Checked before the token is even looked
 *  up, so a flood of made-up tokens costs one map lookup rather than a query
 *  each. */
export function allowPortalWriteIp(ipKey: string): boolean {
  return checkPortalRateLimit(`po-portal-write-ip:${ipKey}`, PORTAL_IP_WRITE_LIMIT.max, PORTAL_IP_WRITE_LIMIT.windowMs)
}

/** Empties the buckets. For tests only - nothing in the running site wants this. */
export function resetPortalRateLimits(): void {
  buckets.clear()
  writesSinceSweep = 0
}

/**
 * The address a portal request came from, for the limiter's key only. Never
 * stored: what goes in the event log is a keyed hash (see hashPortalIp).
 *
 * The LAST hop, not the first. x-forwarded-for is a list the caller can prepend
 * to, so the leftmost entry is whatever they typed and rotating it walks through
 * any per-address limit. Core learned that the expensive way, in
 * lib/auth/rate-limit.ts.
 */
export function portalClientIpFrom(get: (name: string) => string | null): string {
  const hops = (get('x-forwarded-for') ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean)
  const lastHop = hops[hops.length - 1]
  if (lastHop) return lastHop
  return get('x-real-ip')?.trim() || 'unknown'
}

/** The same, for a route handler that has the request in hand. The page reads
 *  its headers through next/headers instead and calls the function above. */
export function portalClientIp(request: Request): string {
  return portalClientIpFrom((name) => request.headers.get(name))
}
