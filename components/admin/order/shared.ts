import type { PoPortalAdminEvent, PoPortalTokenSummary } from '@/modules/purchase-orders/lib/portal-view'

// Types the order screen and its cards pass between them.

/** The documents filed against an order, resolved to something clickable: the
 *  two the supplier sends us, and the proof of payment that goes the other way.
 *  The order row holds a Media id and nothing else - core owns that table - so
 *  the link is looked up on the server rather than being a column here that
 *  could drift out of step with the library. */
export type SupplierDocument = { url: string; originalName: string | null; mimeType: string | null }
export type SupplierDocuments = {
  proforma: SupplierDocument | null
  acknowledgement: SupplierDocument | null
  paymentProof: SupplierDocument | null
}

export const NO_DOCUMENTS: SupplierDocuments = { proforma: null, acknowledgement: null, paymentProof: null }

/** What the supplier link endpoint hands back for one order. */
export type PortalState = {
  enabled: boolean
  lifetimeDays: number
  tokens: PoPortalTokenSummary[]
  events: PoPortalAdminEvent[]
}

export type FiledDocumentKind = 'proforma' | 'acknowledgement' | 'payment-proof'

/** A document filed on the order from a supplier's email, as the order's GET
 *  hands it over: what it was filed as, the file it left, and the conversation
 *  it came on. */
export type EmailedDocument = {
  id: string
  filedAs: 'proforma' | 'acknowledgement' | 'invoice'
  supplierRef: string | null
  receivedAt: string | null
  fromAddress: string
  threadId: string | null
  billId: string | null
  /** Something worth a look: their proforma disagrees with the order, or its
   *  total could not be read. */
  flag: string | null
  /** The flag is a warning worth putting in front of somebody about to pay. */
  flagAlert: boolean
  handledAt: string | null
  /** Filed by somebody on the Paperwork list rather than by itself. */
  byPerson: boolean
  file: SupplierDocument | null
}
