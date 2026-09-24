'use client'

import type { CSSProperties, ReactNode } from 'react'
import Link from 'next/link'
import { withUnit } from '@/modules/purchase-orders/lib/money'
import { isReceivable, outstanding } from '@/modules/purchase-orders/lib/receiving'
import type { PoStanding } from '@/modules/purchase-orders/lib/standing'
import type {
  PoAuditEntry,
  PoBillSummary,
  PoDespatchableLine,
  PoOrder,
  PoReceiptSummary,
  PoReturnSummary,
  PoRevisionSummary,
  PoShipment,
} from '@/modules/purchase-orders/lib/types'
import {
  BillStatusBadge,
  card,
  formatDay,
  formatWhen,
  linkButton,
  MatchBadge,
  Money,
  muted,
  ReturnStatusBadge,
  table,
  td,
  tdRight,
  th,
  thRight,
} from '../ui'
import { DespatchesCard } from './DespatchesCard'
import { ProformaCard, proformaCardShows } from './ProformaCard'
import { SupplierLinkCard } from './SupplierLinkCard'
import { Totals } from './Totals'
import type { FiledDocumentKind, PortalState, SupplierDocuments } from './shared'

export type OrderViewProps = {
  order: PoOrder
  /** Where the order stands, worked out from the order - see lib/standing.ts. */
  standing: PoStanding
  history: PoAuditEntry[]
  revisions: PoRevisionSummary[]
  receipts: PoReceiptSummary[]
  returns: PoReturnSummary[]
  bills: PoBillSummary[]
  /** `/…/m/purchase-orders/returns` and `/…/bills`, for the rows that link out. */
  returnsBase: string
  billsBase: string
  /** `/…/m/shop/orders`, for the customer order a FROM_ORDER order was bought for. */
  shopOrdersBase: string
  /** Null unless this order is one whose lines can still be given up on. */
  onCancelLine: ((lineId: string) => void) | null
  /** Null until the supplier link has loaded, which is a request of its own. */
  portal: PortalState | null
  /** The link just made, shown once. Only its hash is stored, so this is the
   *  only moment anybody can copy it. */
  newLink: string | null
  onRevokeLink: ((tokenId: string) => void) | null
  onRevokeAllLinks: (() => void) | null
  onApplyDate: ((eventId: string) => void) | null
  /** What the supplier says has left them, drop by drop. */
  shipments: PoShipment[]
  /** What is still to send, for the form that writes one down by hand. */
  despatchable: PoDespatchableLine[]
  /** Null for anybody who may neither buy nor receive. */
  onRecordDespatch: ((body: Record<string, unknown>) => Promise<{ number: string; trimmed: number } | null>) | null
  onDeleteDespatch: ((shipmentId: string) => void) | null
  despatchOpen: boolean
  onDespatchOpenChange: (open: boolean) => void
  /** Their proforma and their acknowledgement, where either has arrived. */
  documents: SupplierDocuments
  /** Null for anybody without the permission to say money has moved. */
  onPayProforma: ((paymentRef: string, sendProof: boolean) => void) | null
  onUnpayProforma: (() => void) | null
  onSetProformaTerms: ((required: boolean) => void) | null
  /** Filing what arrived by email or in the post. Buying for the supplier's own
   *  paperwork, paying for the proof that the money left. */
  onFileDocument: ((kind: FiledDocumentKind, file: File) => Promise<boolean>) | null
  onFileProof: ((kind: FiledDocumentKind, file: File) => Promise<boolean>) | null
  onSaveSupplierRefs: ((body: Record<string, string>) => Promise<boolean>) | null
}

const heading: CSSProperties = { margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }
const quiet: CSSProperties = { margin: 0, color: 'var(--color-text-secondary)' }

const SHIP_TO_LABELS: Record<PoOrder['shipToKind'], string> = {
  WAREHOUSE: 'Our own address',
  CUSTOMER: 'Straight to the customer',
  OTHER: 'Somewhere else',
}

const STANDING_ALERT: Record<PoStanding['tone'], string> = {
  info: 'alert alert-info',
  success: 'alert alert-success',
  warning: 'alert alert-warning',
  danger: 'alert alert-danger',
}

/** The name over a run of cards that belong to one part of an order's life.
 *  The page used to be fourteen cards in the order they were written; these say
 *  which three questions they answer. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h2
        style={{
          margin: '1.5rem 0 0.5rem',
          fontSize: 'var(--text-xs)',
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--color-text-secondary)',
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  )
}

/** `order.proforma_paid` as "Proforma paid". */
function actionLabel(action: string): string {
  const words = action.replace(/^order\./, '').replace(/[._]/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** One fact in the details card: a quiet label over the thing itself. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div style={muted}>{label}</div>
      <div>{children}</div>
    </div>
  )
}

/**
 * The order, read-only.
 *
 * Nothing on this screen changes the ORDER - every button that does is in the
 * bar at the top. What is left on the cards is the paperwork that hangs off an
 * order: filing a document beside the row that shows it, stopping a link on the
 * row of the link.
 *
 * Two columns where there is room. The wide one is what the order is and what
 * has happened to it, in the order it happens: the lines, the goods arriving,
 * the money leaving, the supplier's say. The narrow one is what somebody glances
 * at - who, when, where to, the notes, and the trail of who did what.
 */
export function OrderView({
  order, standing, history, revisions, receipts, returns, bills, returnsBase, billsBase, shopOrdersBase,
  onCancelLine, portal, newLink, onRevokeLink, onRevokeAllLinks, onApplyDate,
  shipments, despatchable, onRecordDespatch, onDeleteDespatch, despatchOpen, onDespatchOpenChange,
  documents, onPayProforma, onUnpayProforma, onSetProformaTerms,
  onFileDocument, onFileProof, onSaveSupplierRefs,
}: OrderViewProps) {
  const totals = {
    subtotal: order.subtotal,
    discountAmount: order.discountAmount,
    carriageAmount: order.carriageAmount,
    surchargeAmount: order.surchargeAmount,
    taxAmount: order.taxAmount,
    total: order.total,
    lineTotals: order.lines.map((l) => l.lineTotal),
  }

  const sourceOrderNumber =
    order.sourceKind === 'FROM_ORDER' && typeof order.sourceRef?.orderNumber === 'string' ? order.sourceRef.orderNumber : null
  const sourceOrderId =
    order.sourceKind === 'FROM_ORDER' && typeof order.sourceRef?.orderId === 'string' ? order.sourceRef.orderId : null

  const address = order.shipTo.address
  const addressLines = [
    address.line1,
    address.line2,
    [address.city, address.region].filter(Boolean).join(', '),
    address.postcode,
    address.country,
  ].filter(Boolean)

  // Nothing can arrive on an order that has not gone, and a card saying
  // "nothing was ever booked in" on a draft is an answer to a question nobody
  // asked. Once it has gone - or once anything is filed against it - it stays.
  // And never for a supplier who drop-ships, unless something was booked in
  // before the switch was turned on - what happened stays on the record.
  const showDeliveries =
    receipts.length > 0 || (!order.supplierDropships && (isReceivable(order.status) || Boolean(order.sentAt)))
  // "Received" and "Still due" are columns about a door nothing comes through.
  const showArrivals = !order.supplierDropships || order.lines.some((l) => Number(l.qtyReceived) > 0)
  // Only once something has actually turned up. Nothing can go back that never
  // arrived.
  const showReturns = returns.length > 0 || order.lines.some((l) => Number(l.qtyReceived) > 0)
  const showDespatches = shipments.length > 0 || (Boolean(onRecordDespatch) && isReceivable(order.status))
  // Invoices are shown from the moment the order has gone out rather than
  // waiting for a delivery: plenty of suppliers invoice on despatch, and a few
  // ask for the money before anything moves at all.
  const showBills = bills.length > 0 || Boolean(order.sentAt)
  const showProforma = proformaCardShows(order)

  return (
    <>
      <div className={STANDING_ALERT[standing.tone]} style={{ marginBottom: '1rem' }} role="status">
        <strong style={{ fontWeight: 600 }}>{standing.headline}</strong>
        {standing.detail && <> {standing.detail}</>}
      </div>

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* The wide column. `minWidth: 0` is what lets the tables inside it
            scroll sideways instead of pushing the narrow column off the page. */}
        <div style={{ flex: '999 1 600px', minWidth: 0 }}>
          <div style={card}>
            <h2 style={heading}>Lines</h2>
            <div style={{ overflowX: 'auto' }}>
              <table style={table}>
                <thead>
                  <tr>
                    <th style={th}>Description</th>
                    <th style={th}>Their code</th>
                    <th style={thRight}>Ordered</th>
                    {showArrivals && <th style={thRight}>Received</th>}
                    {showArrivals && <th style={thRight}>Still due</th>}
                    <th style={thRight}>Invoiced</th>
                    <th style={thRight}>Cost</th>
                    <th style={thRight}>Line total</th>
                    {onCancelLine && <th style={th} />}
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((l) => {
                    const left = outstanding(l)
                    return (
                      <tr key={l.id}>
                        <td style={td}>
                          {l.description}
                          {/* Their words head the line, because they are what goes
                              on the sheet they read. Ours sits under it where the
                              two differ, so whoever is checking this against the
                              shop can still tell what it is. */}
                          {l.productName && l.productName !== l.description && (
                            <div style={muted}>{l.productName} in your catalogue</div>
                          )}
                          {l.serviceName && (
                            <div style={muted}>
                              {l.serviceName}
                              {l.serviceCost && (
                                <>
                                  {' - '}
                                  <Money value={l.serviceCost} currency={order.currency} /> a unit, not in the line total
                                </>
                              )}
                            </div>
                          )}
                          {Number(l.qtyCancelled) > 0 && <div style={muted}>{l.qtyCancelled} cancelled</div>}
                        </td>
                        <td style={td}>{l.supplierSku ?? '—'}</td>
                        <td style={tdRight}>{withUnit(l.qty, l.unit)}</td>
                        {showArrivals && <td style={tdRight}>{l.qtyReceived}</td>}
                        {showArrivals && <td style={tdRight}>{left > 0 ? left : '—'}</td>}
                        <td style={tdRight}>{l.qtyInvoiced}</td>
                        <td style={tdRight}>
                          <Money value={l.unitCost} currency={order.currency} />
                        </td>
                        <td style={tdRight}>
                          <Money value={l.lineTotal} currency={order.currency} />
                        </td>
                        {onCancelLine && (
                          <td style={td}>
                            {left > 0 && (
                              <button
                                style={linkButton}
                                onClick={() => onCancelLine(l.id)}
                                title="The rest of this line is never coming"
                              >
                                Give up on the rest
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Totals totals={totals} currency={order.currency} />
          </div>

          {(showDespatches || showDeliveries || showReturns) && (
            <Section title="Getting it here">
              <DespatchesCard
                shipments={shipments}
                despatchable={despatchable}
                order={order}
                onRecord={onRecordDespatch}
                onDelete={onDeleteDespatch}
                open={despatchOpen}
                onOpenChange={onDespatchOpenChange}
              />

              {showDeliveries && (
                <div style={card}>
                  <h2 style={heading}>Deliveries</h2>
                  {receipts.length === 0 ? (
                    <p style={quiet}>
                      {isReceivable(order.status)
                        ? 'Nothing has turned up against this one yet.'
                        : 'Nothing was ever booked in against this order.'}
                    </p>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={table}>
                        <thead>
                          <tr>
                            <th style={th}>Delivery</th>
                            <th style={th}>Arrived</th>
                            <th style={th}>Their delivery note</th>
                            <th style={th}>Booked in by</th>
                            <th style={th} />
                          </tr>
                        </thead>
                        <tbody>
                          {receipts.map((r) => (
                            <tr key={r.id}>
                              <td style={td}>{r.number}</td>
                              <td style={td}>{formatDay(r.receivedDate)}</td>
                              <td style={td}>{r.deliveryNoteRef ?? '—'}</td>
                              <td style={td}>{r.receivedByName ?? 'Somebody'}</td>
                              <td style={td}>{r.stockApplied ? 'Added to stock' : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {showReturns && (
                <div style={card}>
                  <h2 style={heading}>Returns</h2>
                  {returns.length === 0 ? (
                    <p style={quiet}>Nothing has gone back on this one.</p>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={table}>
                        <thead>
                          <tr>
                            <th style={th}>Return</th>
                            <th style={th}>Raised</th>
                            <th style={th}>Status</th>
                            <th style={thRight}>Credit expected</th>
                            <th style={th}>Their credit note</th>
                          </tr>
                        </thead>
                        <tbody>
                          {returns.map((r) => (
                            <tr key={r.id}>
                              <td style={td}>
                                <Link href={`${returnsBase}/${r.id}`} style={{ color: 'var(--color-primary)' }}>
                                  {r.number}
                                </Link>
                              </td>
                              <td style={td}>{formatDay(r.raisedDate)}</td>
                              <td style={td}>
                                <ReturnStatusBadge status={r.status} />
                              </td>
                              <td style={tdRight}>
                                <Money value={r.creditExpected} currency={r.currency} />
                              </td>
                              <td style={td}>{r.creditRef ?? ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </Section>
          )}

          {(showProforma || showBills) && (
            <Section title="Paying for it">
              <ProformaCard
                order={order}
                documents={documents}
                onPay={onPayProforma}
                onUnpay={onUnpayProforma}
                onSetTerms={onSetProformaTerms}
                onFile={onFileDocument}
                onFileProof={onFileProof ? (chosen) => onFileProof('payment-proof', chosen) : null}
                onSaveRefs={onSaveSupplierRefs}
              />

              {showBills && (
                <div style={card}>
                  <h2 style={heading}>Bills</h2>
                  {bills.length === 0 ? (
                    <p style={quiet}>Nobody has invoiced you for this one yet.</p>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={table}>
                        <thead>
                          <tr>
                            <th style={th}>Their invoice</th>
                            <th style={th}>Dated</th>
                            <th style={th}>Status</th>
                            <th style={th}>Checked against the order</th>
                            <th style={thRight}>Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bills.map((b) => (
                            <tr key={b.id}>
                              <td style={td}>
                                <Link href={`${billsBase}/${b.id}`} style={{ color: 'var(--color-primary)' }}>
                                  {b.supplierInvoiceNumber}
                                </Link>
                              </td>
                              <td style={td}>{formatDay(b.invoiceDate)}</td>
                              <td style={td}>
                                <BillStatusBadge status={b.status} />
                              </td>
                              <td style={td}>
                                <MatchBadge status={b.matchStatus} count={b.varianceCount} />
                              </td>
                              <td style={tdRight}>
                                <Money value={b.total} currency={b.currency} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </Section>
          )}

          {portal && (
            <Section title="The supplier's side">
              <SupplierLinkCard
                order={order}
                portal={portal}
                newLink={newLink}
                onRevokeLink={onRevokeLink}
                onRevokeAllLinks={onRevokeAllLinks}
                onApplyDate={onApplyDate}
              />
            </Section>
          )}
        </div>

        {/* The narrow column. It drops under the wide one when there is no room
            for both, which is every phone and most tablets held upright. */}
        <div style={{ flex: '1 1 280px', minWidth: 0 }}>
          <div style={card}>
            <h2 style={heading}>Details</h2>
            <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
              <Fact label="Supplier">
                {order.supplierName}
                {order.supplierDropships && <div style={muted}>Drop-ships to the customer</div>}
              </Fact>
              <Fact label="Raised">{formatDay(order.raisedDate)}</Fact>
              <Fact label="Wanted by">{formatDay(order.requiredByDate)}</Fact>
              <Fact label="Expected">{formatDay(order.expectedDate)}</Fact>
              <Fact label="Last sent">{order.sentAt ? formatWhen(order.sentAt) : 'Not sent'}</Fact>
              {/* Who approved it is in the history below; this is the glance. An
                  order sent without ever being formally approved is approved by
                  the act of sending it, so a sent order always has a date here. */}
              <Fact label="Approved">{order.approvedAt ? formatWhen(order.approvedAt) : 'Not yet'}</Fact>
              <Fact label="Payment terms">{order.paymentTerms ?? '—'}</Fact>
              {order.deliveryTerms && <Fact label="Delivery terms">{order.deliveryTerms}</Fact>}
              {order.currency !== order.baseCurrency && (
                <Fact label="Currency">
                  {order.currency} at {order.fxRate}
                </Fact>
              )}
              {sourceOrderNumber && (
                <Fact label="Bought for customer order">
                  {sourceOrderId ? (
                    <Link href={`${shopOrdersBase}/${sourceOrderId}`} style={{ color: 'var(--color-primary)' }}>
                      {sourceOrderNumber}
                    </Link>
                  ) : sourceOrderNumber}
                </Fact>
              )}
            </div>
          </div>

          <div style={card}>
            <h2 style={heading}>Deliver to</h2>
            <div style={muted}>{SHIP_TO_LABELS[order.shipToKind]}</div>
            <div>{order.shipTo.name || '—'}</div>
            {addressLines.length === 0 ? (
              <div style={muted}>No address recorded</div>
            ) : (
              addressLines.map((line, index) => <div key={index}>{line}</div>)
            )}
            {(order.shipTo.contact || order.shipTo.phone) && (
              <div style={{ marginTop: '0.5rem' }}>
                {[order.shipTo.contact, order.shipTo.phone].filter(Boolean).join(' - ')}
              </div>
            )}
            {order.shipTo.instructions && (
              <div style={{ marginTop: '0.5rem' }}>
                <div style={muted}>Delivery instructions</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{order.shipTo.instructions}</div>
              </div>
            )}
          </div>

          {(order.notesSupplier || order.notesInternal) && (
            <div style={card}>
              <h2 style={heading}>Notes</h2>
              {order.notesSupplier && (
                <>
                  <div style={muted}>For the supplier - printed on the order</div>
                  <p style={{ margin: '0 0 0.75rem', whiteSpace: 'pre-wrap' }}>{order.notesSupplier}</p>
                </>
              )}
              {order.notesInternal && (
                <>
                  <div style={muted}>For us - never leaves the building</div>
                  <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{order.notesInternal}</p>
                </>
              )}
            </div>
          )}

          {revisions.length > 0 && (
            <div style={card}>
              <h2 style={heading}>Revisions</h2>
              <p style={{ ...muted, marginTop: 0 }}>
                What the supplier was sent before. Each one is kept exactly as it was printed.
              </p>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {revisions.map((r) => (
                  <li key={r.id} style={{ padding: '0.5rem 0', borderTop: '1px solid var(--color-border)' }}>
                    <div>
                      Rev {r.revision}
                      {r.reason ? ` - ${r.reason}` : ''}
                    </div>
                    <div style={muted}>
                      {r.createdByName ?? 'Somebody'}, {formatWhen(r.createdAt)}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div style={card}>
            <h2 style={heading}>History</h2>
            {history.length === 0 ? (
              <p style={quiet}>Nothing recorded yet.</p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {history.map((h) => (
                  <li key={h.id} style={{ padding: '0.5rem 0', borderTop: '1px solid var(--color-border)' }}>
                    <div>{actionLabel(h.action)}</div>
                    {typeof h.detail.note === 'string' && h.detail.note && (
                      <div style={{ whiteSpace: 'pre-wrap' }}>{h.detail.note}</div>
                    )}
                    <div style={muted}>
                      {h.userName ?? 'Somebody'}, {formatWhen(h.createdAt)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
