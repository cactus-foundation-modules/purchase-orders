import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { listAudit, recordAudit } from '@/modules/purchase-orders/lib/audit'
import { getOrder } from '@/modules/purchase-orders/lib/db'
import {
  DuplicateInvoiceError, deleteBill, getBill, listBillableLines, listBookCategories,
  refreshBillMatch, updateBill,
} from '@/modules/purchase-orders/lib/bills'
import {
  availableBillTransitions, billTotals, isBillEditable, isMatchLive, validateBillDrafts,
} from '@/modules/purchase-orders/lib/billing'
import { BillBody, billDrafts, orNull } from '@/modules/purchase-orders/lib/bill-body'

type Params = { params: Promise<{ id: string }> }

/**
 * GET - one bill, and everything the screen draws around it.
 *
 * The match is re-run here rather than read out of the column, but ONLY while
 * the bill is still open. A delivery booked in an hour after the invoice was
 * typed changes the answer, and a screen showing yesterday's verdict is how a
 * perfectly good invoice sits queried for a fortnight. Once it is approved, the
 * recorded variance is the record of what somebody agreed to pay in spite of,
 * and a later delivery does not get to tidy that away.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const existing = await getBill(id)
  if (!existing) return errorResponse('That bill is not here any more.', 404)

  if (isMatchLive(existing.status)) await refreshBillMatch(id)

  const [bill, billable, categories, history] = await Promise.all([
    getBill(id),
    existing.orderId ? listBillableLines(existing.orderId, id) : Promise.resolve([]),
    listBookCategories(),
    listAudit('bill', id),
  ])
  if (!bill) return errorResponse('That bill is not here any more.', 404)

  return NextResponse.json({
    bill,
    billable,
    categories,
    history,
    transitions: availableBillTransitions(bill.status, access),
  })
}

// PUT - save a bill over itself. Only while nobody has approved it: a figure
// that can be edited after approval is a figure nobody has really approved.
export async function PUT(request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canBills) return errorResponse('Forbidden', 403)

  const { id } = await params
  const bill = await getBill(id)
  if (!bill) return errorResponse('That bill is not here any more.', 404)
  if (!isBillEditable(bill.status)) {
    return errorResponse(
      'This bill has been approved. Take the approval back first, which is recorded, then change it.',
      409,
    )
  }

  const parsed = BillBody.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const body = parsed.data
  const orderId = orNull(body.orderId)

  let supplierId = body.supplierId
  if (orderId) {
    const order = await getOrder(orderId)
    if (!order) return errorResponse('That purchase order is not here any more.', 404)
    supplierId = order.supplierId
  }

  // This bill's own lines are excluded from what counts as already invoiced, or
  // a draft saved twice would flag itself for claiming the same goods again.
  const billable = orderId ? await listBillableLines(orderId, id) : []
  const check = validateBillDrafts(billable, billDrafts(body))
  if (!check.ok) return errorResponse(check.reason, 409)

  const totals = billTotals({
    lines: check.lines,
    carriageAmount: body.carriageAmount,
    carriageTaxRatePercent: body.carriageTaxRatePercent,
    taxOverride: body.taxAmount,
  })

  try {
    await updateBill(id, {
      supplierId,
      orderId,
      supplierInvoiceNumber: body.supplierInvoiceNumber.trim(),
      invoiceDate: body.invoiceDate,
      dueDate: orNull(body.dueDate),
      currency: body.currency.toUpperCase(),
      fxRate: body.fxRate,
      subtotal: totals.subtotal,
      carriageAmount: totals.carriageAmount,
      taxAmount: totals.taxAmount,
      total: totals.total,
      lines: check.lines.map((line, index) => ({
        ...line,
        lineTotal: totals.lineTotals[index] ?? '0',
      })),
    })
  } catch (error) {
    if (error instanceof DuplicateInvoiceError) return errorResponse(error.message, 409)
    throw error
  }

  const match = await refreshBillMatch(id)
  await recordAudit(
    'bill',
    id,
    'bill.updated',
    { total: totals.total, lines: check.lines.length, match: match?.status, variances: match?.flags.length ?? 0 },
    user.id,
  )

  return NextResponse.json({ ok: true, total: totals.total, match })
}

// DELETE - unfile a bill entirely. Only one nobody has approved: an approved
// invoice is a decision, and a decision is voided rather than deleted.
export async function DELETE(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canBills) return errorResponse('Forbidden', 403)

  const { id } = await params
  const bill = await getBill(id)
  if (!bill) return errorResponse('That bill is not here any more.', 404)
  if (!isBillEditable(bill.status)) {
    return errorResponse('An approved bill is voided rather than deleted, so the record of it survives.', 409)
  }

  await deleteBill(id)
  await recordAudit(
    bill.orderId ? 'order' : 'supplier',
    bill.orderId ?? bill.supplierId,
    'bill.deleted',
    { invoice: bill.supplierInvoiceNumber, total: bill.total },
    user.id,
  )

  return NextResponse.json({ ok: true })
}
