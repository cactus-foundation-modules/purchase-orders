'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import type {
  PoAuditEntry, PoBill, PoBillableLine, PoBookCategory, PoSupplier,
} from '@/modules/purchase-orders/lib/types'
import {
  PO_VAT_RATE_CODES, PO_VAT_RATE_LABELS, PO_VAT_TREATMENTS, PO_VAT_TREATMENT_LABELS,
} from '@/modules/purchase-orders/lib/types'
import {
  billTotals, dueDateFor, isBillEditable, isBillPostable, varianceTotal, type PoBillTransition,
} from '@/modules/purchase-orders/lib/billing'
import { readBooksOutcome } from '@/modules/purchase-orders/lib/books-outcome'
import { preflightFileError } from '@/modules/purchase-orders/lib/bill-file-kinds'
import {
  BillStatusBadge, card, Field, formatDay, formatWhen, input, linkButton, localToday, MatchBadge,
  Money, muted, table, td, tdRight, th, thRight,
} from './ui'

// One supplier invoice: what they say we owe, what we ordered, what turned up,
// and whether those three agree.
//
// Doubles as the "enter one" screen - `billId` null means a new bill, against
// the order in `orderId` where there is one. Same trick as the order and the
// return screen, and for the same reason: a separate page for the empty version
// of a form is a second copy of every field, and the two drift apart within a
// release.

type LineDraft = {
  key: string
  orderLineId: string | null
  description: string
  qty: string
  unitCost: string
  taxRatePercent: string
  taxRateCode: string
  vatTreatment: string
  categoryId: string
}

type Props = {
  billId: string | null
  orderId: string | null
  canBills: boolean
}

const TRANSITION_LABELS: Record<PoBillTransition, string> = {
  query: 'Query it with them',
  resolve: 'The query is settled',
  approve: 'Approve it for payment',
  unapprove: 'Take the approval back',
  void: 'Void it',
}

let keySeed = 0
function nextKey(): string {
  keySeed += 1
  return `line-${keySeed}`
}

/** 3.000 reads as 3, and 2.500 as 2.5. The column keeps three places either way. */
function trimQty(value: number | string): string {
  const n = Number(value)
  return Number.isFinite(n) ? String(Number(n.toFixed(3))) : '0'
}

function blankLine(): LineDraft {
  return {
    key: nextKey(),
    orderLineId: null,
    description: '',
    qty: '1',
    unitCost: '0',
    taxRatePercent: '0',
    taxRateCode: '',
    vatTreatment: '',
    categoryId: '',
  }
}

export function BillScreen({ billId, orderId, canBills }: Props) {
  const router = useRouter()
  const adminPath = useAdminPath()
  const base = `/${adminPath}/m/purchase-orders`
  const isNew = billId === null

  const [bill, setBill] = useState<PoBill | null>(null)
  const [billable, setBillable] = useState<PoBillableLine[]>([])
  const [categories, setCategories] = useState<PoBookCategory[]>([])
  const [suppliers, setSuppliers] = useState<PoSupplier[]>([])
  const [history, setHistory] = useState<PoAuditEntry[]>([])
  const [transitions, setTransitions] = useState<PoBillTransition[]>([])
  const [hasBooks, setHasBooks] = useState(false)
  const [order, setOrder] = useState<{ id: string; number: string; supplierName: string } | null>(null)

  const [supplierId, setSupplierId] = useState('')
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [invoiceDate, setInvoiceDate] = useState(localToday())
  const [dueDate, setDueDate] = useState('')
  const [currency, setCurrency] = useState('GBP')
  const [fxRate, setFxRate] = useState('1')
  const [carriage, setCarriage] = useState('0')
  const [carriageTax, setCarriageTax] = useState('0')
  const [taxOverride, setTaxOverride] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([])
  const [termsDays, setTermsDays] = useState<number | null>(null)

  const [editing, setEditing] = useState(isNew)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // Written as promise chains rather than an async body called from the effect:
  // every setState lands in a callback, which is what keeps the load out of the
  // synchronous render pass.
  const load = useCallback(() => {
    if (isNew && orderId) {
      return fetch(`/api/m/purchase-orders/admin/orders/${orderId}/billable`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.order) {
            setOrder({ id: data.order.id, number: data.order.number, supplierName: data.order.supplierName })
            setSupplierId(data.order.supplierId)
            setCurrency(data.order.currency ?? 'GBP')
            setFxRate(data.order.fxRate ?? '1')
            setBillable(data.order.lines ?? [])
            setCategories(data.categories ?? [])
            setTermsDays(data.paymentTermsDays ?? null)
            setDueDate(dueDateFor(localToday(), data.paymentTermsDays ?? null) ?? '')
            setLines(linesFromOrder(data.order.lines ?? [], data))
          }
          setLoaded(true)
        })
        .catch(() => setLoaded(true))
    }
    if (isNew) {
      return fetch('/api/m/purchase-orders/admin/suppliers')
        .then((r) => (r.ok ? r.json() : { suppliers: [] }))
        .then((data) => {
          setSuppliers(data.suppliers ?? [])
          setLines([blankLine()])
          setLoaded(true)
        })
        .catch(() => setLoaded(true))
    }
    return fetch(`/api/m/purchase-orders/admin/bills/${billId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.bill) {
          const b = data.bill as PoBill
          setBill(b)
          setBillable(data.billable ?? [])
          setCategories(data.categories ?? [])
          setHistory(data.history ?? [])
          setTransitions(data.transitions ?? [])
          setHasBooks(Boolean(data.hasBooks))
          setOrder(b.orderId ? { id: b.orderId, number: b.orderNumber ?? '', supplierName: b.supplierName } : null)
          setSupplierId(b.supplierId)
          setInvoiceNumber(b.supplierInvoiceNumber)
          setInvoiceDate(b.invoiceDate || localToday())
          setDueDate(b.dueDate ?? '')
          setCurrency(b.currency)
          setFxRate(b.fxRate)
          setCarriage(b.carriageAmount)
          setTaxOverride(b.taxAmount)
          setLines(linesFromBill(b))
          setEditing(false)
        }
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [billId, isNew, orderId])

  useEffect(() => {
    void load()
  }, [load])

  // Choosing a supplier on a standalone bill brings their currency and their
  // terms with it, rather than making somebody go and look both up. Done in the
  // handler rather than in an effect watching `supplierId`: an effect that
  // setStates on every render of a changed value is a cascade, and this only
  // ever needs to happen at the moment somebody picks.
  function chooseSupplier(id: string) {
    setSupplierId(id)
    const supplier = suppliers.find((s) => s.id === id)
    if (!supplier) return
    setCurrency(supplier.currency || 'GBP')
    const days = supplier.paymentTermsDays ?? null
    setTermsDays(days)
    setDueDate((current) => current || dueDateFor(invoiceDate, days) || '')
  }

  // The due date follows the INVOICE date, not the day it was typed in: an
  // invoice dated the second and opened on the twentieth is due thirty days
  // after the second, and paying it thirty days after the twentieth is how an
  // account goes on stop. A date somebody has typed themselves is left alone.
  function changeInvoiceDate(value: string) {
    setInvoiceDate(value)
    setDueDate((current) => current || dueDateFor(value, termsDays) || '')
  }

  const totals = useMemo(
    () =>
      billTotals({
        lines: lines.filter((l) => Number(l.qty) > 0),
        carriageAmount: carriage,
        carriageTaxRatePercent: carriageTax,
        taxOverride: taxOverride || null,
      }),
    [lines, carriage, carriageTax, taxOverride],
  )

  const billableById = useMemo(
    () => new Map(billable.map((l) => [l.orderLineId, l])),
    [billable],
  )

  function setLine(key: string, patch: Partial<LineDraft>) {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  async function save() {
    setError(null)
    setMessage(null)
    setSaving(true)
    const body = {
      supplierId,
      orderId: order?.id ?? orderId ?? null,
      supplierInvoiceNumber: invoiceNumber.trim(),
      invoiceDate,
      dueDate: dueDate || null,
      currency,
      fxRate: fxRate || '1',
      carriageAmount: carriage || '0',
      carriageTaxRatePercent: carriageTax || '0',
      taxAmount: taxOverride || null,
      lines: lines
        .filter((l) => Number(l.qty) > 0)
        .map((l) => ({
          orderLineId: l.orderLineId,
          description: l.description,
          qty: l.qty,
          unitCost: l.unitCost || '0',
          taxRatePercent: l.taxRatePercent || '0',
          taxRateCode: l.taxRateCode || null,
          vatTreatment: l.vatTreatment || null,
          categoryId: l.categoryId || null,
        })),
    }
    const res = await fetch(
      isNew ? '/api/m/purchase-orders/admin/bills' : `/api/m/purchase-orders/admin/bills/${billId}`,
      {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    setSaving(false)
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not save that bill.')
      return
    }
    const data = await res.json()
    if (isNew) {
      router.push(`${base}/bills/${data.id}`)
      return
    }
    setEditing(false)
    await load()
    router.refresh()
  }

  // Whatever the books last said about this bill, read defensively: the column
  // is JSON and a release older than this one wrote nothing into it at all.
  const booksOutcome = useMemo(() => readBooksOutcome(bill?.booksOutcome), [bill?.booksOutcome])

  async function runTransition(transition: PoBillTransition) {
    setError(null)
    setMessage(null)
    setBusy(true)
    const res = await fetch(`/api/m/purchase-orders/admin/bills/${billId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transition, note: note || null }),
    })
    setBusy(false)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(data.error ?? 'That did not work.')
      return
    }
    const said: string[] = []
    if (data.orderClosed) said.push(`Order ${data.orderClosed} has been closed - everything is delivered and invoiced.`)
    // What the books said travels back with the transition, because a bill that
    // was approved and then refused by a set of books is two things that
    // happened and the second one is the one somebody has to act on.
    if (data.books?.message) said.push(data.books.message)
    if (said.length > 0) setMessage(said.join(' '))
    setNote('')
    await load()
    router.refresh()
  }

  /** Send it to the books, or try again after they said no. */
  async function sendToBooks() {
    setError(null)
    setMessage(null)
    setBusy(true)
    const res = await fetch(`/api/m/purchase-orders/admin/bills/${billId}/books`, { method: 'POST' })
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

  async function upload(file: File) {
    setError(null)
    setMessage(null)
    const problem = preflightFileError(file)
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    const form = new FormData()
    form.append('file', file)
    const res = await fetch(`/api/m/purchase-orders/admin/bills/${billId}/attachment`, {
      method: 'POST',
      body: form,
    })
    setBusy(false)
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'That file was not saved.')
      return
    }
    setMessage('Their invoice is attached.')
    if (fileRef.current) fileRef.current.value = ''
    await load()
  }

  async function detach() {
    setError(null)
    setBusy(true)
    const res = await fetch(`/api/m/purchase-orders/admin/bills/${billId}/attachment`, { method: 'DELETE' })
    setBusy(false)
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not unfile that.')
      return
    }
    await load()
  }

  async function remove() {
    setError(null)
    setBusy(true)
    const res = await fetch(`/api/m/purchase-orders/admin/bills/${billId}`, { method: 'DELETE' })
    setBusy(false)
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not delete that bill.')
      return
    }
    router.push(`${base}/bills`)
  }

  if (!loaded) return <p>Loading…</p>
  if (!isNew && !bill) return <div className="alert alert-danger">That bill is not here any more.</div>

  const editable = canBills && (isNew || (bill !== null && isBillEditable(bill.status) && editing))
  const canEditNow = canBills && bill !== null && isBillEditable(bill.status) && !editing
  const flags = bill?.variance ?? []

  return (
    <div>
      <div
        className="page-header"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}
      >
        <h1 className="page-title">
          {isNew
            ? order
              ? `Bill against ${order.number}`
              : 'Enter a supplier bill'
            : `Invoice ${bill!.supplierInvoiceNumber}`}
          {!isNew && (
            <span style={{ marginLeft: '0.75rem' }}>
              <BillStatusBadge status={bill!.status} />
            </span>
          )}
        </h1>
        <Link href={`${base}/bills`} className="btn btn-secondary">
          Back to bills
        </Link>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}
      {message && <div className="alert alert-success">{message}</div>}

      {/* ------------------------------------------------------------------ */}

      <div style={card}>
        <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <Field label="Supplier">
            {editable && isNew && !order ? (
              <select
                style={input}
                value={supplierId}
                onChange={(e) => chooseSupplier(e.target.value)}
                aria-label="Supplier"
              >
                <option value="">Choose one</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            ) : (
              <div>{order?.supplierName ?? bill?.supplierName ?? '—'}</div>
            )}
          </Field>
          <Field label="Against order" hint={order ? undefined : 'Not everything you buy starts with an order.'}>
            {order ? (
              <div>
                <Link href={`${base}/orders/${order.id}`} style={{ color: 'var(--color-primary)' }}>
                  {order.number}
                </Link>
              </div>
            ) : (
              <div style={muted}>None</div>
            )}
          </Field>
          <Field label="Their invoice number" hint="What everybody will quote when they chase it.">
            {editable ? (
              <input style={input} value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
            ) : (
              <div>{bill?.supplierInvoiceNumber}</div>
            )}
          </Field>
          <Field label="Invoice date" hint="The date on their paperwork, not today.">
            {editable ? (
              <input type="date" style={input} value={invoiceDate} onChange={(e) => changeInvoiceDate(e.target.value)} />
            ) : (
              <div>{formatDay(bill?.invoiceDate)}</div>
            )}
          </Field>
          <Field label="Due">
            {editable ? (
              <input type="date" style={input} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            ) : (
              <div>{formatDay(bill?.dueDate)}</div>
            )}
          </Field>
          <Field label="Currency" hint={currency === 'GBP' ? undefined : 'The rate on the invoice date is the one the books will use.'}>
            {editable ? (
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  style={{ ...input, width: 90 }}
                  value={currency}
                  maxLength={3}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  aria-label="Currency"
                />
                <input
                  style={input}
                  value={fxRate}
                  onChange={(e) => setFxRate(e.target.value)}
                  aria-label="Exchange rate"
                />
              </div>
            ) : (
              <div>
                {bill?.currency}
                {bill && Number(bill.fxRate) !== 1 && <span style={muted}> at {bill.fxRate}</span>}
              </div>
            )}
          </Field>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}

      <div style={card}>
        <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>What they have billed</h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Description</th>
                {billable.length > 0 && <th style={thRight}>Ordered</th>}
                {billable.length > 0 && <th style={thRight}>Delivered</th>}
                {billable.length > 0 && <th style={thRight}>Already billed</th>}
                <th style={thRight}>Billed</th>
                <th style={thRight}>Unit cost</th>
                <th style={thRight}>VAT %</th>
                <th style={th}>VAT treatment</th>
                <th style={th}>Category</th>
                <th style={thRight}>Line total</th>
                {editable && <th style={th} />}
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const source = line.orderLineId ? billableById.get(line.orderLineId) : undefined
                const lineTotal = (
                  Math.round(Number(line.qty || 0) * Number(line.unitCost || 0) * 100) / 100
                ).toFixed(2)
                return (
                  <tr key={line.key}>
                    <td style={td}>
                      {editable && !line.orderLineId ? (
                        <input
                          style={{ ...input, minWidth: 200 }}
                          value={line.description}
                          onChange={(e) => setLine(line.key, { description: e.target.value })}
                          placeholder="What this charge is for"
                          aria-label="Description"
                        />
                      ) : (
                        <>
                          {line.description || source?.description}
                          {!line.orderLineId && billable.length > 0 && (
                            <div style={muted}>Not on the order</div>
                          )}
                        </>
                      )}
                    </td>
                    {billable.length > 0 && (
                      <td style={tdRight}>{source ? trimQty(Number(source.qtyOrdered) - Number(source.qtyCancelled)) : '—'}</td>
                    )}
                    {billable.length > 0 && <td style={tdRight}>{source ? trimQty(source.qtyReceived) : '—'}</td>}
                    {billable.length > 0 && <td style={tdRight}>{source ? trimQty(source.qtyInvoiced) : '—'}</td>}
                    <td style={tdRight}>
                      {editable ? (
                        <input
                          style={{ ...input, width: 90, textAlign: 'right' }}
                          inputMode="decimal"
                          value={line.qty}
                          onChange={(e) => setLine(line.key, { qty: e.target.value })}
                          aria-label={`Quantity billed for ${line.description || source?.description || 'this line'}`}
                        />
                      ) : (
                        trimQty(line.qty)
                      )}
                    </td>
                    <td style={tdRight}>
                      {editable ? (
                        <input
                          style={{ ...input, width: 100, textAlign: 'right' }}
                          inputMode="decimal"
                          value={line.unitCost}
                          onChange={(e) => setLine(line.key, { unitCost: e.target.value })}
                          aria-label={`Unit cost for ${line.description || source?.description || 'this line'}`}
                        />
                      ) : (
                        <Money value={line.unitCost} currency={currency} />
                      )}
                    </td>
                    <td style={tdRight}>
                      {editable ? (
                        <input
                          style={{ ...input, width: 70, textAlign: 'right' }}
                          inputMode="decimal"
                          value={line.taxRatePercent}
                          onChange={(e) => setLine(line.key, { taxRatePercent: e.target.value })}
                          aria-label="VAT rate"
                        />
                      ) : (
                        line.taxRatePercent
                      )}
                    </td>
                    <td style={td}>
                      {editable ? (
                        <select
                          style={{ ...input, minWidth: 150 }}
                          value={line.vatTreatment}
                          onChange={(e) => setLine(line.key, { vatTreatment: e.target.value })}
                          aria-label="VAT treatment"
                        >
                          <option value="">Not said</option>
                          {PO_VAT_TREATMENTS.map((t) => (
                            <option key={t} value={t}>
                              {PO_VAT_TREATMENT_LABELS[t]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span style={muted}>
                          {line.vatTreatment
                            ? PO_VAT_TREATMENT_LABELS[line.vatTreatment as keyof typeof PO_VAT_TREATMENT_LABELS] ??
                              line.vatTreatment
                            : '—'}
                        </span>
                      )}
                      {editable && (
                        <select
                          style={{ ...input, minWidth: 150, marginTop: '0.25rem' }}
                          value={line.taxRateCode}
                          onChange={(e) => setLine(line.key, { taxRateCode: e.target.value })}
                          aria-label="VAT band"
                        >
                          <option value="">Band not said</option>
                          {PO_VAT_RATE_CODES.map((c) => (
                            <option key={c} value={c}>
                              {PO_VAT_RATE_LABELS[c]}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td style={td}>
                      {editable && categories.length > 0 ? (
                        <select
                          style={{ ...input, minWidth: 150 }}
                          value={line.categoryId}
                          onChange={(e) => setLine(line.key, { categoryId: e.target.value })}
                          aria-label="Category"
                        >
                          <option value="">Not said</option>
                          {categories.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span style={muted}>
                          {categories.find((c) => c.id === line.categoryId)?.name ?? (line.categoryId ? line.categoryId : '—')}
                        </span>
                      )}
                    </td>
                    <td style={tdRight}>
                      <Money value={lineTotal} currency={currency} />
                    </td>
                    {editable && (
                      <td style={td}>
                        <button
                          style={linkButton}
                          onClick={() => setLines((current) => current.filter((l) => l.key !== line.key))}
                          title="Take this line off the bill"
                        >
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {editable && (
          <p style={{ margin: '0.75rem 0 0' }}>
            <button style={linkButton} onClick={() => setLines((current) => [...current, blankLine()])}>
              Add a charge that is not on the order
            </button>
          </p>
        )}

        <div
          style={{
            display: 'grid',
            gap: '1rem',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            marginTop: '1rem',
          }}
        >
          {editable && (
            <>
              <Field label="Carriage" hint="Delivery charged separately on their invoice.">
                <input style={input} value={carriage} onChange={(e) => setCarriage(e.target.value)} />
              </Field>
              <Field label="VAT on carriage %" hint="Blank follows the highest rate on the bill.">
                <input style={input} value={carriageTax} onChange={(e) => setCarriageTax(e.target.value)} />
              </Field>
              <Field
                label="VAT, as their invoice states it"
                hint={`Ours works out at ${totals.computedTax}. Overtype it if theirs says otherwise.`}
              >
                <input style={input} value={taxOverride} onChange={(e) => setTaxOverride(e.target.value)} />
              </Field>
            </>
          )}
        </div>

        <table style={{ ...table, marginTop: '1rem', maxWidth: 320, marginLeft: 'auto' }}>
          <tbody>
            <tr>
              <td style={td}>Goods</td>
              <td style={tdRight}>
                <Money value={editable ? totals.subtotal : (bill?.subtotal ?? '0')} currency={currency} />
              </td>
            </tr>
            {Number(editable ? totals.carriageAmount : (bill?.carriageAmount ?? 0)) !== 0 && (
              <tr>
                <td style={td}>Carriage</td>
                <td style={tdRight}>
                  <Money value={editable ? totals.carriageAmount : (bill?.carriageAmount ?? '0')} currency={currency} />
                </td>
              </tr>
            )}
            <tr>
              <td style={td}>VAT</td>
              <td style={tdRight}>
                <Money value={editable ? totals.taxAmount : (bill?.taxAmount ?? '0')} currency={currency} />
              </td>
            </tr>
            <tr>
              <td style={{ ...td, fontWeight: 600 }}>Total</td>
              <td style={{ ...tdRight, fontWeight: 600 }}>
                <Money value={editable ? totals.total : (bill?.total ?? '0')} currency={currency} />
              </td>
            </tr>
          </tbody>
        </table>

        {editable && (
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              onClick={save}
              disabled={saving || !supplierId || !invoiceNumber.trim() || lines.every((l) => Number(l.qty) <= 0)}
            >
              {saving ? 'Saving…' : isNew ? 'Enter this bill' : 'Save changes'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                if (isNew) {
                  router.push(`${base}/bills`)
                  return
                }
                setEditing(false)
                void load()
              }}
            >
              Cancel
            </button>
          </div>
        )}
        {canEditNow && (
          <p style={{ marginTop: '0.75rem', marginBottom: 0 }}>
            <button style={linkButton} onClick={() => setEditing(true)}>
              Change this bill
            </button>
          </p>
        )}
        {!isNew && bill !== null && !isBillEditable(bill.status) && (
          <p style={{ ...muted, marginTop: '0.75rem' }}>
            Somebody has approved this one, so the figures are fixed. Take the approval back first, which is
            recorded, if it needs changing.
          </p>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}

      {!isNew && bill !== null && (
        <>
          <div style={card}>
            <div
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}
            >
              <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>Against the order</h2>
              <MatchBadge status={bill.matchStatus} count={flags.length} />
            </div>
            {bill.matchStatus === 'NOT_MATCHED' && (
              <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
                There is no purchase order behind this one, so there is nothing to check it against. That is
                perfectly ordinary - the electricity does not arrive on an order.
              </p>
            )}
            {bill.matchStatus === 'MATCHED' && (
              <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
                Everything on this invoice matches what you ordered and what turned up, within the tolerances in
                your settings.
              </p>
            )}
            {flags.length > 0 && (
              <>
                <p style={{ margin: '0 0 0.5rem' }}>
                  <strong>
                    <Money value={varianceTotal(flags)} currency={bill.currency} />
                  </strong>{' '}
                  of this invoice does not agree with the order:
                </p>
                <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                  {flags.map((flag, index) => (
                    <li key={`${flag.kind}-${flag.orderLineId ?? index}`} style={{ marginBottom: '0.25rem' }}>
                      {flag.message}{' '}
                      {Number(flag.amount) !== 0 && (
                        <span style={muted}>
                          (<Money value={flag.amount} currency={bill.currency} />)
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <p style={{ ...muted, margin: '0.75rem 0 0' }}>
                  None of this stops you approving the invoice. Sometimes the supplier is right and the extra two
                  are being kept - what matters is that the decision is on the record rather than in somebody&rsquo;s head.
                </p>
              </>
            )}
            {bill.queryNote && (
              <p style={{ margin: '0.75rem 0 0' }}>
                <span style={muted}>Queried with them: </span>
                {bill.queryNote}
              </p>
            )}
          </div>

          <div style={card}>
            <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>Their invoice</h2>
            {bill.attachment ? (
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <a
                  className="btn btn-secondary"
                  href={bill.attachment.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open {bill.attachment.name}
                </a>
                {canBills && (
                  <button style={linkButton} onClick={detach} disabled={busy}>
                    Unfile it
                  </button>
                )}
              </div>
            ) : (
              <p style={{ margin: '0 0 0.75rem', color: 'var(--color-text-secondary)' }}>
                Nothing attached yet. A PDF, JPEG, PNG or WebP up to 15 MB.
              </p>
            )}
            {canBills && bill.status !== 'VOID' && (
              <p style={{ margin: '0.75rem 0 0' }}>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.webp"
                  aria-label="Attach their invoice"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) void upload(file)
                  }}
                />
              </p>
            )}
            <p style={{ ...muted, marginTop: '0.75rem', marginBottom: 0 }}>
              Files are stored and checked for what they claim to be. They are not scanned for viruses - nothing
              on this platform is, and pretending otherwise would be worse than saying so.
            </p>
          </div>

          {(hasBooks || booksOutcome) && (
            <div style={card}>
              <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>In the books</h2>
              {bill.postedAt && (
                <p style={{ margin: '0 0 0.5rem' }}>Filed in the accounts {formatWhen(bill.postedAt)}.</p>
              )}
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
                  {isBillPostable(bill.status)
                    ? 'This one has not been sent to the accounts yet.'
                    : 'A bill goes to the accounts when somebody approves it.'}
                </p>
              )}
              {canBills && isBillPostable(bill.status) && (
                <button className="btn btn-secondary" onClick={sendToBooks} disabled={busy}>
                  {booksOutcome ? 'Try the books again' : 'Send it to the books'}
                </button>
              )}
            </div>
          )}

          <div style={card}>
            <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>What happens next</h2>
            {bill.approvedAt && (
              <p style={{ ...muted, margin: '0 0 0.75rem' }}>
                Approved by {bill.approvedByName ?? 'somebody'} {formatWhen(bill.approvedAt)}.
              </p>
            )}
            {transitions.includes('query') && (
              <div style={{ maxWidth: 480, marginBottom: '0.75rem' }}>
                <Field label="What you are asking them" hint="Kept on the bill, so the next person can see what was asked.">
                  <textarea rows={2} style={input} value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {transitions.map((t) => (
                <button
                  key={t}
                  className={t === 'approve' ? 'btn btn-primary' : 'btn btn-secondary'}
                  onClick={() => runTransition(t)}
                  disabled={busy}
                >
                  {TRANSITION_LABELS[t]}
                </button>
              ))}
              {transitions.length === 0 && (
                <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
                  {canBills ? 'Nothing left to do with this one.' : 'You do not have permission to act on a bill.'}
                </p>
              )}
            </div>
            {canBills && isBillEditable(bill.status) && (
              <p style={{ marginTop: '0.75rem', marginBottom: 0 }}>
                <button style={linkButton} onClick={remove} disabled={busy}>
                  Delete this bill
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
                      <td style={td}>{entry.action.replace(/^bill\./, '').replace(/[-_]/g, ' ')}</td>
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

/**
 * A new bill against an order, prefilled from what has actually been delivered
 * and not yet invoiced.
 *
 * Deliberately NOT from what was ordered. The overwhelmingly common invoice is
 * for the delivery that just arrived, and a form that opens by proposing to pay
 * for goods nobody has seen is a form somebody will one day save by accident.
 * Anything genuinely being invoiced ahead of delivery is typed in, and the match
 * then says so in plain words.
 */
function linesFromOrder(
  billable: PoBillableLine[],
  defaults: { defaultCategoryId?: string | null; defaultVatTreatment?: string | null; defaultVatRateCode?: string | null },
): LineDraft[] {
  const drafts = billable
    .map((line) => {
      const left = Math.max(0, Number(line.qtyReceived) - Number(line.qtyInvoiced))
      return {
        key: nextKey(),
        orderLineId: line.orderLineId,
        description: line.description,
        qty: trimQty(left),
        unitCost: line.unitCost,
        taxRatePercent: line.taxRatePercent,
        taxRateCode: line.taxRateCode ?? defaults.defaultVatRateCode ?? '',
        vatTreatment: line.vatTreatment ?? defaults.defaultVatTreatment ?? '',
        categoryId: line.categoryId ?? defaults.defaultCategoryId ?? '',
      }
    })
  const withSomething = drafts.filter((line) => Number(line.qty) > 0)
  // Nothing delivered yet, so nothing is proposed - but the lines are still put
  // up at zero rather than leaving an empty table, because an invoice ahead of
  // delivery does happen and typing the order out again would be daft.
  return withSomething.length > 0 ? withSomething : drafts
}

function linesFromBill(bill: PoBill): LineDraft[] {
  return bill.lines.map((line) => ({
    key: nextKey(),
    orderLineId: line.orderLineId,
    description: line.description,
    qty: trimQty(line.qty),
    unitCost: line.unitCost,
    taxRatePercent: line.taxRatePercent,
    taxRateCode: line.taxRateCode ?? '',
    vatTreatment: line.vatTreatment ?? '',
    categoryId: line.categoryId ?? '',
  }))
}
