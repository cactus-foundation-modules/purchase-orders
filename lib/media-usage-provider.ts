import { prisma } from '@/lib/db/prisma'

// Provider for the core.media-usage-providers extension point.
//
// Three kinds of file, all of them a plain Media id on a po_ table core has no
// sight of: a supplier's invoice attached to a bill, the proforma they sent
// before they would confirm an order, and the acknowledgement they sent when
// they did. Without this the library would count every one of them as unused
// clutter and offer them up for a tidy.
//
// A purchase invoice is the evidence behind an expense, which HMRC expect kept
// for six years, and a proforma is the evidence behind money that left the
// building before any goods did. The media clean-up is not allowed to be the
// thing that loses either.
export async function purchaseOrdersMediaUsageProvider(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ ref: string | null }[]>`
    SELECT "attachment_media_id" AS ref FROM "po_bills" WHERE "attachment_media_id" IS NOT NULL
    UNION
    SELECT "proforma_media_id" AS ref FROM "po_orders" WHERE "proforma_media_id" IS NOT NULL
    UNION
    SELECT "ack_media_id" AS ref FROM "po_orders" WHERE "ack_media_id" IS NOT NULL
  `
  return rows.map((r) => r.ref).filter((r): r is string => !!r)
}
