import { injectDocumentContext, type PuckLikeData } from '@/lib/documents/context'
import type { PoDocParty, PoDocShipTo } from './doc-context'

// Context injected onto every packing-slip part-block before the layout renders.
// Same shape as the order's and the returns note's, and a separate one for the
// same reason: this is a third piece of paper doing a third job.
//
// WHAT A PACKING SLIP IS FOR, because it decides every field below. It goes IN
// THE BOX. On a drop-shipped order the person who opens that box is our
// CUSTOMER, not us and not the supplier. So:
//
//  - There is no money on it anywhere. Not a unit cost, not a line total, not a
//    carriage figure, not an order total. There is no field here to print one
//    from, which is the only way to be sure no block ever does.
//  - The SUPPLIER is not named on it. They are the ones printing it and putting
//    it in the box; the customer opening it should see who they bought from,
//    which is us. There is no supplier party in this context at all.
//  - It lists what is in THIS delivery, not what is on the order. An order sent
//    in three drops gets three slips, each one honest about its own box.
//
// CLIENT-SAFE, and it has to stay that way: the blocks import the sample from
// here and they are in the editor bundle. Nothing in this file may reach the
// database, next/headers, or any module's server code.

/** One line of this delivery. Quantities are STRINGS the whole way from the
 *  numeric column to the page, like everywhere else in this module. */
export type PoPsLine = {
  id: string
  description: string
  /** Our own code for it. The one code a customer might quote back at us. */
  ourSku: string | null
  /** The supplier's code. Off by default on the printed slip - it is their
   *  reference, not ours, and a customer reading it has nothing to do with it -
   *  but it is here for a business shipping to its own yard. */
  supplierSku: string | null
  qty: string
  unit: string
  /** How many were ordered in total, for a slip that wants to say "2 of 6". */
  qtyOrdered: string
}

export type PoPsDoc = {
  /** The despatch number - DSP-00007 - which is what this slip is filed under. */
  number: string
  despatchedDate: string
  /** The order it is part of. The one reference everybody involved recognises. */
  orderNumber: string
  orderDate: string | null
  /** Our own reference for the customer order behind it, where there is one. */
  customerReference: string
  carrier: string
  trackingRef: string
  notes: string
  lines: PoPsLine[]
  /** True when there is still something to come on this order, so the slip can
   *  say so rather than leaving somebody counting a box against an order. */
  partial: boolean
}

export type PoPsDocContext = {
  slip: PoPsDoc
  /** Us: whoever the customer thinks they bought from. There is deliberately no
   *  supplier party on this document - see the note at the top. */
  buyer: PoDocParty
  /** Where the box is going. */
  shipTo: PoDocShipTo
  site: { name: string; logoUrl: string | null; url: string }
  /** Wording from Purchase Orders settings, resolved once. */
  copy: { heading: string; intro: string; terms: string; footerNote: string }
  /** True while rendering for the PDF. */
  print: boolean
}

// Every block that reads the slip. The style block and the divider are not here
// on purpose: neither prints a figure, so neither needs the document.
export const PO_PS_PART_TYPES = [
  'PoPsHeader',
  'PoPsFrom',
  'PoPsShipTo',
  'PoPsLines',
  'PoPsTracking',
  'PoPsNotes',
]

/** Clones the saved layout and attaches the context by reference, so one object
 *  is shared by every part rather than serialised per block. */
export function injectPoPsDocContext<T extends PuckLikeData>(data: T, ctx: PoPsDocContext): T {
  return injectDocumentContext(data, ctx, PO_PS_PART_TYPES)
}

/** The sample the editor canvas draws, so somebody designing the slip sees a
 *  filled-in one rather than six empty boxes. Deliberately obvious placeholder
 *  data - nobody should mistake it for a real delivery. */
export const SAMPLE_PO_PS_CONTEXT: PoPsDocContext = {
  slip: {
    number: 'DSP-00007',
    despatchedDate: '2026-04-21',
    orderNumber: 'PO-00147',
    orderDate: '2026-04-06',
    customerReference: 'SO-10432',
    carrier: 'Palletways',
    trackingRef: 'PW-88213445',
    notes: 'Two boxes on one pallet. The chairs follow next week.',
    partial: true,
    lines: [
      {
        id: 'sample-1',
        description: 'Oak desk 1600mm, silver legs',
        ourSku: 'DSK-1600-OAK',
        supplierSku: 'ND-1600-OAK',
        qty: '8.000',
        unit: 'each',
        qtyOrdered: '12.000',
      },
      {
        id: 'sample-2',
        description: 'Desk cable tray, 1600mm',
        ourSku: 'ACC-TRAY-1600',
        supplierSku: 'ND-TRAY-16',
        qty: '8.000',
        unit: 'each',
        qtyOrdered: '8.000',
      },
    ],
  },
  buyer: {
    name: 'Your business name',
    addressLines: ['12 Example Street', 'Leeds', 'LS1 1AA'],
    contactName: 'Customer service',
    email: 'hello@example.com',
    phone: '0113 496 0000',
    vatNumber: 'GB 123 4567 89',
    companyNumber: '01234567',
    accountNumber: '',
  },
  shipTo: {
    name: 'Sample Customer Ltd',
    contact: 'Site office',
    phone: '0113 496 0000',
    addressLines: ['Unit 4, Example Business Park', 'Leeds', 'LS1 1AA'],
    country: 'GB',
    instructions: 'Deliveries between 8am and 3pm. Tail lift needed.',
  },
  site: { name: 'Your site', logoUrl: null, url: 'https://example.com' },
  copy: {
    heading: 'Packing slip',
    intro: 'Everything in this delivery is listed below. Please check it against the goods and tell us straight away if anything is missing or damaged.',
    terms: '',
    footerNote: '',
  },
  print: false,
}
