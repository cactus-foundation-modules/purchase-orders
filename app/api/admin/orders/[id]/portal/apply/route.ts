import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getOrder } from '@/modules/purchase-orders/lib/db'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import { applyProposedExpectedDate, listPortalEvents } from '@/modules/purchase-orders/lib/portal'
import { parsePortalDate } from '@/modules/purchase-orders/lib/portal-view'

type Params = { params: Promise<{ id: string }> }

const Body = z.object({ eventId: z.string().min(1) })

// POST - takes the supplier up on the date they offered.
//
// The one place a portal proposal ever reaches the order, and a person here
// presses it. The date is read off the stored event rather than taken from the
// request, so what gets applied is what the supplier actually said and not what
// somebody typed into a console afterwards.
//
// A shortage deliberately has no button. Cutting a line down is an amendment -
// the supplier is holding a copy of the old one and is owed the new one - so it
// goes through the amendment flow, or through "give up on the rest" where that
// is what it really is. A one-click "apply" that quietly rewrote the order they
// hold would be the worst of both.
export async function POST(request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const order = await getOrder(id)
  if (!order) return errorResponse('That purchase order is not here any more.', 404)

  // Scoped to this order's own events, so an event id from another order cannot
  // move this one's dates.
  const events = await listPortalEvents(id, 200)
  const event = events.find((row) => row.id === parsed.data.eventId)
  if (!event || event.kind !== 'DATE_PROPOSED') return errorResponse('That is not a date the supplier offered.', 404)

  const date = parsePortalDate(event.payload.date)
  if (!date) return errorResponse('That is not a date the supplier offered.', 409)

  await applyProposedExpectedDate(id, date)
  await recordAudit(
    'order',
    id,
    'order.portal-date-applied',
    { note: `Expected date moved to ${date}`, was: order.expectedDate, eventId: event.id },
    user.id,
  )
  return NextResponse.json({ ok: true, expectedDate: date })
}
