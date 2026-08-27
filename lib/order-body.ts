import { z } from 'zod'
import type { OrderInput } from './db'

// The order form, validated once and shared by create and update.
//
// Every money and quantity field is a STRING from the browser to the numeric
// column. Numbers would be JSON floats, and a JSON float is exactly how a unit
// cost of 1.005 arrives as 1.0049999999999999 and puts a supplier's invoice a
// pound out over a two-hundred-unit line.

const Decimal = (places: number, label: string) =>
  z.string().regex(new RegExp(`^-?\\d{1,10}(\\.\\d{1,${places}})?$`), label)

const Money = Decimal(2, 'Amounts need to look like 12.34')
const Qty = Decimal(3, 'Quantities can have up to three decimal places')
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
})

export const OrderBody = z.object({
  supplierId: z.string().min(1, 'Pick a supplier'),
  shipToKind: z.enum(['WAREHOUSE', 'CUSTOMER', 'OTHER']).default('WAREHOUSE'),
  shipTo: ShipToBody.default({}),
  currency: z.string().trim().length(3, 'Currency is a three-letter code').default('GBP'),
  baseCurrency: z.string().trim().length(3, 'Currency is a three-letter code').default('GBP'),
  fxRate: Decimal(8, 'The exchange rate can have up to eight decimal places').default('1'),
  taxMode: z.enum(['EXCLUSIVE', 'INCLUSIVE']).default('EXCLUSIVE'),
  discountAmount: Money.default('0'),
  carriageAmount: Money.default('0'),
  requiredByDate: DateOnly.default(null),
  expectedDate: DateOnly.default(null),
  paymentTerms: z.string().max(200).nullable().default(null),
  deliveryTerms: z.string().max(200).nullable().default(null),
  notesSupplier: z.string().max(5000).nullable().default(null),
  notesInternal: z.string().max(5000).nullable().default(null),
  lines: z.array(OrderLineBody).min(1, 'An order needs at least one line'),
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
    })),
  }
}
