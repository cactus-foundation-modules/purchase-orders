import { z } from 'zod'

import { WEB_ADDRESS_MESSAGE, webAddress } from '@/modules/purchase-orders/lib/web-address'

// What a supplier is allowed to post through the portal, and nothing else.
//
// A discriminated union rather than one loose object with everything optional:
// the things they can say have different shapes, and a union is what stops
// "message" arriving with a lines array that some later edit starts trusting.
// Every string is bounded - this endpoint takes writes from anybody holding a
// link, and an unbounded text field is a free jsonb column on somebody else's
// site.

const TOKEN = z.string().min(1).max(200)
const NOTE = z.string().max(500).optional()

/** Plain YYYY-MM-DD. Kept as a string the whole way rather than parsed to a Date
 *  and formatted back, which is how a delivery date moves a day in the summer. */
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'That is not a date we can read.')

/** A quantity as typed: up to three decimals, matching po_order_lines.qty. */
const QTY = z.string().regex(/^\d{1,9}(\.\d{1,3})?$/, 'That is not a quantity we can read.')

/** A tracking page as typed, normalised to an http(s) address - or refused. An
 *  empty box is "not given" rather than a complaint. */
const TRACKING_URL = z
  .string()
  .max(500)
  .refine((value) => value.trim() === '' || webAddress(value) !== null, WEB_ADDRESS_MESSAGE)
  .transform((value) => webAddress(value))

const LINE_ID = z.string().min(1).max(64)

export const PortalActionBody = z.discriminatedUnion('action', [
  z.object({
    token: TOKEN,
    action: z.literal('acknowledge'),
    note: NOTE,
    /** Their own acknowledgement number, where they quote one. The document
     *  itself goes up the multipart route - a file cannot ride on JSON. */
    ref: z.string().max(120).optional(),
  }),
  z.object({
    token: TOKEN,
    action: z.literal('propose-date'),
    // Per LINE, because a supplier who ships an order in three drops has three
    // answers and one box for all of them was never the truth. At least one, and
    // a ceiling that matches the shortage form's.
    lines: z
      .array(z.object({ lineId: LINE_ID, date: DAY }))
      .min(1, 'Put a date against at least one line.')
      .max(200),
    note: NOTE,
  }),
  z.object({
    token: TOKEN,
    action: z.literal('shortage'),
    // At least one line, and a sane ceiling: an order with more than two hundred
    // lines short is a phone call, not a form.
    lines: z
      .array(z.object({ lineId: LINE_ID, qty: QTY }))
      .min(1, 'Say which line is short.')
      .max(200),
    note: NOTE,
  }),
  z.object({
    token: TOKEN,
    action: z.literal('despatch'),
    date: DAY,
    lines: z
      .array(z.object({ lineId: LINE_ID, qty: QTY }))
      .min(1, 'Tick what you have sent.')
      .max(200),
    carrier: z.string().max(120).optional(),
    trackingRef: z.string().max(200).optional(),
    // Their own tracking page. Rendered as a link nowhere a customer sees - it
    // goes on the order screen in the admin, for somebody in this building to
    // click, which is exactly why it goes through webAddress() rather than
    // zod's .url(): that one waves javascript: straight through.
    trackingUrl: TRACKING_URL.optional(),
    note: NOTE,
  }),
  z.object({
    token: TOKEN,
    action: z.literal('message'),
    text: z.string().min(1, 'There is nothing to send.').max(2000),
    // Which lines they are talking about, when it is not the whole order.
    // Absent or empty means the whole order, which is the ordinary case and the
    // panel's own default - so an older page that sends neither still works.
    lines: z.array(LINE_ID).max(200).optional(),
  }),
])

export type PortalAction = z.infer<typeof PortalActionBody>

/** The fields that ride ALONGSIDE a file on the multipart upload. The file
 *  itself is pulled off the form and checked in lib/portal-upload.ts. */
export const PortalUploadFields = z.object({
  token: TOKEN,
  kind: z.enum(['proforma', 'acknowledgement']),
  ref: z.string().max(120).optional(),
  /** What their proforma is for, as they typed it. Money as a string all the way
   *  into the numeric column, like everywhere else in this module. */
  amount: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,2})?$/, 'That amount does not look right.')
    .optional(),
  note: NOTE,
})

export type PortalUploadFieldsInput = z.infer<typeof PortalUploadFields>

/**
 * The fields that ride alongside a supplier's own VAT invoice.
 *
 * Its own schema rather than another branch of the upload's, because the two
 * have nothing in common past the token: one files a document against the order,
 * this one writes down what we owe somebody.
 *
 * Everything except the token and the lines is optional, and deliberately: the
 * number, the date and the total are read off the document where the document
 * can be read, and a supplier who has to type all three is a supplier who
 * emails it instead. Where nothing can be read, the panel asks for the number
 * and nothing else.
 */
export const PortalInvoiceFields = z.object({
  token: TOKEN,
  /** Their invoice number. Blank falls back to whatever the document says. */
  ref: z.string().max(120).optional(),
  /** The invoice date as printed. Blank falls back to the document, then today. */
  date: DAY.optional(),
  /** What their invoice says it comes to, including VAT. Never used as a
   *  figure - it is compared against our own arithmetic over the order's
   *  prices, and where the two disagree the bill says so. */
  total: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,2})?$/, 'That total does not look right.')
    .optional(),
  lines: z
    .array(z.object({ lineId: LINE_ID, qty: QTY }))
    .min(1, 'Tick what this invoice covers.')
    .max(200),
  note: NOTE,
})

export type PortalInvoiceFieldsInput = z.infer<typeof PortalInvoiceFields>

/** The lines of a multipart invoice form, which arrive as one JSON string
 *  because a form field cannot carry an array. Anything unreadable comes back as
 *  an empty list, which the schema above then refuses in plain English. */
export function portalInvoiceLinesField(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
