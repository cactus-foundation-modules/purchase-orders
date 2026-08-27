import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getOrder, syncOrderReceiptStatus } from '@/modules/purchase-orders/lib/db'
import { createReceipt, getReceipt, listReceiptsForOrder } from '@/modules/purchase-orders/lib/receipts'
import { generateReceiptNumber } from '@/modules/purchase-orders/lib/numbering'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { isReceivable, overReceiptFlags } from '@/modules/purchase-orders/lib/receiving'
import { ReceiptBody, toReceiptInput } from '@/modules/purchase-orders/lib/receipt-body'
import { applyReceiptStock, stockBlockedReason } from '@/modules/purchase-orders/lib/inventory'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const receipts = await listReceiptsForOrder(id)
  return NextResponse.json({ receipts })
}

/**
 * Books a delivery in against an order.
 *
 * The order of events matters and is deliberate:
 *
 *   1. the delivery is filed, because what turned up turned up;
 *   2. the order's status is brought in line with the lines;
 *   3. stock is moved, if the site does that, and a failure there is reported
 *      rather than thrown - the goods are still in the yard either way.
 *
 * Over-delivery is allowed and flagged, never blocked. Suppliers send full
 * cases, and a receipt that refuses to match the pallet is worse than useless.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canReceive) return errorResponse('Forbidden', 403)

  const { id } = await params
  const order = await getOrder(id)
  if (!order) return errorResponse('That purchase order is not here any more.', 404)

  if (!isReceivable(order.status)) {
    return errorResponse(
      `Nothing can be booked in against an order that is ${order.status.toLowerCase().replace(/_/g, ' ')}.`,
      409,
    )
  }

  const parsed = ReceiptBody.safeParse(await request.json())
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const input = toReceiptInput(id, parsed.data)
  if (input.lines.length === 0) {
    return errorResponse('Put a quantity against at least one line, or there is nothing to record.')
  }

  // Every line has to belong to THIS order. The screen only offers this order's
  // lines, but the id comes off the wire and po_receipt_lines has no idea which
  // order its parent receipt belongs to.
  const ours = new Set(order.lines.map((line) => line.id))
  if (input.lines.some((line) => !ours.has(line.orderLineId))) {
    return errorResponse('One of those lines is not on this order.', 409)
  }

  const config = await getPoConfigCached()
  const flags = overReceiptFlags(
    order.lines,
    input.lines.map((line) => ({
      orderLineId: line.orderLineId,
      qtyAccepted: Number(line.qtyAccepted),
      qtyRejected: Number(line.qtyRejected),
    })),
    config.overReceiptTolerancePercent,
  )

  const number = await generateReceiptNumber()
  const receiptId = await createReceipt(number, input, user.id)
  const status = await syncOrderReceiptStatus(id, user.id)

  await recordAudit(
    'order',
    id,
    'receipt.created',
    {
      receipt: number,
      lines: input.lines.length,
      deliveryNote: input.deliveryNoteRef,
      overReceived: flags.length > 0 ? flags.map((f) => f.description) : undefined,
      status: status ?? undefined,
    },
    user.id,
  )

  // Stock last, and never fatal. The paperwork is already right; a stock system
  // that would not answer is a thing to tell somebody about, not a reason to
  // lose the delivery note.
  let stock: { applied: boolean; message: string; result?: unknown } | null = null
  if (parsed.data.applyStock) {
    const blocked = await stockBlockedReason()
    if (blocked) {
      stock = { applied: false, message: blocked }
    } else {
      const receipt = await getReceipt(receiptId)
      const outcome = receipt ? await applyReceiptStock(receipt, user.id) : null
      if (!outcome) {
        stock = { applied: false, message: 'The delivery saved, but its stock could not be read back.' }
      } else if (outcome.applied) {
        stock = { applied: true, message: 'Stock updated.', result: outcome.result }
        await recordAudit('order', id, 'receipt.stocked', { receipt: number, result: outcome.result }, user.id)
      } else {
        stock = { applied: false, message: outcome.reason }
      }
    }
  }

  return NextResponse.json({ id: receiptId, number, status, overReceipt: flags, stock })
}
