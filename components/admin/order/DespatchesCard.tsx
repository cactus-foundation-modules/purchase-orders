'use client'

import { useState } from 'react'
import { withUnit } from '@/modules/purchase-orders/lib/money'
import { isReceivable } from '@/modules/purchase-orders/lib/receiving'
import type { PoDespatchableLine, PoOrder, PoShipment } from '@/modules/purchase-orders/lib/types'
import { card, Field, formatDay, input, linkButton, localToday, muted, table, td, tdRight, th, thRight } from '../ui'

type DespatchesCardProps = {
  shipments: PoShipment[]
  despatchable: PoDespatchableLine[]
  order: PoOrder
  onRecord: ((body: Record<string, unknown>) => Promise<{ number: string; trimmed: number } | null>) | null
  onDelete: ((shipmentId: string) => void) | null
  /** Whether the form is showing. Held by the screen rather than here, because
   *  the button that opens it lives in the bar at the top with every other
   *  action, not on this card. */
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Where the bar scrolls to when somebody asks to record a despatch. */
export const DESPATCHES_CARD_ID = 'po-despatches'

/** Whether there is anything a despatch could still be recorded against - the
 *  same test the card runs, shared so the bar only offers the action when the
 *  card would honour it. */
export function canRecordDespatch(order: PoOrder, despatchable: PoDespatchableLine[], allowed: boolean): boolean {
  return allowed && isReceivable(order.status) && despatchable.length > 0
}

/**
 * What the supplier says has left them, drop by drop, and the packing slip that
 * went in each box - plus the form for writing one down yourself.
 *
 * The supplier's own link is the happy path and plenty of suppliers will never
 * touch it: they email, or they ring, and somebody here writes it down. Same
 * row, same packing slip, and the table says which of the two it was.
 *
 * Deliberately NOT the Deliveries card above. A despatch is the supplier saying
 * a pallet left them on Tuesday; a delivery is somebody here saying it turned up
 * and counting it. The two are different facts, they arrive days apart, and the
 * day they are merged is the day a stock count moves because somebody typed in
 * an email.
 */
export function DespatchesCard({ shipments, despatchable, order, onRecord, onDelete, open, onOpenChange }: DespatchesCardProps) {
  const [saving, setSaving] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [despatchedDate, setDespatchedDate] = useState(localToday())
  const [carrier, setCarrier] = useState('')
  const [trackingRef, setTrackingRef] = useState('')
  const [trackingUrl, setTrackingUrl] = useState('')
  const [notes, setNotes] = useState('')
  const [qty, setQty] = useState<Record<string, string>>({})

  const canRecord = Boolean(onRecord) && isReceivable(order.status)
  // Nothing to show and nothing anybody could add: no card at all, rather than a
  // heading over an empty table.
  if (shipments.length === 0 && !canRecord) return null

  const lines = Object.entries(qty)
    .map(([orderLineId, value]) => ({ orderLineId, qty: value.trim() }))
    .filter((row) => row.qty !== '' && Number(row.qty) > 0)

  async function save() {
    if (!onRecord || saving) return
    setSaving(true)
    setSaid(null)
    try {
      const result = await onRecord({
        despatchedDate,
        carrier: carrier.trim() || null,
        trackingRef: trackingRef.trim() || null,
        trackingUrl: trackingUrl.trim() || null,
        notes: notes.trim() || null,
        lines,
      })
      if (!result) return
      setSaid(
        result.trimmed > 0
          ? `Recorded ${result.number}. ${result.trimmed} line${result.trimmed === 1 ? ' was' : 's were'} trimmed to what was still to send.`
          : `Recorded ${result.number}. The packing slip is in the table below.`,
      )
      setQty({})
      setTrackingRef('')
      setTrackingUrl('')
      setNotes('')
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ ...card, scrollMarginTop: '9rem' }} id={DESPATCHES_CARD_ID}>
      <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>What the supplier has sent</h2>
      <p style={{ ...muted, marginTop: 0 }}>
        What the supplier says has left them, whether they told you through their own link or by email. Nothing here
        has been booked in, counted or added to stock - that is still Deliveries, below.
        {shipments.length > 0 &&
          ` Order ${order.number} has ${shipments.length} despatch${shipments.length === 1 ? '' : 'es'} against it.`}
      </p>

      {said && (
        <p style={{ color: 'var(--color-success)', margin: '0 0 0.75rem', fontSize: 'var(--text-sm)' }} role="status">
          {said}
        </p>
      )}

      {canRecord && despatchable.length === 0 && shipments.length > 0 && (
        <p style={{ ...muted, marginTop: 0 }}>Everything on this order has been despatched.</p>
      )}

      {open && canRecord && (
        <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: '0.75rem', marginBottom: '1rem' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Line</th>
                  <th style={thRight}>Still to send</th>
                  <th style={thRight}>Sent now</th>
                </tr>
              </thead>
              <tbody>
                {despatchable.map((line) => (
                  <tr key={line.orderLineId}>
                    <td style={td}>
                      {line.description}
                      {line.supplierSku && <div style={muted}>{line.supplierSku}</div>}
                    </td>
                    <td style={tdRight}>
                      {withUnit(Number(line.qtyOutstanding), line.unit)}
                    </td>
                    <td style={tdRight}>
                      <input
                        style={{ ...input, width: 100, textAlign: 'right' }}
                        inputMode="decimal"
                        value={qty[line.orderLineId] ?? ''}
                        onChange={(e) => setQty((q) => ({ ...q, [line.orderLineId]: e.target.value }))}
                        aria-label={`How many of ${line.description} have been sent`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginTop: '0.75rem' }}>
            <Field label="The date it left them">
              <input type="date" style={input} value={despatchedDate} onChange={(e) => setDespatchedDate(e.target.value)} />
            </Field>
            <Field label="Carrier">
              <input style={input} value={carrier} onChange={(e) => setCarrier(e.target.value)} maxLength={120} />
            </Field>
            <Field label="Tracking number">
              <input style={input} value={trackingRef} onChange={(e) => setTrackingRef(e.target.value)} maxLength={200} />
            </Field>
            <Field label="Tracking link" hint="Only ever shown here, never on the packing slip.">
              <input style={input} value={trackingUrl} onChange={(e) => setTrackingUrl(e.target.value)} maxLength={500} placeholder="https://..." />
            </Field>
          </div>

          <div style={{ marginTop: '0.75rem' }}>
            <Field label="Note" hint="Prints on the packing slip, so write it for whoever opens the box.">
              <input style={input} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
            </Field>
          </div>

          <p style={{ ...muted, marginTop: '0.75rem' }}>
            Anything over what is still to send is trimmed to it. A supplier sending more than you ordered is an
            over-delivery to flag when it turns up, not a packing slip to print.
          </p>

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
            <button className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving || lines.length === 0 || !despatchedDate}>
              {saving ? 'Recording…' : 'Record this despatch'}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => onOpenChange(false)} disabled={saving}>
              Never mind
            </button>
          </div>
        </div>
      )}

      {shipments.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          Nothing has been despatched against this one yet.
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Despatch</th>
                <th style={th}>Sent</th>
                <th style={th}>What went</th>
                <th style={th}>Carrier and tracking</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {shipments.map((shipment) => (
                <tr key={shipment.id}>
                  <td style={td}>
                    {shipment.number}
                    <div style={muted}>{shipment.source === 'PORTAL' ? 'Told to us by the supplier' : 'Entered here'}</div>
                  </td>
                  <td style={td}>{formatDay(shipment.despatchedDate)}</td>
                  <td style={td}>
                    {shipment.lines.map((line) => (
                      <div key={line.id}>
                        {withUnit(Number(line.qty), line.unit)} {line.description}
                      </div>
                    ))}
                    {shipment.notes && <div style={muted}>{shipment.notes}</div>}
                  </td>
                  <td style={td}>
                    {shipment.carrier ?? '—'}
                    {/* A link with no number to hang it off still has to be
                        clickable - suppliers hand over one or the other, and a
                        tracking page nobody can reach is the same as none. */}
                    {(shipment.trackingRef || shipment.trackingUrl) && (
                      <div style={muted}>
                        {shipment.trackingUrl ? (
                          <a href={shipment.trackingUrl} target="_blank" rel="noreferrer">
                            {shipment.trackingRef || 'Track this delivery'}
                          </a>
                        ) : (
                          shipment.trackingRef
                        )}
                      </div>
                    )}
                  </td>
                  <td style={td}>
                    <a
                      href={`/api/m/purchase-orders/admin/shipments/${shipment.id}/pdf`}
                      style={{ color: 'var(--color-primary)' }}
                    >
                      Packing slip
                    </a>
                    {onDelete && (
                      <div style={{ marginTop: '0.375rem' }}>
                        <button
                          style={{ ...linkButton, color: 'var(--color-danger)' }}
                          onClick={() => onDelete(shipment.id)}
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
