import { injectDocumentContext, type PuckLikeData } from '@/lib/documents/context'

// Context injected onto every purchase-order-document part-block before the
// layout renders, and the injector that puts it there. The page loads the order
// once, attaches it by reference, and each part renders its own slice with no
// re-fetch.
//
// In the Puck editor canvas `_ctx` is undefined and each part draws a sample
// order instead - the canvas has no purchase order, and an owner dragging blocks
// around needs to see the shape of the thing they are designing.
//
// CLIENT-SAFE, and it has to stay that way: the blocks import the sample from
// here and they are in the editor bundle. Nothing in this file may reach the
// database, next/headers, or any module's server code. Gathering the real thing
// is lib/document.tsx's job.

/** One side of the order: who is buying, or who is supplying. Every field is a
 *  string, and a blank one is simply left off the page rather than printed as an
 *  empty line - a business that has not filled in its VAT number does not want a
 *  document that says "VAT registration". */
export type PoDocParty = {
  name: string
  addressLines: string[]
  contactName: string
  email: string
  phone: string
  vatNumber: string
  companyNumber: string
  /** Our account with them, on the supplier side. Blank on the buyer's. */
  accountNumber: string
}

/** Money and quantities are STRINGS the whole way from the numeric column to the
 *  page. A JSON float is how a unit cost of 1.005 becomes 1.0049999999999999. */
export type PoDocLine = {
  id: string
  description: string
  productName: string | null
  supplierSku: string | null
  ourSku: string | null
  qty: string
  unit: string
  unitCost: string
  discountPercent: string | null
  taxRatePercent: string
  lineTotal: string
  expectedDate: string | null
  qtyCancelled: string
  /** The delivery service this line has to be sent on. The cost is deliberately
   *  not projected: what the supplier is owed for carriage is the order's own
   *  carriageAmount, and a second per-line figure beside it only confuses. */
  serviceName: string | null
}

export type PoDocShipTo = {
  name: string
  contact: string
  phone: string
  addressLines: string[]
  instructions: string
}

export type PoDocOrder = {
  number: string
  revision: number
  status: string
  statusLabel: string
  currency: string
  taxMode: 'EXCLUSIVE' | 'INCLUSIVE'
  raisedDate: string | null
  requiredByDate: string | null
  expectedDate: string | null
  paymentTerms: string
  deliveryTerms: string
  notesSupplier: string
  subtotal: string
  discountAmount: string
  carriageAmount: string
  taxAmount: string
  total: string
  lines: PoDocLine[]
  shipTo: PoDocShipTo
  /** Who signed it off, where anybody did. A purchase order is an instruction to
   *  spend money, and the name against it is half of why a supplier accepts it. */
  raisedByName: string
  approvedByName: string
  approvedAt: string | null
}

export type PoDocContext = {
  order: PoDocOrder
  /** Us. From this module's own settings, falling back to the shop's trading
   *  identity where a shop is installed - nobody should type their VAT number
   *  into two settings screens and keep them in step by hand. */
  buyer: PoDocParty
  /** Them, as the order has them. Frozen into the order's supplier snapshot once
   *  it has gone out, so a later rename or deletion cannot rewrite paperwork the
   *  supplier already holds. */
  supplier: PoDocParty
  site: { name: string; logoUrl: string | null; url: string }
  /** Wording from Purchase Orders settings, resolved once. */
  copy: { heading: string; intro: string; terms: string; footerNote: string }
  /** True while rendering for the PDF. Parts use it to drop anything that only
   *  makes sense on screen - there is nothing to click in a PDF. */
  print: boolean
}

// Every block that reads the order. The style block and the divider are not here
// on purpose: neither prints a figure, so neither needs the document, and
// attaching it to them would only make the injected tree bigger.
export const PO_DOC_PART_TYPES = [
  'PoDocHeader',
  'PoDocParties',
  'PoDocFrom',
  'PoDocTo',
  'PoDocShipTo',
  'PoDocLines',
  'PoDocTotals',
  'PoDocTerms',
  'PoDocNotes',
  'PoDocApproval',
  'PoDocNotice',
]

/** Clones the saved layout (pure JSON) and attaches the context by reference, so
 *  one object is shared by every part rather than serialised per block. The walk
 *  itself is core's; what stays here is which blocks read an order. */
export function injectPoDocContext<T extends PuckLikeData>(data: T, ctx: PoDocContext): T {
  return injectDocumentContext(data, ctx, PO_DOC_PART_TYPES)
}

/** The sample order the editor canvas draws, so somebody designing the document
 *  sees a filled-in one rather than ten empty boxes. Deliberately obvious
 *  placeholder data - nobody should mistake it for a real supplier. */
export const SAMPLE_PO_CONTEXT: PoDocContext = {
  order: {
    number: 'PO-00147',
    revision: 1,
    status: 'SENT',
    statusLabel: 'Sent',
    currency: 'GBP',
    taxMode: 'EXCLUSIVE',
    raisedDate: '2026-04-06',
    requiredByDate: '2026-04-27',
    expectedDate: '2026-04-24',
    paymentTerms: 'Net 30',
    deliveryTerms: 'Delivered, carriage paid',
    notesSupplier: 'Please book the delivery in with the site contact before it leaves you.',
    subtotal: '2640.00',
    discountAmount: '0.00',
    carriageAmount: '45.00',
    taxAmount: '537.00',
    total: '3222.00',
    lines: [
      {
        id: 'sample-1',
        description: 'Oak desk 1600mm, silver legs',
        productName: 'Oak desk 1600mm',
        supplierSku: 'ND-1600-OAK',
        ourSku: 'DSK-1600-OAK',
        qty: '12.000',
        unit: 'each',
        unitCost: '165.0000',
        discountPercent: null,
        taxRatePercent: '20.00',
        lineTotal: '1980.00',
        expectedDate: '2026-04-24',
        qtyCancelled: '0.000',
        serviceName: 'Pre-assembled delivery',
      },
      {
        id: 'sample-2',
        description: 'Task chair, black mesh back',
        productName: 'Task chair',
        supplierSku: 'ND-TASK-BLK',
        ourSku: 'CHR-TASK-BLK',
        qty: '12.000',
        unit: 'each',
        unitCost: '55.0000',
        discountPercent: '0.00',
        taxRatePercent: '20.00',
        lineTotal: '660.00',
        expectedDate: null,
        qtyCancelled: '0.000',
        serviceName: null,
      },
    ],
    shipTo: {
      name: 'Sample Customer Ltd',
      contact: 'Site office',
      phone: '0113 496 0000',
      addressLines: ['Unit 4, Example Business Park', 'Leeds', 'LS1 1AA'],
      instructions: 'Deliveries between 8am and 3pm. Tail lift needed.',
    },
    raisedByName: 'Sample Buyer',
    approvedByName: 'Sample Approver',
    approvedAt: '2026-04-06T11:20:00.000Z',
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
    heading: 'Purchase order',
    intro: 'Please supply the following, quoting our order number on all paperwork.',
    terms: 'Invoices must quote this order number. Goods not ordered will be returned at your cost.',
    footerNote: '',
  },
  print: false,
}
