'use client'

import { useRef, useState, type CSSProperties } from 'react'
import { preflightFileError } from '@/modules/purchase-orders/lib/bill-file-kinds'
import { PO_PORTAL_EVENT_LABELS, type PoPortalView } from '@/modules/purchase-orders/lib/portal-view'

// The only part of this platform a supplier ever touches.
//
// It sits ABOVE the order document on the same page, and that is deliberate: a
// supplier should not have to scroll past thirty lines of desks to find the
// button that says they can supply them. Everything they can press is in this
// panel, and the panel is the first thing on the page.
//
// Most of what it does is still a PROPOSAL. Accepting the order stamps it,
// attaching a document files it, and telling us what has left them files a
// despatch - none of which changes a line, a price or a total. That is not a
// limitation to be fixed later: a document somebody else can edit is not a
// purchase order.
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
  marginBottom: '2rem',
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

/** A download, drawn as a button but built as a link - a browser needs an anchor
 *  to save a file it has not been handed by script, and the viewer's own sandbox
 *  is a great deal happier about one. */
const linkButton: CSSProperties = {
  ...quietButton,
  display: 'inline-block',
  textDecoration: 'none',
}

const cell: CSSProperties = { padding: '0.375rem 0.5rem 0.375rem 0', borderTop: '1px solid var(--color-border, #ddd)' }
const cellRight: CSSProperties = { ...cell, textAlign: 'right', padding: '0.375rem 0.5rem' }
const headCell: CSSProperties = { textAlign: 'left', padding: '0.375rem 0.5rem 0.375rem 0', fontWeight: 600 }
const headCellRight: CSSProperties = { ...headCell, textAlign: 'right', padding: '0.375rem 0.5rem' }

function when(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}

/** Today, in the browser's own clock, as the plain day the server expects. Not
 *  toISOString(): that is UTC, and a supplier despatching at eight in the evening
 *  in July would have their date put back to yesterday. */
function today(): string {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

const ENDPOINT = '/api/m/purchase-orders/public/portal'

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

  const [dates, setDates] = useState<Record<string, string>>({})
  const [dateNote, setDateNote] = useState('')
  const [shortNote, setShortNote] = useState('')
  const [shortages, setShortages] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')

  const [proformaRef, setProformaRef] = useState('')
  const [proformaAmount, setProformaAmount] = useState('')
  const proformaFile = useRef<HTMLInputElement | null>(null)

  const [ackRef, setAckRef] = useState('')
  const ackFile = useRef<HTMLInputElement | null>(null)

  const [despatchDate, setDespatchDate] = useState(today())
  const [carrier, setCarrier] = useState('')
  const [trackingRef, setTrackingRef] = useState('')
  const [despatchQty, setDespatchQty] = useState<Record<string, string>>({})
  const [despatchNote, setDespatchNote] = useState('')

  const orderPdfUrl = `${ENDPOINT}/pdf?k=${encodeURIComponent(token)}`
  const packingSlipUrl = (number: string) =>
    `${ENDPOINT}/packing-slip?k=${encodeURIComponent(token)}&d=${encodeURIComponent(number)}`

  /** True when it landed, so a caller can clear its own boxes and only then. */
  async function send(body: Record<string, unknown>, said: string): Promise<boolean> {
    if (busy) return false
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const res = await fetch(ENDPOINT, {
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

  /** A file, with the same checks the server runs done here first so an obvious
   *  refusal costs nobody an upload. */
  async function upload(
    input: HTMLInputElement | null,
    kind: 'proforma' | 'acknowledgement',
    extra: Record<string, string>,
    said: string,
  ): Promise<boolean> {
    if (busy) return false
    const file = input?.files?.[0]
    if (!file) {
      setError('Choose a file first.')
      return false
    }
    const refusal = preflightFileError(file)
    if (refusal) {
      setError(refusal)
      return false
    }

    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const form = new FormData()
      form.set('token', token)
      form.set('kind', kind)
      for (const [key, value] of Object.entries(extra)) if (value) form.set(key, value)
      form.set('file', file)

      const res = await fetch(`${ENDPOINT}/upload`, { method: 'POST', body: form })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? 'That did not go through. Try again in a moment.')
        return false
      }
      if (data.view) setView(data.view as PoPortalView)
      setDone(said)
      if (input) input.value = ''
      return true
    } catch {
      setError('That did not go through. Try again in a moment.')
      return false
    } finally {
      setBusy(false)
    }
  }

  const dateLines = Object.entries(dates)
    .map(([lineId, date]) => ({ lineId, date: date.trim() }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date))

  const shortLines = Object.entries(shortages)
    .map(([lineId, qty]) => ({ lineId, qty: qty.trim() }))
    .filter((row) => row.qty !== '' && Number(row.qty) > 0)

  const stillToSend = view.lines.filter((line) => Number(line.qtyToSend) > 0)
  const despatchLines = Object.entries(despatchQty)
    .map(([lineId, qty]) => ({ lineId, qty: qty.trim() }))
    .filter((row) => row.qty !== '' && Number(row.qty) > 0)

  return (
    <div style={panel}>
      <h2 style={heading}>Order {view.orderNumber}</h2>
      <p style={sub}>
        Everything you need to tell us about this order is on this page, and the order itself is printed below.
        Nothing you do here changes the order, so you never have to worry about pressing the wrong thing.
      </p>

      {/* The one thing on this panel that is not about telling us something: a
          copy of the order to keep. It sits first because it is what a supplier
          reaches for before anything else. */}
      <p style={{ margin: '0 0 1rem' }}>
        <a style={linkButton} href={orderPdfUrl}>
          Download this order as a PDF
        </a>
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
          {/* ---------------------------------------------------------------
              The proforma, on an order to a supplier we pay up front.
              Absent entirely on every other order, which is most of them.
              --------------------------------------------------------------- */}
          {view.proforma.required && (
            <div style={block}>
              <strong>Your proforma invoice</strong>
              {view.proforma.paid ? (
                <p style={{ ...sub, margin: '0.25rem 0 0' }}>
                  Paid{view.proforma.paidAt ? ` on ${when(view.proforma.paidAt)}` : ''}
                  {view.proforma.ref ? `, against your ${view.proforma.ref}` : ''}. You can confirm the order below.
                </p>
              ) : (
                <>
                  <p style={{ ...sub, margin: '0.25rem 0 0.5rem' }}>
                    {view.proforma.received
                      ? 'We have your proforma and it is with us to pay. You can send a replacement here if you need to.'
                      : 'We pay this order up front. Send us your proforma and we will pay it, and then you can confirm the order below.'}
                  </p>
                  {view.canUpload ? (
                    <>
                      <label style={label} htmlFor="po-portal-proforma">
                        Your proforma (PDF, JPEG, PNG or WebP)
                      </label>
                      <input
                        id="po-portal-proforma"
                        ref={proformaFile}
                        type="file"
                        accept=".pdf,.jpg,.jpeg,.png,.webp"
                        style={{ ...field, padding: '0.375rem' }}
                      />
                      <label style={{ ...label, marginTop: '0.75rem' }} htmlFor="po-portal-proforma-ref">
                        Your invoice number (optional)
                      </label>
                      <input
                        id="po-portal-proforma-ref"
                        style={field}
                        value={proformaRef}
                        onChange={(e) => setProformaRef(e.target.value)}
                        maxLength={120}
                      />
                      <label style={{ ...label, marginTop: '0.75rem' }} htmlFor="po-portal-proforma-amount">
                        The amount, if it is not the order total (optional)
                      </label>
                      <input
                        id="po-portal-proforma-amount"
                        style={{ ...field, maxWidth: 200 }}
                        inputMode="decimal"
                        value={proformaAmount}
                        onChange={(e) => setProformaAmount(e.target.value)}
                        maxLength={13}
                      />
                      <p style={{ margin: '0.75rem 0 0' }}>
                        <button
                          style={button}
                          disabled={busy}
                          onClick={() =>
                            void upload(
                              proformaFile.current,
                              'proforma',
                              { ref: proformaRef.trim(), amount: proformaAmount.trim() },
                              'Thank you - your proforma is with us.',
                            )
                          }
                        >
                          Send us your proforma
                        </button>
                      </p>
                    </>
                  ) : (
                    <p style={{ margin: 0 }}>Email your proforma to us, quoting {view.orderNumber}.</p>
                  )}
                </>
              )}
            </div>
          )}

          {/* ---------------------------------------------------------------
              Confirming the order, with their own acknowledgement attached.
              --------------------------------------------------------------- */}
          <div style={block}>
            <strong>Can you supply it?</strong>
            {view.acknowledged ? (
              <p style={{ ...sub, margin: '0.25rem 0 0' }}>
                Thank you - you accepted this order{view.acknowledgedAt ? ` on ${when(view.acknowledgedAt)}` : ''}.
                {view.acknowledgementFiled ? ' We have your acknowledgement on file.' : ''}
              </p>
            ) : !view.canAcknowledge ? (
              <p style={{ ...sub, margin: '0.25rem 0 0' }}>{view.acknowledgeBlockedReason}</p>
            ) : (
              <>
                {view.canUpload && (
                  <>
                    <p style={{ ...sub, margin: '0.25rem 0 0.5rem' }}>
                      Attach your order acknowledgement if you have one. It is not compulsory - you can simply confirm.
                    </p>
                    <label style={label} htmlFor="po-portal-ack">
                      Your acknowledgement (PDF, JPEG, PNG or WebP)
                    </label>
                    <input
                      id="po-portal-ack"
                      ref={ackFile}
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png,.webp"
                      style={{ ...field, padding: '0.375rem' }}
                    />
                    <label style={{ ...label, marginTop: '0.75rem' }} htmlFor="po-portal-ack-ref">
                      Your own reference for it (optional)
                    </label>
                    <input
                      id="po-portal-ack-ref"
                      style={field}
                      value={ackRef}
                      onChange={(e) => setAckRef(e.target.value)}
                      maxLength={120}
                    />
                  </>
                )}
                <p style={{ margin: '0.75rem 0 0', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {view.canUpload && (
                    <button
                      style={button}
                      disabled={busy}
                      onClick={() =>
                        void upload(
                          ackFile.current,
                          'acknowledgement',
                          { ref: ackRef.trim() },
                          'Thank you - the order is confirmed and we have your acknowledgement.',
                        )
                      }
                    >
                      Confirm and send your acknowledgement
                    </button>
                  )}
                  <button
                    style={view.canUpload ? quietButton : button}
                    disabled={busy}
                    onClick={() =>
                      void send(
                        { action: 'acknowledge', ref: ackRef.trim() || undefined },
                        'Thank you - we have told them you can supply it.',
                      )
                    }
                  >
                    {view.canUpload ? 'Confirm without a document' : 'Yes, we can supply this'}
                  </button>
                </p>
              </>
            )}
          </div>

          {/* ---------------------------------------------------------------
              Dates, PER LINE. A supplier shipping an order in three drops has
              three answers, and one box for the lot was never the truth.
              --------------------------------------------------------------- */}
          <div style={block}>
            <strong>Will any of it be later than we asked?</strong>
            <p style={{ ...sub, margin: '0.25rem 0 0.5rem' }}>
              Put a date against any line you cannot do on time and leave the rest blank. Somebody here will confirm
              them.
            </p>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr>
                  <th style={headCell}>Line</th>
                  <th style={headCellRight}>We have</th>
                  <th style={headCellRight}>You can do</th>
                </tr>
              </thead>
              <tbody>
                {view.lines.map((line) => (
                  <tr key={line.id}>
                    <td style={cell}>
                      {line.description}
                      {line.supplierSku ? ` (${line.supplierSku})` : ''}
                      {/* The service this one has to go on. It is the only thing
                          on the line they have to treat differently. */}
                      {line.serviceName && (
                        <div style={{ color: 'var(--color-text-secondary, #666)', fontSize: '0.8125rem' }}>
                          {line.serviceName}
                        </div>
                      )}
                    </td>
                    <td style={cellRight}>{line.expectedDate ?? view.expectedDate ?? '-'}</td>
                    <td style={{ ...cellRight, paddingRight: 0 }}>
                      <input
                        type="date"
                        style={{ ...field, width: 160 }}
                        value={dates[line.id] ?? ''}
                        onChange={(e) => setDates((d) => ({ ...d, [line.id]: e.target.value }))}
                        aria-label={`The date you can deliver ${line.description}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
                disabled={busy || dateLines.length === 0}
                onClick={() =>
                  void send(
                    { action: 'propose-date', lines: dateLines, note: dateNote || undefined },
                    'Thank you - we have passed those dates on.',
                  )
                }
              >
                Send us those dates
              </button>
            </p>
          </div>

          {/* ---------------------------------------------------------------
              What has actually left them, drop by drop, with the packing slip
              for each one.
              --------------------------------------------------------------- */}
          {view.canDespatch && (
            <div style={block}>
              <strong>Have you sent any of it?</strong>
              <p style={{ ...sub, margin: '0.25rem 0 0.5rem' }}>
                Tell us what has gone and we will give you a packing slip to put in the box. Send it in as many
                deliveries as suits you - each one gets its own slip.
              </p>

              {stillToSend.length === 0 ? (
                <p style={{ margin: 0 }}>You have told us about everything on this order. Thank you.</p>
              ) : (
                <>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                    <thead>
                      <tr>
                        <th style={headCell}>Line</th>
                        <th style={headCellRight}>Still to send</th>
                        <th style={headCellRight}>Sending now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stillToSend.map((line) => (
                        <tr key={line.id}>
                          <td style={cell}>
                            {line.description}
                            {line.supplierSku ? ` (${line.supplierSku})` : ''}
                            {Number(line.qtyDespatched) > 0 && (
                              <div style={{ color: 'var(--color-text-secondary, #666)', fontSize: '0.8125rem' }}>
                                {line.qtyDespatched} of {line.qty} already sent
                              </div>
                            )}
                          </td>
                          <td style={cellRight}>
                            {line.qtyToSend} {line.unit}
                          </td>
                          <td style={{ ...cellRight, paddingRight: 0 }}>
                            <input
                              style={{ ...field, width: 90, textAlign: 'right' }}
                              inputMode="decimal"
                              value={despatchQty[line.id] ?? ''}
                              onChange={(e) => setDespatchQty((q) => ({ ...q, [line.id]: e.target.value }))}
                              aria-label={`How many of ${line.description} you are sending`}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
                    <div>
                      <label style={label} htmlFor="po-portal-despatch-date">
                        The date it left you
                      </label>
                      <input
                        id="po-portal-despatch-date"
                        type="date"
                        style={{ ...field, width: 170 }}
                        value={despatchDate}
                        onChange={(e) => setDespatchDate(e.target.value)}
                      />
                    </div>
                    <div>
                      <label style={label} htmlFor="po-portal-carrier">
                        Who is carrying it (optional)
                      </label>
                      <input
                        id="po-portal-carrier"
                        style={{ ...field, width: 200 }}
                        value={carrier}
                        onChange={(e) => setCarrier(e.target.value)}
                        maxLength={120}
                      />
                    </div>
                    <div>
                      <label style={label} htmlFor="po-portal-tracking">
                        Tracking number (optional)
                      </label>
                      <input
                        id="po-portal-tracking"
                        style={{ ...field, width: 220 }}
                        value={trackingRef}
                        onChange={(e) => setTrackingRef(e.target.value)}
                        maxLength={200}
                      />
                    </div>
                  </div>

                  <label style={{ ...label, marginTop: '0.75rem' }} htmlFor="po-portal-despatch-note">
                    Anything we should know about this delivery (optional)
                  </label>
                  <input
                    id="po-portal-despatch-note"
                    style={field}
                    value={despatchNote}
                    onChange={(e) => setDespatchNote(e.target.value)}
                    maxLength={500}
                  />

                  <p style={{ margin: '0.75rem 0 0' }}>
                    <button
                      style={button}
                      disabled={busy || despatchLines.length === 0 || !despatchDate}
                      onClick={() => {
                        void send(
                          {
                            action: 'despatch',
                            date: despatchDate,
                            lines: despatchLines,
                            carrier: carrier.trim() || undefined,
                            trackingRef: trackingRef.trim() || undefined,
                            note: despatchNote.trim() || undefined,
                          },
                          'Thank you - your packing slip is ready to download below.',
                        ).then((ok) => {
                          if (!ok) return
                          setDespatchQty({})
                          setTrackingRef('')
                          setDespatchNote('')
                        })
                      }}
                    >
                      Tell us what you have sent
                    </button>
                  </p>
                </>
              )}

              {view.shipments.length > 0 && (
                <div style={{ marginTop: '1rem' }}>
                  <strong style={{ fontSize: '0.9375rem' }}>Your deliveries, and their packing slips</strong>
                  <ul style={{ listStyle: 'none', margin: '0.5rem 0 0', padding: 0 }}>
                    {view.shipments.map((shipment) => (
                      <li
                        key={shipment.id}
                        style={{ padding: '0.625rem 0', borderTop: '1px solid var(--color-border, #ddd)' }}
                      >
                        <div style={{ fontSize: '0.875rem' }}>
                          <strong>{shipment.number}</strong> - sent {shipment.despatchedDate}
                          {shipment.carrier ? ` by ${shipment.carrier}` : ''}
                          {shipment.trackingRef ? `, tracking ${shipment.trackingRef}` : ''}
                        </div>
                        <div style={{ color: 'var(--color-text-secondary, #666)', fontSize: '0.8125rem' }}>
                          {shipment.lines.map((line) => `${line.qty} ${line.unit} ${line.description}`).join('; ')}
                        </div>
                        <p style={{ margin: '0.5rem 0 0' }}>
                          <a style={linkButton} href={packingSlipUrl(shipment.number)}>
                            Download the packing slip
                          </a>
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* ---------------------------------------------------------------
              Shortages.
              --------------------------------------------------------------- */}
          <div style={block}>
            <strong>Is anything short?</strong>
            <p style={{ ...sub, margin: '0.25rem 0 0.5rem' }}>
              Put in how many you cannot send at all. Leave the rest blank.
            </p>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr>
                  <th style={headCell}>Line</th>
                  <th style={headCellRight}>Ordered</th>
                  <th style={headCellRight}>Short by</th>
                </tr>
              </thead>
              <tbody>
                {view.lines.map((line) => (
                  <tr key={line.id}>
                    <td style={cell}>
                      {line.description}
                      {line.supplierSku ? ` (${line.supplierSku})` : ''}
                    </td>
                    <td style={cellRight}>
                      {line.qty} {line.unit}
                    </td>
                    <td style={{ ...cellRight, paddingRight: 0 }}>
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
