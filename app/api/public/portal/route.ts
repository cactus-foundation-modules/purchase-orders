import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { getOrder } from '@/modules/purchase-orders/lib/db'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import { sendPortalReplyToBuyer } from '@/modules/purchase-orders/lib/email'
import { PortalActionBody } from '@/modules/purchase-orders/lib/portal-body'
import {
  acknowledgeFromPortal, listPortalEvents, portalNoticeRecipient, recordPortalEvent, resolvePortalToken,
} from '@/modules/purchase-orders/lib/portal'
import { hashPortalIp } from '@/modules/purchase-orders/lib/portal-token'
import { allowPortalWriteIp, allowPortalWriteToken, portalClientIp } from '@/modules/purchase-orders/lib/portal-rate-limit'
import { isPortalOpen, portalEventSummary, portalView } from '@/modules/purchase-orders/lib/portal-view'
import type { PoPortalEventKind } from '@/modules/purchase-orders/lib/portal-view'

// POST - the four things a supplier may say back through their own link.
//
// The only write endpoint on this platform that takes instructions from outside
// the building with no account behind them, so the shape of it matters:
//
//  - Every reply is a PROPOSAL. Accepting the order stamps it and nothing more;
//    a date or a shortage lands in po_portal_events for somebody here to apply.
//    Nothing a supplier types ever reaches a line, a price or a total.
//  - A token opens exactly one order, and the order is looked up FROM the token
//    rather than from anything the caller sends. There is no order id on the
//    wire to tamper with.
//  - Every failure is the same 404. Whether a link never existed, has been
//    revoked, has aged out, or the owner has switched the portal off is nobody
//    else's business.
export async function POST(request: NextRequest) {
  const ip = portalClientIp(request)
  // Before the token is even looked up, so a flood of made-up ones costs a map
  // lookup rather than a query each.
  if (!allowPortalWriteIp(ip)) {
    return errorResponse('That is a lot of messages at once. Give it a few minutes.', 429)
  }

  const parsed = PortalActionBody.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'We could not read that.')
  const body = parsed.data

  const config = await getPoConfigCached()
  if (!config.portalEnabled) return errorResponse('That link is not open any more.', 404)

  const token = await resolvePortalToken(body.token)
  if (!token) return errorResponse('That link is not open any more.', 404)
  if (!allowPortalWriteToken(token.hash)) {
    return errorResponse('That is a lot of messages at once. Give it a few minutes.', 429)
  }

  const order = await getOrder(token.orderId)
  if (!order) return errorResponse('That link is not open any more.', 404)
  if (!isPortalOpen(order.status)) {
    return errorResponse('This order is closed, so there is nothing left to tell us about it here.', 409)
  }

  const note = 'note' in body ? (body.note ?? '').trim() : ''
  let kind: PoPortalEventKind
  let payload: Record<string, unknown>

  switch (body.action) {
    case 'acknowledge': {
      kind = 'ACKNOWLEDGED'
      payload = { note }
      // The one write to the order itself, and it is guarded in SQL: two people
      // at the supplier pressing the button at the same moment cannot both move
      // the status.
      await acknowledgeFromPortal(order.id, note || null)
      break
    }
    case 'propose-date': {
      kind = 'DATE_PROPOSED'
      payload = { date: body.date, note }
      break
    }
    case 'shortage': {
      // Line ids are checked against THIS order's own lines, so a supplier
      // holding one link cannot file a shortage against a line belonging to
      // somebody else's order. The description is snapshotted alongside, so the
      // history still reads properly after an amendment rewrites the lines.
      const byId = new Map(order.lines.map((line) => [line.id, line]))
      const lines = body.lines
        .map((row) => {
          const line = byId.get(row.lineId)
          return line
            ? { lineId: line.id, description: line.description, supplierSku: line.supplierSku, qty: row.qty }
            : null
        })
        .filter((row): row is { lineId: string; description: string; supplierSku: string | null; qty: string } => row !== null)
      if (lines.length === 0) return errorResponse('Those lines are not on this order.')
      kind = 'SHORTAGE'
      payload = { lines, note }
      break
    }
    case 'message': {
      kind = 'MESSAGE'
      payload = { text: body.text.trim() }
      break
    }
  }

  await recordPortalEvent(token.id, order.id, kind, payload, hashPortalIp(ip))

  const summary = portalEventSummary(kind, payload)
  // Filed against the order rather than against a portal entity of its own: the
  // order is where anybody would look for it, and it is the only place the whole
  // story of this order is told in one column.
  await recordAudit('order', order.id, `order.portal-${kind.toLowerCase()}`, { note: summary, supplier: order.supplierName }, null)

  // Nobody sits watching an order screen. A proposal nobody reads is a proposal
  // nobody applies, so the buyer is told - best-effort, and the reply has landed
  // in the history whether the email sends or not.
  const to = await portalNoticeRecipient()
  if (to) await sendPortalReplyToBuyer(to, order.supplierName, order.number, summary)

  // Read back rather than patched together here, so what the supplier sees after
  // pressing the button is what the database now says.
  const [fresh, events] = await Promise.all([getOrder(order.id), listPortalEvents(order.id, 20)])
  return NextResponse.json({
    ok: true,
    view: portalView(
      fresh ?? order,
      events.map((event) => ({ id: event.id, kind: event.kind, createdAt: event.createdAt, summary: event.summary })),
    ),
  })
}
