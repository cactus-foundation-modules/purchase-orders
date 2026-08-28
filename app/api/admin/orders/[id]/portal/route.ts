import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { getSiteUrl } from '@/lib/config/env'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getOrder } from '@/modules/purchase-orders/lib/db'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import { createPortalToken, listPortalEvents, listPortalTokens, revokeAllPortalTokens } from '@/modules/purchase-orders/lib/portal'
import { portalPath } from '@/modules/purchase-orders/lib/portal-token'
import { parsePortalDate, proposedLinesFrom } from '@/modules/purchase-orders/lib/portal-view'

type Params = { params: Promise<{ id: string }> }

// The supplier link, from this side of it: what links exist, what the supplier
// has said through them, making another one, and stopping the lot.
//
// The raw link is returned by POST and never again. Only its hash is stored, so
// there is nothing here that can hand back yesterday's link - which is the whole
// point of storing a hash, and worth the small inconvenience of making a new one
// when somebody loses the email.

export async function GET(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const [config, tokens, events] = await Promise.all([
    getPoConfigCached(),
    listPortalTokens(id),
    listPortalEvents(id),
  ])

  return NextResponse.json({
    enabled: config.portalEnabled,
    lifetimeDays: config.portalTokenLifetimeDays,
    tokens,
    // The payload itself stays here. What the screen needs off it is the dates
    // somebody might press a button to accept, and those are worth naming rather
    // than handing over a jsonb blob for a component to rummage through.
    //
    // Both shapes, because both exist: a supplier who ships an order in three
    // drops answers per line, and everything filed before per-line dates arrived
    // carries one date for the whole order.
    events: events.map((event) => ({
      id: event.id,
      kind: event.kind,
      createdAt: event.createdAt,
      summary: event.summary,
      proposedDate: event.kind === 'DATE_PROPOSED' ? parsePortalDate(event.payload.date) : null,
      proposedLines: event.kind === 'DATE_PROPOSED' ? proposedLinesFrom(event.payload) : [],
    })),
  })
}

export async function POST(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const { id } = await params
  const order = await getOrder(id)
  if (!order) return errorResponse('That purchase order is not here any more.', 404)

  const config = await getPoConfigCached()
  if (!config.portalEnabled) {
    return errorResponse('The supplier link is switched off in your purchasing settings.', 409)
  }
  // Only an order that has actually gone out. A link to a draft would be a link
  // to prices nobody has agreed yet, sent to somebody who was never told about
  // the order in the first place.
  if (!order.sentAt) {
    return errorResponse('Send this order to the supplier first, and the link goes with it.', 409)
  }

  const { id: tokenId, token, expiresAt } = await createPortalToken(id, config.portalTokenLifetimeDays, user.id)
  await recordAudit('order', id, 'order.portal-link-made', { tokenId, expiresAt }, user.id)

  return NextResponse.json({ ok: true, url: `${getSiteUrl()}${portalPath(order.number, token)}`, expiresAt })
}

/** Stops every link for this order at once, for the day somebody forwards one to
 *  the wrong supplier. */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const { id } = await params
  const revoked = await revokeAllPortalTokens(id)
  if (revoked > 0) await recordAudit('order', id, 'order.portal-links-revoked', { count: revoked }, user.id)
  return NextResponse.json({ ok: true, revoked })
}
