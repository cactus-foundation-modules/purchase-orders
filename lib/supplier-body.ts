import { z } from 'zod'
import { catalogueNameKey } from './catalogue-import'
import type { SupplierInput } from './db'

// The supplier form, validated once and shared by the create and the update
// route. Money fields cross the wire as strings and stay strings all the way
// into the numeric column - parsing them to a float first is how a carriage
// threshold of 249.99 becomes 249.98999999999998.

const Money = z.string().regex(/^-?\d{1,10}(\.\d{1,2})?$/, 'Amounts need to look like 12.34').nullable()

/** A per-unit rate, four decimal places - same precision `unit_cost` and
 *  `service_cost` already carry, because a rate is exactly that kind of
 *  figure and two places would round it before it was ever used. Eight integer
 *  digits, not ten like `Money` above: the column is NUMERIC(12,4), and a
 *  ninth digit is a number this rate can never actually hold - caught here
 *  as a plain validation message rather than a raw overflow error out of
 *  the transaction that tries to write it. */
const UnitRate = z.string().regex(/^\d{1,8}(\.\d{1,4})?$/, 'A rate looks like 6.00 or 40')

const SurchargeRateBody = z.object({
  category: z.string().trim().min(1, 'Give this category a name').max(120),
  ratePerUnit: UnitRate,
})

/** A trade discount, as the column holds it: NUMERIC(5,2), nought to a hundred.
 *  A string all the way in, same as the money fields and for the same reason. */
const Percent = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'A discount looks like 25 or 12.5')
  .refine((value) => Number(value) <= 100, 'A discount cannot be more than 100%')
  .nullable()

const AddressBody = z.object({
  line1: z.string().max(200).default(''),
  line2: z.string().max(200).default(''),
  city: z.string().max(120).default(''),
  region: z.string().max(120).default(''),
  postcode: z.string().max(40).default(''),
  country: z.string().max(120).default(''),
})

export const SupplierBody = z.object({
  name: z.string().trim().min(1, 'Give the supplier a name').max(200),
  shopSupplierId: z.string().nullable().default(null),
  shopSupplierName: z.string().nullable().default(null),
  accountNumber: z.string().max(120).nullable().default(null),
  contactName: z.string().max(200).nullable().default(null),
  phone: z.string().max(60).nullable().default(null),
  email: z.string().email('That email address does not look right').nullable().default(null),
  emailCc: z.string().email('That copy-to address does not look right').nullable().default(null),
  // Their accounts department. Defaulted rather than required, so a form written
  // before these existed still saves - and a supplier nobody has thought about
  // behaves exactly as every existing row does.
  accountsEmail: z.string().email('That accounts address does not look right').nullable().default(null),
  proformaPaidToAccounts: z.boolean().default(false),
  dropships: z.boolean().default(false),
  address: AddressBody.default({}),
  currency: z.string().trim().length(3, 'Currency is a three-letter code').default('GBP'),
  paymentTerms: z.string().max(200).nullable().default(null),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().default(null),
  // Credit account, or proforma-before-confirmation. Defaulted rather than
  // required, so a form written before this field existed still saves - and a
  // supplier nobody has thought about is on an account, which is what every
  // existing row is.
  accountTerms: z.enum(['CREDIT', 'PROFORMA']).default('CREDIT'),
  leadTimeDays: z.number().int().min(0).max(365).nullable().default(null),
  minimumOrderValue: Money.default(null),
  carriagePaidOver: Money.default(null),
  carriageCharge: Money.default(null),
  // Net value below which a sale surcharge is added to an order raised for
  // this supplier - null is "no surcharge", same convention as the two above.
  surchargeThreshold: Money.default(null),
  surchargeRates: z.array(SurchargeRateBody)
    .default([])
    .refine(
      (rates) => new Set(rates.map((r) => catalogueNameKey(r.category))).size === rates.length,
      'Two of these categories are the same - give each one its own name.',
    ),
  discountPercent: Percent.default(null),
  defaultCategoryId: z.string().max(100).nullable().default(null),
  defaultVatTreatment: z.string().max(60).nullable().default(null),
  defaultVatRateCode: z.string().max(60).nullable().default(null),
  taxRegistrationNumber: z.string().max(60).nullable().default(null),
  deliveryInstructions: z.string().max(2000).nullable().default(null),
  // What this supplier reads at the top of their own portal page. Bounded like
  // everything else, and defaulted so a form written before it existed saves.
  portalNote: z.string().max(2000).nullable().default(null),
  status: z.enum(['ENABLED', 'DISABLED', 'ON_HOLD']).default('ENABLED'),
  notes: z.string().max(5000).nullable().default(null),
})

export type SupplierBodyInput = z.infer<typeof SupplierBody>

/** Empty strings out of an HTML form mean "not given", not "given as blank". */
function orNull(value: string | null): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

export function toSupplierInput(body: SupplierBodyInput): SupplierInput {
  return {
    name: body.name.trim(),
    shopSupplierId: orNull(body.shopSupplierId),
    shopSupplierName: orNull(body.shopSupplierName),
    accountNumber: orNull(body.accountNumber),
    contactName: orNull(body.contactName),
    phone: orNull(body.phone),
    email: orNull(body.email),
    emailCc: orNull(body.emailCc),
    accountsEmail: orNull(body.accountsEmail),
    // An address that is not there cannot be sent to, and a switch left on
    // against an empty box would quietly send the payment note nowhere. The form
    // says the same thing; this is the half that holds when the form is not the
    // thing calling.
    proformaPaidToAccounts: body.proformaPaidToAccounts && orNull(body.accountsEmail) !== null,
    dropships: body.dropships,
    address: body.address,
    currency: body.currency.trim().toUpperCase(),
    paymentTerms: orNull(body.paymentTerms),
    paymentTermsDays: body.paymentTermsDays,
    accountTerms: body.accountTerms,
    leadTimeDays: body.leadTimeDays,
    minimumOrderValue: orNull(body.minimumOrderValue),
    carriagePaidOver: orNull(body.carriagePaidOver),
    carriageCharge: orNull(body.carriageCharge),
    surchargeThreshold: orNull(body.surchargeThreshold),
    surchargeRates: body.surchargeRates.map((r) => ({
      category: r.category.trim(),
      categoryKey: catalogueNameKey(r.category),
      ratePerUnit: r.ratePerUnit,
    })),
    discountPercent: orNull(body.discountPercent),
    defaultCategoryId: orNull(body.defaultCategoryId),
    defaultVatTreatment: orNull(body.defaultVatTreatment),
    defaultVatRateCode: orNull(body.defaultVatRateCode),
    taxRegistrationNumber: orNull(body.taxRegistrationNumber),
    deliveryInstructions: orNull(body.deliveryInstructions),
    portalNote: orNull(body.portalNote),
    status: body.status,
    notes: orNull(body.notes),
  }
}

/**
 * The unique index on name_key is what stops two people creating the same
 * supplier twice over. Turned into plain English rather than a 500.
 */
export function isDuplicateSupplierName(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('po_suppliers_name_key_unique')
}

/**
 * The unique index on (supplier_id, category_key) is the backstop for a race
 * the form's own duplicate check above cannot see - two saves landing at once.
 * Turned into plain English rather than a 500, same as the supplier-name one.
 */
export function isDuplicateSurchargeCategory(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('po_supplier_surcharge_rates_supplier_category_unique')
}
