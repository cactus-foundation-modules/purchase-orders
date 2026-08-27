'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import type { PoOrder, PoOrderLine, PoReceiptSummary, PoStockLineResult } from '@/modules/purchase-orders/lib/types'
import { outstanding, overReceiptFlags } from '@/modules/purchase-orders/lib/receiving'
import { card, Field, formatDay, formatWhen, input, localToday, muted, table, td, tdRight, th, thRight } from './ui'

// Booking a delivery in: the order's outstanding lines, a box per line, and a
// tick to say the shelf should move too.
//
// The accepted box is pre-filled with what is outstanding, because the
// overwhelmingly common case is "it all came" and typing eleven numbers to say
// so is how people stop booking deliveries in at all. Everything is editable,
// including upwards - over-delivery is flagged, never blocked.

type LineDraft = {
  qtyAccepted: string
  qtyRejected: string
  rejectReason: string
  conditionNote: string
}

type Props = {
  orderId: string
  canReceive: boolean
  stockOffered: boolean
  stockBlockedReason: string | null
  overReceiptTolerancePercent: number
}

function emptyDraft(line: PoOrderLine): LineDraft {
  const left = outstanding(line)
  return {
    qtyAccepted: left > 0 ? trimQty(left) : '0',
    qtyRejected: '0',
    rejectReason: '',
    conditionNote: '',
  }
}

/** 3.000 reads as 3, and 2.500 as 2.5. The column keeps three places either way. */
function trimQty(value: number): string {
  return String(Number(value.toFixed(3)))
}

export function BookInScreen({
  orderId,
  canReceive,
  stockOffered,
  stockBlockedReason,
  overReceiptTolerancePercent,
}: Props) {
  const router = useRouter()
  const adminPath = useAdminPath()
  const base = `/${adminPath}/m/purchase-orders`

  const [order, setOrder] = useState<PoOrder | null>(null)
  const [receipts, setReceipts] = useState<PoReceiptSummary[]>([])
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>({})
  const [receivedDate, setReceivedDate] = useState(localToday())
  const [deliveryNoteRef, setDeliveryNoteRef] = useState('')
  const [carrier, setCarrier] = useState('')
  const [notes, setNotes] = useState('')
  const [applyStock, setApplyStock] = useState(stockOffered)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ number: string; stock: string | null; stockLines: PoStockLineResult[] } | null>(null)
  const [loaded, setLoaded] = useState(false)

  // Written as a promise chain rather than an async body called from the effect:
  // every setState lands in a callback, which is what keeps the load out of the
  // synchronous render pass.
  const load = useCallback(
    () =>
      Promise.all([
        fetch(`/api/m/purchase-orders/admin/orders/${orderId}`).then((r) => (r.ok ? r.json() : null)),
        fetch(`/api/m/purchase-orders/admin/orders/${orderId}/receipts`)
          .then((r) => (r.ok ? r.json() : { receipts: [] }))
          .catch(() => ({ receipts: [] })),
      ])
        .then(([data, deliveries]) => {
          if (data?.order) {
            setOrder(data.order)
            const next: Record<string, LineDraft> = {}
            for (const line of data.order.lines as PoOrderLine[]) next[line.id] = emptyDraft(line)
            setDrafts(next)
          }
          setReceipts(deliveries?.receipts ?? [])
          setLoaded(true)
        })
        .catch(() => setLoaded(true)),
    [orderId],
  )

  useEffect(() => {
    void load()
  }, [load])

  const lines = useMemo(() => order?.lines ?? [], [order])

  // The same check the server does, run here so nobody is told about an
  // over-delivery only after they have saved it.
  const flags = useMemo(
    () =>
      overReceiptFlags(
        lines,
        lines.map((line) => ({
          orderLineId: line.id,
          qtyAccepted: Number(drafts[line.id]?.qtyAccepted ?? 0) || 0,
          qtyRejected: Number(drafts[line.id]?.qtyRejected ?? 0) || 0,
        })),
        overReceiptTolerancePercent,
      ),
    [lines, drafts, overReceiptTolerancePercent],
  )

  const anything = lines.some(
    (line) => Number(drafts[line.id]?.qtyAccepted ?? 0) > 0 || Number(drafts[line.id]?.qtyRejected ?? 0) > 0,
  )

  function setDraft(lineId: string, patch: Partial<LineDraft>) {
    setDrafts((d) => ({ ...d, [lineId]: { ...d[lineId]!, ...patch } }))
  }

  function fillAll() {
    setDrafts((d) => {
      const next = { ...d }
      for (const line of lines) next[line.id] = { ...next[line.id]!, qtyAccepted: trimQty(outstanding(line)) }
      return next
    })
  }

  function clearAll() {
    setDrafts((d) => {
      const next = { ...d }
      for (const line of lines) next[line.id] = { ...next[line.id]!, qtyAccepted: '0', qtyRejected: '0' }
      return next
    })
  }

  async function save() {
    setError(null)
    setSaving(true)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/receipts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receivedDate,
        deliveryNoteRef: deliveryNoteRef || null,
        carrier: carrier || null,
        notes: notes || null,
        applyStock: applyStock && stockOffered,
        lines: lines.map((line) => ({
          orderLineId: line.id,
          qtyAccepted: drafts[line.id]?.qtyAccepted || '0',
          qtyRejected: drafts[line.id]?.qtyRejected || '0',
          rejectReason: drafts[line.id]?.rejectReason || null,
          conditionNote: drafts[line.id]?.conditionNote || null,
        })),
      }),
    })
    setSaving(false)
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not record that delivery.')
      return
    }
    const data = await res.json()
    setDone({
      number: data.number,
      stock: data.stock ? data.stock.message : null,
      stockLines: (data.stock?.result?.lines ?? []) as PoStockLineResult[],
    })
    router.refresh()
    await load()
    // Everything already booked in is now part of the line's received figure,
    // so the boxes reset to whatever is left rather than to what was just typed.
  }

  if (!loaded) return <p>Loading…</p>
  if (!order) return <div className="alert alert-danger">That purchase order is not here any more.</div>

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 className="page-title">Book in {order.number}</h1>
        <Link href={`${base}/receiving`} className="btn btn-secondary">
          Back to receiving
        </Link>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      {done && (
        <div className="alert alert-success">
          Delivery {done.number} recorded.
          {done.stock ? ` ${done.stock}` : ''}
          {done.stockLines.length > 0 && (
            <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
              {done.stockLines.map((l, i) => (
                <li key={`${l.orderLineId}-${i}`}>
                  {l.description}: {l.ok && l.after !== null ? `${l.before} → ${l.after}` : (l.message ?? 'not changed')}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div style={card}>
        <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <div>
            <div style={muted}>Supplier</div>
            <div>{order.supplierName}</div>
          </div>
          <div>
            <div style={muted}>Expected</div>
            <div>{formatDay(order.expectedDate)}</div>
          </div>
          <div>
            <div style={muted}>Deliver to</div>
            <div>
              {order.shipTo.name || '—'}
              <div style={muted}>
                {[order.shipTo.address.line1, order.shipTo.address.city, order.shipTo.address.postcode]
                  .filter(Boolean)
                  .join(', ') || 'No address recorded'}
              </div>
            </div>
          </div>
          <div>
            <div style={muted}>Order</div>
            <div>
              <Link href={`${base}/orders/${order.id}`} style={{ color: 'var(--color-primary)' }}>
                Open the order
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>What arrived</h2>
          {canReceive && (
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={fillAll}>
                It all came
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={clearAll}>
                Clear
              </button>
            </div>
          )}
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Description</th>
                <th style={th}>Their code</th>
                <th style={thRight}>Ordered</th>
                <th style={thRight}>Had</th>
                <th style={thRight}>Still due</th>
                <th style={thRight}>Accepted</th>
                <th style={thRight}>Rejected</th>
                <th style={th}>Note</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const draft = drafts[line.id]
                const left = outstanding(line)
                const rejected = Number(draft?.qtyRejected ?? 0) > 0
                return (
                  <tr key={line.id}>
                    <td style={td}>
                      {line.description}
                      {Number(line.qtyCancelled) > 0 && <div style={muted}>{trimQty(Number(line.qtyCancelled))} cancelled</div>}
                    </td>
                    <td style={td}>{line.supplierSku ?? '—'}</td>
                    <td style={tdRight}>
                      {trimQty(Number(line.qty))} {line.unit}
                    </td>
                    <td style={tdRight}>{trimQty(Number(line.qtyReceived))}</td>
                    <td style={tdRight}>{trimQty(left)}</td>
                    <td style={tdRight}>
                      <input
                        style={{ ...input, width: 90, textAlign: 'right' }}
                        inputMode="decimal"
                        disabled={!canReceive}
                        value={draft?.qtyAccepted ?? '0'}
                        onChange={(e) => setDraft(line.id, { qtyAccepted: e.target.value })}
                        aria-label={`Accepted quantity for ${line.description}`}
                      />
                    </td>
                    <td style={tdRight}>
                      <input
                        style={{ ...input, width: 90, textAlign: 'right' }}
                        inputMode="decimal"
                        disabled={!canReceive}
                        value={draft?.qtyRejected ?? '0'}
                        onChange={(e) => setDraft(line.id, { qtyRejected: e.target.value })}
                        aria-label={`Rejected quantity for ${line.description}`}
                      />
                    </td>
                    <td style={td}>
                      <input
                        style={{ ...input, minWidth: 180 }}
                        disabled={!canReceive}
                        placeholder={rejected ? 'Why it went back' : 'Condition, batch, anything odd'}
                        value={rejected ? (draft?.rejectReason ?? '') : (draft?.conditionNote ?? '')}
                        onChange={(e) =>
                          setDraft(line.id, rejected ? { rejectReason: e.target.value } : { conditionNote: e.target.value })
                        }
                        aria-label={`Note for ${line.description}`}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {flags.length > 0 && (
          <div className="alert alert-warning" style={{ marginTop: '1rem', marginBottom: 0 }}>
            More than you ordered on {flags.length === 1 ? 'one line' : `${flags.length} lines`}. That is allowed and it
            will be recorded, but their invoice will have to answer for it:
            <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
              {flags.map((f) => (
                <li key={f.orderLineId}>
                  {f.description} - {trimQty(f.overBy)} over the {trimQty(f.ordered)} ordered
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div style={card}>
        <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>The delivery</h2>
        <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <Field label="Date it arrived">
            <input
              type="date"
              style={input}
              disabled={!canReceive}
              value={receivedDate}
              onChange={(e) => setReceivedDate(e.target.value)}
            />
          </Field>
          <Field label="Their delivery note" hint="The number on the paperwork that came with it.">
            <input style={input} disabled={!canReceive} value={deliveryNoteRef} onChange={(e) => setDeliveryNoteRef(e.target.value)} />
          </Field>
          <Field label="Carrier">
            <input style={input} disabled={!canReceive} value={carrier} onChange={(e) => setCarrier(e.target.value)} />
          </Field>
        </div>
        <div style={{ marginTop: '0.75rem' }}>
          <Field label="Notes">
            <textarea
              style={{ ...input, minHeight: 70 }}
              disabled={!canReceive}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
        </div>

        {stockOffered ? (
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.75rem' }}>
            <input type="checkbox" checked={applyStock} disabled={!canReceive} onChange={(e) => setApplyStock(e.target.checked)} />
            Add these to stock as well
          </label>
        ) : (
          stockBlockedReason && <p style={{ ...muted, marginTop: '0.75rem' }}>{stockBlockedReason}</p>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={save} disabled={!canReceive || saving || !anything}>
            {saving ? 'Recording…' : 'Record this delivery'}
          </button>
        </div>
        {!canReceive && (
          <p style={{ ...muted, marginTop: '0.5rem' }}>You do not have permission to book goods in.</p>
        )}
      </div>

      {receipts.length > 0 && (
        <div style={card}>
          <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>Already booked in</h2>
          <table style={table}>
            <tbody>
              {receipts.map((r) => (
                <tr key={r.id}>
                  <td style={td}>{r.number}</td>
                  <td style={td}>{formatDay(r.receivedDate)}</td>
                  <td style={td}>{r.deliveryNoteRef ?? '—'}</td>
                  <td style={td}>{r.receivedByName ?? 'Somebody'}</td>
                  <td style={td}>{formatWhen(r.createdAt)}</td>
                  <td style={td}>{r.stockApplied ? 'Added to stock' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
