import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getOrder } from '@/modules/purchase-orders/lib/db'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import { generateShipmentNumber } from '@/modules/purchase-orders/lib/numbering'
import { isReceivable } from '@/modules/purchase-orders/lib/receiving'
import { createShipment, despatchableLines, listShipmentsForOrder } from '@/modules/purchase-orders/lib/shipments'
import { ShipmentBody, shipmentHeaderFrom, shipmentLinesFrom } from '@/modules/purchase-orders/lib/shipment-body'

type Params = { params: Promise<{ id: string }> }

/**
 * Who may file a despatch by hand.
 *
 * Both desks, because on a small site they are one person and on a large one it
 * could be either: the buyer reads the supplier's "your pallet left today" email,
 * and goods-in is who cares that it is coming. It is a note about goods
 * arriving, not a change to what was ordered, so it needs neither `create` alone
 * nor a permission of its own.
 */
function mayDespatch(access: { canReceive: boolean; canCreate: boolean }): boolean {
  return access.canReceive || access.canCreate
}

// GET - what the supplier says they have sent against this order, drop by drop.
//
// Its own request rather than riding on the order's, exactly as deliveries and
// invoices do: most orders arrive in one go and never have a despatch filed
// against them at all, so the join would be earning its keep on a minority of
// order screens.
export async function GET(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const [shipments, outstanding] = await Promise.all([listShipmentsForOrder(id), despatchableLines(id)])
  // What is left to send goes down with the list, so the form beside it is drawn
  // from the same answer the save will be clamped against rather than from
  // arithmetic done twice on two sides of the wire.
  return NextResponse.json({ shipments, outstanding })
}

/**
 * POST - recording a despatch here rather than waiting for the supplier to.
 *
 * The supplier's own link is the happy path, and plenty of suppliers will never
 * touch it: they email, or they ring, and somebody here writes it down. Same row,
 * same packing slip, `source` of ADMIN rather than PORTAL so the order screen can
 * say which it was.
 *
 * A despatch still moves no stock, closes no line and changes no status. Goods-in
 * is the only thing that says something arrived, and typing what a supplier says
 * has left them must never quietly become a delivery.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!mayDespatch(access)) return errorResponse('Forbidden', 403)

  const { id } = await params
  const order = await getOrder(id)
  if (!order) return errorResponse('That purchase order is not here any more.', 404)
  // Wider than the supplier's own page allows on purpose: they may only file
  // against an order that is still open to them, where somebody here may still
  // be writing up the paperwork for an order already marked received.
  if (!isReceivable(order.status)) {
    return errorResponse(
      `An order that is ${order.status.toLowerCase().replace(/_/g, ' ')} cannot have a despatch recorded against it.`,
      409,
    )
  }

  const parsed = ShipmentBody.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const wanted = shipmentLinesFrom(parsed.data)
  if (wanted.length === 0) return errorResponse('Put a quantity against at least one line.')

  // Clamped against what is genuinely left, off the same despatchableLines() the
  // supplier's own page is held to. A packing slip listing goods that are not on
  // the order is worse than no packing slip, and two people filing the same
  // pallet from two directions is exactly how that happens.
  //
  // Clamped rather than refused, unlike the portal: this is somebody in the
  // building looking at the outstanding figures on the same screen, and the
  // trimming is handed straight back to them below. The supplier's page has no
  // such screen behind it, so there a number that is too big is refused outright
  // rather than quietly cut down to size.
  const outstanding = new Map((await despatchableLines(id)).map((line) => [line.orderLineId, line]))
  const lines: { orderLineId: string; description: string; qty: string }[] = []
  let trimmed = 0
  for (const row of wanted) {
    const line = outstanding.get(row.orderLineId)
    if (!line) continue
    const qty = Math.min(Number(row.qty), Number(line.qtyOutstanding))
    if (!(qty > 0)) continue
    if (qty < Number(row.qty)) trimmed += 1
    lines.push({ orderLineId: row.orderLineId, description: line.description, qty: qty.toFixed(3) })
  }
  if (lines.length === 0) {
    return errorResponse('There is nothing left to send on those lines.', 409)
  }

  const header = shipmentHeaderFrom(parsed.data)
  const number = await generateShipmentNumber()
  await createShipment(number, {
    orderId: id,
    ...header,
    source: 'ADMIN',
    tokenId: null,
    createdByUserId: user.id,
    lines: lines.map((line) => ({ orderLineId: line.orderLineId, qty: line.qty })),
  })

  await recordAudit(
    'order',
    id,
    'order.despatch-recorded',
    {
      note: `Recorded despatch ${number}, sent ${header.despatchedDate}${header.trackingRef ? `, tracking ${header.trackingRef}` : ''}`,
      number,
      lines: lines.map((line) => ({ description: line.description, qty: String(Number(line.qty)) })),
    },
    user.id,
  )

  const [shipments, left] = await Promise.all([listShipmentsForOrder(id), despatchableLines(id)])
  // `trimmed` is handed back rather than swallowed: somebody who typed ten
  // against a line with eight left deserves to be told it went in as eight.
  return NextResponse.json({ ok: true, number, trimmed, shipments, outstanding: left })
}
