'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import type {
  PoAuditEntry, PoReturn, PoReturnableLine, PoStockLineResult,
} from '@/modules/purchase-orders/lib/types'
import {
  creditOutstanding, isReturnEditable, isReturnStockable, returnableQty, returnTotals,
  type PoReturnTransition,
} from '@/modules/purchase-orders/lib/returning'
import { readBooksOutcome } from '@/modules/purchase-orders/lib/books-outcome'
import {
  card, Field, formatDay, formatWhen, input, linkButton, localToday, Money, muted,
  ReturnStatusBadge, table, td, tdRight, th, thRight,
} from './ui'

// One return: what is going back, why, what it is worth, and whether the money
// has come back yet.
//
// Doubles as the "raise one" screen. `returnId` null means a new note against
// the order in `orderId` - the same trick the order screen uses, and for the same
// reason: a separate page for the empty version of a form is a second copy of
// every field, and the two drift apart within a release.

type LineDraft = { qty: string; receiptLineId: string }

type Props = {
  returnId: string | null
  orderId: string | null
  canReceive: boolean
  canBills: boolean
}

/** 3.000 reads as 3, and 2.500 as 2.5. The column keeps three places either way. */
function trimQty(value: number | string): string {
  const n = Number(value)
  return Number.isFinite(n) ? String(Number(n.toFixed(3))) : '0'
}

const TRANSITION_LABELS: Record<PoReturnTransition, string> = {
  send: 'Mark as sent',
  promised: 'They have promised a credit',
  credited: 'The credit has arrived',
  close: 'Close it',
  cancel: 'Cancel it',
  reopen: 'Reopen it',
}

export function ReturnScreen({ returnId, orderId, canReceive, canBills }: Props) {
  const router = useRouter()
  const adminPath = useAdminPath()
  const base = `/${adminPath}/m/purchase-orders`

  const isNew = returnId === null
  const [ret, setRet] = useState<PoReturn | null>(null)
  const [order, setOrder] = useState<{ id: string; number: string; currency: string; supplierName: string } | null>(null)
  const [returnable, setReturnable] = useState<PoReturnableLine[]>([])
  const [history, setHistory] = useState<PoAuditEntry[]>([])
  const [transitions, setTransitions] = useState<PoReturnTransition[]>([])
  const [stockBlocked, setStockBlocked] = useState<string | null>(null)
  const [hasBooks, setHasBooks] = useState(false)

  const [drafts, setDrafts] = useState<Record<string, LineDraft>>({})
  const [reason, setReason] = useState('')
  const [notes, setNotes] = useState('')
  const [raisedDate, setRaisedDate] = useState(localToday())
  const [editing, setEditing] = useState(isNew)

  const [creditReceived, setCreditReceived] = useState('')
  const [creditRef, setCreditRef] = useState('')

  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [stockLines, setStockLines] = useState<PoStockLineResult[]>([])
  const [loaded, setLoaded] = useState(false)

  // Written as promise chains rather than an async body called from the effect:
  // every setState lands in a callback, which is what keeps the load out of the
  // synchronous render pass.
  const load = useCallback(() => {
    if (isNew) {
      return fetch(`/api/m/purchase-orders/admin/orders/${orderId}/returnable`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data) {
            setOrder(data.order)
            setReturnable(data.lines ?? [])
            setStockBlocked(data.stockBlocked ?? null)
            setDrafts(emptyDrafts(data.lines ?? []))
          }
          setLoaded(true)
        })
        .catch(() => setLoaded(true))
    }
    return fetch(`/api/m/purchase-orders/admin/returns/${returnId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.return) {
          const note = data.return as PoReturn
          setRet(note)
          setOrder({
            id: note.orderId,
            number: note.orderNumber,
            currency: note.currency,
            supplierName: note.supplierName,
          })
          setReturnable(data.returnable ?? [])
          setHistory(data.history ?? [])
          setTransitions(data.transitions ?? [])
          setStockBlocked(data.stockBlocked ?? null)
          setHasBooks(Boolean(data.hasBooks))
          setReason(note.reason ?? '')
          setNotes(note.notes ?? '')
          setRaisedDate(note.raisedDate ?? localToday())
          setCreditReceived(note.creditExpected)
          setCreditRef(note.creditRef ?? '')
          setDrafts(draftsFromReturn(note, data.returnable ?? []))
        }
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [isNew, orderId, returnId])

  useEffect(() => {
    void load()
  }, [load])

  const currency = order?.currency ?? 'GBP'

  // What is still returnable on each line. On an existing draft its own
  // quantities are added back, or a note saved twice would shrink each time.
  const headroom = useMemo(() => {
    const mine = new Map<string, number>()
    if (ret && isReturnEditable(ret.status)) {
      for (const line of ret.lines) {
        mine.set(line.orderLineId, (mine.get(line.orderLineId) ?? 0) + Number(line.qty))
      }
    }
    const out = new Map<string, number>()
    for (const line of returnable) {
      out.set(line.orderLineId, returnableQty(line) + (mine.get(line.orderLineId) ?? 0))
    }
    return out
  }, [returnable, ret])

  // The same arithmetic the server will do on save, run here only so the numbers
  // move while somebody types. Nothing on the wire depends on it.
  const totals = useMemo(
    () =>
      returnTotals(
        returnable
          .filter((line) => Number(drafts[line.orderLineId]?.qty ?? 0) > 0)
          .map((line) => ({
            qty: drafts[line.orderLineId]?.qty ?? '0',
            unitCost: line.unitCost,
            taxRatePercent: line.taxRatePercent,
          })),
      ),
    [returnable, drafts],
  )

  const anything = returnable.some((line) => Number(drafts[line.orderLineId]?.qty ?? 0) > 0)
  const tooMuch = returnable.filter(
    (line) => Number(drafts[line.orderLineId]?.qty ?? 0) > (headroom.get(line.orderLineId) ?? 0) + 0.0005,
  )

  function setDraft(orderLineId: string, patch: Partial<LineDraft>) {
    setDrafts((d) => ({ ...d, [orderLineId]: { ...(d[orderLineId] ?? { qty: '0', receiptLineId: '' }), ...patch } }))
  }

  async function save() {
    setError(null)
    setMessage(null)
    setSaving(true)
    const body = {
      orderId: order?.id ?? orderId,
      reason: reason || null,
      raisedDate,
      notes: notes || null,
      lines: returnable.map((line) => ({
        orderLineId: line.orderLineId,
        receiptLineId: drafts[line.orderLineId]?.receiptLineId || null,
        qty: drafts[line.orderLineId]?.qty || '0',
      })),
    }
    const res = await fetch(
      isNew ? '/api/m/purchase-orders/admin/returns' : `/api/m/purchase-orders/admin/returns/${returnId}`,
      {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    setSaving(false)
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not save that return.')
      return
    }
    const data = await res.json()
    if (isNew) {
      router.push(`${base}/returns/${data.id}`)
      return
    }
    setEditing(false)
    await load()
    router.refresh()
  }

  async function runTransition(transition: PoReturnTransition) {
    setError(null)
    setMessage(null)
    setBusy(true)
    const res = await fetch(`/api/m/purchase-orders/admin/returns/${returnId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transition,
        creditReceived: transition === 'credited' ? creditReceived || null : null,
        creditRef: transition === 'credited' ? creditRef || null : null,
      }),
    })
    setBusy(false)
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'That did not work.')
      return
    }
    await load()
    router.refresh()
  }

  // Whatever the books last said about this credit, read defensively: the column
  // is JSON and a release older than this one wrote nothing into it at all.
  const booksOutcome = useMemo(() => readBooksOutcome(ret?.booksOutcome), [ret?.booksOutcome])

  /** Send the credit to the books, or try again after they said no. */
  async function sendToBooks() {
    setError(null)
    setMessage(null)
    setBusy(true)
    const res = await fetch(`/api/m/purchase-orders/admin/returns/${returnId}/books`, { method: 'POST' })
    setBusy(false)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(data.error ?? 'That did not work.')
      return
    }
    setMessage(data.books?.message ?? 'Sent to the books.')
    await load()
    router.refresh()
  }

  async function sendIt() {
    setError(null)
    setMessage(null)
    setBusy(true)
    const res = await fetch(`/api/m/purchase-orders/admin/returns/${returnId}/send`, { method: 'POST' })
    setBusy(false)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(data.error ?? 'The return could not be sent.')
      return
    }
    setMessage(`Sent to ${data.to}.`)
    await load()
  }

  async function takeOffStock() {
    setError(null)
    setMessage(null)
    setStockLines([])
    setBusy(true)
    const res = await fetch(`/api/m/purchase-orders/admin/returns/${returnId}/stock`, { method: 'POST' })
    setBusy(false)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(data.error ?? 'Stock was not changed.')
      return
    }
    setMessage('Stock updated.')
    setStockLines((data.result?.lines ?? []) as PoStockLineResult[])
    await load()
  }

  async function remove() {
    setError(null)
    setBusy(true)
    const res = await fetch(`/api/m/purchase-orders/admin/returns/${returnId}`, { method: 'DELETE' })
    setBusy(false)
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not delete that return.')
      return
    }
    router.push(`${base}/returns`)
  }

  if (!loaded) return <p>Loading…</p>
  if (!isNew && !ret) return <div className="alert alert-danger">That return is not here any more.</div>
  if (isNew && returnable.length === 0) {
    return (
      <div className="alert alert-warning">
        Nothing has been delivered against this order yet, so there is nothing to send back.
      </div>
    )
  }

  const editable = isNew || (ret !== null && isReturnEditable(ret.status) && canReceive)

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <h1 className="page-title">
          {isNew ? `Send something back on ${order?.number ?? ''}` : `Return ${ret!.number}`}
          {!isNew && <span style={{ marginLeft: '0.75rem' }}><ReturnStatusBadge status={ret!.status} /></span>}
        </h1>
        <Link href={`${base}/returns`} className="btn btn-secondary">
          Back to returns
        </Link>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}
      {message && (
        <div className="alert alert-success">
          {message}
          {stockLines.length > 0 && (
            <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
              {stockLines.map((l, i) => (
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
            <div>{order?.supplierName ?? '—'}</div>
          </div>
          <div>
            <div style={muted}>Against order</div>
            <div>
              <Link href={`${base}/orders/${order?.id ?? ''}`} style={{ color: 'var(--color-primary)' }}>
                {order?.number ?? '—'}
              </Link>
            </div>
          </div>
          <div>
            <div style={muted}>Raised</div>
            <div>{isNew ? formatDay(raisedDate) : formatDay(ret!.raisedDate)}</div>
          </div>
          {!isNew && (
            <div>
              <div style={muted}>Sent</div>
              <div>{ret!.sentAt ? formatWhen(ret!.sentAt) : 'Not yet'}</div>
            </div>
          )}
        </div>
      </div>

      <div style={card}>
        <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>What is going back</h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Description</th>
                <th style={th}>Their code</th>
                <th style={thRight}>Delivered</th>
                <th style={thRight}>Already back</th>
                <th style={thRight}>{editable ? 'Sending back' : 'Sent back'}</th>
                <th style={th}>Came in on</th>
                <th style={thRight}>Credit due</th>
              </tr>
            </thead>
            <tbody>
              {returnable.map((line) => {
                const draft = drafts[line.orderLineId]
                const qty = Number(draft?.qty ?? 0)
                const lineTotal = (Math.round(qty * Number(line.unitCost) * 100) / 100).toFixed(2)
                const over = qty > (headroom.get(line.orderLineId) ?? 0) + 0.0005
                return (
                  <tr key={line.orderLineId}>
                    <td style={td}>{line.description}</td>
                    <td style={td}>{line.supplierSku ?? '—'}</td>
                    <td style={tdRight}>
                      {trimQty(line.qtyReceived)} {line.unit}
                    </td>
                    <td style={tdRight}>{trimQty(line.qtyReturned)}</td>
                    <td style={tdRight}>
                      {editable ? (
                        <input
                          style={{
                            ...input,
                            width: 90,
                            textAlign: 'right',
                            ...(over ? { borderColor: 'var(--color-error)' } : {}),
                          }}
                          inputMode="decimal"
                          value={draft?.qty ?? '0'}
                          onChange={(e) => setDraft(line.orderLineId, { qty: e.target.value })}
                          aria-label={`Quantity going back for ${line.description}`}
                        />
                      ) : (
                        trimQty(draft?.qty ?? '0')
                      )}
                    </td>
                    <td style={td}>
                      {/* Which delivery these arrived on. It prints on the note
                          for the supplier's own goods-in desk, and it is what
                          decides whether the goods can come off a stock count. */}
                      {editable && line.receipts.length > 0 ? (
                        <select
                          style={{ ...input, minWidth: 170 }}
                          value={draft?.receiptLineId ?? ''}
                          onChange={(e) => setDraft(line.orderLineId, { receiptLineId: e.target.value })}
                          aria-label={`Delivery for ${line.description}`}
                        >
                          <option value="">Not sure</option>
                          {line.receipts.map((r) => (
                            <option key={r.receiptLineId} value={r.receiptLineId}>
                              {r.receiptNumber} · {formatDay(r.receivedDate)}
                              {r.stockApplied ? ' · stocked' : ''}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span style={muted}>
                          {line.receipts.find((r) => r.receiptLineId === draft?.receiptLineId)?.receiptNumber ?? '—'}
                        </span>
                      )}
                    </td>
                    <td style={tdRight}>
                      <Money value={lineTotal} currency={currency} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {tooMuch.length > 0 && (
          <div className="alert alert-danger" style={{ marginTop: '1rem', marginBottom: 0 }}>
            You cannot send back more than turned up:
            <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
              {tooMuch.map((line) => (
                <li key={line.orderLineId}>
                  {line.description} - {trimQty(headroom.get(line.orderLineId) ?? 0)} left to return
                </li>
              ))}
            </ul>
          </div>
        )}

        <table style={{ ...table, marginTop: '1rem', maxWidth: 320, marginLeft: 'auto' }}>
          <tbody>
            <tr>
              <td style={td}>Goods</td>
              <td style={tdRight}>
                <Money value={editable ? totals.subtotal : ret?.taxAmount !== undefined ? subtotalOf(ret) : '0'} currency={currency} />
              </td>
            </tr>
            <tr>
              <td style={td}>VAT</td>
              <td style={tdRight}>
                <Money value={editable ? totals.taxAmount : (ret?.taxAmount ?? '0')} currency={currency} />
              </td>
            </tr>
            <tr>
              <td style={{ ...td, fontWeight: 600 }}>Credit due</td>
              <td style={{ ...tdRight, fontWeight: 600 }}>
                <Money value={editable ? totals.creditExpected : (ret?.creditExpected ?? '0')} currency={currency} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style={card}>
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <Field label="Why they are going back" hint="This prints on the note. It is what a supplier decides on.">
            {editable ? (
              <textarea rows={3} style={input} value={reason} onChange={(e) => setReason(e.target.value)} />
            ) : (
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{ret?.reason || '—'}</p>
            )}
          </Field>
          <Field label="Notes" hint="Also on the note - collection arrangements, packaging, anything else.">
            {editable ? (
              <textarea rows={2} style={input} value={notes} onChange={(e) => setNotes(e.target.value)} />
            ) : (
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{ret?.notes || '—'}</p>
            )}
          </Field>
          {editable && (
            <div style={{ maxWidth: 220 }}>
              <Field label="Date raised">
                <input type="date" style={input} value={raisedDate} onChange={(e) => setRaisedDate(e.target.value)} />
              </Field>
            </div>
          )}
        </div>

        {editable && (
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              onClick={save}
              disabled={saving || !anything || tooMuch.length > 0}
            >
              {saving ? 'Saving…' : isNew ? 'Raise this return' : 'Save changes'}
            </button>
            {!isNew && (
              <button className="btn btn-secondary" onClick={() => { setEditing(false); void load() }}>
                Cancel
              </button>
            )}
          </div>
        )}
        {!editable && !isNew && ret !== null && isReturnEditable(ret.status) && !canReceive && (
          <p style={{ ...muted, marginTop: '0.5rem' }}>You do not have permission to change a return.</p>
        )}
        {!isNew && ret !== null && !isReturnEditable(ret.status) && !editing && (
          <p style={{ ...muted, marginTop: '0.5rem' }}>
            The supplier is holding a copy of this one, so it cannot be edited. Cancel it and raise another if it is wrong.
          </p>
        )}
      </div>

      {!isNew && ret !== null && (
        <>
          <div style={card}>
            <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>The credit</h2>
            <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
              <div>
                <div style={muted}>Claimed</div>
                <div><Money value={ret.creditExpected} currency={currency} /></div>
              </div>
              <div>
                <div style={muted}>Credited so far</div>
                <div><Money value={ret.creditReceived} currency={currency} /></div>
              </div>
              <div>
                <div style={muted}>Still owed</div>
                <div><Money value={creditOutstanding(ret.creditExpected, ret.creditReceived)} currency={currency} /></div>
              </div>
              <div>
                <div style={muted}>Their credit note</div>
                <div>{ret.creditRef ?? '—'}</div>
              </div>
            </div>

            {canBills && transitions.includes('credited') && (
              <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', marginTop: '1rem' }}>
                <Field label="Amount credited" hint="Blank credits the whole claim.">
                  <input style={input} value={creditReceived} onChange={(e) => setCreditReceived(e.target.value)} />
                </Field>
                <Field label="Their credit note number">
                  <input style={input} value={creditRef} onChange={(e) => setCreditRef(e.target.value)} />
                </Field>
              </div>
            )}
          </div>

          <div style={card}>
            <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>The note</h2>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {/* Plain links: one is a page to look at and the other a file to
                  save, and the browser does both better than we would. The
                  document link redirects through a route that mints its own
                  short-lived token, so nothing here has to carry one. */}
              <a
                className="btn btn-secondary"
                href={`/api/m/purchase-orders/admin/returns/${ret.id}/document`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View note
              </a>
              <a className="btn btn-secondary" href={`/api/m/purchase-orders/admin/returns/${ret.id}/pdf`}>
                Download PDF
              </a>
              {canReceive && (
                <button className="btn btn-primary" onClick={sendIt} disabled={busy}>
                  {ret.sentAt ? 'Send it again' : 'Email it to the supplier'}
                </button>
              )}
              {canReceive && isReturnStockable(ret.status) && !ret.stockApplied && !stockBlocked && (
                <button className="btn btn-secondary" onClick={takeOffStock} disabled={busy}>
                  Take these off stock
                </button>
              )}
            </div>
            {ret.stockApplied && (
              <p style={{ ...muted, marginTop: '0.75rem' }}>
                Taken off stock {ret.stockAppliedAt ? formatWhen(ret.stockAppliedAt) : ''}.
              </p>
            )}
            {stockBlocked && !ret.stockApplied && (
              <p style={{ ...muted, marginTop: '0.75rem' }}>{stockBlocked}</p>
            )}
          </div>

          {(hasBooks || booksOutcome) && (
            <div style={card}>
              <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>In the books</h2>
              {booksOutcome ? (
                <p
                  style={{
                    margin: '0 0 0.75rem',
                    color: booksOutcome.ok ? 'var(--color-text)' : 'var(--color-error)',
                  }}
                >
                  {booksOutcome.message}
                </p>
              ) : (
                <p style={{ ...muted, margin: '0 0 0.75rem' }}>
                  A credit reaches the accounts once the money has actually come back.
                </p>
              )}
              {canBills && (ret.status === 'CREDITED' || ret.status === 'CLOSED') && (
                <button className="btn btn-secondary" onClick={sendToBooks} disabled={busy}>
                  {booksOutcome ? 'Try the books again' : 'Send it to the books'}
                </button>
              )}
            </div>
          )}

          <div style={card}>
            <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>What happens next</h2>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {transitions.map((t) => (
                <button key={t} className="btn btn-secondary" onClick={() => runTransition(t)} disabled={busy}>
                  {TRANSITION_LABELS[t]}
                </button>
              ))}
              {transitions.length === 0 && (
                <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
                  Nothing left to do with this one.
                </p>
              )}
            </div>
            {canReceive && ret.status === 'DRAFT' && (
              <p style={{ marginTop: '0.75rem', marginBottom: 0 }}>
                <button style={linkButton} onClick={remove} disabled={busy}>
                  Delete this draft
                </button>
              </p>
            )}
          </div>

          {history.length > 0 && (
            <div style={card}>
              <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>History</h2>
              <table style={table}>
                <tbody>
                  {history.map((entry) => (
                    <tr key={entry.id}>
                      <td style={td}>{entry.action.replace(/^return\./, '').replace(/[-_]/g, ' ')}</td>
                      <td style={td}>{entry.userName ?? 'Somebody'}</td>
                      <td style={td}>{formatWhen(entry.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** The net of a saved return, from its own lines. */
function subtotalOf(ret: PoReturn | null): string {
  if (!ret) return '0'
  const pence = ret.lines.reduce((sum, line) => sum + Math.round(Number(line.lineTotal) * 100), 0)
  return (pence / 100).toFixed(2)
}

/** Nothing pre-filled. Unlike a delivery - where "it all came" is the
 *  overwhelmingly common case - the overwhelmingly common return is one line out
 *  of eight, and a form that starts by proposing to send everything back is a
 *  form somebody will one day save by accident. */
function emptyDrafts(lines: PoReturnableLine[]): Record<string, LineDraft> {
  const out: Record<string, LineDraft> = {}
  for (const line of lines) {
    out[line.orderLineId] = { qty: '0', receiptLineId: line.receipts[0]?.receiptLineId ?? '' }
  }
  return out
}

function draftsFromReturn(ret: PoReturn, lines: PoReturnableLine[]): Record<string, LineDraft> {
  const out = emptyDrafts(lines)
  for (const line of ret.lines) {
    out[line.orderLineId] = {
      qty: trimQty(line.qty),
      receiptLineId: line.receiptLineId ?? out[line.orderLineId]?.receiptLineId ?? '',
    }
  }
  return out
}
