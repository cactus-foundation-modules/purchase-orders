import { z } from 'zod'

// What a supplier is allowed to post through the portal, and nothing else.
//
// A discriminated union rather than one loose object with everything optional:
// the four things they can say have four different shapes, and a union is what
// stops "message" arriving with a lines array that some later edit starts
// trusting. Every string is bounded - this endpoint takes writes from anybody
// holding a link, and an unbounded text field is a free jsonb column on somebody
// else's site.

const TOKEN = z.string().min(1).max(200)
const NOTE = z.string().max(500).optional()

/** Plain YYYY-MM-DD. Kept as a string the whole way rather than parsed to a Date
 *  and formatted back, which is how a delivery date moves a day in the summer. */
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'That is not a date we can read.')

/** A quantity as typed: up to three decimals, matching po_order_lines.qty. */
const QTY = z.string().regex(/^\d{1,9}(\.\d{1,3})?$/, 'That is not a quantity we can read.')

export const PortalActionBody = z.discriminatedUnion('action', [
  z.object({
    token: TOKEN,
    action: z.literal('acknowledge'),
    note: NOTE,
  }),
  z.object({
    token: TOKEN,
    action: z.literal('propose-date'),
    date: DAY,
    note: NOTE,
  }),
  z.object({
    token: TOKEN,
    action: z.literal('shortage'),
    // At least one line, and a sane ceiling: an order with more than two hundred
    // lines short is a phone call, not a form.
    lines: z
      .array(z.object({ lineId: z.string().min(1).max(64), qty: QTY }))
      .min(1, 'Say which line is short.')
      .max(200),
    note: NOTE,
  }),
  z.object({
    token: TOKEN,
    action: z.literal('message'),
    text: z.string().min(1, 'There is nothing to send.').max(2000),
  }),
])

export type PortalAction = z.infer<typeof PortalActionBody>
