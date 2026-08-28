import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { bumpOrderRevision, deleteOrder, getOrder, listOrderRevisions, updateOrder } from '@/modules/purchase-orders/lib/db'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { editMode, needsApproval } from '@/modules/purchase-orders/lib/lifecycle'
import { orderRevisionSnapshot } from '@/modules/purchase-orders/lib/document'
import { orderTotals } from '@/modules/purchase-orders/lib/totals'
import { OrderBody, toOrderInput } from '@/modules/purchase-orders/lib/order-body'
import { listAudit, recordAudit } from '@/modules/purchase-orders/lib/audit'
import { mediaLink } from '@/modules/purchase-orders/lib/proforma'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const order = await getOrder(id)
  if (!order) return errorResponse('That purchase order is not here any more.', 404)

  // The two documents the supplier sends us, resolved to something clickable.
  // The order row carries a Media id and nothing else - core owns that table -
  // so the link is looked up here rather than being a column somebody could let
  // drift out of step with the library.
  const [history, revisions, proforma, acknowledgement] = await Promise.all([
    listAudit('order', id),
    listOrderRevisions(id),
    mediaLink(order.proformaMediaId),
    mediaLink(order.ackMediaId),
  ])
  return NextResponse.json({ order, history, revisions, documents: { proforma, acknowledgement } })
}

export async function PUT(request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const { id } = await params
  const existing = await getOrder(id)
  if (!existing) return errorResponse('That purchase order is not here any more.', 404)

  // Two kinds of edit, and which one this is depends entirely on whether the
  // supplier is holding a copy.
  //
  //  free    a draft. Saved over, nothing filed, nobody told.
  //  amend   an order already out. The version they hold is filed as a revision
  //          first, the live one moves to Rev N + 1, and the screen offers to
  //          send them the replacement.
  //  refused cancelled, closed or fully received. There is nothing left to amend;
  //          raise a fresh order.
  const mode = editMode(existing.status)
  if (mode === 'refused') {
    return errorResponse(
      `An order that is ${existing.status.toLowerCase().replace(/_/g, ' ')} cannot be edited. Raise a fresh one instead.`,
      409,
    )
  }

  const parsed = OrderBody.safeParse(await request.json())
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const reason = (parsed.data.amendmentReason ?? '').trim()
  // Asked for rather than optional. An amendment is a document going back out to
  // somebody who acted on the last one, and "what changed" is the first thing
  // they will ask - and the first thing anybody reading the trail in a year's
  // time will want.
  if (mode === 'amend' && !reason) {
    return errorResponse('This order has already gone to the supplier. Say what has changed and it will be filed as a new revision.')
  }

  // An amendment replaces every line wholesale (see updateOrder), which is only
  // safe while nothing else points at them. `po_receipt_lines.order_line_id` is
  // ON DELETE RESTRICT, so a line with a delivery, a bill or a return against it
  // would fail at the database with a message nobody outside this file could act
  // on. Refused here instead, in words that say what to do.
  //
  // Nothing can trip this today - receiving, bills and returns all arrive in
  // later releases and no child row can exist yet - but the check costs a loop
  // over lines already in hand, and the alternative is a 500 on somebody's live
  // order the week receiving ships.
  const settled = existing.lines.filter(
    (line) => Number(line.qtyReceived) > 0 || Number(line.qtyInvoiced) > 0 || Number(line.qtyReturned) > 0,
  )
  if (mode === 'amend' && settled.length > 0) {
    return errorResponse(
      'Some of this order has already been delivered or invoiced, so its lines cannot be rewritten. Close it and raise a fresh order for the difference.',
      409,
    )
  }

  const input = toOrderInput(parsed.data)
  const config = await getPoConfigCached()
  const totals = orderTotals({
    lines: input.lines,
    taxMode: input.taxMode,
    discountAmount: input.discountAmount,
    carriageAmount: input.carriageAmount,
  })

  // The revision is filed BEFORE the write, from the copy already in hand, so a
  // failure between the two leaves the order unchanged rather than changed with
  // no record of what it used to say. The unique index on (order_id, revision) is
  // what stops two people amending at once and both writing revision 2.
  let revision = existing.revision
  if (mode === 'amend') {
    revision = await bumpOrderRevision(id, orderRevisionSnapshot(existing), reason, user.id)
  }

  await updateOrder(id, input, totals, needsApproval(totals.total, config), user.id)
  await recordAudit(
    'order',
    id,
    mode === 'amend' ? 'order.amended' : 'order.updated',
    {
      total: totals.total,
      previousTotal: existing.total,
      lines: input.lines.length,
      ...(mode === 'amend' ? { revision, note: reason } : {}),
    },
    user.id,
  )
  return NextResponse.json({ ok: true, revision, amended: mode === 'amend' })
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const { id } = await params
  const existing = await getOrder(id)
  if (!existing) return errorResponse('That purchase order is not here any more.', 404)

  // Only a draft can be deleted outright. Anything that has been out into the
  // world gets cancelled instead, so the number and the trail survive.
  if (existing.status !== 'DRAFT') {
    return errorResponse('Only a draft can be deleted. Cancel this one instead.', 409)
  }

  await deleteOrder(id)
  await recordAudit('order', id, 'order.deleted', { number: existing.number }, user.id)
  return NextResponse.json({ ok: true })
}
