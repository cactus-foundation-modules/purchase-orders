import { prisma } from '@/lib/db/prisma'
import { getPoConfigCached } from './config'
import { getSupplier } from './db'
import { billLedgerLines, ledgerTotals, returnLedgerLines } from './ledger'
import { getBill, setBillBooksOutcome } from './bills'
import { getReturn, setReturnBooksOutcome } from './returns'
import {
  dispatchBillApproved,
  dispatchBillCredited,
  dispatchBillVoided,
  hasBookSinks,
  summariseResults,
  type PoBillApprovedPayload,
  type PoBillCreditedPayload,
  type PoBookDocument,
  type PoBookSupplier,
  type PoBooksOutcome,
} from './book-sinks'

// The handoff itself: turning what is on a bill into what the books are handed,
// and writing down what they said.
//
// Every function here is quiet. Nothing throws at the caller, because every one
// of them runs inside somebody else's write path - approving an invoice,
// withdrawing one, recording a credit that has already reached the bank - and
// there is no bookkeeping problem that justifies failing any of those. A refusal
// comes back as a sentence, gets stored, and the screen offers the button again.

function supplierOf(supplier: { name: string; accountNumber: string | null; taxRegistrationNumber: string | null } | null, fallbackName: string): PoBookSupplier {
  return {
    name: supplier?.name?.trim() || fallbackName || 'Supplier',
    accountNumber: supplier?.accountNumber ?? null,
    taxRegistrationNumber: supplier?.taxRegistrationNumber ?? null,
  }
}

/** The supplier's own invoice as the books should file it: a reference to the
 *  one copy in the media library, never a second copy of the bytes. */
async function documentOf(mediaId: string | null): Promise<PoBookDocument | undefined> {
  if (!mediaId) return undefined
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "url", "key", "provider", "mimeType", "sizeBytes", "originalName"
      FROM "Media" WHERE "id" = ${mediaId} LIMIT 1
  `
  const row = rows[0]
  if (!row) return undefined
  const key = String(row.key ?? '')
  return {
    mediaId: row.id as string,
    url: row.url as string,
    filename: (row.originalName as string | null) || key.split('/').pop() || 'supplier-invoice',
    mimeType: (row.mimeType as string | null) ?? 'application/octet-stream',
    sizeBytes: Number(row.sizeBytes ?? 0),
    mediaProvider: (row.provider as string | null) ?? null,
    mediaKey: key || null,
  }
}

const NOTHING_LISTENING: PoBooksOutcome = {
  ok: false,
  message: 'There is no bookkeeping module on this site to send it to.',
  at: '',
  results: [],
}

/**
 * Sends one approved bill to whatever keeps the books, and stores the answer.
 *
 * Returns `posted` when the books took it, which is the only thing that moves a
 * bill to "In the books". A status claiming an entry exists when no books were
 * written to would be the worst kind of lie, so nothing here is optimistic:
 * where nobody is listening, the bill stays approved and says so.
 */
export async function sendBillToBooks(billId: string): Promise<{ outcome: PoBooksOutcome; posted: boolean }> {
  const bill = await getBill(billId)
  if (!bill) return { outcome: { ...NOTHING_LISTENING, message: 'That bill is not here any more.' }, posted: false }

  if (!(await hasBookSinks())) {
    await setBillBooksOutcome(billId, NOTHING_LISTENING, false)
    return { outcome: NOTHING_LISTENING, posted: false }
  }

  const config = await getPoConfigCached()
  const supplier = await getSupplier(bill.supplierId)
  const document = await documentOf(bill.attachment?.mediaId ?? null)

  const lines = billLedgerLines({
    lines: bill.lines.map((line) => ({
      description: line.description,
      lineTotal: line.lineTotal,
      taxRatePercent: line.taxRatePercent,
      taxRateCode: line.taxRateCode,
      vatTreatment: line.vatTreatment,
      categoryId: line.categoryId,
    })),
    carriageAmount: bill.carriageAmount,
    statedTax: bill.taxAmount,
    fxRate: bill.fxRate,
    defaultCategoryId: supplier?.defaultCategoryId || config.defaultCategoryId,
    defaultVatTreatment: supplier?.defaultVatTreatment,
    defaultVatRateCode: supplier?.defaultVatRateCode,
  })

  const payload: PoBillApprovedPayload = {
    source: 'purchase-orders',
    billId: bill.id,
    invoiceNumber: bill.supplierInvoiceNumber,
    orderId: bill.orderId,
    orderNumber: bill.orderNumber,
    supplier: supplierOf(supplier, bill.supplierName),
    taxPointDate: bill.invoiceDate,
    dueDate: bill.dueDate,
    currency: bill.currency,
    baseCurrency: config.baseCurrency,
    fxRate: bill.fxRate,
    totals: ledgerTotals(lines),
    lines,
    description: bill.orderNumber
      ? `Invoice ${bill.supplierInvoiceNumber} against order ${bill.orderNumber}`
      : `Invoice ${bill.supplierInvoiceNumber}`,
    ...(document ? { document } : {}),
  }

  const outcome = summariseResults(await dispatchBillApproved(payload))
  await setBillBooksOutcome(billId, outcome, outcome.ok)
  return { outcome, posted: outcome.ok }
}

/**
 * Tells the books an approved bill has been withdrawn.
 *
 * Never blocks the void. The invoice is withdrawn either way - somebody has
 * decided we do not owe it - and a bookkeeping module that was down at the wrong
 * moment must not hold the purchasing record hostage. What it said is stored, and
 * the screen offers the button again.
 */
export async function sendBillVoidToBooks(billId: string, reason: string): Promise<PoBooksOutcome> {
  const bill = await getBill(billId)
  if (!bill) return { ...NOTHING_LISTENING, message: 'That bill is not here any more.' }

  if (!(await hasBookSinks())) {
    await setBillBooksOutcome(billId, NOTHING_LISTENING, false)
    return NOTHING_LISTENING
  }

  const outcome = summariseResults(
    await dispatchBillVoided({
      source: 'purchase-orders',
      billId: bill.id,
      invoiceNumber: bill.supplierInvoiceNumber,
      orderNumber: bill.orderNumber,
      supplierName: bill.supplierName,
      voidedAt: new Date().toISOString(),
      reason: reason.trim(),
      taxPointDate: bill.invoiceDate,
      description: `Invoice ${bill.supplierInvoiceNumber} voided`,
    }),
  )
  // The bill is void either way, so `posted` goes back to false: there is no
  // entry in the books any more, and a stamp saying otherwise would be a lie.
  await setBillBooksOutcome(billId, outcome, false)
  return outcome
}

/**
 * The posted bill a credit belongs against, where there is exactly one.
 *
 * Only one, and only a posted one. Two invoices on an order is ordinary - a
 * delivery split over two months - and picking one of them for a credit that
 * might belong to either is a guess in somebody's books. Null is a perfectly
 * good answer: the credit is then a reduction of expenditure in its own right.
 */
async function soleBillForOrder(orderId: string): Promise<{ id: string; number: string } | null> {
  const rows = await prisma.$queryRaw<{ id: string; supplier_invoice_number: string }[]>`
    SELECT "id", "supplier_invoice_number" FROM "po_bills"
     WHERE "order_id" = ${orderId} AND "status" = 'POSTED'
     LIMIT 2
  `
  if (rows.length !== 1) return null
  return { id: rows[0]!.id, number: rows[0]!.supplier_invoice_number }
}

/** The order lines behind a return, for the category and VAT treatment somebody
 *  chose when the goods were bought. A return line carries neither: it is a
 *  quantity going back, and what it was for was settled on the order. */
async function returnLineContext(returnId: string): Promise<Record<string, {
  categoryId: string | null
  vatTreatment: string | null
  taxRateCode: string | null
  description: string
}>> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT rl."id", l."category_id", l."vat_treatment", l."tax_rate_code", l."description"
      FROM "po_return_lines" rl
      JOIN "po_order_lines" l ON l."id" = rl."order_line_id"
     WHERE rl."return_id" = ${returnId}
  `
  const out: Record<string, { categoryId: string | null; vatTreatment: string | null; taxRateCode: string | null; description: string }> = {}
  for (const row of rows) {
    out[row.id as string] = {
      categoryId: (row.category_id as string | null) ?? null,
      vatTreatment: (row.vat_treatment as string | null) ?? null,
      taxRateCode: (row.tax_rate_code as string | null) ?? null,
      description: (row.description as string | null) ?? '',
    }
  }
  return out
}

/**
 * Sends one supplier credit to the books, and stores the answer.
 *
 * Fired when a return reaches "credited", because that is the moment the money
 * actually came back. A credit promised and never received is not an entry in
 * anybody's books, which is rather the point of keeping the two statuses apart.
 */
export async function sendReturnCreditToBooks(returnId: string): Promise<PoBooksOutcome> {
  const ret = await getReturn(returnId)
  if (!ret) return { ...NOTHING_LISTENING, message: 'That return is not here any more.' }

  if (!(await hasBookSinks())) {
    await setReturnBooksOutcome(returnId, NOTHING_LISTENING)
    return NOTHING_LISTENING
  }

  const config = await getPoConfigCached()
  const [supplier, context, bill] = await Promise.all([
    getSupplier(ret.supplierId),
    returnLineContext(returnId),
    soleBillForOrder(ret.orderId),
  ])

  const lines = returnLedgerLines({
    lines: ret.lines.map((line) => {
      const source = context[line.id]
      return {
        description: line.description || source?.description || 'Goods returned',
        lineTotal: line.lineTotal,
        taxRatePercent: line.taxRatePercent,
        taxRateCode: source?.taxRateCode ?? null,
        vatTreatment: source?.vatTreatment ?? null,
        categoryId: source?.categoryId ?? null,
      }
    }),
    creditReceived: ret.creditReceived,
    fxRate: ret.fxRate,
    defaultCategoryId: supplier?.defaultCategoryId || config.defaultCategoryId,
    defaultVatTreatment: supplier?.defaultVatTreatment,
    defaultVatRateCode: supplier?.defaultVatRateCode,
  })

  const payload: PoBillCreditedPayload = {
    source: 'purchase-orders',
    returnId: ret.id,
    returnNumber: ret.number,
    orderId: ret.orderId,
    orderNumber: ret.orderNumber,
    billId: bill?.id ?? null,
    billInvoiceNumber: bill?.number ?? null,
    supplier: supplierOf(supplier, ret.supplierName),
    // The day the credit landed, never the day of the purchase. Dating it back
    // would reopen a VAT return that has very probably been filed, and a credit
    // belongs in the period it was given in anyway.
    taxPointDate: new Date().toISOString().slice(0, 10),
    currency: ret.currency || config.baseCurrency,
    baseCurrency: config.baseCurrency,
    fxRate: ret.fxRate,
    totals: ledgerTotals(lines),
    lines,
    reason: ret.reason ?? '',
    description: `Credit note ${ret.number} against order ${ret.orderNumber}`,
  }

  const outcome = summariseResults(await dispatchBillCredited(payload))
  await setReturnBooksOutcome(returnId, outcome)
  return outcome
}
