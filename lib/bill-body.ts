import { z } from 'zod'
import { PO_VAT_RATE_CODES, PO_VAT_TREATMENTS } from './types'
import type { BillLineDraft } from './billing'

// The bill form. Same rule as everywhere else in this module: quantities and
// money are STRINGS from the browser to the numeric column, because a JSON float
// is how a unit cost of 1.005 arrives as 1.0049999999999999 and a supplier's
// invoice ends up a pound out against the paper it was copied from.

const Qty = z.string().regex(/^\d{1,10}(\.\d{1,3})?$/, 'Quantities can have up to three decimal places')
const Cost = z.string().regex(/^-?\d{1,10}(\.\d{1,4})?$/, 'Costs can have up to four decimal places')
const Amount = z.string().regex(/^-?\d{1,10}(\.\d{1,2})?$/, 'Amounts need to look like 12.34')
const Percent = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'A rate looks like 20 or 5.5')
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates need to look like 2026-08-27')

// The two vocabularies are checked rather than taken on trust. They are handed
// straight to the books in a later release, and a treatment bookkeeping has
// never heard of would be refused there, on a screen nobody is looking at.
const RateCode = z.enum(PO_VAT_RATE_CODES).nullable().default(null)
const Treatment = z.enum(PO_VAT_TREATMENTS).nullable().default(null)

export const BillLineBody = z.object({
  /** Which order line this charge is against, where it is against one at all. */
  orderLineId: z.string().max(100).nullable().default(null),
  description: z.string().max(500).default(''),
  qty: Qty.default('0'),
  unitCost: Cost.default('0'),
  taxRatePercent: Percent.default('0'),
  taxRateCode: RateCode,
  vatTreatment: Treatment,
  categoryId: z.string().max(100).nullable().default(null),
})

export const BillBody = z.object({
  supplierId: z.string().min(1, 'A bill has to be from a supplier'),
  orderId: z.string().max(100).nullable().default(null),
  supplierInvoiceNumber: z.string().min(1, 'Their invoice number is what everybody will quote').max(120),
  invoiceDate: Day,
  dueDate: Day.nullable().default(null),
  currency: z.string().min(3).max(3).default('GBP'),
  fxRate: z.string().regex(/^\d{1,10}(\.\d{1,8})?$/, 'An exchange rate looks like 1.16482').default('1'),
  carriageAmount: Amount.default('0'),
  carriageTaxRatePercent: Percent.default('0'),
  /** The VAT figure on their invoice, where it differs from ours. Blank uses ours. */
  taxAmount: Amount.nullable().default(null),
  lines: z.array(BillLineBody).min(1, 'A bill needs at least one line'),
})

export type BillBodyInput = z.infer<typeof BillBody>

/** Lines with nothing on them are dropped rather than stored: the screen offers
 *  every line of the order so somebody can tick off what has been invoiced, and
 *  on a part-invoice most of them will be left at zero. */
export function billDrafts(body: BillBodyInput): BillLineDraft[] {
  return body.lines
    .filter((line) => Number(line.qty) > 0)
    .map((line) => ({
      orderLineId: (line.orderLineId ?? '').trim() || null,
      description: line.description,
      qty: line.qty,
      unitCost: line.unitCost,
      taxRatePercent: line.taxRatePercent,
      taxRateCode: line.taxRateCode,
      vatTreatment: line.vatTreatment,
      categoryId: (line.categoryId ?? '').trim() || null,
    }))
}

export function orNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/** Querying, approving and voiding. The note is what the supplier gets told. */
export const BillTransitionBody = z.object({
  transition: z.string().min(1),
  note: z.string().max(2000).nullable().default(null),
})
