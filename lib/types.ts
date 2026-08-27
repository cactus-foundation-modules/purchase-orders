import type { PoAddress } from './config'

// Shared shapes. Money and quantities cross the wire as STRINGS, not numbers:
// they come out of Postgres as Prisma.Decimal and a float round-trip is how a
// penny goes missing between the order and the bill.

export const PO_STATUSES = [
  'DRAFT',
  'AWAITING_APPROVAL',
  'APPROVED',
  'SENT',
  'ACKNOWLEDGED',
  'PART_RECEIVED',
  'RECEIVED',
  'CLOSED',
  'CANCELLED',
  'ON_HOLD',
] as const
export type PoStatus = (typeof PO_STATUSES)[number]

export const PO_STATUS_LABELS: Record<PoStatus, string> = {
  DRAFT: 'Draft',
  AWAITING_APPROVAL: 'Awaiting approval',
  APPROVED: 'Approved',
  SENT: 'Sent',
  ACKNOWLEDGED: 'Acknowledged',
  PART_RECEIVED: 'Part received',
  RECEIVED: 'Received',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
  ON_HOLD: 'On hold',
}

export const SUPPLIER_STATUSES = ['ENABLED', 'DISABLED', 'ON_HOLD'] as const
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number]

export const SHIP_TO_KINDS = ['WAREHOUSE', 'CUSTOMER', 'OTHER'] as const
export type ShipToKind = (typeof SHIP_TO_KINDS)[number]

export const SOURCE_KINDS = ['MANUAL', 'FROM_ORDER', 'REORDER'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export type PoSupplier = {
  id: string
  name: string
  nameKey: string
  shopSupplierId: string | null
  shopSupplierName: string | null
  accountNumber: string | null
  contactName: string | null
  phone: string | null
  email: string | null
  emailCc: string | null
  address: PoAddress
  currency: string
  paymentTerms: string | null
  paymentTermsDays: number | null
  leadTimeDays: number | null
  minimumOrderValue: string | null
  carriagePaidOver: string | null
  carriageCharge: string | null
  defaultCategoryId: string | null
  defaultVatTreatment: string | null
  defaultVatRateCode: string | null
  taxRegistrationNumber: string | null
  deliveryInstructions: string | null
  status: SupplierStatus
  notes: string | null
  orderCount: number
  /** Set when shop is installed AND the linked row is still there. */
  shopLinkLive: boolean
}

export type PoShipTo = {
  name: string
  contact: string
  phone: string
  address: PoAddress
  instructions: string
}

export type PoOrderLine = {
  id: string
  position: number
  productId: string | null
  productName: string | null
  supplierSku: string | null
  ourSku: string | null
  description: string
  qty: string
  unit: string
  unitCost: string
  discountPercent: string | null
  taxRatePercent: string
  taxRateCode: string | null
  vatTreatment: string | null
  categoryId: string | null
  lineTotal: string
  expectedDate: string | null
  qtyCancelled: string
  /** Derived, never stored - see lib/progress.ts. */
  qtyReceived: string
  qtyInvoiced: string
  qtyReturned: string
}

export type PoOrderSummary = {
  id: string
  number: string
  revision: number
  status: PoStatus
  supplierId: string
  supplierName: string
  currency: string
  total: string
  raisedDate: string | null
  requiredByDate: string | null
  expectedDate: string | null
  lineCount: number
  createdAt: string
}

export type PoOrder = PoOrderSummary & {
  supplierSnapshot: Record<string, unknown>
  shipToKind: ShipToKind
  shipTo: PoShipTo
  sourceKind: SourceKind
  sourceRef: Record<string, unknown> | null
  baseCurrency: string
  fxRate: string
  taxMode: 'EXCLUSIVE' | 'INCLUSIVE'
  subtotal: string
  discountAmount: string
  carriageAmount: string
  taxAmount: string
  paymentTerms: string | null
  deliveryTerms: string | null
  notesSupplier: string | null
  notesInternal: string | null
  approvalRequired: boolean
  approvedByUserId: string | null
  approvedAt: string | null
  approvalNote: string | null
  sentAt: string | null
  acknowledgedAt: string | null
  acknowledgedNote: string | null
  cancelledAt: string | null
  cancelReason: string | null
  closedAt: string | null
  closeReason: string | null
  updatedAt: string
  lines: PoOrderLine[]
}

/** One earlier version of an order, as the screen lists them. The snapshot
 *  itself is deliberately not here: it is the whole document, it is only read
 *  when somebody actually asks for it, and shipping it down with the list would
 *  put ten copies of an order on the wire to draw four lines of a table. */
export type PoRevisionSummary = {
  id: string
  revision: number
  reason: string | null
  createdByUserId: string | null
  createdByName: string | null
  createdAt: string
}

export type PoAuditEntry = {
  id: string
  action: string
  detail: Record<string, unknown>
  userId: string | null
  userName: string | null
  createdAt: string
}

/** A catalogue product offered in the line editor. Empty when there is no catalogue. */
export type CatalogueProduct = {
  id: string
  name: string
  sku: string | null
  supplier: string | null
  costPrice: string | null
}
