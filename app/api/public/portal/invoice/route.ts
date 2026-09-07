import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { getOrder, getSupplier } from '@/modules/purchase-orders/lib/db'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import { sendPortalReplyToBuyer } from '@/modules/purchase-orders/lib/email'
import { PortalInvoiceFields, portalInvoiceLinesField } from '@/modules/purchase-orders/lib/portal-body'
import { buildPortalView } from '@/modules/purchase-orders/lib/portal-response'
import { readPortalUpload, storeOrderDocument } from '@/modules/purchase-orders/lib/portal-upload'
import { guessInvoiceDetails } from '@/modules/purchase-orders/lib/document-reference'
import { portalInvoiceLines } from '@/modules/purchase-orders/lib/portal-invoice'
import {
  DuplicateInvoiceError, createBill, listBillableLines, refreshBillMatch, setBillAttachment,
} from '@/modules/purchase-orders/lib/bills'
import { billTotals, dueDateFor } from '@/modules/purchase-orders/lib/billing'
import { settleOrder } from '@/modules/purchase-orders/lib/order-settle'
import { portalNoticeRecipient, recordPortalEvent, resolvePortalToken } from '@/modules/purchase-orders/lib/portal'
import { hashPortalIp } from '@/modules/purchase-orders/lib/portal-token'
import {
  allowPortalWriteIp, allowPortalWriteToken, portalClientIp,
} from '@/modules/purchase-orders/lib/portal-rate-limit'
import { isPortalOpen, portalEventSummary } from '@/modules/purchase-orders/lib/portal-view'

// POST - the supplier's own VAT invoice, arriving as a file with the lines it
// covers ticked off beside it.
//
// The one thing on the portal that WRITES A RECORD OF WHAT WE OWE, which is why
// it has a switch of its own, off until an owner turns it on, and why what it
// writes is a DRAFT and never anything else. Nothing here approves anything and
// nothing reaches a set of books: an entry in somebody's accounts on a
// supplier's unattended say-so is precisely the thing this design will not do.
//
// The money is not theirs to set. Every line is priced at what the ORDER says,
// at the rate the order says - see lib/portal-invoice.ts. What they send is the
// total off their own document, stored beside our arithmetic rather than
// replacing it, so where the two disagree the bill says so and somebody here
// reads it before a penny moves.
//
// Everything the other portal endpoints promise holds here: the order is looked
// up from the token, nothing on the wire names it, and every failure that could
// confirm a link exists is the same 404.
export async function POST(request: NextRequest) {
  const ip = portalClientIp(request)
  if (!allowPortalWriteIp(ip)) {
    return errorResponse('That is a lot of files at once. Give it a few minutes.', 429)
  }

  const form = await request.formData().catch(() => null)
  if (!form) return errorResponse('We could not read that.')

  const parsed = PortalInvoiceFields.safeParse({
    token: form.get('token') ?? '',
    ref: form.get('ref')?.toString().trim() || undefined,
    date: form.get('date')?.toString().trim() || undefined,
    total: form.get('total')?.toString().trim() || undefined,
    note: form.get('note')?.toString().trim() || undefined,
    lines: portalInvoiceLinesField(form.get('lines')),
  })
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'We could not read that.')
  const fields = parsed.data

  const config = await getPoConfigCached()
  if (!config.portalEnabled) return errorResponse('That link is not open any more.', 404)
  if (!config.portalInvoicesEnabled || !config.portalUploadsEnabled) {
    return errorResponse('We are not taking invoices through this page. Email it to us instead.', 409)
  }

  const token = await resolvePortalToken(fields.token)
  if (!token) return errorResponse('That link is not open any more.', 404)
  if (!allowPortalWriteToken(token.hash)) {
    return errorResponse('That is a lot of files at once. Give it a few minutes.', 429)
  }

  const order = await getOrder(token.orderId)
  if (!order) return errorResponse('That link is not open any more.', 404)
  if (!isPortalOpen(order.status)) {
    return errorResponse('This order is closed, so there is nothing left to invoice us for.', 409)
  }

  // What the ticks come to, before anything is stored: a refusal has to leave
  // the order exactly as it was, and the media library with nothing extra in it.
  const supplier = await getSupplier(order.supplierId)
  const billable = await listBillableLines(order.id)
  const drafted = portalInvoiceLines(billable, fields.lines, {
    categoryId: supplier?.defaultCategoryId || config.defaultCategoryId || null,
    vatTreatment: supplier?.defaultVatTreatment ?? null,
    vatRateCode: supplier?.defaultVatRateCode ?? null,
  })
  if (!drafted.ok) return errorResponse(drafted.reason, 409)

  const upload = await readPortalUpload(form.get('file'))
  if (!upload.ok) return errorResponse(upload.reason, upload.status)

  // What the document itself says, for the boxes they left alone. A guess every
  // time, never allowed to overtype something they typed, and shown back to them
  // on their own page where they can correct it.
  const guess = guessInvoiceDetails(upload.filename, upload.buffer, order.number)
  const invoiceNumber = (fields.ref ?? '').trim() || guess.reference || ''
  if (!invoiceNumber) {
    return errorResponse('We could not find your invoice number on that file. Type it in and send it again.', 400)
  }
  const invoiceDate = fields.date ?? guess.date ?? new Date().toISOString().slice(0, 10)
  const statedTotal = (fields.total ?? '').trim() || guess.total || null

  const totals = billTotals({ lines: drafted.lines })

  // The file goes up BEFORE the bill is written, and on purpose. A duplicate
  // invoice number is the one failure that actually happens here - a supplier
  // pressing send twice - and it leaves a spare copy of a document we already
  // have. The other order round loses the file, and the supplier has to be asked
  // for it again.
  const stored = await storeOrderDocument(upload, 'invoice', order.number, null)
  if (!stored.ok) return errorResponse(stored.reason, stored.status)

  let billId: string
  try {
    billId = await createBill(
      {
        supplierId: order.supplierId,
        orderId: order.id,
        supplierInvoiceNumber: invoiceNumber,
        invoiceDate,
        dueDate: dueDateFor(invoiceDate, supplier?.paymentTermsDays ?? null),
        currency: order.currency,
        fxRate: order.fxRate,
        subtotal: totals.subtotal,
        carriageAmount: totals.carriageAmount,
        taxAmount: totals.taxAmount,
        total: totals.total,
        statedTotal,
        lines: drafted.lines.map((line, index) => ({
          ...line,
          lineTotal: totals.lineTotals[index] ?? '0',
        })),
      },
      // No user id: a supplier is not a user of this site, and putting somebody
      // else's against their invoice would be a lie in the one column anybody
      // asking "who entered this" would read.
      null,
      'PORTAL',
    )
  } catch (error) {
    if (error instanceof DuplicateInvoiceError) {
      return errorResponse(`We already have your invoice ${invoiceNumber} for this order.`, 409)
    }
    throw error
  }

  await setBillAttachment(billId, stored.mediaId)
  const match = await refreshBillMatch(billId)

  const payload: Record<string, unknown> = {
    ref: invoiceNumber,
    total: statedTotal ?? totals.total,
    filename: upload.filename,
    note: (fields.note ?? '').trim(),
    lines: drafted.lines.map((line) => ({ description: line.description, qty: line.qty })),
  }
  await recordPortalEvent(token.id, order.id, 'INVOICED', payload, hashPortalIp(ip))

  const summary = portalEventSummary('INVOICED', payload)
  await recordAudit('bill', billId, 'bill.portal-created', {
    invoice: invoiceNumber,
    order: order.number,
    total: totals.total,
    stated: statedTotal ?? undefined,
    match: match?.status,
    variances: match?.flags.length ?? 0,
  })
  await recordAudit('order', order.id, 'bill.portal-entered', {
    note: summary,
    supplier: order.supplierName,
    invoice: invoiceNumber,
    filename: upload.filename,
  })

  // Everything delivered, everything invoiced and nothing owed back puts the
  // order in front of somebody here rather than closing it: these invoices are
  // drafts nobody has read.
  const settled = await settleOrder(order.id, null)

  const to = await portalNoticeRecipient()
  if (to) await sendPortalReplyToBuyer(to, order.supplierName, order.number, summary)

  const view = await buildPortalView(order.id)
  return NextResponse.json({ ok: true, view, pendingClose: settled?.status === 'PENDING_CLOSE' })
}
