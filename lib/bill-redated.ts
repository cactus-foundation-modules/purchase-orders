// The books moved a bill's tax point; the bill follows.
//
// uk-bookkeeping publishes `uk-bookkeeping.entry-redated` when the owner corrects
// the date on an entry. If that entry is one of this module's approved bills, the
// bill's invoice date is brought into line, so the bill screen and shop's Reports
// > Profits show the date the books hold. Nothing here imports the books: the
// payload is restated, and the books' entry is recognised by the reference this
// module itself gave it (`bill:<id>`).
import { prisma } from '@/lib/db/prisma'

type EntryRedatedPayload = {
  source: string
  sourceRef: string
  taxPointDate: string
  previousTaxPointDate: string
}

export async function purchaseOrdersBillRedated(payload: EntryRedatedPayload): Promise<void> {
  if (payload.source !== 'purchase-orders') return
  const match = /^bill:(.+)$/.exec(payload.sourceRef ?? '')
  if (!match || !/^\d{4}-\d{2}-\d{2}$/.test(payload.taxPointDate)) return
  await prisma.$executeRaw`
    UPDATE "po_bills"
       SET "invoice_date" = ${payload.taxPointDate}::date, "updated_at" = now()
     WHERE "id" = ${match[1]}
       AND "status" IN ('APPROVED', 'POSTED')
       AND "invoice_date" IS DISTINCT FROM ${payload.taxPointDate}::date
  `
}
