import { injectDocumentContext, type PuckLikeData } from '@/lib/documents/context'
import type { PoDocParty } from './doc-context'

// Context injected onto every returns-note part-block before the layout renders.
// Exactly the shape lib/doc-context.ts has for the purchase order, and a
// separate one on purpose: a return is a different document with a different
// job. Reusing the order's context would have meant every returns block reading
// `order.total` and quietly meaning "the credit we are owed", which is the kind
// of thing that reads fine until somebody prints it.
//
// The two parties are the same shape, so `PoDocParty` is shared rather than
// copied - a return goes from the same business to the same supplier.
//
// CLIENT-SAFE, and it has to stay that way: the blocks import the sample from
// here and they are in the editor bundle. Nothing in this file may reach the
// database, next/headers, or any module's server code.

/** Money and quantities are STRINGS the whole way from the numeric column to the
 *  page, for the same reason they are on the order. */
export type PoRetDocLine = {
  id: string
  description: string
  supplierSku: string | null
  qty: string
  unit: string
  unitCost: string
  taxRatePercent: string
  lineTotal: string
  /** Which delivery these came in on, where anybody said. */
  receiptNumber: string | null
}

export type PoRetDoc = {
  number: string
  status: string
  statusLabel: string
  raisedDate: string | null
  /** The order these came off. A supplier's returns desk finds nothing without it. */
  orderNumber: string
  orderDate: string | null
  /** Why they are going back, in whatever words somebody typed. */
  reason: string
  notes: string
  currency: string
  subtotal: string
  taxAmount: string
  /** What the supplier is being asked to credit. */
  creditExpected: string
  /** Their credit note reference, once one has arrived. */
  creditRef: string
  lines: PoRetDocLine[]
  raisedByName: string
}

export type PoRetDocContext = {
  ret: PoRetDoc
  /** Us: the business sending the goods back. */
  buyer: PoDocParty
  /** Them: the supplier being asked for the credit. */
  supplier: PoDocParty
  site: { name: string; logoUrl: string | null; url: string }
  /** Wording from Purchase Orders settings, resolved once. */
  copy: { heading: string; intro: string; terms: string; footerNote: string }
  /** True while rendering for the PDF. */
  print: boolean
}

// Every block that reads the return. The style block and the divider are not
// here on purpose: neither prints a figure, so neither needs the document.
export const PO_RET_PART_TYPES = [
  'PoRetHeader',
  'PoRetParties',
  'PoRetTo',
  'PoRetLines',
  'PoRetTotals',
  'PoRetReason',
  'PoRetNotes',
  'PoRetNotice',
]

/** Clones the saved layout and attaches the context by reference, so one object
 *  is shared by every part rather than serialised per block. */
export function injectPoRetDocContext<T extends PuckLikeData>(data: T, ctx: PoRetDocContext): T {
  return injectDocumentContext(data, ctx, PO_RET_PART_TYPES)
}

/** The sample the editor canvas draws, so somebody designing the note sees a
 *  filled-in one rather than eight empty boxes. Deliberately obvious placeholder
 *  data - nobody should mistake it for a real supplier. */
export const SAMPLE_PO_RET_CONTEXT: PoRetDocContext = {
  ret: {
    number: 'SRN-00014',
    status: 'SENT',
    statusLabel: 'Sent',
    raisedDate: '2026-05-11',
    orderNumber: 'PO-00147',
    orderDate: '2026-04-06',
    reason: 'Two desks arrived with the tops scratched through the lacquer. Photographs sent to your sales desk on the 9th.',
    notes: 'Collected by your own carrier. Please credit against the original order number.',
    currency: 'GBP',
    subtotal: '330.00',
    taxAmount: '66.00',
    creditExpected: '396.00',
    creditRef: '',
    lines: [
      {
        id: 'sample-1',
        description: 'Oak desk 1600mm, silver legs',
        supplierSku: 'ND-1600-OAK',
        qty: '2.000',
        unit: 'each',
        unitCost: '165.0000',
        taxRatePercent: '20.00',
        lineTotal: '330.00',
        receiptNumber: 'GRN-00032',
      },
    ],
    raisedByName: 'Sample Buyer',
  },
  buyer: {
    name: 'Your business name',
    addressLines: ['12 Example Street', 'Leeds', 'LS1 1AA'],
    contactName: 'Purchasing',
    email: 'purchasing@example.com',
    phone: '0113 496 0000',
    vatNumber: 'GB 123 4567 89',
    companyNumber: '01234567',
    accountNumber: '',
  },
  supplier: {
    name: 'Northern Clay Co.',
    addressLines: ['Unit 9, Example Trading Estate', 'Bradford', 'BD1 2AB'],
    contactName: 'Sales desk',
    email: 'orders@example-supplier.com',
    phone: '01274 000 000',
    vatNumber: 'GB 987 6543 21',
    companyNumber: '07654321',
    accountNumber: 'ACC-0042',
  },
  site: { name: 'Your site', logoUrl: null, url: 'https://example.com' },
  copy: {
    heading: 'Returns note',
    intro: 'The goods below are being returned to you. Please raise a credit note against our order number.',
    terms: 'Credits are expected within 30 days of collection. Goods are returned in the condition they arrived in.',
    footerNote: '',
  },
  print: false,
}
