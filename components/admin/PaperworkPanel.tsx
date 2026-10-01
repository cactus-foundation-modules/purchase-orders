'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { startingKind } from '@/modules/purchase-orders/lib/inbound-filing'
import { PO_STATUS_LABELS, type PoStatus } from '@/modules/purchase-orders/lib/types'
import { card, formatDay, input, linkButton, muted } from './ui'

// Supplier paperwork from email that is waiting for a person.
//
// Everything the half-hourly job could not file on its own (lib/inbound-run.ts)
// lands here, at the top of the Orders tab, each with the one sentence saying
// why and three answers: file it on this order, it is not ours, ignore it.
// Filing by hand runs the same code the job does, rules and all, so a choice
// here cannot put a proforma on a cancelled order any more than the machine
// can.
//
// Delivery tracking matched to an order by its postcode alone waits here too
// (lib/inbound-tracking.ts), with "yes, that one" in place of the filing
// controls.
//
// Draws nothing at all when nothing is waiting, which on most sites - and on
// every site that never switches the filing on - is always.

type Kind = 'proforma' | 'acknowledgement' | 'invoice'

type Choice = { id: string; number: string; status: PoStatus; supplierName: string }

type Item = {
  id: string
  threadId: string | null
  sourceMediaId: string | null
  filename: string
  subject: string
  fromAddress: string
  receivedAt: string | null
  pageFrom: number
  pageTo: number | null
  pageCount: number | null
  kind: string | null
  supplierRef: string | null
  reason: string | null
  supplierNames: string[]
  choices: Choice[]
  orderNumber: string | null
  tracking: Tracking | null
}

type Tracking = {
  carrier: string | null
  trackingNumber: string | null
  trackingUrl: string | null
  deliveryDate: string | null
  deliverySlot: [string, string] | null
  postcodes: string[]
}

const KIND_OPTIONS: Array<{ value: Kind; label: string }> = [
  { value: 'proforma', label: 'Their proforma' },
  { value: 'acknowledgement', label: 'Their acknowledgement' },
  { value: 'invoice', label: 'Their invoice (enters a draft bill)' },
]



function pagesOf(item: Item): string {
  if (item.pageFrom < 1 || !item.pageCount || item.pageCount < 2) return ''
  const to = item.pageTo ?? item.pageFrom
  return ` (page ${to > item.pageFrom ? `${item.pageFrom}-${to}` : item.pageFrom} of ${item.pageCount})`
}

async function decide(id: string, body: Record<string, unknown>): Promise<{ ok: true; orderNumber?: string } | { ok: false; error: string }> {
  const res = await fetch(`/api/m/purchase-orders/admin/paperwork/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, error: data.error ?? 'That did not work. Try again.' }
  return { ok: true, orderNumber: data.orderNumber }
}

/** Where the email came from, and a way back to it. */
function FromLine({ item }: { item: Item }) {
  const adminPath = useAdminPath()
  return (
    <div style={muted}>
      {item.supplierNames.join(' or ') || item.fromAddress}
      {item.receivedAt ? `, ${formatDay(item.receivedAt)}` : ''}
      {item.threadId && (
        <>
          {' · '}
          <a
            href={`/${adminPath}/inbox?tab=unified-inbox&id=${encodeURIComponent(item.threadId)}`}
            style={{ color: 'var(--color-primary)' }}
          >
            Open the email
          </a>
        </>
      )}
    </div>
  )
}

/**
 * Delivery tracking matched to an order by its postcode alone. Never recorded
 * by itself - it would reach that customer's order - so it waits here for a
 * person to say "yes, that one", which records it exactly as a certain match
 * would have.
 */
function TrackingRow({ item, canFile, onDone }: { item: Item; canFile: boolean; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const t = item.tracking

  async function act(body: Record<string, unknown>, done: string) {
    setBusy(true)
    setProblem(null)
    try {
      const result = await decide(item.id, body)
      if (!result.ok) setProblem(result.error)
      else onDone(result.orderNumber ? `Tracking recorded on ${result.orderNumber}.` : done)
    } finally {
      setBusy(false)
    }
  }

  const slot = t?.deliverySlot ? `, ${t.deliverySlot[0]} to ${t.deliverySlot[1]}` : ''
  return (
    <li style={{ padding: '0.75rem 0', borderTop: '1px solid var(--color-border)' }}>
      <div style={{ fontWeight: 600 }}>
        Delivery tracking{item.orderNumber ? ` for ${item.orderNumber}?` : ''}
      </div>
      <FromLine item={item} />
      {t && (
        <div style={{ ...muted, marginTop: '0.25rem' }}>
          {[t.carrier, t.trackingNumber].filter(Boolean).join(' ')}
          {t.trackingUrl && (
            <>
              {t.carrier || t.trackingNumber ? ' · ' : ''}
              <a href={t.trackingUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--color-primary)' }}>
                Their tracking page
              </a>
            </>
          )}
          {t.deliveryDate ? ` · delivering ${formatDay(t.deliveryDate)}${slot}` : ''}
          {t.postcodes.length > 0 ? ` · to ${t.postcodes.join(', ')}` : ''}
        </div>
      )}
      {item.reason && <p style={{ margin: '0.375rem 0 0' }}>{item.reason}</p>}
      {canFile && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.5rem' }}>
          {item.orderNumber && (
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act({ action: 'apply-tracking' }, 'Recorded.')}>
              Yes, that one
            </button>
          )}
          <button style={linkButton} disabled={busy} onClick={() => void act({ action: 'not-ours' }, 'Marked as not ours.')}>
            It is not ours
          </button>
          <button style={linkButton} disabled={busy} onClick={() => void act({ action: 'ignore' }, 'Ignored.')}>
            Ignore it
          </button>
        </div>
      )}
      {problem && <div style={{ ...muted, color: 'var(--color-danger)', marginTop: '0.375rem' }}>{problem}</div>}
    </li>
  )
}

function PaperworkRow({
  item,
  canFile,
  canFileInvoices,
  onDone,
}: {
  item: Item
  canFile: boolean
  canFileInvoices: boolean
  onDone: (message: string) => void
}) {
  const [orderId, setOrderId] = useState('')
  const [kind, setKind] = useState<Kind | ''>(startingKind(item.kind, canFileInvoices))
  const [ref, setRef] = useState(item.supplierRef ?? '')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function act(body: Record<string, unknown>, done: string) {
    setBusy(true)
    setProblem(null)
    try {
      const result = await decide(item.id, body)
      if (!result.ok) setProblem(result.error)
      else onDone(result.orderNumber ? `Filed on ${result.orderNumber}.` : done)
    } finally {
      setBusy(false)
    }
  }

  const fileable = canFile && item.sourceMediaId !== null && item.choices.length > 0
  const kinds = KIND_OPTIONS.filter((option) => option.value !== 'invoice' || canFileInvoices)

  return (
    <li style={{ padding: '0.75rem 0', borderTop: '1px solid var(--color-border)' }}>
      <div style={{ fontWeight: 600 }}>
        {item.filename || 'A file'}
        {pagesOf(item)}
      </div>
      <FromLine item={item} />
      {item.reason && <p style={{ margin: '0.375rem 0 0' }}>{item.reason}</p>}

      {canFile && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.5rem' }}>
          {fileable && (
            <>
              <select
                style={{ ...input, width: 'auto' }}
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                aria-label="The purchase order it belongs on"
                disabled={busy}
              >
                <option value="">Which order?</option>
                {item.choices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.number} ({PO_STATUS_LABELS[choice.status].toLowerCase()})
                    {item.supplierNames.length > 1 ? `, ${choice.supplierName}` : ''}
                  </option>
                ))}
              </select>
              <select
                style={{ ...input, width: 'auto' }}
                value={kind}
                onChange={(e) => setKind(e.target.value as Kind | '')}
                aria-label="What it is"
                disabled={busy}
              >
                <option value="">What is it?</option>
                {kinds.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <input
                style={{ ...input, width: 'auto', minWidth: 160 }}
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="Their reference"
                aria-label="Their reference"
                maxLength={120}
                disabled={busy}
              />
              <button
                className="btn btn-primary btn-sm"
                disabled={busy || !orderId || !kind}
                onClick={() => void act({ action: 'file', orderId, kind, ref: ref.trim() || undefined }, 'Filed.')}
              >
                File it on this order
              </button>
            </>
          )}
          <button
            style={linkButton}
            disabled={busy}
            onClick={() => void act({ action: 'not-ours' }, 'Marked as not ours.')}
          >
            It is not ours
          </button>
          <button style={linkButton} disabled={busy} onClick={() => void act({ action: 'ignore' }, 'Ignored.')}>
            Ignore it
          </button>
        </div>
      )}
      {problem && <div style={{ ...muted, color: 'var(--color-danger)', marginTop: '0.375rem' }}>{problem}</div>}
    </li>
  )
}

export function PaperworkPanel({ onFiled }: { onFiled?: () => void }) {
  const [items, setItems] = useState<Item[]>([])
  const [canFile, setCanFile] = useState(false)
  const [canFileInvoices, setCanFileInvoices] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // Bumped after every decision to read the list again.
  const [version, setVersion] = useState(0)
  const refresh = useCallback(() => setVersion((v) => v + 1), [])

  useEffect(() => {
    let live = true
    fetch('/api/m/purchase-orders/admin/paperwork')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!live || !data) return
        setItems(data.items ?? [])
        setCanFile(Boolean(data.canFile))
        setCanFileInvoices(Boolean(data.canFileInvoices))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [version])

  if (items.length === 0 && !message) return null

  return (
    <div style={{ ...card, borderColor: 'var(--color-warning)' }}>
      <h2 style={{ margin: '0 0 0.25rem', fontSize: 'var(--text-lg)' }}>Paperwork</h2>
      <p style={{ ...muted, margin: 0 }}>
        {items.length === 0
          ? 'Nothing else is waiting.'
          : `Supplier paperwork and delivery tracking from email that could not be filed on its own. ${items.length === 1 ? 'One needs' : `${items.length} need`} a decision.`}
      </p>
      {message && <p style={{ margin: '0.5rem 0 0' }} role="status">{message}</p>}
      <ul style={{ listStyle: 'none', margin: '0.5rem 0 0', padding: 0 }}>
        {items.map((item) => {
          const onDone = (done: string) => {
            setMessage(done)
            refresh()
            onFiled?.()
          }
          return item.kind === 'tracking' ? (
            <TrackingRow key={item.id} item={item} canFile={canFile} onDone={onDone} />
          ) : (
            <PaperworkRow key={item.id} item={item} canFile={canFile} canFileInvoices={canFileInvoices} onDone={onDone} />
          )
        })}
      </ul>
    </div>
  )
}
