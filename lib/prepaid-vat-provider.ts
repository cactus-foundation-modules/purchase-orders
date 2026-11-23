// VAT already paid to suppliers up front, for the books' "VAT this period"
// estimate - contributed to uk-bookkeeping's `uk-bookkeeping.prepaid-vat` point.
// Server-only: it reads this module's own tables and nothing else.
//
// When a supplier on proforma terms is paid before they invoice, the payment is
// the tax point. The VAT on it is reclaimable in the period the money left, but
// the books do not hear about it until the supplier's invoice turns up and is
// approved - often weeks later, sometimes the next quarter. Until then the
// overview's running figure overstates what is owed to HMRC. This hands over
// the gap: one row per paid order, dated to the day it was paid.
//
// The day paid is `proforma_proof_paid_on` (the date typed beside the proof of
// payment, the same date an approved bill is re-dated to), else the day the
// payment was marked, in the site's own timezone.
//
// The VAT is the order's own tax, scaled to the proforma where the supplier's
// figure differs from the order total, in the site's currency at the order's
// rate. VAT on bills against the order that the books have already taken
// (status POSTED) is subtracted, so nothing is counted twice: once every bill is
// in the books, the order drops out. A cancelled order is left out.
//
// Nothing here imports '@/modules/uk-bookkeeping/...'. The shape is restated,
// and the books Zod-check it on arrival.
import { prisma } from '@/lib/db/prisma'
import { getSiteTimezone } from '@/lib/config/timezone.server'

export type PrepaidVatRange = { from: string; to: string }
export type PrepaidVatItem = { ref: string; label: string; paidOn: string; vat: string }

const DAY = /^\d{4}-\d{2}-\d{2}$/

export async function purchaseOrdersPrepaidVat(range: PrepaidVatRange): Promise<PrepaidVatItem[]> {
  if (!DAY.test(range?.from ?? '') || !DAY.test(range?.to ?? '')) return []
  const timezone = await getSiteTimezone()

  const rows = await prisma.$queryRaw<{ id: string; number: string; supplier: string | null; paid_on: string; vat: string }[]>`
    WITH paid AS (
      SELECT o."id", o."number", s."name" AS supplier,
             COALESCE(o."proforma_proof_paid_on", (o."proforma_paid_at" AT TIME ZONE ${timezone})::date) AS paid_on,
             (CASE WHEN o."proforma_amount" IS NOT NULL AND o."total" > 0
                   THEN o."tax_amount" * o."proforma_amount" / o."total"
                   ELSE o."tax_amount" END) * o."fx_rate" AS paid_vat,
             COALESCE((SELECT SUM(b."tax_amount" * b."fx_rate")
                         FROM "po_bills" b
                        WHERE b."order_id" = o."id" AND b."status" = 'POSTED'), 0) AS booked_vat
        FROM "po_orders" o
        LEFT JOIN "po_suppliers" s ON s."id" = o."supplier_id"
       WHERE (o."proforma_proof_paid_on" IS NOT NULL OR o."proforma_paid_at" IS NOT NULL)
         AND o."status" <> 'CANCELLED'
    )
    SELECT "id", "number", supplier,
           to_char(paid_on, 'YYYY-MM-DD') AS paid_on,
           ROUND(GREATEST(paid_vat - booked_vat, 0), 2)::text AS vat
      FROM paid
     WHERE paid_on BETWEEN ${range.from}::date AND ${range.to}::date
       AND ROUND(GREATEST(paid_vat - booked_vat, 0), 2) > 0
     ORDER BY paid_on, "number"
  `

  return rows.map((row) => ({
    ref: `order:${row.id}`,
    label: row.supplier ? `${row.number} - ${row.supplier}` : row.number,
    paidOn: row.paid_on,
    vat: row.vat,
  }))
}
