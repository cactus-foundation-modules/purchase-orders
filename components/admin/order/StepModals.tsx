'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { preflightFileError } from '@/modules/purchase-orders/lib/bill-file-kinds'
import { billTotals } from '@/modules/purchase-orders/lib/billing'
import { withUnit } from '@/modules/purchase-orders/lib/money'
import type { PoPaperworkStep } from '@/modules/purchase-orders/lib/next-step'
import type { PoBillableLine, PoOrder } from '@/modules/purchase-orders/lib/types'
import { Field, input, localToday, Money, muted, table, td, tdRight, th, thRight } from '../ui'
import type { SupplierDocuments } from './shared'

// The four pieces of paperwork an order collects, each as a small window over
// the order rather than a card to scroll to.
//
// They do their own requests instead of borrowing the screen's handlers, and for
// one reason: whatever goes wrong has to be said INSIDE the window. The screen
// reports errors in the bar at the top, which is exactly where a window drawn
// over the page is covering.

/** What a modal tells the screen when it has finished: reload, and say this.
 *  `problem` is for the half-successes - the payment is recorded, the email did
 *  not go - which want saying in red without pretending nothing was saved. */
export type StepDone = (message: string, problem?: boolean) => void

type StepProps = {
  order: PoOrder
  documents: SupplierDocuments
  onClose: () => void
  onDone: StepDone
}

const FILE_HINT = 'A PDF, JPEG, PNG or WebP, up to 15 MB.'

async function readError(res: Response, fallback: string): Promise<string> {
  const data: unknown = await res.json().catch(() => null)
  if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') return data.error
  return fallback
}

// ---------------------------------------------------------------------------

type ModalProps = {
  title: string
  /** One sentence under the title: what this is and what pressing the button does. */
  intro: ReactNode
  children: ReactNode
  error: string | null
  busy: boolean
  submitLabel: string
  busyLabel: string
  /** Why the button is greyed out, or null when it is not. */
  blocked: string | null
  onSubmit: () => void
  onClose: () => void
  wide?: boolean
}

function Modal({ title, intro, children, error, busy, submitLabel, busyLabel, blocked, onSubmit, onClose, wide }: ModalProps) {
  const box = useRef<HTMLDivElement>(null)

  // Deliberately NOT closed by a click on the backdrop: these hold a chosen file
  // and typed numbers, and a stray click beside the window should not bin them.
  // Escape closes it, unless something is halfway up the wire - shutting the
  // window on an upload leaves somebody wondering whether it landed.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  // Into the first thing that can be typed in or chosen, so the keyboard is
  // inside the window rather than still on the page underneath it.
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('input, select, textarea')?.focus()
  }, [])

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 70, background: 'var(--color-overlay)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '4vh 1rem', overflowY: 'auto',
      }}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          background: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)',
          borderRadius: 10, boxShadow: 'var(--shadow-lg)', width: '100%', maxWidth: wide ? 760 : 520, padding: '1.25rem',
        }}
      >
        <h2 style={{ margin: '0 0 0.25rem', fontSize: 'var(--text-lg)' }}>{title}</h2>
        <p style={{ margin: '0 0 1rem', color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>{intro}</p>

        <div style={{ display: 'grid', gap: '0.75rem' }}>{children}</div>

        {error && (
          <div className="alert alert-danger" role="alert" style={{ margin: '1rem 0 0' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap', marginTop: '1.25rem' }}>
          {blocked && !busy && <span style={{ ...muted, marginRight: 'auto' }}>{blocked}</span>}
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onSubmit} disabled={busy || blocked !== null}>
            {busy ? busyLabel : submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Choosing the file, with the same checks the route runs done here first so an
 *  obvious refusal costs nobody an upload. */
function FileField({
  label, hint, file, onFile, disabled,
}: {
  label: string
  hint: string
  file: File | null
  onFile: (file: File | null) => void
  disabled: boolean
}) {
  const [problem, setProblem] = useState<string | null>(null)
  return (
    <Field label={label} hint={problem ? undefined : hint}>
      <input
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,.webp"
        disabled={disabled}
        onChange={(e) => {
          const chosen = e.target.files?.[0] ?? null
          const refusal = chosen ? preflightFileError(chosen) : null
          setProblem(refusal)
          if (refusal) e.target.value = ''
          onFile(refusal ? null : chosen)
        }}
      />
      {file && !problem && <span style={{ display: 'block', ...muted }}>{file.name}</span>}
      {problem && <span style={{ display: 'block', ...muted, color: 'var(--color-danger)' }}>{problem}</span>}
    </Field>
  )
}

// ---------------------------------------------------------------------------

/** Their proforma: the file, and the two numbers off it. */
function ProformaModal({ order, onClose, onDone }: StepProps) {
  const [file, setFile] = useState<File | null>(null)
  const [ref, setRef] = useState(order.proformaRef ?? '')
  const [amount, setAmount] = useState(order.proformaAmount ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!file || busy) return
    setBusy(true)
    setError(null)
    try {
      const body = new FormData()
      body.set('kind', 'proforma')
      body.set('file', file)
      if (ref.trim()) body.set('ref', ref.trim())
      const filed = await fetch(`/api/m/purchase-orders/admin/orders/${order.id}/documents`, { method: 'POST', body })
      if (!filed.ok) {
        setError(await readError(filed, 'That file was not saved.'))
        return
      }
      const data = (await filed.json().catch(() => ({}))) as { readOffTheFile?: string | null }

      // The amount is its own request because the upload has never carried one.
      // The file is in by now, so a refusal here is said as a half-success
      // rather than as a failure of the whole thing.
      if (amount.trim() && amount.trim() !== (order.proformaAmount ?? '')) {
        const saved = await fetch(`/api/m/purchase-orders/admin/orders/${order.id}/documents`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ proformaAmount: amount.trim() }),
        })
        if (!saved.ok) {
          onDone(`Their proforma is filed, but the amount was not saved: ${await readError(saved, 'it did not look right.')}`, true)
          return
        }
      }
      onDone(
        data.readOffTheFile
          ? `Their proforma is filed. We read ${data.readOffTheFile} off it as their invoice number - change it if that is not right.`
          : 'Their proforma is filed. Next: pay it, and send them the proof.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Upload their proforma"
      intro={`The invoice ${order.supplierName} wants paying before they confirm ${order.number}.`}
      error={error}
      busy={busy}
      submitLabel="File their proforma"
      busyLabel="Filing…"
      blocked={file ? null : 'Choose their proforma first.'}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <FileField label="Their proforma" hint={FILE_HINT} file={file} onFile={setFile} disabled={busy} />
      <Field label="Their invoice number" hint="Leave it empty and we will try to read it off the file.">
        <input style={input} value={ref} onChange={(e) => setRef(e.target.value)} maxLength={120} />
      </Field>
      <Field label="What they are invoicing" hint={`This order comes to ${order.total} ${order.currency}.`}>
        <input style={input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={order.total} />
      </Field>
    </Modal>
  )
}

/** The proof that it was paid, and saying so - which is what releases the
 *  supplier's own confirm button and, in practice, the goods. */
function PaymentModal({ order, documents, onClose, onDone }: StepProps) {
  const [file, setFile] = useState<File | null>(null)
  const [paymentRef, setPaymentRef] = useState('')
  const [send, setSend] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const alreadyFiled = documents.paymentProof
  const hasProof = Boolean(file) || Boolean(alreadyFiled)

  async function submit() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (file) {
        const body = new FormData()
        body.set('kind', 'payment-proof')
        body.set('file', file)
        const filed = await fetch(`/api/m/purchase-orders/admin/orders/${order.id}/documents`, { method: 'POST', body })
        if (!filed.ok) {
          setError(await readError(filed, 'That file was not saved.'))
          return
        }
      }
      const paid = await fetch(`/api/m/purchase-orders/admin/orders/${order.id}/proforma`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentRef: paymentRef.trim() || undefined, sendProof: hasProof && send }),
      })
      if (!paid.ok) {
        setError(await readError(paid, 'Could not mark that as paid.'))
        return
      }
      const data = (await paid.json().catch(() => ({}))) as { emailProblem?: string | null; proofProblem?: string | null }
      const problem = data.emailProblem ?? data.proofProblem ?? null
      if (problem) onDone(`The payment is recorded. ${problem}`, true)
      else onDone(hasProof && send ? 'Marked as paid, and the proof is on its way to them.' : 'Marked as paid, and they have been told.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Upload proof of payment"
      intro={
        <>
          Their proforma{order.proformaRef ? ` ${order.proformaRef}` : ''}
          {order.proformaAmount ? (
            <>
              {' '}for <Money value={order.proformaAmount} currency={order.currency} />
            </>
          ) : null}
          . This marks it as paid and tells them - they are waiting on nothing else.
        </>
      }
      error={error}
      busy={busy}
      submitLabel={hasProof && send ? 'Mark it paid and send the proof' : 'Mark it as paid'}
      busyLabel="Sending…"
      blocked={null}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <FileField
        label="Proof of payment"
        hint={
          alreadyFiled
            ? `${alreadyFiled.originalName ?? 'One'} is already filed. Choose another to replace it.`
            : `A screenshot of the payment, or a remittance. ${FILE_HINT}`
        }
        file={file}
        onFile={setFile}
        disabled={busy}
      />
      <Field label="Your payment reference" hint="Optional. Whatever will find it on the bank statement.">
        <input style={input} value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)} maxLength={120} />
      </Field>
      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: 'var(--text-sm)' }}>
        <input type="checkbox" checked={send && hasProof} disabled={!hasProof || busy} onChange={(e) => setSend(e.target.checked)} style={{ marginTop: '0.2rem' }} />
        <span>
          Attach the proof to the email
          <span style={{ display: 'block', ...muted }}>
            They are emailed either way. A supplier told &ldquo;we have paid&rdquo; waits; one holding the proof ships.
          </span>
        </span>
      </label>
    </Modal>
  )
}

/** Their acknowledgement, which is also - nearly always - the moment the order
 *  stops being "sent" and starts being "confirmed". */
function AcknowledgementModal({ order, onClose, onDone }: StepProps) {
  const [file, setFile] = useState<File | null>(null)
  const [ref, setRef] = useState(order.ackRef ?? '')
  const [confirm, setConfirm] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Only an order that still reads "Sent" can be confirmed by this. Anything
  // further on already has been, one way or another.
  const canConfirm = order.status === 'SENT'

  async function submit() {
    if (!file || busy) return
    setBusy(true)
    setError(null)
    try {
      const body = new FormData()
      body.set('kind', 'acknowledgement')
      body.set('file', file)
      if (ref.trim()) body.set('ref', ref.trim())
      if (canConfirm && confirm) body.set('acknowledge', '1')
      const filed = await fetch(`/api/m/purchase-orders/admin/orders/${order.id}/documents`, { method: 'POST', body })
      if (!filed.ok) {
        setError(await readError(filed, 'That file was not saved.'))
        return
      }
      const data = (await filed.json().catch(() => ({}))) as { readOffTheFile?: string | null }
      const confirmed = canConfirm && confirm ? ' The order is marked as confirmed.' : ''
      onDone(
        data.readOffTheFile
          ? `Their acknowledgement is filed.${confirmed} We read ${data.readOffTheFile} off it as their sales order number - change it if that is not right.`
          : `Their acknowledgement is filed.${confirmed}`,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Upload their acknowledgement"
      intro={`What ${order.supplierName} sent back to say they have ${order.number} and are getting on with it.`}
      error={error}
      busy={busy}
      submitLabel="File their acknowledgement"
      busyLabel="Filing…"
      blocked={file ? null : 'Choose their acknowledgement first.'}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <FileField label="Their acknowledgement" hint={FILE_HINT} file={file} onFile={setFile} disabled={busy} />
      <Field label="Their sales order number" hint="Leave it empty and we will try to read it off the file.">
        <input style={input} value={ref} onChange={(e) => setRef(e.target.value)} maxLength={120} />
      </Field>
      {canConfirm && (
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: 'var(--text-sm)' }}>
          <input type="checkbox" checked={confirm} disabled={busy} onChange={(e) => setConfirm(e.target.checked)} style={{ marginTop: '0.2rem' }} />
          <span>Mark the order as confirmed by the supplier</span>
        </label>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------

type InvoiceLine = {
  orderLineId: string
  description: string
  supplierSku: string | null
  unit: string
  stillOwed: number
  qty: string
  unitCost: string
  taxRatePercent: string
  taxRateCode: string | null
  vatTreatment: string | null
  categoryId: string | null
}

type BillableDefaults = {
  defaultCategoryId: string | null
  defaultVatTreatment: string | null
  defaultVatRateCode: string | null
  paymentTermsDays: number | null
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return ''
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/**
 * Their invoice, entered in one go.
 *
 * The short road, not a replacement for the bill screen. It proposes what an
 * invoice for an order nearly always is - everything still owed on it, at the
 * prices the order was placed at, plus the carriage - and leaves the checking to
 * the match, which runs the moment it is saved and says what it disagrees with.
 * Anything stranger than that (a charge that is not on the order, a different
 * VAT treatment per line) belongs on the full screen, and there is a link to it.
 */
function InvoiceModal({ order, onClose, onDone, fullFormHref }: StepProps & { fullFormHref: string }) {
  const [lines, setLines] = useState<InvoiceLine[] | null>(null)
  const [defaults, setDefaults] = useState<BillableDefaults | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [number, setNumber] = useState('')
  const [invoiceDate, setInvoiceDate] = useState(localToday())
  const [dueDate, setDueDate] = useState('')
  const [statedTotal, setStatedTotal] = useState('')
  const [carriage, setCarriage] = useState('0')
  const [reading, setReading] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    fetch(`/api/m/purchase-orders/admin/orders/${order.id}/billable`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!live) return
        if (!data?.order) {
          setError('We could not load what is still to be invoiced on this order.')
          setLines([])
          return
        }
        const billable = (data.order.lines ?? []) as PoBillableLine[]
        const drafted = billable
          .map((line) => {
            const stillOwed = Math.max(0, Number(line.qtyOrdered) - Number(line.qtyCancelled) - Number(line.qtyInvoiced))
            return {
              orderLineId: line.orderLineId,
              description: line.description,
              supplierSku: line.supplierSku,
              unit: line.unit,
              stillOwed,
              qty: String(Number(stillOwed.toFixed(3))),
              unitCost: line.unitCost,
              taxRatePercent: line.taxRatePercent,
              taxRateCode: line.taxRateCode ?? data.defaultVatRateCode ?? null,
              vatTreatment: line.vatTreatment ?? data.defaultVatTreatment ?? null,
              categoryId: line.categoryId ?? data.defaultCategoryId ?? null,
            }
          })
          .filter((line) => line.stillOwed > 0)
        setLines(drafted)
        setDefaults({
          defaultCategoryId: data.defaultCategoryId ?? null,
          defaultVatTreatment: data.defaultVatTreatment ?? null,
          defaultVatRateCode: data.defaultVatRateCode ?? null,
          paymentTermsDays: typeof data.paymentTermsDays === 'number' ? data.paymentTermsDays : null,
        })
        // Carriage is charged once. If anything on this order has been invoiced
        // already, it has very probably been charged already too.
        const invoicedBefore = billable.some((line) => Number(line.qtyInvoiced) > 0)
        setCarriage(invoicedBefore ? '0' : order.carriageAmount)
      })
      .catch(() => {
        if (!live) return
        setError('We could not load what is still to be invoiced on this order.')
        setLines([])
      })
    return () => {
      live = false
    }
  }, [order.id, order.carriageAmount])

  // Reading the file is a guess and is treated as one: it only fills a box that
  // is still empty, and every box stays editable.
  async function choose(chosen: File | null) {
    setFile(chosen)
    setReading(null)
    if (!chosen) return
    setReading('Reading it…')
    try {
      const body = new FormData()
      body.append('file', chosen)
      body.append('orderNumber', order.number)
      const res = await fetch('/api/m/purchase-orders/admin/bills/scan', { method: 'POST', body })
      const data = (await res.json().catch(() => ({}))) as {
        guess?: { reference?: string | null; date?: string | null; total?: string | null }
      }
      const guess = res.ok ? data.guess : null
      const filled: string[] = []
      if (guess?.reference && !number.trim()) {
        setNumber(guess.reference)
        filled.push('their invoice number')
      }
      if (guess?.date) {
        setInvoiceDate(guess.date)
        filled.push('the date')
      }
      if (guess?.total && !statedTotal.trim()) {
        setStatedTotal(guess.total)
        filled.push('their total')
      }
      setReading(
        filled.length
          ? `Read ${filled.join(', ')} off the file. Worth a glance before you save.`
          : 'Nothing could be read off that one, so the boxes are yours to fill in. It will still be filed.',
      )
    } catch {
      setReading('Nothing could be read off that one, so the boxes are yours to fill in. It will still be filed.')
    }
  }

  const live = useMemo(() => (lines ?? []).filter((line) => Number(line.qty) > 0), [lines])
  // The highest rate on the bill, which is the treatment HMRC expect when
  // delivery is ancillary to the goods - and what the bill screen defaults to.
  const carriageRate = useMemo(
    () => String(live.reduce((max, line) => Math.max(max, Number(line.taxRatePercent) || 0), 0)),
    [live],
  )
  const totals = useMemo(
    () =>
      billTotals({
        lines: live.map((line) => ({ qty: line.qty, unitCost: line.unitCost || '0', taxRatePercent: line.taxRatePercent || '0' })),
        carriageAmount: carriage || '0',
        carriageTaxRatePercent: carriageRate,
        taxOverride: null,
      }),
    [live, carriage, carriageRate],
  )

  const blocked =
    lines === null
      ? 'Loading the order…'
      : !number.trim()
        ? 'Their invoice number is what everybody will quote.'
        : !invoiceDate
          ? 'An invoice needs its date.'
          : live.length === 0
            ? 'Nothing on this order is left to invoice.'
            : null

  async function submit() {
    if (busy || blocked) return
    setBusy(true)
    setError(null)
    try {
      const created = await fetch('/api/m/purchase-orders/admin/bills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId: order.supplierId,
          orderId: order.id,
          supplierInvoiceNumber: number.trim(),
          invoiceDate,
          dueDate: dueDate || (defaults?.paymentTermsDays != null ? addDays(invoiceDate, defaults.paymentTermsDays) : '') || null,
          currency: order.currency,
          fxRate: order.fxRate || '1',
          carriageAmount: carriage || '0',
          carriageTaxRatePercent: carriageRate,
          taxAmount: null,
          statedTotal: statedTotal.trim() || null,
          lines: live.map((line) => ({
            orderLineId: line.orderLineId,
            description: line.description,
            qty: line.qty,
            unitCost: line.unitCost || '0',
            taxRatePercent: line.taxRatePercent || '0',
            taxRateCode: line.taxRateCode,
            vatTreatment: line.vatTreatment,
            categoryId: line.categoryId,
          })),
        }),
      })
      if (!created.ok) {
        setError(await readError(created, 'That invoice was not saved.'))
        return
      }
      const data = (await created.json().catch(() => ({}))) as { id?: string; match?: { flags?: unknown[] } | null }
      const things = data.match?.flags?.length ?? 0
      const verdict =
        things === 0
          ? 'It agrees with the order.'
          : `There ${things === 1 ? 'is one thing' : `are ${things} things`} on it to look at before anybody approves it.`

      // The bill exists by now. A file that will not go up is said as a
      // half-success: entering it again would be refused as a duplicate.
      if (file && data.id) {
        const body = new FormData()
        body.append('file', file)
        const attached = await fetch(`/api/m/purchase-orders/admin/bills/${data.id}/attachment`, { method: 'POST', body })
        if (!attached.ok) {
          onDone(`Their invoice ${number.trim()} is entered, but the file was not attached: ${await readError(attached, 'it would not go up.')} Attach it from the bill.`, true)
          return
        }
      }
      onDone(`Their invoice ${number.trim()} is entered. ${verdict} It is under Bills, below.`, things > 0)
    } finally {
      setBusy(false)
    }
  }

  function setLine(orderLineId: string, patch: Partial<InvoiceLine>) {
    setLines((current) => (current ?? []).map((line) => (line.orderLineId === orderLineId ? { ...line, ...patch } : line)))
  }

  return (
    <Modal
      wide
      title="Enter their invoice"
      intro={
        <>
          Everything still to be invoiced on {order.number}, at the prices it was ordered at. Change what their invoice
          says differently - it is checked against the order the moment it is saved. For anything that is not on the
          order, <a href={fullFormHref}>use the full bill form</a>.
        </>
      }
      error={error}
      busy={busy}
      submitLabel="Enter their invoice"
      busyLabel="Saving…"
      blocked={blocked}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <FileField label="Their invoice" hint={`Optional, and worth having. ${FILE_HINT}`} file={file} onFile={(f) => void choose(f)} disabled={busy} />
      {reading && <div style={muted} role="status">{reading}</div>}

      <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))' }}>
        <Field label="Their invoice number">
          <input style={input} value={number} onChange={(e) => setNumber(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Invoice date">
          <input type="date" style={input} value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        </Field>
        <Field label="Due" hint={defaults?.paymentTermsDays != null ? `Empty means ${defaults.paymentTermsDays} days, their terms.` : undefined}>
          <input type="date" style={input} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="Their total" hint="As printed on it. Compared with ours, never used as a figure.">
          <input style={input} inputMode="decimal" value={statedTotal} onChange={(e) => setStatedTotal(e.target.value)} />
        </Field>
      </div>

      {lines && lines.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Line</th>
                <th style={thRight}>Still to invoice</th>
                <th style={thRight}>On this invoice</th>
                <th style={thRight}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.orderLineId}>
                  <td style={td}>
                    {line.description}
                    {line.supplierSku && <div style={muted}>{line.supplierSku}</div>}
                  </td>
                  <td style={tdRight}>{withUnit(line.stillOwed, line.unit)}</td>
                  <td style={tdRight}>
                    <input
                      style={{ ...input, width: 90, textAlign: 'right' }}
                      inputMode="decimal"
                      value={line.qty}
                      onChange={(e) => setLine(line.orderLineId, { qty: e.target.value })}
                      aria-label={`How many of ${line.description} are on this invoice`}
                    />
                  </td>
                  <td style={tdRight}>
                    <input
                      style={{ ...input, width: 110, textAlign: 'right' }}
                      inputMode="decimal"
                      value={line.unitCost}
                      onChange={(e) => setLine(line.orderLineId, { unitCost: e.target.value })}
                      aria-label={`What ${line.description} costs a unit on this invoice`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div style={{ flex: '0 1 180px' }}>
          <Field label="Carriage" hint="Before tax.">
            <input style={input} inputMode="decimal" value={carriage} onChange={(e) => setCarriage(e.target.value)} />
          </Field>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={muted}>
            Goods <Money value={totals.subtotal} currency={order.currency} /> · Tax{' '}
            <Money value={totals.taxAmount} currency={order.currency} />
          </div>
          <div style={{ fontWeight: 600 }}>
            We make it <Money value={totals.total} currency={order.currency} />
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------

/** Whichever of the four is open, or nothing. */
export function StepModal({
  step, fullFormHref, ...props
}: StepProps & { step: PoPaperworkStep | null; fullFormHref: string }) {
  if (step === 'PROFORMA') return <ProformaModal {...props} />
  if (step === 'PAYMENT') return <PaymentModal {...props} />
  if (step === 'ACKNOWLEDGEMENT') return <AcknowledgementModal {...props} />
  if (step === 'INVOICE') return <InvoiceModal {...props} fullFormHref={fullFormHref} />
  return null
}
