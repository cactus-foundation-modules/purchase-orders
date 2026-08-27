// PROTECTED - the credential that lets the printing browser open a purchase
// order's own page.
//
// A purchase order is not an invoice. A shop invoice is signed with a token that
// never expires, because a customer files it and comes back to it years later.
// Nobody outside the business ever needs to open a purchase order by URL: it is
// what the business is paying, at the prices it negotiated, and the numbers run
// in sequence so the number itself is no lock at all.
//
// So the token here is SHORT-LIVED and exists for one reason: `renderPoPdf`
// prints by fetching the document's own page over HTTP from the site's public
// address, and that request carries no session cookie. Something has to open the
// door for it, for as long as the print takes and no longer.
//
// The page ALSO opens for a signed-in user holding purchase-orders.access, which
// is what makes "View document" in the admin work after the token behind it has
// aged out. Neither path is the supplier's: the supplier portal (a later
// release) mints its own token, scoped to one order, stored as a hash and
// revocable, and grants read through po_portal_tokens rather than through here.
import { createHmac, timingSafeEqual } from 'crypto'

/** Long enough for a slow print on a cold serverless instance, short enough that
 *  a link pasted into a chat has stopped working by the time anybody clicks it. */
export const PRINT_TOKEN_TTL_MINUTES = 30

function getKey(): string {
  const key = process.env.ENCRYPTION_KEY
  if (!key) throw new Error('ENCRYPTION_KEY is not set - required for purchase order document links.')
  return key
}

function digest(orderNumber: string, expiresAtMinute: number): string {
  return createHmac('sha256', getKey())
    .update(`purchase-order:${orderNumber}:${expiresAtMinute}`)
    .digest('base64url')
}

/**
 * A token for one order, good for `PRINT_TOKEN_TTL_MINUTES`.
 *
 * The expiry is carried in the token rather than stored, so there is no table to
 * sweep and no row to leak. It is inside the HMAC, so it cannot be moved.
 */
export function signPoPrintToken(orderNumber: string, ttlMinutes = PRINT_TOKEN_TTL_MINUTES): string {
  const expiresAtMinute = Math.floor(Date.now() / 60_000) + Math.max(1, Math.trunc(ttlMinutes))
  return `${expiresAtMinute}.${digest(orderNumber, expiresAtMinute)}`
}

/** Whether this token was issued for this order and has not aged out.
 *  Constant-time, and false for anything malformed rather than throwing - a bad
 *  link is a 404, not a 500. */
export function verifyPoPrintToken(orderNumber: string, token: string | null | undefined): boolean {
  if (!orderNumber || !token) return false
  const dot = token.indexOf('.')
  if (dot < 1) return false
  const expiresAtMinute = Number(token.slice(0, dot))
  if (!Number.isSafeInteger(expiresAtMinute)) return false
  // Checked BEFORE the comparison, so an expired token costs no HMAC at all.
  if (expiresAtMinute < Math.floor(Date.now() / 60_000)) return false
  try {
    const a = Buffer.from(token.slice(dot + 1))
    const b = Buffer.from(digest(orderNumber, expiresAtMinute))
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** The site-relative address of one order's document page, with no token on it.
 *  `printPath` from core adds the token, the print flag and its cache-busting
 *  nonce; a link for a human gets one from `poDocumentPath` below. */
export function poDocumentBasePath(orderNumber: string): string {
  return `/purchase-order/${encodeURIComponent(orderNumber)}`
}

/** The same, for somebody to click. */
export function poDocumentPath(orderNumber: string): string {
  return `${poDocumentBasePath(orderNumber)}?t=${signPoPrintToken(orderNumber)}`
}
