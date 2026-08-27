import { z } from 'zod'

// The return form. Same rule as everywhere else in this module: quantities and
// money are STRINGS from the browser to the numeric column, because a JSON float
// is how a unit cost of 1.005 arrives as 1.0049999999999999 and a credit claim
// comes out a pound under what the order said.

const Qty = z.string().regex(/^\d{1,10}(\.\d{1,3})?$/, 'Quantities can have up to three decimal places')

export const ReturnLineBody = z.object({
  orderLineId: z.string().min(1),
  // Which delivery these came in on. Optional, because a return can be raised
  // straight off an order line - but it is what decides whether the goods can
  // come off a stock count, so the screen fills it in wherever it can.
  receiptLineId: z.string().max(100).nullable().default(null),
  qty: Qty.default('0'),
})

export const ReturnBody = z.object({
  reason: z.string().max(2000).nullable().default(null),
  raisedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates need to look like 2026-08-27'),
  notes: z.string().max(5000).nullable().default(null),
  lines: z.array(ReturnLineBody).min(1, 'A return needs at least one line'),
})

export type ReturnBodyInput = z.infer<typeof ReturnBody>

/** Lines with nothing on them are dropped rather than stored. The screen shows
 *  every line that ever arrived so somebody can tick down what is going back,
 *  and most of them will be left at zero. */
export function returnDrafts(body: ReturnBodyInput): { orderLineId: string; receiptLineId: string | null; qty: string }[] {
  return body.lines
    .filter((line) => Number(line.qty) > 0)
    .map((line) => ({
      orderLineId: line.orderLineId,
      receiptLineId: (line.receiptLineId ?? '').trim() || null,
      qty: line.qty,
    }))
}

export function orNull(value: string | null): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/** Recording the supplier's credit when it arrives. */
export const ReturnTransitionBody = z.object({
  transition: z.string().min(1),
  creditReceived: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,2})?$/, 'Amounts need to look like 12.34')
    .nullable()
    .default(null),
  creditRef: z.string().max(200).nullable().default(null),
  note: z.string().max(2000).nullable().default(null),
})
