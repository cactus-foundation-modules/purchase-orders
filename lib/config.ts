import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'

// Purchase Orders settings, stored as one JSON column on the po_settings
// singleton row - the same shape shop uses for shp_settings. A corrupted or
// partial column falls back to defaults rather than throwing, so a bad write can
// never lock the owner out of the screen that would let them fix it.

const AddressSchema = z.object({
  line1: z.string().default(''),
  line2: z.string().default(''),
  city: z.string().default(''),
  region: z.string().default(''),
  postcode: z.string().default(''),
  country: z.string().default(''),
})

export type PoAddress = z.infer<typeof AddressSchema>

// Where goods go when the order is not being drop-shipped to a customer. Kept
// in settings rather than asked for every time, because for most sites it is the
// same yard every single order.
const ShipToSchema = z.object({
  name: z.string().default(''),
  contact: z.string().default(''),
  phone: z.string().default(''),
  address: AddressSchema.default({}),
  instructions: z.string().default(''),
})

// Who is doing the buying, as it prints at the top of a purchase order.
//
// This module is standalone, so it cannot assume a shop is installed to borrow a
// trading identity from. Every field is optional and blank falls back to the
// shop's own invoice identity where a shop IS installed - read by raw SQL, never
// imported - so nobody types their VAT number into two settings screens and then
// keeps the two in step by hand.
const OrganisationSchema = z.object({
  name: z.string().default(''),
  address: z.string().default(''),
  contactName: z.string().default(''),
  email: z.string().default(''),
  phone: z.string().default(''),
  vatNumber: z.string().default(''),
  companyNumber: z.string().default(''),
})

export type PoOrganisation = z.infer<typeof OrganisationSchema>

const WordingSchema = z.object({
  heading: z.string().default('Purchase order'),
  intro: z.string().default('Please supply the following, quoting our order number on all paperwork.'),
  terms: z.string().default(''),
  footerNote: z.string().default(''),
})

// The packing slip is a third document with a third job: it goes IN THE BOX, and
// on a drop-shipped order the person opening that box is the customer. So it
// gets its own wording, and it never carries a price or the supplier's name -
// see components/puck/po-packing-parts.tsx.
const PackingSlipWordingSchema = z.object({
  heading: z.string().default('Packing slip'),
  intro: z.string().default('Everything in this delivery is listed below. Please check it against the goods and tell us straight away if anything is missing or damaged.'),
  terms: z.string().default(''),
})

// The return note is a different document with a different job, so it gets its
// own wording rather than borrowing the order's. "Please supply the following"
// on a note about goods going back would be quite the mixed message.
const ReturnWordingSchema = z.object({
  heading: z.string().default('Returns note'),
  intro: z.string().default('The goods below are being returned to you. Please raise a credit note against our order number.'),
  terms: z.string().default(''),
})

export const PoConfigSchema = z.object({
  // Numbering. The sequence is shared; only the prefix is the owner's.
  orderNumberPrefix: z.string().default('PO-'),
  receiptNumberPrefix: z.string().default('GRN-'),
  returnNumberPrefix: z.string().default('SRN-'),
  // Despatches: what the supplier says they have SENT, which is a different
  // number series from what we booked IN.
  shipmentNumberPrefix: z.string().default('DSP-'),

  // Approval. `approvalRequired` off means no order ever waits for anybody;
  // on, an order whose total is at or above the threshold needs somebody with
  // the approve permission before it can be sent. A threshold of 0 with
  // approval on means every order needs approving, which is what a site that
  // wants two pairs of eyes on everything is asking for.
  approvalRequired: z.boolean().default(false),
  approvalThreshold: z.number().min(0).default(0),

  // Tolerances, all percentages. Over-receipt is allowed but flagged past this.
  overReceiptTolerancePercent: z.number().min(0).max(100).default(0),
  priceVarianceTolerancePercent: z.number().min(0).max(100).default(2),
  quantityVarianceTolerancePercent: z.number().min(0).max(100).default(0),

  // Whether receiving goods should change stock at all. OFF by default: plenty
  // of sites drop-ship, and plenty have no catalogue to adjust.
  stockOnReceipt: z.boolean().default(false),

  // Whether the nightly job may raise draft orders on its own.
  //
  // OFF by default, and deliberately so. Reorder levels are worth setting up
  // and reading long before anybody wants a machine acting on them at four in
  // the morning, and an update that quietly starts raising purchase orders on a
  // live site is not an update anybody would thank us for. With it off the
  // Reorder tab still works out and shows everything; the buttons still raise
  // orders; it is only the job that holds off.
  reorderAutomatic: z.boolean().default(false),

  // Whether suppliers' own price lists are kept here at all.
  //
  // OFF by default, and for the same reason the nightly reorder run is. An
  // empty catalogue prices nothing, so switching this on before a list has been
  // imported would change no order - but it would put a tab in front of
  // everybody that most sites will never fill in, and a site that buys from one
  // supplier at agreed prices is perfectly well served by the cost on the
  // product. With it on, an order line for a code the supplier's current list
  // names is drafted at THAT price rather than at whatever the catalogue's
  // cost_price says, and the Catalogues tab will say which codes have moved,
  // gone or been discontinued underneath us.
  supplierCatalogues: z.boolean().default(false),

  // Whether a paid customer order drafts its purchase orders by itself.
  //
  // OFF by default, for the third time on this schema and for the same reason
  // each time. Everything it does can already be done by pressing Raise on the
  // order, and an update that quietly starts drafting purchase orders on a live
  // site is not an update anybody would thank us for.
  //
  // It DRAFTS AND STOPS. Nothing is approved, nothing is sent, no supplier hears
  // anything, exactly as the nightly reorder run behaves. What is being
  // automated is the typing, not the buying - and that line should not be moved
  // later without somebody saying so out loud.
  autoDraftFromPaidOrders: z.boolean().default(false),

  defaultShipToKind: z.enum(['WAREHOUSE', 'CUSTOMER', 'OTHER']).default('WAREHOUSE'),
  warehouse: ShipToSchema.default({}),

  baseCurrency: z.string().default('GBP'),

  // Supplier portal (built in a later release; the settings are here so the
  // whole schema and its config land in one migration).
  portalEnabled: z.boolean().default(false),
  portalTokenLifetimeDays: z.number().int().min(1).max(365).default(60),

  // Whether a supplier may put a file on the site through their own link - the
  // proforma they want paying, and the acknowledgement they send back when they
  // confirm.
  //
  // ON, because a portal that cannot take the two documents the portal exists to
  // collect is a portal nobody uses. It is still worth a switch: this is the one
  // place on the platform where somebody with no account can put bytes on the
  // site, and a business that would rather those arrived by email can say so.
  // Every file is type-sniffed and size-capped either way - see
  // lib/portal-upload.ts.
  portalUploadsEnabled: z.boolean().default(true),

  // Whether the supplier's link lets them say what they have SENT, drop by
  // drop, and take away a packing slip for each one. On: an order that arrives
  // in three lorries is an ordinary order, and the alternative is three emails.
  portalDespatchEnabled: z.boolean().default(true),

  // Chasing overdue orders.
  chaseEnabled: z.boolean().default(false),
  chaseAfterDays: z.number().int().min(0).max(365).default(3),
  chaseRepeatDays: z.number().int().min(0).max(365).default(7),

  organisation: OrganisationSchema.default({}),
  wording: WordingSchema.default({}),
  returnWording: ReturnWordingSchema.default({}),
  packingSlipWording: PackingSlipWordingSchema.default({}),
  pdfFilenamePrefix: z.string().default('purchase-order'),
  returnPdfFilenamePrefix: z.string().default('returns-note'),
  packingSlipFilenamePrefix: z.string().default('packing-slip'),

  // Bookkeeping category every bill line falls back to. A plain string: the
  // books may not be installed, and this module never holds a foreign key into
  // another module's tables.
  defaultCategoryId: z.string().default(''),

  // Whether approving a bill also files it in the books. On by default, because
  // a site that has installed both modules has said what it wants; off is for
  // the owner whose accountant keys purchases in from the bank instead, and who
  // would otherwise find every invoice in there twice. Nothing happens either
  // way on a site with no bookkeeping module - there is nowhere to send it.
  postApprovedBillsToBooks: z.boolean().default(true),
})

export type PoConfig = z.infer<typeof PoConfigSchema>

export const PO_CONFIG_DEFAULTS: PoConfig = PoConfigSchema.parse({})

export function parsePoConfig(raw: unknown): PoConfig {
  const result = PoConfigSchema.safeParse(raw ?? {})
  return result.success ? result.data : PO_CONFIG_DEFAULTS
}

export async function getPoConfig(): Promise<PoConfig> {
  const rows = await prisma.$queryRaw<{ config: unknown }[]>`
    SELECT "config" FROM "po_settings" WHERE "id" = 'singleton' LIMIT 1
  `
  return parsePoConfig(rows[0]?.config)
}

let cachedConfig: PoConfig | null = null
let cachedConfigAt = 0
const CACHE_TTL_MS = 5_000

export async function getPoConfigCached(): Promise<PoConfig> {
  const now = Date.now()
  if (cachedConfig && now - cachedConfigAt < CACHE_TTL_MS) return cachedConfig
  const config = await getPoConfig()
  cachedConfig = config
  cachedConfigAt = now
  return config
}

export function invalidatePoConfigCache(): void {
  cachedConfig = null
  cachedConfigAt = 0
}

/**
 * Merge-then-validate partial update.
 *
 * An upsert rather than a bare UPDATE: the singleton row is seeded by the
 * migration, but a plain "UPDATE ... WHERE id = 'singleton'" silently affects
 * zero rows if that row is ever missing - the save returns 200, looks fine, and
 * nothing persists.
 */
export async function updatePoConfig(patch: Partial<PoConfig>): Promise<PoConfig> {
  const current = await getPoConfig()
  const next = PoConfigSchema.parse({ ...current, ...patch })
  const serialised = JSON.stringify(next)
  await prisma.$executeRaw`
    INSERT INTO "po_settings" ("id", "config", "updated_at")
    VALUES ('singleton', ${serialised}::jsonb, now())
    ON CONFLICT ("id") DO UPDATE
      SET "config" = ${serialised}::jsonb, "updated_at" = now()
  `
  invalidatePoConfigCache()
  return next
}
