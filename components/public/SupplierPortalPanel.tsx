'use client'

import { useState, type CSSProperties } from 'react'
import { PO_PORTAL_EVENT_LABELS, type PoPortalView } from '@/modules/purchase-orders/lib/portal-view'

// The only part of this platform a supplier ever touches.
//
// It sits under the order document on the same page, and everything it can do is
// a proposal: accept the order, offer a different date, say something is short,
// or leave a message. None of it changes the order. That is not a limitation to
// be fixed later - a document somebody else can edit is not a purchase order.
//
// Written plainly, with the site's own colour tokens and a fallback on each one,
// because this renders inside whatever theme the site is wearing and a supplier
// on a phone in a warehouse yard is the person it has to work for.

const panel: CSSProperties = {
  border: '1px solid var(--color-border, #ddd)',
  borderRadius: 10,
  background: 'var(--color-surface, #fff)',
  color: 'var(--color-text, #111)',
  padding: '1.25rem',
  marginTop: '2rem',
}

const heading: CSSProperties = { margin: '0 0 0.25rem', fontSize: '1.125rem' }
const sub: CSSProperties = { margin: '0 0 1rem', color: 'var(--color-text-secondary, #666)', fontSize: '0.875rem' }
const block: CSSProperties = { borderTop: '1px solid var(--color-border, #ddd)', paddingTop: '1rem', marginTop: '1rem' }
const label: CSSProperties = { display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.25rem' }

const field: CSSProperties = {
  padding: '0.5rem 0.625rem',
  border: '1px solid var(--color-border, #ddd)',
  borderRadius: 6,
  background: 'var(--color-bg, #fff)',
  color: 'var(--color-text, #111)',
  font: 'inherit',
  width: '100%',
  maxWidth: 420,
}

const button: CSSProperties = {
  padding: '0.5rem 1rem',
  borderRadius: 6,
  border: '1px solid var(--color-primary, #2f6f4f)',
  background: 'var(--color-primary, #2f6f4f)',
  color: 'var(--color-on-primary, #fff)',
  font: 'inherit',
  cursor: 'pointer',
}

const quietButton: CSSProperties = {
  ...button,
  background: 'transparent',
  color: 'var(--color-text, #111)',
  borderColor: 'var(--color-border, #ddd)',
}

function when(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}

type Props = {
  view: PoPortalView
  /** The supplier's own key, straight back off the address bar. It is what the
   *  server looks the order up from - there is no order id on the wire. */
  token: string
}

export function SupplierPortalPanel({ view: initial, token }: Props) {
  const [view, setView] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const [date, setDate] = useState('')
  const [dateNote, setDateNote] = useState('')
  const [shortNote, setShortNote] = useState('')
  const [shortages, setShortages] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')

  /** True when it landed, so a caller can clear its own box and only then. */
  async function send(body: Record<string, unknown>, said: string): Promise<boolean> {
    if (busy) return false
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const res = await fetch('/api/m/purchase-orders/public/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, ...body }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? 'That did not go through. Try again in a moment.')
        return false
      }
      if (data.view) setView(data.view as PoPortalView)
      setDone(said)
      return true
    } catch {
      setError('That did not go through. Try again in a moment.')
      return false
    } finally {
      setBusy(false)
    }
  }

  const shortLines = Object.entries(shortages)
    .map(([lineId, qty]) => ({ lineId, qty: qty.trim() }))
    .filter((row) => row.qty !== '' && Number(row.qty) > 0)

  return (
    <div style={panel}>
      <h2 style={heading}>Tell us about this order</h2>
      <p style={sub}>
        Anything you say here goes straight to the person who raised order {view.orderNumber}. Nothing you do on this
        page changes the order itself, so you never have to worry about pressing the wrong thing.
      </p>

      {error && (
        <p style={{ color: 'var(--color-error, #b3261e)', margin: '0 0 1rem' }} role="alert">
          {error}
        </p>
      )}
      {done && (
        <p style={{ color: 'var(--color-success, #2f6f4f)', margin: '0 0 1rem' }} role="status">
          {done}
        </p>
      )}

      {!view.open ? (
        <p style={{ margin: 0 }}>
          This order is marked as {view.statusLabel.toLowerCase()}, so there is nothing left to tell us about it here.
          If that is not right, reply to the email this link came in.
        </p>
      ) : (
        <>
          <div>
            <strong>Can you supply it?</strong>
            {view.acknowledged ? (
              <p style={{ ...sub, margin: '0.25rem 0 0' }}>
                Thank you - you accepted this order{view.acknowledgedAt ? ` on ${when(view.acknowledgedAt)}` : ''}.
              </p>
            ) : (
              <p style={{ margin: '0.5rem 0 0' }}>
                <button style={button} disabled={busy} onClick={() => void send({ action: 'acknowledge' }, 'Thank you - we have told them you can supply it.')}>
                  Yes, we can supply this
                </button>
              </p>
            )}
          </div>

          <div style={block}>
            <strong>Will it be later than we asked?</strong>
            <p style={{ ...sub, margin: '0.25rem 0 0.5rem' }}>
              {view.expectedDate ? `We have it down as ${view.expectedDate}.` : 'We have no date down for it yet.'} Tell
              us the date you can actually do and somebody here will confirm it.
            </p>
            <label style={label} htmlFor="po-portal-date">
              The date you can deliver
            </label>
            <input
              id="po-portal-date"
              type="date"
              style={field}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
            <label style={{ ...label, marginTop: '0.75rem' }} htmlFor="po-portal-date-note">
              Anything we should know (optional)
            </label>
            <input
              id="po-portal-date-note"
              style={field}
              value={dateNote}
              onChange={(e) => setDateNote(e.target.value)}
              maxLength={500}
            />
            <p style={{ margin: '0.75rem 0 0' }}>
              <button
                style={button}
                disabled={busy || !date}
                onClick={() => void send({ action: 'propose-date', date, note: dateNote || undefined }, 'Thank you - we have passed the date on.')}
              >
                Send us that date
              </button>
            </p>
          </div>

          <div style={block}>
            <strong>Is anything short?</strong>
            <p style={{ ...sub, margin: '0.25rem 0 0.5rem' }}>
              Put in how many you cannot send. Leave the rest blank.
            </p>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '0.375rem 0.5rem 0.375rem 0' }}>Line</th>
                  <th style={{ textAlign: 'right', padding: '0.375rem 0.5rem' }}>Ordered</th>
                  <th style={{ textAlign: 'right', padding: '0.375rem 0' }}>Short by</th>
                </tr>
              </thead>
              <tbody>
                {view.lines.map((line) => (
                  <tr key={line.id}>
                    <td style={{ padding: '0.375rem 0.5rem 0.375rem 0', borderTop: '1px solid var(--color-border, #ddd)' }}>
                      {line.description}
                      {line.supplierSku ? ` (${line.supplierSku})` : ''}
                    </td>
                    <td style={{ padding: '0.375rem 0.5rem', textAlign: 'right', borderTop: '1px solid var(--color-border, #ddd)' }}>
                      {line.qty} {line.unit}
                    </td>
                    <td style={{ padding: '0.375rem 0', textAlign: 'right', borderTop: '1px solid var(--color-border, #ddd)' }}>
                      <input
                        style={{ ...field, width: 90, textAlign: 'right' }}
                        inputMode="decimal"
                        value={shortages[line.id] ?? ''}
                        onChange={(e) => setShortages((s) => ({ ...s, [line.id]: e.target.value }))}
                        aria-label={`How many of ${line.description} are short`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <label style={{ ...label, marginTop: '0.75rem' }} htmlFor="po-portal-short-note">
              What has happened (optional)
            </label>
            <input
              id="po-portal-short-note"
              style={field}
              value={shortNote}
              onChange={(e) => setShortNote(e.target.value)}
              maxLength={500}
            />
            <p style={{ margin: '0.75rem 0 0' }}>
              <button
                style={button}
                disabled={busy || shortLines.length === 0}
                onClick={() =>
                  void send(
                    { action: 'shortage', lines: shortLines, note: shortNote || undefined },
                    'Thank you - we have told them what is short.',
                  )
                }
              >
                Tell us what is short
              </button>
            </p>
          </div>

          <div style={block}>
            <strong>Anything else</strong>
            <label style={{ ...label, marginTop: '0.5rem' }} htmlFor="po-portal-message">
              Your message
            </label>
            <textarea
              id="po-portal-message"
              rows={3}
              style={{ ...field, maxWidth: '100%' }}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={2000}
            />
            <p style={{ margin: '0.75rem 0 0' }}>
              <button
                style={quietButton}
                disabled={busy || !message.trim()}
                onClick={() => {
                  void send({ action: 'message', text: message.trim() }, 'Thank you - your message is with them.').then(
                    (ok) => {
                      if (ok) setMessage('')
                    },
                  )
                }}
              >
                Send it
              </button>
            </p>
          </div>
        </>
      )}

      {view.events.length > 0 && (
        <div style={block}>
          <strong>What you have told us</strong>
          <ul style={{ listStyle: 'none', margin: '0.5rem 0 0', padding: 0 }}>
            {view.events.map((event) => (
              <li key={event.id} style={{ padding: '0.375rem 0', borderTop: '1px solid var(--color-border, #ddd)' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary, #666)' }}>
                  {when(event.createdAt)} - {PO_PORTAL_EVENT_LABELS[event.kind]}
                </span>
                <div>{event.summary}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
