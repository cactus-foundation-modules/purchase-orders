import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getOrder } from '@/modules/purchase-orders/lib/db'
import {
  DuplicateInvoiceError, billSummaryTotals, createBill, listBills, listBillsForOrder,
  listBillableLines, refreshBillMatch,
} from '@/modules/purchase-orders/lib/bills'
import { billTotals, validateBillDrafts } from '@/modules/purchase-orders/lib/billing'
import { BillBody, billDrafts, orNull } from '@/modules/purchase-orders/lib/bill-body'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import type { PoBillStatus } from '@/modules/purchase-orders/lib/types'

// GET - everything the Bills tab draws in one request: the invoices themselves
// and what is still sitting there unagreed.
export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const params = request.nextUrl.searchParams
  const orderId = params.get('orderId') ?? ''
  const status = (params.get('status') ?? '') as PoBillStatus | 'ALL' | 'OPEN' | ''

  const [bills, totals] = await Promise.all([
    orderId
      ? listBillsForOrder(orderId)
      : listBills({
          search: params.get('search') ?? '',
          status: status || 'ALL',
          supplierId: params.get('supplierId') ?? '',
          variance: params.get('variance') === '1',
        }),
    billSummaryTotals(),
  ])

  return NextResponse.json({ bills, totals })
}

/**
 * POST - enter a supplier's invoice.
 *
 * Against an order, or on its own: plenty of what a business buys never had a
 * purchase order raised for it, and a module that refuses to record the
 * electricity bill is a module somebody keeps a spreadsheet alongside.
 *
 * Over-invoicing is FLAGGED, never refused - the opposite instinct to a return
 * note. A supplier billing for twelve when ten turned up has made a claim
 * somebody now has to look at, and refusing to record the claim only moves the
 * argument into an inbox.
 */
export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canBills) return errorResponse('Forbidden', 403)

  const parsed = BillBody.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const body = parsed.data
  const orderId = orNull(body.orderId)

  // The supplier on a bill against an order is the ORDER's supplier, not
  // whatever the form sent. Two purchase orders' worth of invoice filed under
  // the wrong name is a reconciliation nobody enjoys.
  let supplierId = body.supplierId
  if (orderId) {
    const order = await getOrder(orderId)
    if (!order) return errorResponse('That purchase order is not here any more.', 404)
    supplierId = order.supplierId
  }

  const billable = orderId ? await listBillableLines(orderId) : []
  const check = validateBillDrafts(billable, billDrafts(body))
  if (!check.ok) return errorResponse(check.reason, 409)

  const totals = billTotals({
    lines: check.lines,
    carriageAmount: body.carriageAmount,
    carriageTaxRatePercent: body.carriageTaxRatePercent,
    taxOverride: body.taxAmount,
  })

  let id: string
  try {
    id = await createBill(
      {
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
      },
      user.id,
    )
  } catch (error) {
    if (error instanceof DuplicateInvoiceError) return errorResponse(error.message, 409)
    throw error
  }

  const match = await refreshBillMatch(id)

  await recordAudit(
    'bill',
    id,
    'bill.created',
    {
      invoice: body.supplierInvoiceNumber,
      order: orderId ?? undefined,
      total: totals.total,
      match: match?.status,
      variances: match?.flags.length ?? 0,
    },
    user.id,
  )
  if (orderId) {
    await recordAudit(
      'order',
      orderId,
      'bill.entered',
      { invoice: body.supplierInvoiceNumber, total: totals.total, match: match?.status },
      user.id,
    )
  }

  return NextResponse.json({ id, total: totals.total, match })
}
