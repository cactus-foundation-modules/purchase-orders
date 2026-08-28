import { z } from 'zod'

import { WEB_ADDRESS_MESSAGE, webAddress } from '@/modules/purchase-orders/lib/web-address'

// The despatch form, from this side of it: somebody here typing in what the
// supplier has just emailed to say has left them.
//
// Same rule as every other form in this module - quantities are STRINGS all the
// way from the browser to the numeric column, because a JSON float is how 0.3 of
// a metre becomes 0.30000000000000004 and a delivery note stops adding up.
//
// Deliberately NOT shared with the portal's own `despatch` action in
// lib/portal-body.ts. That one is a member of a discriminated union carrying a
// token and taking writes from outside the building; this one arrives on a route
// that already knows which order it is on and who is signed in. Squeezing both
// through one schema would mean a token field nobody sends and an order id the
// portal must never be allowed to name.

/**
 * A quantity as typed, up to three decimals - and an EMPTY box read as none.
 *
 * The delivery form's own Qty does not tolerate a blank, and does not need to:
 * booking a delivery in pre-fills every line with what is outstanding, because
 * "it all came" is the overwhelmingly common case. A despatch is the opposite -
 * a supplier emailing to say two of eleven lines have gone - so the boxes start
 * empty, and nine blanks must mean nine noughts rather than a 400.
 */
const Qty = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,3})?$/, 'Quantities can have up to three decimal places')
  .or(z.literal('').transform(() => '0'))

export const ShipmentLineBody = z.object({
  orderLineId: z.string().min(1).max(64),
  qty: Qty.default('0'),
})

export const ShipmentBody = z.object({
  despatchedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates need to look like 2026-08-27'),
  carrier: z.string().max(120).nullable().default(null),
  trackingRef: z.string().max(200).nullable().default(null),
  // Their own tracking page. Only ever rendered as a link on the order screen,
  // for somebody in this building to click - it never reaches the packing slip.
  // webAddress() rather than zod's .url() because .url() is happy with
  // javascript:, and this string becomes an href on a page behind the login.
  trackingUrl: z
    .string()
    .max(500)
    .nullable()
    .default(null)
    .refine((value) => value === null || value.trim() === '' || webAddress(value) !== null, WEB_ADDRESS_MESSAGE)
    .transform((value) => webAddress(value)),
  notes: z.string().max(2000).nullable().default(null),
  lines: z.array(ShipmentLineBody).min(1, 'A despatch needs at least one line').max(200),
})

export type ShipmentBodyInput = z.infer<typeof ShipmentBody>

/** Empty strings out of an HTML form mean "not given", not "given as blank". */
function orNull(value: string | null): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/**
 * The lines worth storing, with the blanks dropped.
 *
 * The screen shows every outstanding line so somebody can tick down the email in
 * front of them, and most will be left at zero on a part despatch. Storing those
 * would put a row against an order line for a delivery that did not contain it -
 * which then holds an ON DELETE RESTRICT lock on that line for no reason at all.
 *
 * What is NOT done here is the clamp against what is actually outstanding. That
 * needs the database, so it happens in the route, using the same
 * `despatchableLines` the supplier's own page is clamped against - one rule, one
 * place, and no chance of the two paths disagreeing about what is left to send.
 */
export function shipmentLinesFrom(body: ShipmentBodyInput): { orderLineId: string; qty: string }[] {
  return body.lines
    .filter((line) => Number(line.qty) > 0)
    .map((line) => ({ orderLineId: line.orderLineId, qty: line.qty }))
}

export function shipmentHeaderFrom(body: ShipmentBodyInput): {
  despatchedDate: string
  carrier: string | null
  trackingRef: string | null
  trackingUrl: string | null
  notes: string | null
} {
  return {
    despatchedDate: body.despatchedDate,
    carrier: orNull(body.carrier),
    trackingRef: orNull(body.trackingRef),
    trackingUrl: orNull(body.trackingUrl),
    notes: orNull(body.notes),
  }
}
