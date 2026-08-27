// PROTECTED - the credential that lets a SUPPLIER open the one order they are
// supplying, and nothing else on the site.
//
// Deliberately a different animal from lib/print-token.ts, which is an HMAC with
// its expiry inside the signature and no row behind it. That is right for a
// thirty-minute door held open for a headless browser. It is wrong here:
//
//  - a supplier's link lives for weeks, so it has to be revocable, and an HMAC
//    with no row cannot be taken back;
//  - somebody has to be able to see whether it has been used, and when;
//  - the site owner changing their encryption key must not silently unlock or
//    lock every supplier link at once.
//
// So: 32 random bytes, handed out ONCE in the link, and only its sha256 stored.
// A stolen backup, a leaked log line or a nosy admin sees hashes, and a hash
// opens nothing. What IS copied from print-token is the subject discipline - a
// token is scoped to one order and checked against the order being asked for, so
// a link for PO-00147 cannot be pointed at PO-00148.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'

/** 32 bytes. A base64url token of this length is not guessable, which is the
 *  whole security of a link somebody can email. */
const TOKEN_BYTES = 32

/** The query key the portal link carries. Short, because it is going into an
 *  email and then into somebody's address bar. */
export const PORTAL_TOKEN_QUERY_KEY = 'k'

export type MintedPortalToken = {
  /** Shown once, in the link. Never stored anywhere. */
  token: string
  /** What goes in po_portal_tokens.token_hash. */
  hash: string
}

/** A fresh supplier token and the hash to file against the order. */
export function mintPortalToken(): MintedPortalToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  return { token, hash: hashPortalToken(token) }
}

/** The stored form of a token. Plain sha256 and no salt on purpose: the input is
 *  32 random bytes, so there is no dictionary to defend against, and a keyed
 *  digest would tie every supplier's link to an encryption key the owner is
 *  allowed to rotate. */
export function hashPortalToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Whether a token from a URL is even the right shape to look up. Cheap, and it
 *  keeps obvious rubbish out of the database. */
export function looksLikePortalToken(token: string | null | undefined): token is string {
  if (!token) return false
  // 32 bytes of base64url is 43 characters. Anything else was not minted here.
  return /^[A-Za-z0-9_-]{43}$/.test(token)
}

/** Constant-time hash comparison, for the rare caller that has both in hand. The
 *  lookup itself is by unique index, which is not constant-time and does not need
 *  to be: it compares a hash of a secret, not the secret. */
export function samePortalHash(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a)
    const right = Buffer.from(b)
    if (left.length !== right.length) return false
    return timingSafeEqual(left, right)
  } catch {
    return false
  }
}

/** The supplier's link, site-relative. The same page an admin opens, with the
 *  supplier's own key on it rather than a print token. */
export function portalPath(orderNumber: string, token: string): string {
  return `/purchase-order/${encodeURIComponent(orderNumber)}?${PORTAL_TOKEN_QUERY_KEY}=${encodeURIComponent(token)}`
}

/**
 * A one-way stand-in for the caller's address, for the event log.
 *
 * Why not the address itself: a purchase order portal records what a named
 * supplier's staff did, and keeping their addresses turns an ordering log into a
 * record of people's movements for no purchasing benefit at all. The hash is
 * enough to say "these three came from the same place".
 *
 * Keyed with the site's encryption key so the hashes cannot be rebuilt from a
 * list of every IPv4 address, which a bare sha256 of an address absolutely can
 * be. No key, no hash - null is honest, a reversible digest is not.
 */
export function hashPortalIp(ip: string | null | undefined): string | null {
  const key = process.env.ENCRYPTION_KEY
  if (!key || !ip) return null
  return createHmac('sha256', key).update(`purchase-order-portal:${ip}`).digest('hex')
}
