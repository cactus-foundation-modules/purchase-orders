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

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

export type PoReceiptLine = {
  id: string
  orderLineId: string
  qtyAccepted: string
  qtyRejected: string
  rejectReason: string | null
  conditionNote: string | null
  /** Snapshotted off the order line for display, never stored here. */
  description: string
  supplierSku: string | null
  productId: string | null
  unit: string
}

/** What one delivery's stock write did, as it is shown back to whoever pressed
 *  the button. Mirrors core's InventoryAdjustmentOutcome plus the line it came
 *  from - nothing here is typed against the shop, which may not be installed. */
export type PoStockLineResult = {
  orderLineId: string
  productId: string | null
  description: string
  ok: boolean
  before: number | null
  after: number | null
  message?: string
}

export type PoStockResult = {
  /** Which module did the moving, in words: "Shop". */
  adjuster?: string
  at?: string
  byUserId?: string | null
  lines?: PoStockLineResult[]
  /** Set when the whole attempt failed rather than individual lines. */
  error?: string
}

export type PoReceiptSummary = {
  id: string
  number: string
  orderId: string
  orderNumber: string
  supplierName: string
  receivedDate: string
  deliveryNoteRef: string | null
  carrier: string | null
  receivedByUserId: string | null
  receivedByName: string | null
  stockApplied: boolean
  lineCount: number
  createdAt: string
}

export type PoReceipt = PoReceiptSummary & {
  notes: string | null
  stockAppliedAt: string | null
  stockResult: PoStockResult
  lines: PoReceiptLine[]
}

// ---------------------------------------------------------------------------
// Returns and debit notes
// ---------------------------------------------------------------------------

export const RETURN_STATUSES = ['DRAFT', 'SENT', 'CREDIT_EXPECTED', 'CREDITED', 'CLOSED', 'CANCELLED'] as const
export type PoReturnStatus = (typeof RETURN_STATUSES)[number]

export const PO_RETURN_STATUS_LABELS: Record<PoReturnStatus, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  CREDIT_EXPECTED: 'Credit promised',
  CREDITED: 'Credited',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
}

export type PoReturnLine = {
  id: string
  orderLineId: string
  /** Which delivery these came in on, where anybody said. Null on a return
   *  raised straight off the order rather than off a delivery note. */
  receiptLineId: string | null
  qty: string
  unitCost: string
  taxRatePercent: string
  lineTotal: string
  /** Off the order line, for display - never stored twice. */
  description: string
  supplierSku: string | null
  productId: string | null
  unit: string
  /** True when the delivery these came in on was added to stock, which is the
   *  only case in which sending them back has a count to take them off. */
  stockedIn: boolean
}

export type PoReturnSummary = {
  id: string
  number: string
  orderId: string
  orderNumber: string
  supplierId: string
  supplierName: string
  status: PoReturnStatus
  reason: string | null
  raisedDate: string | null
  sentAt: string | null
  currency: string
  creditExpected: string
  creditReceived: string
  creditRef: string | null
  stockApplied: boolean
  lineCount: number
  createdByUserId: string | null
  createdByName: string | null
  createdAt: string
}

export type PoReturn = PoReturnSummary & {
  notes: string | null
  /** Base currency per 1 unit of the return's currency. '1' where nobody set one. */
  fxRate: string
  taxAmount: string
  stockAppliedAt: string | null
  stockResult: PoStockResult
  booksOutcome: Record<string, unknown>
  updatedAt: string
  lines: PoReturnLine[]
}

/** One of an order's lines as the "send something back" screen offers it: what
 *  came in, what has already gone back, and which deliveries it arrived on. */
export type PoReturnableLine = {
  orderLineId: string
  description: string
  supplierSku: string | null
  productId: string | null
  unit: string
  unitCost: string
  taxRatePercent: string
  qtyReceived: string
  qtyReturned: string
  /** The deliveries this line arrived on, newest first. */
  receipts: {
    receiptLineId: string
    receiptId: string
    receiptNumber: string
    receivedDate: string
    qtyAccepted: string
    stockApplied: boolean
  }[]
}

/** An order with something still to come, as the Receiving tab lists them. */
export type PoAwaitingOrder = {
  id: string
  number: string
  status: PoStatus
  supplierName: string
  expectedDate: string | null
  requiredByDate: string | null
  outstandingLines: number
  receiptCount: number
}

// ---------------------------------------------------------------------------
// VAT, as a bill line carries it
// ---------------------------------------------------------------------------
//
// Structurally copied from the bookkeeping module rather than imported: that
// directory does not exist at build time on a site without the books, and a
// static import would break the build there. The STRINGS have to match, because
// Stage 6 hands them straight across - so if bookkeeping ever grows a treatment,
// this list wants the same one.

export const PO_VAT_RATE_CODES = ['standard', 'reduced', 'zero', 'exempt', 'outside_scope'] as const
export type PoVatRateCode = (typeof PO_VAT_RATE_CODES)[number]

export const PO_VAT_RATE_LABELS: Record<PoVatRateCode, string> = {
  standard: 'Standard rate',
  reduced: 'Reduced rate',
  zero: 'Zero rated',
  exempt: 'Exempt',
  outside_scope: 'Outside the scope of VAT',
}

export const PO_VAT_TREATMENTS = [
  'domestic',
  'ni_eu_acquisition',
  'ni_eu_dispatch',
  'reverse_charge_services',
  'import_pva',
  'domestic_reverse_charge',
  'outside_scope',
] as const
export type PoVatTreatment = (typeof PO_VAT_TREATMENTS)[number]

export const PO_VAT_TREATMENT_LABELS: Record<PoVatTreatment, string> = {
  domestic: 'UK domestic',
  ni_eu_acquisition: 'Goods bought into Northern Ireland from the EU',
  ni_eu_dispatch: 'Goods sold from Northern Ireland to the EU',
  reverse_charge_services: 'Services bought from overseas (reverse charge)',
  import_pva: 'Imported goods (postponed VAT accounting)',
  domestic_reverse_charge: 'UK reverse charge (e.g. construction)',
  outside_scope: 'Outside the scope of VAT',
}

/** A bookkeeping category, as the bill line picker offers it. Empty on a site
 *  with no books - the column is then a plain string nobody has to fill in. */
export type PoBookCategory = {
  id: string
  code: string
  name: string
}

// ---------------------------------------------------------------------------
// Supplier bills and the three-way match
// ---------------------------------------------------------------------------

export const BILL_STATUSES = ['DRAFT', 'QUERIED', 'APPROVED', 'POSTED', 'VOID'] as const
export type PoBillStatus = (typeof BILL_STATUSES)[number]

export const PO_BILL_STATUS_LABELS: Record<PoBillStatus, string> = {
  DRAFT: 'Draft',
  QUERIED: 'Queried',
  APPROVED: 'Approved to pay',
  POSTED: 'In the books',
  VOID: 'Void',
}

export const MATCH_STATUSES = ['NOT_MATCHED', 'MATCHED', 'VARIANCE'] as const
export type PoMatchStatus = (typeof MATCH_STATUSES)[number]

export const PO_MATCH_STATUS_LABELS: Record<PoMatchStatus, string> = {
  NOT_MATCHED: 'Nothing to check against',
  MATCHED: 'Agrees with the order',
  VARIANCE: 'Does not agree',
}

/** What kind of disagreement one flag is about. */
export const BILL_VARIANCE_KINDS = ['PRICE', 'QUANTITY', 'NOT_RECEIVED', 'NOT_ORDERED'] as const
export type PoBillVarianceKind = (typeof BILL_VARIANCE_KINDS)[number]

/** One thing the three-way match does not like. Stored on the bill as JSON, so
 *  what was queried - or what somebody approved anyway - is on the record. */
export type PoBillVariance = {
  kind: PoBillVarianceKind
  /** Null for a charge that is on the invoice and not on the order at all. */
  orderLineId: string | null
  description: string
  /** Signed, in the bill's own currency: positive means the supplier wants more. */
  amount: string
  /** One sentence a human can act on, written by lib/billing.ts. */
  message: string
}

export type PoBillLine = {
  id: string
  orderLineId: string | null
  description: string
  qty: string
  unitCost: string
  taxRatePercent: string
  taxRateCode: string | null
  vatTreatment: string | null
  categoryId: string | null
  lineTotal: string
}

export type PoBillSummary = {
  id: string
  supplierId: string
  supplierName: string
  orderId: string | null
  orderNumber: string | null
  supplierInvoiceNumber: string
  invoiceDate: string
  dueDate: string | null
  currency: string
  total: string
  status: PoBillStatus
  matchStatus: PoMatchStatus
  varianceCount: number
  hasAttachment: boolean
  lineCount: number
  createdByUserId: string | null
  createdByName: string | null
  createdAt: string
}

/** The supplier's own invoice, as it was uploaded. Null when nobody attached one. */
export type PoBillAttachment = {
  mediaId: string
  url: string
  name: string
  mimeType: string
  sizeBytes: number
}

export type PoBill = PoBillSummary & {
  fxRate: string
  subtotal: string
  carriageAmount: string
  taxAmount: string
  variance: PoBillVariance[]
  queryNote: string | null
  approvedByUserId: string | null
  approvedByName: string | null
  approvedAt: string | null
  postedAt: string | null
  booksOutcome: Record<string, unknown>
  attachment: PoBillAttachment | null
  updatedAt: string
  lines: PoBillLine[]
}

/** One of an order's lines as the bill screen offers it: what was ordered, what
 *  turned up, and what has already been invoiced on OTHER bills. */
export type PoBillableLine = {
  orderLineId: string
  description: string
  supplierSku: string | null
  unit: string
  unitCost: string
  taxRatePercent: string
  taxRateCode: string | null
  vatTreatment: string | null
  categoryId: string | null
  qtyOrdered: string
  qtyCancelled: string
  qtyReceived: string
  /** Across every other bill. This bill's own lines are never in here. */
  qtyInvoiced: string
}

/** The order the bill screen is billing against, and its lines. */
export type PoBillableOrder = {
  id: string
  number: string
  supplierId: string
  supplierName: string
  currency: string
  fxRate: string
  paymentTerms: string | null
  lines: PoBillableLine[]
}

/** What the Bills tab says at the top: the money nobody has agreed to pay yet. */
export type PoBillTotals = {
  openCount: number
  openTotal: string
  queriedCount: number
  approvedCount: number
  approvedTotal: string
}

// ---------------------------------------------------------------------------
// Reordering
// ---------------------------------------------------------------------------

/** One product's reorder level, as the Reorder tab lists and edits it. */
export type PoReorderRule = {
  id: string
  productId: string
  /** Null when the product has since left the catalogue - the rule is still
   *  shown, so somebody can delete it rather than wonder why nothing happens. */
  productName: string | null
  sku: string | null
  supplierId: string | null
  supplierName: string | null
  reorderPoint: number
  reorderQty: number
  enabled: boolean
  lastSuggestedAt: string | null
  createdAt: string
  updatedAt: string
}

/** One product the levels say should be bought, with the arithmetic shown. */
export type PoReorderSuggestion = {
  ruleId: string
  productId: string
  productName: string
  sku: string | null
  supplierId: string | null
  supplierName: string | null
  reorderPoint: number
  reorderQty: number
  /** Null where nothing is keeping a count of this product. */
  inStock: number | null
  /** On purchase orders that have not fully arrived, drafts included. */
  onOrder: number
  available: number
  suggestedQty: number
  unitCost: string
  taxRatePercent: string
  supplierSku: string | null
  /** Net of tax, at the suggested quantity. */
  lineValue: string
  lastSuggestedAt: string | null
  /** Why this one cannot become an order line. Null when nothing is in the way. */
  blockedReason: string | null
}

/** Everything one supplier should be sent, and whether the nightly run will. */
export type PoReorderPlan = {
  supplierId: string
  supplierName: string
  currency: string
  lines: PoReorderSuggestion[]
  /** Net of tax, before carriage. */
  goodsValue: string
  minimumOrderValue: string | null
  /** How far under the minimum this comes, or null when it clears it. */
  shortOfMinimum: string | null
  carriageAmount: string
  /** True when the goods value has earned free carriage. */
  carriagePaid: boolean
  /** Whether the nightly run would raise this one on its own. */
  auto: boolean
  /** Why it would not, in a sentence. Null when it would. */
  holdReason: string | null
}

/** What the planner made of the whole catalogue. */
export type PoReorderReview = {
  suggestions: PoReorderSuggestion[]
  plans: PoReorderPlan[]
  /** Rules with enough on the shelf to be left alone. */
  restingCount: number
}

/** What one run of the reorder job actually raised. */
export type PoReorderRunResult = {
  ordersCreated: {
    id: string
    number: string
    supplierId: string
    supplierName: string
    currency: string
    total: string
    lineCount: number
  }[]
  /** Suppliers the run deliberately left alone, and why. */
  held: { supplierId: string; supplierName: string; reason: string }[]
  suggested: number
  blocked: number
  /** Set when the run could do nothing at all - no catalogue, say. */
  skipped: string | null
}

// ---------------------------------------------------------------------------
// Reporting, chasing and export
// ---------------------------------------------------------------------------
//
// Every money figure below is in the site's BASE currency, converted once at the
// rate stored on the row it came from - the order's rate for anything still on
// order, the bill's own rate for anything invoiced. Mixing a euro order into a
// sterling total without saying so is the one thing a purchasing report must
// never do, so the screen says which currency it is in, out loud.

/** One supplier's share of what the site has committed to and not yet received. */
export type PoCommitmentSupplier = {
  supplierId: string
  supplierName: string
  value: string
  orderCount: number
  lineCount: number
}

/** One line of an accrual: goods here without an invoice, or the other way round. */
export type PoAccrualRow = {
  orderId: string
  orderNumber: string
  supplierId: string
  supplierName: string
  description: string
  qty: string
  value: string
}

/** An order past its date with something still owing. */
export type PoOverdueOrder = {
  orderId: string
  orderNumber: string
  status: PoStatus
  supplierId: string
  supplierName: string
  dueDate: string
  daysLate: number
  outstandingLines: number
  outstandingValue: string
  /** Off the audit log. Null when nobody has chased this one. */
  lastChasedAt: string | null
}

/** One month of the spend chart. Empty months are present, with zeroes. */
export type PoSpendPoint = {
  key: string
  label: string
  billed: string
  credited: string
  net: string
}

/** Spend with one supplier over the chosen window. */
export type PoSpendSupplier = {
  supplierId: string
  supplierName: string
  billed: string
  credited: string
  net: string
  billCount: number
}

/** Spend under one bookkeeping category. The name is resolved where the books
 *  are installed; otherwise only the id is known, and the screen says so. */
export type PoSpendCategory = {
  categoryId: string | null
  categoryName: string | null
  net: string
  lineCount: number
}

/** Everything the Reports tab draws, in one payload. */
export type PoReports = {
  baseCurrency: string
  /** The window the spend halves cover, as plain days. */
  from: string
  to: string
  today: string
  hasBooks: boolean
  committed: {
    total: string
    orderCount: number
    suppliers: PoCommitmentSupplier[]
  }
  overdue: PoOverdueOrder[]
  receivedNotInvoiced: { total: string; rows: PoAccrualRow[] }
  invoicedNotReceived: { total: string; rows: PoAccrualRow[] }
  spend: {
    billed: string
    credited: string
    net: string
    byMonth: PoSpendPoint[]
    bySupplier: PoSpendSupplier[]
    byCategory: PoSpendCategory[]
  }
  chase: {
    enabled: boolean
    afterDays: number
    repeatDays: number
    decisions: PoChaseDecision[]
  }
}

/** Whether one order is due a chase today, and the sentence saying why not. */
export type PoChaseDecision = {
  orderId: string
  orderNumber: string
  supplierId: string
  supplierName: string
  dueDate: string | null
  daysLate: number
  lastChasedAt: string | null
  due: boolean
  reason: string
}

/** What one chase run actually sent. */
export type PoChaseRunResult = {
  chased: { orderId: string; orderNumber: string; supplierName: string; to: string }[]
  failed: { orderId: string; orderNumber: string; message: string }[]
  /** Considered and left alone. */
  skipped: number
  /** Set when the run did nothing at all because the owner has it switched off. */
  heldBack: string | null
}

/** The four things purchasing will hand you as a spreadsheet. */
export const PO_EXPORT_KINDS = ['orders', 'lines', 'receipts', 'bills'] as const
export type PoExportKind = (typeof PO_EXPORT_KINDS)[number]

/** The tile on the admin dashboard. */
export type PoDashboardSummary = {
  baseCurrency: string
  openOrders: number
  committedValue: string
  overdueCount: number
  billsToLookAt: number
}
