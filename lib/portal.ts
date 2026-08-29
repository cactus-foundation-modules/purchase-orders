import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getSiteUrl } from '@/lib/config/env'
import { getPoConfigCached } from './config'
import { shopTradingIdentity } from './db'
import { hashPortalToken, looksLikePortalToken, mintPortalToken, portalPath } from './portal-token'
import {
  portalEventSummary,
  type PoPortalEvent,
  type PoPortalEventKind,
  type PoPortalOursEvent,
  type PoPortalTokenSummary,
} from './portal-view'

// The supplier portal's own table work: the tokens that open one order, and the
// things a supplier says back through it.
//
// Raw SQL like the rest of this module, and every write here is deliberately
// narrow. The portal may create a token row, count a use, file an event and stamp
// an acknowledgement. It may not touch an order's lines, its totals, its prices
// or its status beyond that one stamp - a supplier proposing a date is a proposal
// in po_portal_events for somebody here to apply, never an edit to the order they
// were sent.

function stamp(value: unknown): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * A new link for one order.
 *
 * The raw token is returned to the caller ONCE and never stored: what lands in
 * the table is its sha256. So a link cannot be recovered from the site later,
 * only replaced - which is the same promise every password field on the platform
 * makes, and for the same reason.
 */
export async function createPortalToken(
  orderId: string,
  lifetimeDays: number,
  userId: string | null,
): Promise<{ id: string; token: string; expiresAt: string }> {
  const { token, hash } = mintPortalToken()
  const days = Math.max(1, Math.min(365, Math.trunc(lifetimeDays)))
  const rows = await prisma.$queryRaw<{ id: string; expires_at: Date }[]>`
    INSERT INTO "po_portal_tokens" ("order_id", "token_hash", "expires_at", "created_by_user_id")
    VALUES (${orderId}, ${hash}, now() + ${Prisma.raw(`interval '${days} days'`)}, ${userId})
    RETURNING "id", "expires_at"
  `
  const row = rows[0]!
  return { id: row.id, token, expiresAt: stamp(row.expires_at) ?? '' }
}

/** Every link ever made for this order, newest first. Never the hash: there is
 *  no screen anywhere that has any business showing it. */
export async function listPortalTokens(orderId: string): Promise<PoPortalTokenSummary[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT t."id", t."created_at", t."expires_at", t."revoked_at", t."last_used_at", t."use_count",
           COALESCE(u."displayName", u."username") AS "created_by_name",
           (t."revoked_at" IS NULL AND t."expires_at" > now()) AS "live"
      FROM "po_portal_tokens" t
      LEFT JOIN "User" u ON u."id" = t."created_by_user_id"
     WHERE t."order_id" = ${orderId}
     ORDER BY t."created_at" DESC
  `
  return rows.map((r) => ({
    id: r.id as string,
    createdAt: stamp(r.created_at) ?? '',
    expiresAt: stamp(r.expires_at) ?? '',
    revokedAt: stamp(r.revoked_at),
    lastUsedAt: stamp(r.last_used_at),
    useCount: Number(r.use_count ?? 0),
    createdByName: (r.created_by_name as string | null) ?? null,
    live: Boolean(r.live),
  }))
}

/** Takes one link back. Scoped to the order as well as the token, so a token id
 *  copied from one order's screen cannot revoke another's. */
export async function revokePortalToken(orderId: string, tokenId: string): Promise<boolean> {
  const count = await prisma.$executeRaw`
    UPDATE "po_portal_tokens"
       SET "revoked_at" = now()
     WHERE "id" = ${tokenId} AND "order_id" = ${orderId} AND "revoked_at" IS NULL
  `
  return count > 0
}

/** Takes every live link for an order back at once, for the "stop them all"
 *  button. Returns how many were actually open. */
export async function revokeAllPortalTokens(orderId: string): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "po_portal_tokens"
       SET "revoked_at" = now()
     WHERE "order_id" = ${orderId} AND "revoked_at" IS NULL
  `
}

export type ResolvedPortalToken = { id: string; orderId: string; hash: string }

/**
 * The order a raw token opens, or null.
 *
 * Null for a token that never existed, one that has been revoked and one that
 * has aged out alike. The caller turns all three into the same 404: telling a
 * supplier which of the three it was tells anybody holding a stale link rather
 * more than they need to know.
 */
export async function resolvePortalToken(raw: string | null | undefined): Promise<ResolvedPortalToken | null> {
  if (!looksLikePortalToken(raw)) return null
  const hash = hashPortalToken(raw)
  const rows = await prisma.$queryRaw<{ id: string; order_id: string }[]>`
    SELECT "id", "order_id"
      FROM "po_portal_tokens"
     WHERE "token_hash" = ${hash} AND "revoked_at" IS NULL AND "expires_at" > now()
     LIMIT 1
  `
  const row = rows[0]
  return row ? { id: row.id, orderId: row.order_id, hash } : null
}

/** Counts an opening. Never throws into the page: a supplier reading their order
 *  must not get an error because the counter would not write. */
export async function touchPortalToken(tokenId: string): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE "po_portal_tokens"
         SET "last_used_at" = now(), "use_count" = "use_count" + 1
       WHERE "id" = ${tokenId}
    `
  } catch (error) {
    console.error('[purchase-orders] could not count a portal visit', { tokenId, error })
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type PoPortalEventRow = PoPortalEvent & {
  tokenId: string
  payload: Record<string, unknown>
}

/** Files what the supplier said. A proposal, never a change. */
export async function recordPortalEvent(
  tokenId: string,
  orderId: string,
  kind: PoPortalEventKind,
  payload: Record<string, unknown>,
  ipHash: string | null,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "po_portal_events" ("token_id", "order_id", "kind", "payload", "ip_hash")
    VALUES (${tokenId}, ${orderId}, ${kind}, ${JSON.stringify(payload)}::jsonb, ${ipHash})
  `
}

/** What the supplier has said about this order, newest first. */
export async function listPortalEvents(orderId: string, limit = 50): Promise<PoPortalEventRow[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "token_id", "kind", "payload", "created_at"
      FROM "po_portal_events"
     WHERE "order_id" = ${orderId}
     ORDER BY "created_at" DESC
     LIMIT ${Prisma.raw(String(Math.max(1, Math.min(200, Math.trunc(limit)))))}
  `
  return rows.map((r) => {
    const kind = r.kind as PoPortalEventKind
    const payload = (r.payload as Record<string, unknown> | null) ?? {}
    return {
      id: r.id as string,
      tokenId: r.token_id as string,
      kind,
      payload,
      createdAt: stamp(r.created_at) ?? '',
      summary: portalEventSummary(kind, payload),
    }
  })
}

/**
 * Our side of the history: what we sent them and what we booked in.
 *
 * An ALLOW-LIST of audit actions, and not one word of the audit detail. The log
 * holds who approved what, at what level, against which internal note - the
 * whole reason it exists - and none of that is the supplier's. What comes back
 * is a sentence built here from the two facts a supplier needs: what we did and
 * when. Everything else on our side of the story is worked out from the order
 * row itself, in portalView.
 */
const SUPPLIER_VISIBLE_ACTIONS = ['order.sent', 'order.amendment-sent', 'order.chased'] as const

export async function listOursPortalEvents(orderId: string, limit = 30): Promise<PoPortalOursEvent[]> {
  const cap = Math.max(1, Math.min(100, Math.trunc(limit)))
  const [sent, receipts] = await Promise.all([
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "action", "detail", "created_at"
        FROM "po_audit_log"
       WHERE "entity_type" = 'order' AND "entity_id" = ${orderId}
         AND "action" = ANY(${[...SUPPLIER_VISIBLE_ACTIONS]}::text[])
       ORDER BY "created_at" DESC
       LIMIT ${Prisma.raw(String(cap))}
    `,
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT r."id", r."number", r."received_date", r."created_at",
             (SELECT count(*) FROM "po_receipt_lines" rl WHERE rl."receipt_id" = r."id") AS "line_count"
        FROM "po_receipts" r
       WHERE r."order_id" = ${orderId}
       ORDER BY r."received_date" DESC, r."created_at" DESC
       LIMIT ${Prisma.raw(String(cap))}
    `,
  ])

  const out: PoPortalOursEvent[] = sent.map((row) => {
    const action = row.action as string
    const detail = (row.detail as Record<string, unknown> | null) ?? {}
    const revision = Number(detail.revision ?? 0)
    const at = stamp(row.created_at) ?? ''
    if (action === 'order.chased') {
      return {
        id: row.id as string,
        kind: 'CHASED' as const,
        createdAt: at,
        summary: 'We sent you a reminder about this order.',
      }
    }
    if (action === 'order.amendment-sent') {
      return {
        id: row.id as string,
        kind: 'AMENDMENT_SENT' as const,
        createdAt: at,
        summary: revision > 0 ? `We sent you revision ${revision} of the order.` : 'We sent you a changed order.',
      }
    }
    return {
      id: row.id as string,
      kind: 'ORDER_SENT' as const,
      createdAt: at,
      summary: 'We sent you this order.',
    }
  })

  for (const row of receipts) {
    const lines = Number(row.line_count ?? 0)
    const day = row.received_date ? String(stamp(row.received_date) ?? '').slice(0, 10) : ''
    const number = (row.number as string | null) ?? ''
    out.push({
      id: row.id as string,
      kind: 'GOODS_RECEIVED',
      // The date it turned up, not the date somebody got round to typing it in:
      // a delivery booked in on the Monday for the Friday reads as the Friday.
      createdAt: stamp(row.received_date) ?? stamp(row.created_at) ?? '',
      summary: `We booked in your delivery${number ? ` as ${number}` : ''}${day ? ` on ${day}` : ''}${
        lines > 0 ? `, ${lines} ${lines === 1 ? 'line' : 'lines'}` : ''
      }.`,
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// The two writes the portal is allowed to make to the order itself
// ---------------------------------------------------------------------------

/**
 * The supplier accepting the order.
 *
 * Guarded in SQL rather than read-then-write, so two people at the supplier
 * pressing the button at once cannot both move the status. SENT is the only
 * status that moves; an order already acknowledged, part received or on hold
 * keeps the status it has and simply gains the stamp if it had none.
 *
 * `updated_by_user_id` is deliberately left alone. A supplier is not a user of
 * this site, and writing an id there that belongs to whoever last touched the
 * order would put their name against somebody else's action.
 */
export async function acknowledgeFromPortal(orderId: string, note: string | null): Promise<boolean> {
  const count = await prisma.$executeRaw`
    UPDATE "po_orders"
       SET "status" = CASE WHEN "status" = 'SENT' THEN 'ACKNOWLEDGED' ELSE "status" END,
           "acknowledged_at" = COALESCE("acknowledged_at", now()),
           "acknowledged_note" = COALESCE(NULLIF(${note ?? ''}, ''), "acknowledged_note"),
           "updated_at" = now()
     WHERE "id" = ${orderId}
       AND "status" IN ('SENT','ACKNOWLEDGED','PART_RECEIVED','ON_HOLD')
  `
  return count > 0
}

/**
 * Somebody here taking the supplier up on the date they offered for the WHOLE
 * order.
 *
 * The one place a portal proposal ever reaches the order, and it is pressed by a
 * person in the admin rather than by the supplier. Only the whole order's
 * expected date moves; the lines keep their own dates, because a supplier saying
 * "the lot will be a fortnight" is not the same as them re-dating each line and
 * guessing would be worse than leaving them.
 *
 * Still here because events filed before per-line dates existed carry exactly
 * this shape, and a history that stops being applicable is not much of a history.
 */
export async function applyProposedExpectedDate(orderId: string, date: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_orders" SET "expected_date" = ${date}::date, "updated_at" = now() WHERE "id" = ${orderId}
  `
}

/**
 * The same, per line - which is what a supplier who ships an order in three
 * drops actually answers with.
 *
 * Each line's own expected date moves, and the ORDER's moves to the last of
 * them: "when will this order be here" has one honest answer and it is the day
 * the last of it turns up. Scoped to the order in the WHERE clause, so a line id
 * belonging to somebody else's order cannot be re-dated through this.
 *
 * Returns how many lines actually moved, which is what the caller reports and
 * logs - a proposal against a line since amended away moves nothing, and saying
 * "done" would be a lie.
 */
export async function applyProposedLineDates(
  orderId: string,
  lines: { lineId: string; date: string }[],
): Promise<number> {
  let moved = 0
  for (const line of lines) {
    const count = await prisma.$executeRaw`
      UPDATE "po_order_lines"
         SET "expected_date" = ${line.date}::date, "updated_at" = now()
       WHERE "id" = ${line.lineId} AND "order_id" = ${orderId}
    `
    moved += count
  }
  if (moved === 0) return 0

  // The order's own date follows the LAST line, and only ever forwards: an
  // order is here when the last of it is here, and a second proposal about one
  // early line must not drag the whole order's date back in front of a later one
  // somebody already accepted.
  await prisma.$executeRaw`
    UPDATE "po_orders" o
       SET "expected_date" = GREATEST(
             COALESCE(o."expected_date", '-infinity'::date),
             (SELECT MAX(l."expected_date") FROM "po_order_lines" l WHERE l."order_id" = o."id")
           ),
           "updated_at" = now()
     WHERE o."id" = ${orderId}
       AND EXISTS (SELECT 1 FROM "po_order_lines" l WHERE l."order_id" = o."id" AND l."expected_date" IS NOT NULL)
  `
  return moved
}

/**
 * A fresh link for the order's own email, or null where the owner has the
 * supplier link switched off.
 *
 * Minted per send rather than reused, because the raw token is never stored and
 * therefore cannot be recovered to put in a second email. The cost is a row per
 * send, all of them listed on the order screen and revocable there; the
 * alternative would be keeping the secret in a readable column, which is the one
 * thing this design will not do.
 */
export async function mintPortalLink(
  orderId: string,
  orderNumber: string,
  userId: string | null,
): Promise<string | null> {
  const config = await getPoConfigCached()
  if (!config.portalEnabled) return null
  const { token } = await createPortalToken(orderId, config.portalTokenLifetimeDays, userId)
  return `${getSiteUrl()}${portalPath(orderNumber, token)}`
}

/**
 * Where a supplier's reply should land in this building.
 *
 * This module's own purchasing email first, then the shop's invoice contact and
 * its store address where a shop is installed - the same fallback ladder the
 * document's buyer block climbs, and read by raw SQL for the same reason.
 * Blank means nobody gets told, which is honest: an address nobody has filled in
 * is not one to guess at.
 */
export async function portalNoticeRecipient(): Promise<string> {
  const config = await getPoConfigCached()
  const mine = config.organisation.email.trim()
  if (mine.includes('@')) return mine
  const shop = await shopTradingIdentity()
  for (const key of ['invoiceContactEmail', 'storeEmail'] as const) {
    const value = (shop?.[key] ?? '').trim()
    if (value.includes('@')) return value
  }
  return ''
}
