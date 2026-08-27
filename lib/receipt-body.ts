import { z } from 'zod'
import type { ReceiptInput } from './receipts'

// The delivery form. Same rule as the order form: quantities are STRINGS all
// the way from the browser to the numeric column, because a JSON float is how
// 0.3 of a metre becomes 0.30000000000000004 and a delivery note stops adding up.

const Qty = z.string().regex(/^\d{1,10}(\.\d{1,3})?$/, 'Quantities can have up to three decimal places')

export const ReceiptLineBody = z.object({
  orderLineId: z.string().min(1),
  qtyAccepted: Qty.default('0'),
  qtyRejected: Qty.default('0'),
  rejectReason: z.string().max(500).nullable().default(null),
  conditionNote: z.string().max(1000).nullable().default(null),
})

export const ReceiptBody = z.object({
  receivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates need to look like 2026-08-27'),
  deliveryNoteRef: z.string().max(200).nullable().default(null),
  carrier: z.string().max(200).nullable().default(null),
  notes: z.string().max(5000).nullable().default(null),
  // Whether to put the goods onto the shelf as well as onto the paperwork.
  // The screen only offers it when the site has both switched it on and
  // something to switch it on with; the route checks again anyway.
  applyStock: z.boolean().default(false),
  lines: z.array(ReceiptLineBody).min(1, 'A delivery needs at least one line'),
})

export type ReceiptBodyInput = z.infer<typeof ReceiptBody>

function orNull(value: string | null): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Lines with nothing on them at all are dropped rather than stored.
 *
 * The screen shows every outstanding line so somebody can tick down the
 * delivery note, and most of them will be left at zero on a part delivery.
 * Storing those would put a row against an order line for a delivery that did
 * not contain it - which then holds an ON DELETE RESTRICT lock on that line for
 * no reason at all.
 */
export function toReceiptInput(orderId: string, body: ReceiptBodyInput): ReceiptInput {
  return {
    orderId,
    receivedDate: body.receivedDate,
    deliveryNoteRef: orNull(body.deliveryNoteRef),
    carrier: orNull(body.carrier),
    notes: orNull(body.notes),
    lines: body.lines
      .filter((line) => Number(line.qtyAccepted) > 0 || Number(line.qtyRejected) > 0)
      .map((line) => ({
        orderLineId: line.orderLineId,
        qtyAccepted: line.qtyAccepted,
        qtyRejected: line.qtyRejected,
        rejectReason: orNull(line.rejectReason),
        conditionNote: orNull(line.conditionNote),
      })),
  }
}
