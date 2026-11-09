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
import { createHmac } from 'crypto'
import { signingKey, verifyWithAnyKey } from '@/lib/crypto/keyring'

/** Long enough for a slow print on a cold serverless instance, short enough that
 *  a link pasted into a chat has stopped working by the time anybody clicks it. */
export const PRINT_TOKEN_TTL_MINUTES = 30

// Signed with the site's active key; checked against every key it has had, so a
// link made just before a key rotation still opens (core's lib/crypto/keyring.ts).
function getKey(): string {
  return signingKey('purchase order document links')
}

function digest(orderNumber: string, expiresAtMinute: number, key: string = getKey()): string {
  return createHmac('sha256', key)
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
  return verifyWithAnyKey(token.slice(dot + 1), (key) => digest(orderNumber, expiresAtMinute, key))
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

// ---------------------------------------------------------------------------
// Drawing an order as approved by the send that is printing it
// ---------------------------------------------------------------------------
//
// Sending an order nobody approved is what approves it, but the approval is only
// written once the email has gone - and the PDF attached to that email is printed
// before then, by a browser fetching the page above. Without this the supplier's
// first copy goes out with nobody under "Authorised by", and an "email it again"
// a day later sends a different-looking sheet for the same order.
//
// So the send hands the printing browser one more parameter: who is approving,
// signed under its own subject string with the order number inside it. Nobody can
// put a name of their choosing on a page by editing a URL, and a value minted for
// one order means nothing on another. The page still ignores it on an order that
// already has an approver.

/** Who is approving by sending: a user's id, or the automatic job. */
export type PoPrintApproving = { userId: string } | { automatic: true }

const AUTO_APPROVER = 'auto'

function approvingDigest(orderNumber: string, who: string, expiresAtMinute: number, key: string = getKey()): string {
  return createHmac('sha256', key)
    .update(`purchase-order-approving:${orderNumber}:${who}:${expiresAtMinute}`)
    .digest('base64url')
}

/** The `a` parameter for one order's print, good for `PRINT_TOKEN_TTL_MINUTES`. */
export function signPoApprovingParam(orderNumber: string, approving: PoPrintApproving, ttlMinutes = PRINT_TOKEN_TTL_MINUTES): string {
  const who = 'userId' in approving ? approving.userId : AUTO_APPROVER
  const expiresAtMinute = Math.floor(Date.now() / 60_000) + Math.max(1, Math.trunc(ttlMinutes))
  return `${expiresAtMinute}.${who}.${approvingDigest(orderNumber, who, expiresAtMinute)}`
}

/** The approver an `a` parameter names, or null for anything forged, aged out,
 *  minted for another order, or malformed. Never throws. */
export function verifyPoApprovingParam(orderNumber: string, value: string | null | undefined): PoPrintApproving | null {
  if (!orderNumber || !value) return null
  const first = value.indexOf('.')
  const last = value.lastIndexOf('.')
  if (first < 1 || last <= first + 1) return null
  const expiresAtMinute = Number(value.slice(0, first))
  if (!Number.isSafeInteger(expiresAtMinute)) return null
  if (expiresAtMinute < Math.floor(Date.now() / 60_000)) return null
  const who = value.slice(first + 1, last)
  if (!verifyWithAnyKey(value.slice(last + 1), (key) => approvingDigest(orderNumber, who, expiresAtMinute, key))) return null
  return who === AUTO_APPROVER ? { automatic: true } : { userId: who }
}

// ---------------------------------------------------------------------------
// Returns notes
// ---------------------------------------------------------------------------
//
// The same door, a different key. A returns note is signed under its own subject
// string, so a token minted for order PO-00147 cannot open return SRN-00014 even
// if somebody works out that both are numbers in a URL.

function returnDigest(returnNumber: string, expiresAtMinute: number, key: string = getKey()): string {
  return createHmac('sha256', key)
    .update(`purchase-return:${returnNumber}:${expiresAtMinute}`)
    .digest('base64url')
}

/** A token for one returns note, good for `PRINT_TOKEN_TTL_MINUTES`. */
export function signPoReturnPrintToken(returnNumber: string, ttlMinutes = PRINT_TOKEN_TTL_MINUTES): string {
  const expiresAtMinute = Math.floor(Date.now() / 60_000) + Math.max(1, Math.trunc(ttlMinutes))
  return `${expiresAtMinute}.${returnDigest(returnNumber, expiresAtMinute)}`
}

/** Whether this token was issued for this returns note and has not aged out.
 *  Constant-time, and false for anything malformed rather than throwing. */
export function verifyPoReturnPrintToken(returnNumber: string, token: string | null | undefined): boolean {
  if (!returnNumber || !token) return false
  const dot = token.indexOf('.')
  if (dot < 1) return false
  const expiresAtMinute = Number(token.slice(0, dot))
  if (!Number.isSafeInteger(expiresAtMinute)) return false
  if (expiresAtMinute < Math.floor(Date.now() / 60_000)) return false
  return verifyWithAnyKey(token.slice(dot + 1), (key) => returnDigest(returnNumber, expiresAtMinute, key))
}

/** The site-relative address of one returns note's document page, with no token
 *  on it. Nested under the module's own public base rather than claiming a second
 *  one - a module gets exactly one. */
export function poReturnDocumentBasePath(returnNumber: string): string {
  return `/purchase-order/returns/${encodeURIComponent(returnNumber)}`
}

/** The same, for somebody to click. */
export function poReturnDocumentPath(returnNumber: string): string {
  return `${poReturnDocumentBasePath(returnNumber)}?t=${signPoReturnPrintToken(returnNumber)}`
}

// ---------------------------------------------------------------------------
// Packing slips
// ---------------------------------------------------------------------------
//
// A third key on the same door, under its own subject string, so a token minted
// for order PO-00147 cannot open packing slip DSP-00003 and neither can one
// minted for a returns note.
//
// This one is opened by a supplier as well as by the printing browser: it is the
// slip they put in the box. They reach it through their own portal token rather
// than through this, exactly as they reach the order - see the packing slip's
// own page.

function packingDigest(shipmentNumber: string, expiresAtMinute: number, key: string = getKey()): string {
  return createHmac('sha256', key)
    .update(`purchase-packing-slip:${shipmentNumber}:${expiresAtMinute}`)
    .digest('base64url')
}

/** A token for one packing slip, good for `PRINT_TOKEN_TTL_MINUTES`. */
export function signPoPackingSlipToken(shipmentNumber: string, ttlMinutes = PRINT_TOKEN_TTL_MINUTES): string {
  const expiresAtMinute = Math.floor(Date.now() / 60_000) + Math.max(1, Math.trunc(ttlMinutes))
  return `${expiresAtMinute}.${packingDigest(shipmentNumber, expiresAtMinute)}`
}

/** Whether this token was issued for this packing slip and has not aged out.
 *  Constant-time, and false for anything malformed rather than throwing. */
export function verifyPoPackingSlipToken(shipmentNumber: string, token: string | null | undefined): boolean {
  if (!shipmentNumber || !token) return false
  const dot = token.indexOf('.')
  if (dot < 1) return false
  const expiresAtMinute = Number(token.slice(0, dot))
  if (!Number.isSafeInteger(expiresAtMinute)) return false
  if (expiresAtMinute < Math.floor(Date.now() / 60_000)) return false
  return verifyWithAnyKey(token.slice(dot + 1), (key) => packingDigest(shipmentNumber, expiresAtMinute, key))
}

/** The site-relative address of one packing slip's page, with no token on it.
 *  Nested under the module's own public base, two segments deep, so it can never
 *  collide with the order's own /purchase-order/<number>. */
export function poPackingSlipBasePath(shipmentNumber: string): string {
  return `/purchase-order/packing-slip/${encodeURIComponent(shipmentNumber)}`
}

/** The same, for somebody to click. */
export function poPackingSlipPath(shipmentNumber: string): string {
  return `${poPackingSlipBasePath(shipmentNumber)}?t=${signPoPackingSlipToken(shipmentNumber)}`
}
