import { prisma } from '@/lib/db/prisma'

// Provider for the core.media-usage-providers extension point.
//
// A supplier's invoice attached to a bill is a plain Media id on a po_ table
// core has no sight of. Without this the library would count every one of them
// as unused clutter and offer them up for a tidy - and a purchase invoice is
// the evidence behind an expense, which HMRC expect kept for six years. The
// media clean-up is not allowed to be the thing that loses it.
export async function purchaseOrdersMediaUsageProvider(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ ref: string | null }[]>`
    SELECT "attachment_media_id" AS ref FROM "po_bills" WHERE "attachment_media_id" IS NOT NULL
  `
  return rows.map((r) => r.ref).filter((r): r is string => !!r)
}
