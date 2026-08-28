'use client'

import { useRef, useState, type ReactNode } from 'react'
import { preflightFileError } from '@/modules/purchase-orders/lib/bill-file-kinds'
import { PO_PORTAL_EVENT_LABELS, type PoPortalView } from '@/modules/purchase-orders/lib/portal-view'
import { PortalDialog, PortalLine, PortalStyles } from '@/modules/purchase-orders/components/public/portal-ui'

// The only part of this platform a supplier ever touches.
//
// It sits ABOVE the order document on the same page, and everything they can
// press is a BUTTON - one row of them, near enough one screen. The order's own
// lines only appear once a button has been pressed, inside the dialog for that
// one job.
//
// That is the whole shape of this rebuild. What was here before printed every
// line of the order three times over - once to be re-dated, once to be marked
// short, once to be despatched - so an eleven-line order ran to four screens of
// tables before a supplier reached the message box, and the one button they
// actually wanted was somewhere in the middle of it. A supplier arrives with one
// thing to say. Ask which, then show them the lines for that.
//
// The names on the buttons are the ones a warehouse says out loud. "Is anything
// short?" became "Report out of stock"; "Anything else" became "Message us";
// "Have you sent any of it?" became "Record a despatch". Nothing about what any
// of them does has changed.
//
// Most of what it does is still a PROPOSAL. Accepting the order stamps it,
// attaching a document files it, and telling us what has left them files a
// despatch - none of which changes a line, a price or a total. That is not a
// limitation to be fixed later: a document somebody else can edit is not a
// purchase order.

const ENDPOINT = '/api/m/purchase-orders/public/portal'

/** Which dialog is up, if any. One at a time, always. */
type Job = 'confirm' | 'proforma' | 'delay' | 'stock' | 'despatch' | 'message' | 'slips' | 'history'

function when(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}

/** A plain YYYY-MM-DD as a person reads it, built from the parts rather than
 *  parsed: new Date('2026-09-16') is midnight UTC, which west of Greenwich is
 *  the fifteenth. */
function day(value: string | null): string {
  if (!value) return ''
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!parts) return value
  const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

/** Today, in the browser's own clock, as the plain day the server expects. Not
 *  toISOString(): that is UTC, and a supplier despatching at eight in the evening
 *  in July would have their date put back to yesterday. */
function today(): string {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

type Props = {
  view: PoPortalView
  /** The supplier's own key, straight back off the address bar. It is what the
   *  server looks the order up from - there is no order id on the wire. */
  token: string
}

export function SupplierPortalPanel({ view: initial, token }: Props) {
  const [view, setView] = useState(initial)
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const [dates, setDates] = useState<Record<string, string>>({})
  const [dateNote, setDateNote] = useState('')
  const [shortages, setShortages] = useState<Record<string, string>>({})
  const [shortNote, setShortNote] = useState('')
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

  /** Opening a dialog clears whatever the last one said. A green "thank you"
   *  still sitting behind a fresh form reads as if the fresh one has already
   *  gone through. */
  function open(next: Job) {
    setError(null)
    setDone(null)
    setJob(next)
  }

  /** True when it landed, so a caller can clear its own boxes and only then. */
  async function send(body: Record<string, unknown>, said: string): Promise<boolean> {
    if (busy) return false
    setBusy(true)
    setError(null)
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
      setJob(null)
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
      setJob(null)
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

  const waitingOnProforma = view.proforma.required && !view.proforma.paid
  const canConfirm = view.open && !view.acknowledged && view.canAcknowledge
  const canSendProforma = view.open && waitingOnProforma && view.canUpload
  const canRecordDespatch = view.open && view.canDespatch && stillToSend.length > 0

  return (
    <div className="pop">
      <PortalStyles />

      <h2 className="pop-title">Purchase order {view.orderNumber}</h2>
      <ul className="pop-status">
        <li>
          <span className={`pop-dot ${view.acknowledged ? 'pop-dot--good' : 'pop-dot--wait'}`} />
          {view.statusLabel}
        </li>
        {view.acknowledged && (
          <li>
            <span className="pop-dot pop-dot--good" />
            You accepted it{view.acknowledgedAt ? ` on ${when(view.acknowledgedAt)}` : ''}
          </li>
        )}
        {view.proforma.required && (
          <li>
            <span className={`pop-dot ${view.proforma.paid ? 'pop-dot--good' : 'pop-dot--wait'}`} />
            {view.proforma.paid
              ? `Proforma paid${view.proforma.paidAt ? ` on ${when(view.proforma.paidAt)}` : ''}`
              : view.proforma.received
                ? 'Proforma with us to pay'
                : 'Proforma needed'}
          </li>
        )}
        {view.requiredByDate && (
          <li>
            <span className="pop-dot pop-dot--wait" />
            Needed by {day(view.requiredByDate)}
          </li>
        )}
        {view.shipments.length > 0 && (
          <li>
            <span className="pop-dot pop-dot--good" />
            {view.shipments.length} {view.shipments.length === 1 ? 'despatch' : 'despatches'} told us about
          </li>
        )}
      </ul>

      <p className="pop-intro">
        Pick what you want to tell us and we will ask for the lines it applies to. Nothing here changes the order, so
        you never have to worry about pressing the wrong thing. The order itself is printed below.
      </p>

      {error && !job && (
        <p className="pop-note pop-note--bad" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="pop-note pop-note--good" role="status">
          {done}
        </p>
      )}

      {!view.open && (
        <p className="pop-note pop-note--quiet">
          This order is marked as {view.statusLabel.toLowerCase()}, so there is nothing left to tell us about it here.
          If that is not right, reply to the email this link came in.
        </p>
      )}
      {view.open && waitingOnProforma && !view.canUpload && (
        <p className="pop-note pop-note--quiet">
          Email us your proforma, quoting {view.orderNumber}. We will pay it, and then you can confirm the order here.
        </p>
      )}
      {view.open && !view.acknowledged && waitingOnProforma && view.acknowledgeBlockedReason && (
        <p className="pop-note pop-note--quiet">{view.acknowledgeBlockedReason}</p>
      )}

      <ul className="pop-actions">
        {canSendProforma && (
          <Action
            primary={!view.proforma.received}
            name="Send your proforma"
            hint={
              view.proforma.received
                ? 'We have one already - send a replacement if you need to'
                : 'We pay this order up front, so we need your invoice first'
            }
            onClick={() => open('proforma')}
          />
        )}
        {canConfirm && (
          <Action
            primary
            name="Confirm the order"
            hint="Tell us you can supply it, and attach your acknowledgement if you have one"
            onClick={() => open('confirm')}
          />
        )}
        {view.open && (
          <Action
            name="Report a delay"
            hint="Give us a new date for any line you cannot deliver on time"
            onClick={() => open('delay')}
          />
        )}
        {view.open && (
          <Action
            name="Report out of stock"
            hint="Tell us how much of a line you cannot send at all"
            onClick={() => open('stock')}
          />
        )}
        {canRecordDespatch && (
          <Action
            name="Record a despatch"
            hint="Say what has left you and we will give you a packing slip for the box"
            onClick={() => open('despatch')}
          />
        )}
        {view.open && (
          <Action name="Message us" hint="Anything else about this order" onClick={() => open('message')} />
        )}
      </ul>

      <div className="pop-quiet">
        <a className="pop-btn pop-btn--quiet pop-btn--small" href={orderPdfUrl}>
          Download the order (PDF)
        </a>
        {view.shipments.length > 0 && (
          <button type="button" className="pop-btn pop-btn--quiet pop-btn--small" onClick={() => open('slips')}>
            Packing slips ({view.shipments.length})
          </button>
        )}
        {view.events.length > 0 && (
          <button type="button" className="pop-btn pop-btn--quiet pop-btn--small" onClick={() => open('history')}>
            What you have told us ({view.events.length})
          </button>
        )}
      </div>

      {/* -------------------------------------------------------------------
          Confirming the order, with their own acknowledgement attached.
          One button rather than two: if they have picked a file it goes up
          with the confirmation, and if they have not it does not.
          ------------------------------------------------------------------- */}
      {job === 'confirm' && (
        <PortalDialog
          title="Confirm the order"
          intro="Tell us you can supply this order. It does not change anything on it."
          onClose={() => setJob(null)}
          footer={
            <button
              type="button"
              className="pop-btn"
              disabled={busy}
              onClick={() => {
                if (view.canUpload && ackFile.current?.files?.[0]) {
                  void upload(
                    ackFile.current,
                    'acknowledgement',
                    { ref: ackRef.trim() },
                    'Thank you - the order is confirmed and we have your acknowledgement.',
                  )
                  return
                }
                void send(
                  { action: 'acknowledge', ref: ackRef.trim() || undefined },
                  'Thank you - we have told them you can supply it.',
                )
              }}
            >
              Yes, we can supply this
            </button>
          }
        >
          <DialogError error={error} />
          {view.canUpload ? (
            <>
              <div className="pop-field">
                <label className="pop-label" htmlFor="pop-ack">
                  Your order acknowledgement, if you have one (PDF, JPEG, PNG or WebP)
                </label>
                <input
                  id="pop-ack"
                  ref={ackFile}
                  type="file"
                  className="pop-file"
                  accept=".pdf,.jpg,.jpeg,.png,.webp"
                />
              </div>
              <div className="pop-field">
                <label className="pop-label" htmlFor="pop-ack-ref">
                  Your own reference for it (optional)
                </label>
                <input
                  id="pop-ack-ref"
                  className="pop-input"
                  value={ackRef}
                  onChange={(e) => setAckRef(e.target.value)}
                  maxLength={120}
                />
              </div>
            </>
          ) : (
            <p className="pop-empty">
              Press the button below and we will record that you have accepted {view.orderNumber}.
            </p>
          )}
        </PortalDialog>
      )}

      {/* -------------------------------------------------------------------
          The proforma, on an order to a supplier we pay up front. Absent
          entirely on every other order, which is most of them.
          ------------------------------------------------------------------- */}
      {job === 'proforma' && (
        <PortalDialog
          title="Send your proforma"
          intro="We pay this order up front. Send us your invoice and we will pay it, and then you can confirm the order."
          onClose={() => setJob(null)}
          footer={
            <button
              type="button"
              className="pop-btn"
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
              Send it
            </button>
          }
        >
          <DialogError error={error} />
          <div className="pop-field">
            <label className="pop-label" htmlFor="pop-proforma">
              Your proforma (PDF, JPEG, PNG or WebP)
            </label>
            <input
              id="pop-proforma"
              ref={proformaFile}
              type="file"
              className="pop-file"
              accept=".pdf,.jpg,.jpeg,.png,.webp"
            />
          </div>
          <div className="pop-row">
            <div className="pop-field">
              <label className="pop-label" htmlFor="pop-proforma-ref">
                Your invoice number (optional)
              </label>
              <input
                id="pop-proforma-ref"
                className="pop-input"
                value={proformaRef}
                onChange={(e) => setProformaRef(e.target.value)}
                maxLength={120}
              />
            </div>
            <div className="pop-field">
              <label className="pop-label" htmlFor="pop-proforma-amount">
                The amount, if it is not the order total (optional)
              </label>
              <input
                id="pop-proforma-amount"
                className="pop-input"
                inputMode="decimal"
                value={proformaAmount}
                onChange={(e) => setProformaAmount(e.target.value)}
                maxLength={13}
              />
            </div>
          </div>
        </PortalDialog>
      )}

      {/* -------------------------------------------------------------------
          Dates, PER LINE. A supplier shipping an order in three drops has
          three answers, and one box for the lot was never the truth.
          ------------------------------------------------------------------- */}
      {job === 'delay' && (
        <PortalDialog
          title="Report a delay"
          intro="Put a date against any line you cannot do on time and leave the rest blank. Somebody here will confirm them."
          onClose={() => setJob(null)}
          footer={
            <button
              type="button"
              className="pop-btn"
              disabled={busy || dateLines.length === 0}
              onClick={() =>
                void send(
                  { action: 'propose-date', lines: dateLines, note: dateNote || undefined },
                  'Thank you - we have passed those dates on.',
                )
              }
            >
              Send {dateLines.length || ''} {dateLines.length === 1 ? 'date' : 'dates'}
            </button>
          }
        >
          <DialogError error={error} />
          <ul className="pop-lines">
            {view.lines.map((line) => {
              const asked = line.expectedDate ?? view.expectedDate
              return (
                <PortalLine
                  key={line.id}
                  name={line.description}
                  meta={
                    <>
                      {[line.supplierSku, `${line.qty} ${line.unit}`, line.serviceName].filter(Boolean).join(' · ')}
                      {asked ? ` · we asked for ${day(asked)}` : ''}
                    </>
                  }
                  control={
                    <input
                      type="date"
                      className="pop-input pop-input--date"
                      value={dates[line.id] ?? ''}
                      onChange={(e) => setDates((d) => ({ ...d, [line.id]: e.target.value }))}
                      aria-label={`The date you can deliver ${line.description}`}
                    />
                  }
                />
              )
            })}
          </ul>
          <div className="pop-field" style={{ marginTop: '1.25rem' }}>
            <label className="pop-label" htmlFor="pop-date-note">
              Anything we should know (optional)
            </label>
            <input
              id="pop-date-note"
              className="pop-input"
              value={dateNote}
              onChange={(e) => setDateNote(e.target.value)}
              maxLength={500}
            />
          </div>
        </PortalDialog>
      )}

      {/* -------------------------------------------------------------------
          Out of stock - what they cannot send at all, as opposed to late.
          ------------------------------------------------------------------- */}
      {job === 'stock' && (
        <PortalDialog
          title="Report out of stock"
          intro="Put in how many of a line you cannot send at all. Leave the rest blank."
          onClose={() => setJob(null)}
          footer={
            <button
              type="button"
              className="pop-btn"
              disabled={busy || shortLines.length === 0}
              onClick={() =>
                void send(
                  { action: 'shortage', lines: shortLines, note: shortNote || undefined },
                  'Thank you - we have told them what is out of stock.',
                )
              }
            >
              Send {shortLines.length || ''} {shortLines.length === 1 ? 'line' : 'lines'}
            </button>
          }
        >
          <DialogError error={error} />
          <ul className="pop-lines">
            {view.lines.map((line) => (
              <PortalLine
                key={line.id}
                name={line.description}
                meta={[line.supplierSku, `${line.qty} ${line.unit} ordered`].filter(Boolean).join(' · ')}
                control={
                  <input
                    className="pop-input pop-input--qty"
                    inputMode="decimal"
                    placeholder="0"
                    value={shortages[line.id] ?? ''}
                    onChange={(e) => setShortages((s) => ({ ...s, [line.id]: e.target.value }))}
                    aria-label={`How many of ${line.description} you cannot send`}
                  />
                }
              />
            ))}
          </ul>
          <div className="pop-field" style={{ marginTop: '1.25rem' }}>
            <label className="pop-label" htmlFor="pop-short-note">
              What has happened (optional)
            </label>
            <input
              id="pop-short-note"
              className="pop-input"
              value={shortNote}
              onChange={(e) => setShortNote(e.target.value)}
              maxLength={500}
            />
          </div>
        </PortalDialog>
      )}

      {/* -------------------------------------------------------------------
          What has actually left them, drop by drop. The packing slip for each
          one is behind the Packing slips button on the panel.
          ------------------------------------------------------------------- */}
      {job === 'despatch' && (
        <PortalDialog
          title="Record a despatch"
          intro="Tell us what has gone and we will give you a packing slip to put in the box. Send it in as many deliveries as suits you - each one gets its own slip."
          onClose={() => setJob(null)}
          footer={
            <button
              type="button"
              className="pop-btn"
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
                  'Thank you - your packing slip is ready under Packing slips.',
                ).then((ok) => {
                  if (!ok) return
                  setDespatchQty({})
                  setTrackingRef('')
                  setDespatchNote('')
                })
              }}
            >
              Record it
            </button>
          }
        >
          <DialogError error={error} />
          <div className="pop-row">
            <div className="pop-field">
              <label className="pop-label" htmlFor="pop-despatch-date">
                The date it left you
              </label>
              <input
                id="pop-despatch-date"
                type="date"
                className="pop-input"
                value={despatchDate}
                onChange={(e) => setDespatchDate(e.target.value)}
              />
            </div>
            <div className="pop-field">
              <label className="pop-label" htmlFor="pop-carrier">
                Who is carrying it (optional)
              </label>
              <input
                id="pop-carrier"
                className="pop-input"
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                maxLength={120}
              />
            </div>
            <div className="pop-field">
              <label className="pop-label" htmlFor="pop-tracking">
                Tracking number (optional)
              </label>
              <input
                id="pop-tracking"
                className="pop-input"
                value={trackingRef}
                onChange={(e) => setTrackingRef(e.target.value)}
                maxLength={200}
              />
            </div>
          </div>

          {/* Whole orders go in one lorry more often than they go in three, and
              typing the same number down eleven rows is how a supplier decides
              to email us instead. */}
          <div className="pop-tools">
            <button
              type="button"
              className="pop-btn pop-btn--quiet pop-btn--small"
              onClick={() =>
                setDespatchQty(Object.fromEntries(stillToSend.map((line) => [line.id, line.qtyToSend])))
              }
            >
              We are sending all of it
            </button>
            {despatchLines.length > 0 && (
              <button
                type="button"
                className="pop-btn pop-btn--quiet pop-btn--small"
                onClick={() => setDespatchQty({})}
              >
                Clear
              </button>
            )}
          </div>

          <ul className="pop-lines">
            {stillToSend.map((line) => (
              <PortalLine
                key={line.id}
                name={line.description}
                meta={
                  <>
                    {[line.supplierSku, `${line.qtyToSend} ${line.unit} still to send`].filter(Boolean).join(' · ')}
                    {Number(line.qtyDespatched) > 0 ? ` · ${line.qtyDespatched} of ${line.qty} already sent` : ''}
                  </>
                }
                control={
                  <input
                    className="pop-input pop-input--qty"
                    inputMode="decimal"
                    placeholder="0"
                    value={despatchQty[line.id] ?? ''}
                    onChange={(e) => setDespatchQty((q) => ({ ...q, [line.id]: e.target.value }))}
                    aria-label={`How many of ${line.description} you are sending`}
                  />
                }
              />
            ))}
          </ul>

          <div className="pop-field" style={{ marginTop: '1.25rem' }}>
            <label className="pop-label" htmlFor="pop-despatch-note">
              Anything we should know about this delivery (optional)
            </label>
            <input
              id="pop-despatch-note"
              className="pop-input"
              value={despatchNote}
              onChange={(e) => setDespatchNote(e.target.value)}
              maxLength={500}
            />
          </div>
        </PortalDialog>
      )}

      {job === 'message' && (
        <PortalDialog
          title="Message us"
          intro={`Anything else about ${view.orderNumber}. It goes straight to whoever raised it.`}
          onClose={() => setJob(null)}
          footer={
            <button
              type="button"
              className="pop-btn"
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
          }
        >
          <DialogError error={error} />
          <div className="pop-field">
            <label className="pop-label" htmlFor="pop-message">
              Your message
            </label>
            <textarea
              id="pop-message"
              className="pop-textarea"
              rows={5}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={2000}
            />
          </div>
        </PortalDialog>
      )}

      {job === 'slips' && (
        <PortalDialog
          title="Packing slips"
          intro="One for every delivery you have told us about. Print it and put it in the box."
          onClose={() => setJob(null)}
          closeLabel="Close packing slips"
        >
          <ul className="pop-lines">
            {view.shipments.map((shipment) => (
              <PortalLine
                key={shipment.id}
                name={
                  <>
                    {shipment.number} - sent {day(shipment.despatchedDate)}
                    {shipment.carrier ? ` by ${shipment.carrier}` : ''}
                    {shipment.trackingRef ? `, tracking ${shipment.trackingRef}` : ''}
                  </>
                }
                meta={shipment.lines.map((line) => `${line.qty} ${line.unit} ${line.description}`).join('; ')}
                control={
                  <a className="pop-btn pop-btn--quiet pop-btn--small" href={packingSlipUrl(shipment.number)}>
                    Download
                  </a>
                }
              />
            ))}
          </ul>
        </PortalDialog>
      )}

      {job === 'history' && (
        <PortalDialog
          title="What you have told us"
          intro={`Everything sent through this link about ${view.orderNumber}, newest first.`}
          onClose={() => setJob(null)}
          closeLabel="Close history"
        >
          <ul className="pop-lines">
            {view.events.map((event) => (
              <PortalLine
                key={event.id}
                name={PO_PORTAL_EVENT_LABELS[event.kind]}
                meta={
                  <>
                    {when(event.createdAt)}
                    <div style={{ marginTop: '.25rem' }}>{event.summary}</div>
                  </>
                }
              />
            ))}
          </ul>
        </PortalDialog>
      )}
    </div>
  )
}

/** One button on the panel: what it does, and one line saying why you would
 *  press it. Big enough to hit with a glove on. */
function Action({
  name,
  hint,
  primary,
  onClick,
}: {
  name: string
  hint: string
  primary?: boolean
  onClick: () => void
}) {
  return (
    <li>
      <button type="button" className={primary ? 'pop-action pop-action--primary' : 'pop-action'} onClick={onClick}>
        <span className="pop-action-name">{name}</span>
        <span className="pop-action-hint">{hint}</span>
      </button>
    </li>
  )
}

/** A refusal, shown at the top of the dialog it happened in - not on the panel
 *  behind it, where it would be covered by the very form that caused it. */
function DialogError({ error }: { error: string | null }): ReactNode {
  if (!error) return null
  return (
    <p className="pop-note pop-note--bad" role="alert">
      {error}
    </p>
  )
}
