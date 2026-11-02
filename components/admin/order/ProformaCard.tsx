'use client'

import { useState } from 'react'
import { preflightFileError } from '@/modules/purchase-orders/lib/bill-file-kinds'
import type { PoOrder } from '@/modules/purchase-orders/lib/types'
import { card, formatDay, formatWhen, input, linkButton, localToday, Money, muted, table, td } from '../ui'
import type { FiledDocumentKind, SupplierDocument, SupplierDocuments } from './shared'
import { BankDetailsCheck } from './BankDetailsCheck'

type ProformaCardProps = {
  order: PoOrder
  documents: SupplierDocuments
  onPay: ((paymentRef: string, sendProof: boolean, acknowledgedWarning: boolean) => void) | null
  onUnpay: (() => void) | null
  onSetTerms: ((required: boolean) => void) | null
  /** Filing what the supplier sent. Null for anybody who may not buy. */
  onFile: ((kind: 'proforma' | 'acknowledgement', file: File) => Promise<boolean>) | null
  /** Filing what we sent THEM. Null for anybody without the permission to say
   *  money has moved - it is part of paying, not of buying. */
  onFileProof: ((file: File, paidOn: string) => Promise<boolean>) | null
  /** Correcting the day the money left, after the proof is filed. Null for
   *  anybody who may not say money has moved. */
  onSaveProofPaidOn?: ((body: Record<string, string>) => Promise<boolean>) | null
  /** Their own numbers, typed in or corrected. Null for anybody who may not buy. */
  onSaveRefs: ((body: Record<string, string>) => Promise<boolean>) | null
  /** Warnings standing on a proforma that arrived by email - above all that a
   *  revised or second one replaced the first. Paying needs the bank details
   *  ticked as checked while there are any. */
  proformaWarnings?: string[]
  /** When the newest of them was raised. A tick belongs to the warnings it was
   *  given for: a newer one arriving unticks it. */
  proformaWarningsAt?: string | null
}

/** One filed document, as a link or as a sentence saying there is not one. */
function FiledDocument({ doc, missing }: { doc: SupplierDocument | null; missing: string }) {
  if (!doc) return <span style={{ color: 'var(--color-text-secondary)' }}>{missing}</span>
  return (
    <a href={doc.url} target="_blank" rel="noreferrer">
      {doc.originalName ?? 'Open it'}
    </a>
  )
}

/**
 * Choosing a file, with the same checks the route runs done here first so an
 * obvious refusal costs nobody an upload.
 *
 * The input is cleared after every attempt, successful or not. Without that,
 * picking the same file twice - which is exactly what somebody does after a
 * failure - fires no change event at all and looks like the screen ignoring
 * them.
 */
function FilePicker({
  label,
  busy,
  onPick,
}: {
  label: string
  busy: boolean
  onPick: (file: File) => void
}) {
  const [problem, setProblem] = useState<string | null>(null)
  return (
    <div style={{ marginTop: '0.375rem' }}>
      <input
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,.webp"
        aria-label={label}
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          const refusal = preflightFileError(file)
          setProblem(refusal)
          if (!refusal) onPick(file)
        }}
      />
      {problem && <div style={{ ...muted, color: 'var(--color-danger)' }}>{problem}</div>}
    </div>
  )
}

/**
 * One of their reference numbers, typed in or corrected.
 *
 * Held in its own state and saved on a button rather than on every keystroke:
 * these are numbers copied off a PDF by somebody looking from one window to
 * another, and a field that saves halfway through is a field that saves a wrong
 * number.
 *
 * What the server holds wins whenever it changes - including a number read off
 * an uploaded file that nobody typed - and that is done by KEYING this component
 * on the value at both call sites rather than by an effect writing state back
 * into itself, which is the same reset with a render's delay and a lint rule
 * against it.
 */
function ReferenceField({
  label,
  field,
  value,
  onSave,
}: {
  label: string
  field: string
  value: string | null
  onSave: (body: Record<string, string>) => Promise<boolean>
}) {
  const [typed, setTyped] = useState(value ?? '')
  const [saving, setSaving] = useState(false)

  const dirty = typed.trim() !== (value ?? '')
  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.375rem' }}>
      <input
        style={{ ...input, maxWidth: 220 }}
        placeholder={label}
        aria-label={label}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        maxLength={120}
      />
      {dirty && (
        <button
          className="btn btn-secondary btn-sm"
          disabled={saving}
          onClick={() => {
            setSaving(true)
            void onSave({ [field]: typed.trim() }).finally(() => setSaving(false))
          }}
        >
          {saving ? 'Saving' : 'Save'}
        </button>
      )}
    </div>
  )
}

/**
 * The day the money actually left, beside the proof of payment.
 *
 * It matters more than it looks: a bill against this order is dated to it when
 * approved, because a payment made before the invoice is the tax point. So it
 * is asked for when the proof is filed (today unless somebody says otherwise)
 * and can be corrected afterwards - the proof filed on Monday for a payment
 * made on Friday is the usual case.
 *
 * Keyed on the stored date at the call site, so what the server holds wins
 * whenever it changes, exactly as ReferenceField does it.
 */
function ProofPaidOn({
  paidOn,
  filed,
  busy,
  onFile,
  onSave,
}: {
  paidOn: string | null
  filed: boolean
  busy: boolean
  onFile: ((file: File, paidOn: string) => void) | null
  onSave: ((body: Record<string, string>) => Promise<boolean>) | null
}) {
  const today = localToday()
  const [typed, setTyped] = useState(paidOn ?? today)
  const [saving, setSaving] = useState(false)
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(typed) && typed <= today
  const dirty = filed && typed !== (paidOn ?? '')

  if (!onFile && !onSave) {
    return paidOn ? <div style={muted}>Paid on {formatDay(paidOn)}</div> : null
  }
  return (
    <>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.375rem' }}>
        <label style={{ ...muted, display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          Date it was paid
          <input
            type="date"
            style={{ ...input, maxWidth: 180 }}
            value={typed}
            max={today}
            disabled={busy || saving}
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
        {dirty && onSave && (
          <button
            className="btn btn-secondary btn-sm"
            disabled={saving || !valid}
            onClick={() => {
              setSaving(true)
              void onSave({ proofPaidOn: typed }).finally(() => setSaving(false))
            }}
          >
            {saving ? 'Saving' : 'Save'}
          </button>
        )}
      </div>
      {!valid && <div style={{ ...muted, color: 'var(--color-danger)' }}>Pick the day it was paid, no later than today.</div>}
      {filed && (
        <div style={muted}>Any bill against this order is dated to this day when it is approved.</div>
      )}
      {onFile && (
        <FilePicker
          label="File the proof of payment"
          busy={busy || !valid}
          onPick={(chosen) => onFile(chosen, typed)}
        />
      )}
    </>
  )
}

/** Whether the card draws at all. A draft nobody has sent has no supplier
 *  documents and no proforma to chase. Exported so the screen can tell whether
 *  the heading above this card has anything under it. */
export function proformaCardShows(order: PoOrder): boolean {
  return !(order.status === 'DRAFT' && !order.proformaRequired)
}

/**
 * The proforma, and the three documents an order on these terms collects.
 *
 * On proforma terms nothing about this order is agreed until the money has
 * moved: the supplier's own page will not let them confirm it, and the button
 * below is what releases them. So "paid" is somebody's decision here, recorded
 * with their name against it - not something inferred from a bank feed nobody
 * has connected.
 *
 * Their paperwork can arrive either way round. The supplier's own link is the
 * tidy route, and plenty of suppliers will never touch it: they email the
 * proforma, or post it, and somebody here files it. Both doors write the same
 * columns, and the reference is read off the file where the box was left empty.
 *
 * The proof of payment goes the other way - out of this building to them - and
 * is the thing that actually releases an order in practice. A supplier who has
 * been told "we have paid it" waits; a supplier holding a screenshot of the
 * payment ships.
 *
 * Whether an order waits for a proforma at all is frozen onto it when it is
 * raised, off the supplier's account terms. The switch at the foot is for the
 * exception: a one-off from a supplier we have an account with who wants the
 * money up front, or the other way about.
 */
export function ProformaCard({
  order, documents, onPay, onUnpay, onSetTerms, onFile, onFileProof, onSaveRefs, onSaveProofPaidOn = null,
  proformaWarnings = [], proformaWarningsAt = null,
}: ProformaCardProps) {
  const [checkedFor, setCheckedFor] = useState<string | null>(null)
  const checkedBank = checkedFor !== null && checkedFor === (proformaWarningsAt ?? '')
  const setCheckedBank = (checked: boolean) => setCheckedFor(checked ? (proformaWarningsAt ?? '') : null)
  const [paymentRef, setPaymentRef] = useState('')
  const [busy, setBusy] = useState<FiledDocumentKind | null>(null)
  // Ticked by default the moment there is something to send, because a supplier
  // who gets the proof is a supplier who stops asking for it.
  const [attachProof, setAttachProof] = useState(true)

  if (!proformaCardShows(order)) return null

  const received = Boolean(order.proformaMediaId) || Boolean(order.proformaReceivedAt)
  const paid = Boolean(order.proformaPaidAt)
  const hasProof = Boolean(documents.paymentProof)

  function file(kind: 'proforma' | 'acknowledgement', chosen: File) {
    if (!onFile) return
    setBusy(kind)
    void onFile(kind, chosen).finally(() => setBusy(null))
  }

  function fileProof(chosen: File, paidOn: string) {
    if (!onFileProof) return
    setBusy('payment-proof')
    void onFileProof(chosen, paidOn).finally(() => setBusy(null))
  }

  /** Their acknowledgement, which an order collects whether it is on proforma
   *  terms or on the account - so it is drawn once and used in both branches. */
  const acknowledgementRow = (
    <tr>
      <td style={td}>Their acknowledgement</td>
      <td style={td}>
        <FiledDocument
          doc={documents.acknowledgement}
          missing={order.acknowledgedAt ? 'Confirmed without one.' : 'Not confirmed yet.'}
        />
        {order.ackRef && !onSaveRefs && <div style={muted}>Their reference {order.ackRef}</div>}
        {onSaveRefs && (
          <ReferenceField
            key={order.ackRef ?? ''}
            label="Their sales order number"
            field="ackRef"
            value={order.ackRef}
            onSave={onSaveRefs}
          />
        )}
        {onFile && (
          <FilePicker
            label="File their acknowledgement"
            busy={busy === 'acknowledgement'}
            onPick={(chosen) => file('acknowledgement', chosen)}
          />
        )}
      </td>
    </tr>
  )

  return (
    <div style={card}>
      <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>Proforma and supplier documents</h2>

      {order.proformaRequired ? (
        <>
          {!paid && (
            // Where somebody about to pay will see it: a proforma replaced by
            // email is how invoice fraud with new bank details is done.
            <BankDetailsCheck warnings={proformaWarnings} checked={checkedBank} onChange={setCheckedBank} />
          )}
          <p style={{ margin: '0 0 0.75rem', color: 'var(--color-text-secondary)' }}>
            This supplier invoices before they confirm. Until the proforma is marked paid here, their own link tells
            them so and holds their confirm button back.
          </p>

          <table style={table}>
            <tbody>
              <tr>
                <td style={td}>Their proforma</td>
                <td style={td}>
                  {received ? (
                    <>
                      <FiledDocument doc={documents.proforma} missing="Recorded" />
                      {order.proformaAmount && (
                        <div style={muted}>
                          For <Money value={order.proformaAmount} currency={order.currency} />
                        </div>
                      )}
                      {order.proformaReceivedAt && <div style={muted}>Sent {formatWhen(order.proformaReceivedAt)}</div>}
                    </>
                  ) : (
                    <span style={{ color: 'var(--color-text-secondary)' }}>
                      Not here yet. It arrives through the supplier&apos;s own link, or by email for you to file below.
                    </span>
                  )}
                  {order.proformaRef && !onSaveRefs && <div style={muted}>Their reference {order.proformaRef}</div>}
                  {onSaveRefs && (
                    <>
                      <ReferenceField
                        key={order.proformaRef ?? ''}
                        label="Their invoice number"
                        field="proformaRef"
                        value={order.proformaRef}
                        onSave={onSaveRefs}
                      />
                      <ReferenceField
                        key={`amount:${order.proformaAmount ?? ''}`}
                        label="What they are invoicing"
                        field="proformaAmount"
                        value={order.proformaAmount}
                        onSave={onSaveRefs}
                      />
                    </>
                  )}
                  {onFile && (
                    <FilePicker
                      label="File their proforma"
                      busy={busy === 'proforma'}
                      onPick={(chosen) => file('proforma', chosen)}
                    />
                  )}
                </td>
              </tr>
              <tr>
                <td style={td}>Proof of payment</td>
                <td style={td}>
                  <FiledDocument
                    doc={documents.paymentProof}
                    missing="None filed. A screenshot of the payment, or a remittance."
                  />
                  {order.proformaProofSentAt && (
                    <div style={muted}>Sent to them {formatWhen(order.proformaProofSentAt)}</div>
                  )}
                  <ProofPaidOn
                    key={order.proformaProofPaidOn ?? ''}
                    paidOn={order.proformaProofPaidOn}
                    filed={hasProof}
                    busy={busy === 'payment-proof'}
                    onFile={onFileProof ? fileProof : null}
                    onSave={hasProof ? onSaveProofPaidOn : null}
                  />
                </td>
              </tr>
              <tr>
                <td style={td}>Paid</td>
                <td style={td}>
                  {paid ? (
                    <>
                      {formatWhen(order.proformaPaidAt)}
                      {order.proformaPaymentRef && <div style={muted}>Reference {order.proformaPaymentRef}</div>}
                      {onPay && hasProof && (
                        <div style={{ marginTop: '0.375rem' }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => onPay('', true, false)}>
                            {order.proformaProofSentAt ? 'Send the proof again' : 'Email them the proof'}
                          </button>
                        </div>
                      )}
                      {onUnpay && (
                        <div style={{ marginTop: '0.375rem' }}>
                          <button style={{ ...linkButton, color: 'var(--color-danger)' }} onClick={onUnpay}>
                            Take that back
                          </button>
                        </div>
                      )}
                    </>
                  ) : onPay ? (
                    <>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                        <input
                          style={{ ...input, maxWidth: 220 }}
                          placeholder="Your payment reference (optional)"
                          value={paymentRef}
                          onChange={(e) => setPaymentRef(e.target.value)}
                          maxLength={120}
                        />
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={proformaWarnings.length > 0 && !checkedBank}
                          onClick={() => onPay(paymentRef, hasProof && attachProof, proformaWarnings.length > 0 && checkedBank)}
                        >
                          {hasProof && attachProof ? 'Mark it paid and send the proof' : 'Mark the proforma as paid'}
                        </button>
                      </div>
                      {hasProof && (
                        <label style={{ ...muted, display: 'block', marginTop: '0.375rem' }}>
                          <input
                            type="checkbox"
                            checked={attachProof}
                            onChange={(e) => setAttachProof(e.target.checked)}
                            style={{ marginRight: '0.375rem' }}
                          />
                          Attach the proof of payment to the email
                        </label>
                      )}
                      <div style={{ ...muted, marginTop: '0.375rem' }}>
                        They are emailed either way - on these terms they are waiting on nothing else.
                      </div>
                    </>
                  ) : (
                    <span style={{ color: 'var(--color-text-secondary)' }}>Not yet.</span>
                  )}
                </td>
              </tr>
              {acknowledgementRow}
            </tbody>
          </table>

          {(onFile || onFileProof) && (
            <p style={{ ...muted, marginTop: '0.75rem', marginBottom: 0 }}>
              A PDF, JPEG, PNG or WebP up to 15 MB. Where a file carries their own number, it is read off it and
              filled in above - always worth a glance, and always yours to correct. Files are stored and checked for
              what they claim to be. They are not scanned for viruses - nothing on this platform is, and pretending
              otherwise would be worse than saying so.
            </p>
          )}

          {onSetTerms && !paid && (
            <p style={{ ...muted, marginBottom: 0, marginTop: '0.75rem' }}>
              <button style={linkButton} onClick={() => onSetTerms(false)}>
                Put this order on their account instead
              </button>
            </p>
          )}
        </>
      ) : (
        <>
          <table style={table}>
            <tbody>{acknowledgementRow}</tbody>
          </table>
          {onFile && (
            <p style={{ ...muted, marginTop: '0.75rem', marginBottom: 0 }}>
              A PDF, JPEG, PNG or WebP up to 15 MB. Where it carries their own sales order number, it is read off the
              file and filled in above.
            </p>
          )}
          {onSetTerms && (
            <p style={{ ...muted, marginBottom: 0, marginTop: '0.75rem' }}>
              This order is on the supplier&apos;s account, so no proforma is expected.{' '}
              <button style={linkButton} onClick={() => onSetTerms(true)}>
                Ask for a proforma on this one
              </button>
            </p>
          )}
        </>
      )}
    </div>
  )
}
