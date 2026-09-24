import { z } from 'zod'
import type { OrderInput } from './db'

// The order form, validated once and shared by create and update.
//
// Every money and quantity field is a STRING from the browser to the numeric
// column. Numbers would be JSON floats, and a JSON float is exactly how a unit
// cost of 1.005 arrives as 1.0049999999999999 and puts a supplier's invoice a
// pound out over a two-hundred-unit line.

// The integer-digit cap must come off the column's own precision, not be
// hardcoded to 10 regardless of scale: NUMERIC(12,3) leaves room for nine
// integer digits, NUMERIC(12,4) for eight, and a validator that let ten
// through either way passed a number Postgres would refuse - surfacing as a
// raw "numeric field overflow" out of the transaction that tried to write it,
// rather than the plain-English message this exists to give instead. Every
// column here is NUMERIC(12,x) except fxRate below, which says so itself.
//
// Signed, for Money below: carriage and a unit cost can genuinely go negative
// (a credit note, a cost correction), neither column carries a CHECK
// forbidding it, and lib/totals.ts's orderTotals() carries both straight
// through with no clamp either way - a negative value there is consistent
// end to end, stored and totalled the same figure.
const Decimal = (places: number, label: string, precision = 12) =>
  z.string().regex(new RegExp(`^-?\\d{1,${precision - places}}(\\.\\d{1,${places}})?$`), label)

const Money = Decimal(2, 'Amounts need to look like 12.34')
// NOT Money: an order-level discount is "an amount off the whole order" (the
// screen's own words) and orderTotals() already assumes exactly that -
// Math.max(0, ...) clamps a negative discount to nothing there, and
// Math.min(discount, net) refuses to let it exceed the goods it is coming off
// either. A negative value passing Zod here would have stored one figure in
// "discount_amount" while every total on the order was computed as though it
// were zero - a silent mismatch between what is on record and what the order
// actually comes to, not the loud rejection this gives instead.
const DiscountAmount = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'A discount needs to look like 12.34, and never negative')
// NOT built on Decimal() above - a quantity is never signed, and unlike Money/
// UnitCost this one has a real CHECK behind it: po_order_lines has
// CHECK (qty > 0). A leading minus passing Zod here does not just look odd, it
// fails the INSERT with a raw constraint violation instead of this file's own
// message - every sibling body-schema file in this module (bill/receipt/
// return/shipment/portal) already validates its own qty the same unsigned
// way; this was the one left signed by mistake. qtyCancelled shares this
// validator too, but for a different reason: no column carries a CHECK on it,
// it is simply always a COUNT - every reader of it (receiving, billing, the
// reports) computes qty - qtyCancelled and would silently corrupt that
// arithmetic on a negative value rather than fail loudly the way qty does.
const Qty = z.string().regex(/^\d{1,9}(\.\d{1,3})?$/, 'Quantities can have up to three decimal places')
const UnitCost = Decimal(4, 'Unit costs can have up to four decimal places')
const Percent = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Percentages need to look like 20 or 17.5')

const DateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates need to look like 2026-08-27')
  .nullable()

const AddressBody = z.object({
  line1: z.string().max(200).default(''),
  line2: z.string().max(200).default(''),
  city: z.string().max(120).default(''),
  region: z.string().max(120).default(''),
  postcode: z.string().max(40).default(''),
  country: z.string().max(120).default(''),
})

const ShipToBody = z.object({
  name: z.string().max(200).default(''),
  contact: z.string().max(200).default(''),
  phone: z.string().max(60).default(''),
  address: AddressBody.default({}),
  instructions: z.string().max(2000).default(''),
})

export const OrderLineBody = z.object({
  productId: z.string().max(100).nullable().default(null),
  productName: z.string().max(400).nullable().default(null),
  supplierSku: z.string().max(120).nullable().default(null),
  ourSku: z.string().max(120).nullable().default(null),
  description: z.string().trim().min(1, 'Every line needs a description').max(1000),
  qty: Qty,
  unit: z.string().max(40).default('each'),
  unitCost: UnitCost.default('0'),
  discountPercent: Percent.nullable().default(null),
  taxRatePercent: Percent.default('0'),
  taxRateCode: z.string().max(60).nullable().default(null),
  vatTreatment: z.string().max(60).nullable().default(null),
  categoryId: z.string().max(100).nullable().default(null),
  expectedDate: DateOnly.default(null),
  qtyCancelled: Qty.default('0'),
  // The delivery service the line has to be sent on. Both default to null, so
  // an existing client and the nightly reorder job carry on unchanged. The cost
  // is validated like a unit cost rather than left a free string: it goes
  // straight into a NUMERIC(12,4) column, and anything that is not a number
  // there is a 500 rather than a form error.
  serviceName: z.string().max(200).nullable().default(null),
  // An emptied box is allowed through as blank and becomes null in toOrderInput,
  // the same as a name somebody deleted. Anything else has to look like money.
  serviceCost: UnitCost.or(z.literal('')).nullable().default(null),
  // The customer order line this was bought for, carried on the wire so that
  // editing a purchase order raised off a shop order does not erase the link -
  // updateOrder replaces the lines wholesale, so anything the form does not
  // send back is gone.
  sourceOrderItemId: z.string().max(100).nullable().default(null),
})

export const OrderBody = z.object({
  supplierId: z.string().min(1, 'Pick a supplier'),
  shipToKind: z.enum(['WAREHOUSE', 'CUSTOMER', 'OTHER']).default('WAREHOUSE'),
  shipTo: ShipToBody.default({}),
  currency: z.string().trim().length(3, 'Currency is a three-letter code').default('GBP'),
  baseCurrency: z.string().trim().length(3, 'Currency is a three-letter code').default('GBP'),
  // NUMERIC(18,8), not the 12 every other decimal column here is - ten
  // integer digits, not four.
  fxRate: Decimal(8, 'The exchange rate can have up to eight decimal places', 18).default('1'),
  taxMode: z.enum(['EXCLUSIVE', 'INCLUSIVE']).default('EXCLUSIVE'),
  discountAmount: DiscountAmount.default('0'),
  carriageAmount: Money.default('0'),
  surchargeAmount: Money.default('0'),
  requiredByDate: DateOnly.default(null),
  expectedDate: DateOnly.default(null),
  paymentTerms: z.string().max(200).nullable().default(null),
  deliveryTerms: z.string().max(200).nullable().default(null),
  notesSupplier: z.string().max(5000).nullable().default(null),
  notesInternal: z.string().max(5000).nullable().default(null),
  lines: z.array(OrderLineBody).min(1, 'An order needs at least one line'),
  // Why this order changed, on an amendment. Ignored on a create and on an edit
  // to a draft: neither has anything to explain to anybody. Required by the
  // update route when the supplier is already holding a copy - see editMode().
  amendmentReason: z.string().max(2000).optional(),
})

export type OrderBodyInput = z.infer<typeof OrderBody>

function orNull(value: string | null): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

export function toOrderInput(body: OrderBodyInput): OrderInput {
  return {
    supplierId: body.supplierId,
    shipToKind: body.shipToKind,
    shipTo: body.shipTo,
    currency: body.currency.trim().toUpperCase(),
    baseCurrency: body.baseCurrency.trim().toUpperCase(),
    fxRate: body.fxRate,
    taxMode: body.taxMode,
    discountAmount: body.discountAmount,
    carriageAmount: body.carriageAmount,
    surchargeAmount: body.surchargeAmount,
    requiredByDate: body.requiredByDate,
    expectedDate: body.expectedDate,
    paymentTerms: orNull(body.paymentTerms),
    deliveryTerms: orNull(body.deliveryTerms),
    notesSupplier: orNull(body.notesSupplier),
    notesInternal: orNull(body.notesInternal),
    lines: body.lines.map((line) => ({
      productId: orNull(line.productId),
      productName: orNull(line.productName),
      supplierSku: orNull(line.supplierSku),
      ourSku: orNull(line.ourSku),
      description: line.description.trim(),
      qty: line.qty,
      unit: line.unit.trim() || 'each',
      unitCost: line.unitCost,
      discountPercent: orNull(line.discountPercent),
      taxRatePercent: line.taxRatePercent,
      taxRateCode: orNull(line.taxRateCode),
      vatTreatment: orNull(line.vatTreatment),
      categoryId: orNull(line.categoryId),
      expectedDate: line.expectedDate,
      qtyCancelled: line.qtyCancelled,
      serviceName: orNull(line.serviceName),
      serviceCost: orNull(line.serviceCost),
      sourceOrderItemId: orNull(line.sourceOrderItemId),
    })),
  }
}
