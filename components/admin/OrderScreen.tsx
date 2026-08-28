'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { availableTransitions, canSend, editMode, TRANSITIONS } from '@/modules/purchase-orders/lib/lifecycle'
import type { PoTransition } from '@/modules/purchase-orders/lib/lifecycle'
import type { PoAccess } from '@/modules/purchase-orders/lib/permissions'
import { PO_PORTAL_EVENT_LABELS } from '@/modules/purchase-orders/lib/portal-view'
import type { PoPortalAdminEvent, PoPortalTokenSummary } from '@/modules/purchase-orders/lib/portal-view'
import { orderTotals } from '@/modules/purchase-orders/lib/totals'
import { isReceivable, outstanding } from '@/modules/purchase-orders/lib/receiving'
import type {
  CatalogueProduct,
  PoAuditEntry,
  PoBillSummary,
  PoOrder,
  PoReceiptSummary,
  PoReturnSummary,
  PoRevisionSummary,
  PoStatus,
  PoSupplier,
} from '@/modules/purchase-orders/lib/types'
import {
  BillStatusBadge,
  card,
  Field,
  formatDay,
  formatWhen,
  input,
  linkButton,
  MatchBadge,
  Money,
  muted,
  ReturnStatusBadge,
  StatusBadge,
  table,
  td,
  tdRight,
  th,
  thRight,
} from './ui'

type LineForm = {
  key: string
  productId: string | null
  productName: string | null
  supplierSku: string
  ourSku: string
  description: string
  qty: string
  unit: string
  unitCost: string
  discountPercent: string
  taxRatePercent: string
  expectedDate: string
  qtyCancelled: string
  // The delivery service this line has to go on, and what it costs per unit.
  // The cost is not in the line total - it is summed into the order's carriage.
  serviceName: string
  serviceCost: string
  // Never edited, never shown: the customer order line this was bought for. It
  // is carried through the form only so that saving an order raised off a shop
  // order does not throw the link away.
  sourceOrderItemId: string | null
}

type Form = {
  supplierId: string
  shipToKind: 'WAREHOUSE' | 'CUSTOMER' | 'OTHER'
  shipToName: string
  shipToContact: string
  shipToPhone: string
  shipToLine1: string
  shipToLine2: string
  shipToCity: string
  shipToRegion: string
  shipToPostcode: string
  shipToCountry: string
  shipToInstructions: string
  currency: string
  baseCurrency: string
  fxRate: string
  taxMode: 'EXCLUSIVE' | 'INCLUSIVE'
  discountAmount: string
  carriageAmount: string
  requiredByDate: string
  expectedDate: string
  paymentTerms: string
  deliveryTerms: string
  notesSupplier: string
  notesInternal: string
  lines: LineForm[]
}

let lineCounter = 0
function newLine(patch: Partial<LineForm> = {}): LineForm {
  lineCounter += 1
  return {
    key: `line-${lineCounter}`,
    productId: null,
    productName: null,
    supplierSku: '',
    ourSku: '',
    description: '',
    qty: '1',
    unit: 'each',
    unitCost: '0',
    discountPercent: '',
    taxRatePercent: '20',
    expectedDate: '',
    qtyCancelled: '0',
    serviceName: '',
    serviceCost: '',
    sourceOrderItemId: null,
    ...patch,
  }
}

function emptyForm(defaults: FormDefaults): Form {
  return {
    supplierId: '',
    shipToKind: defaults.defaultShipToKind,
    shipToName: defaults.warehouseName,
    shipToContact: defaults.warehouseContact,
    shipToPhone: defaults.warehousePhone,
    shipToLine1: defaults.warehouseLine1,
    shipToLine2: defaults.warehouseLine2,
    shipToCity: defaults.warehouseCity,
    shipToRegion: defaults.warehouseRegion,
    shipToPostcode: defaults.warehousePostcode,
    shipToCountry: defaults.warehouseCountry,
    shipToInstructions: defaults.warehouseInstructions,
    currency: defaults.baseCurrency,
    baseCurrency: defaults.baseCurrency,
    fxRate: '1',
    taxMode: 'EXCLUSIVE',
    discountAmount: '0',
    carriageAmount: '0',
    requiredByDate: '',
    expectedDate: '',
    paymentTerms: '',
    deliveryTerms: '',
    notesSupplier: '',
    notesInternal: '',
    lines: [newLine()],
  }
}

function formFromOrder(order: PoOrder): Form {
  return {
    supplierId: order.supplierId,
    shipToKind: order.shipToKind,
    shipToName: order.shipTo.name,
    shipToContact: order.shipTo.contact,
    shipToPhone: order.shipTo.phone,
    shipToLine1: order.shipTo.address.line1,
    shipToLine2: order.shipTo.address.line2,
    shipToCity: order.shipTo.address.city,
    shipToRegion: order.shipTo.address.region,
    shipToPostcode: order.shipTo.address.postcode,
    shipToCountry: order.shipTo.address.country,
    shipToInstructions: order.shipTo.instructions,
    currency: order.currency,
    baseCurrency: order.baseCurrency,
    fxRate: order.fxRate,
    taxMode: order.taxMode,
    discountAmount: order.discountAmount,
    carriageAmount: order.carriageAmount,
    requiredByDate: order.requiredByDate ?? '',
    expectedDate: order.expectedDate ?? '',
    paymentTerms: order.paymentTerms ?? '',
    deliveryTerms: order.deliveryTerms ?? '',
    notesSupplier: order.notesSupplier ?? '',
    notesInternal: order.notesInternal ?? '',
    lines: order.lines.map((l) =>
      newLine({
        productId: l.productId,
        productName: l.productName,
        supplierSku: l.supplierSku ?? '',
        ourSku: l.ourSku ?? '',
        description: l.description,
        qty: l.qty,
        unit: l.unit,
        unitCost: l.unitCost,
        discountPercent: l.discountPercent ?? '',
        taxRatePercent: l.taxRatePercent,
        expectedDate: l.expectedDate ?? '',
        qtyCancelled: l.qtyCancelled,
        serviceName: l.serviceName ?? '',
        serviceCost: l.serviceCost ?? '',
        sourceOrderItemId: l.sourceOrderItemId,
      }),
    ),
  }
}

/** What the supplier link endpoint hands back for one order. */
type PortalState = {
  enabled: boolean
  lifetimeDays: number
  tokens: PoPortalTokenSummary[]
  events: PoPortalAdminEvent[]
}

export type FormDefaults = {
  baseCurrency: string
  defaultShipToKind: 'WAREHOUSE' | 'CUSTOMER' | 'OTHER'
  warehouseName: string
  warehouseContact: string
  warehousePhone: string
  warehouseLine1: string
  warehouseLine2: string
  warehouseCity: string
  warehouseRegion: string
  warehousePostcode: string
  warehouseCountry: string
  warehouseInstructions: string
  approvalRequired: boolean
  approvalThreshold: number
}

type Props = {
  orderId: string | null
  access: PoAccess
  defaults: FormDefaults
  hasCatalogue: boolean
}

export function OrderScreen({ orderId, access, defaults, hasCatalogue }: Props) {
  const router = useRouter()
  const adminPath = useAdminPath()
  const base = `/${adminPath}/m/purchase-orders/orders`

  const isNew = orderId === null
  const [order, setOrder] = useState<PoOrder | null>(null)
  const [history, setHistory] = useState<PoAuditEntry[]>([])
  const [revisions, setRevisions] = useState<PoRevisionSummary[]>([])
  const [receipts, setReceipts] = useState<PoReceiptSummary[]>([])
  const [returns, setReturns] = useState<PoReturnSummary[]>([])
  const [bills, setBills] = useState<PoBillSummary[]>([])
  // The supplier's link, and what they have said through it. Its own request
  // again: most orders never have a link at all, and the join would be earning
  // its keep on a minority of order screens.
  const [portal, setPortal] = useState<PortalState | null>(null)
  // Handed back once, when it is made. There is no way to ask for it again -
  // only the hash is stored - so it stays on screen until the page is left.
  const [newLink, setNewLink] = useState<string | null>(null)
  // Why this order is changing. Only asked for on an amendment - an order the
  // supplier is already holding - and required there, because "what changed" is
  // the first thing they will ask.
  const [amendReason, setAmendReason] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [suppliers, setSuppliers] = useState<PoSupplier[]>([])
  const [form, setForm] = useState<Form>(() => emptyForm(defaults))
  const [editing, setEditing] = useState(isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [loaded, setLoaded] = useState(isNew)

  // Written as a promise chain rather than an async body called from the effect:
  // every setState lands in a callback, which is what keeps the load out of the
  // synchronous render pass.
  const loadOrder = useCallback(
    () =>
      Promise.all([
        fetch(`/api/m/purchase-orders/admin/orders/${orderId}`).then((r) => (r.ok ? r.json() : null)),
        // Deliveries come back on their own request rather than on the order's,
        // because the order screen is drawn far more often than a delivery is
        // booked in and the join is only earning its keep on one of those.
        fetch(`/api/m/purchase-orders/admin/orders/${orderId}/receipts`)
          .then((r) => (r.ok ? r.json() : { receipts: [] }))
          .catch(() => ({ receipts: [] })),
        // Returns come back on their own request too, and for the same reason:
        // most orders never have one, and joining for it on every order screen
        // would be a join earning its keep on a small minority of them.
        fetch(`/api/m/purchase-orders/admin/returns?orderId=${encodeURIComponent(orderId ?? '')}`)
          .then((r) => (r.ok ? r.json() : { returns: [] }))
          .catch(() => ({ returns: [] })),
        // And the invoices, for the same reason again.
        fetch(`/api/m/purchase-orders/admin/bills?orderId=${encodeURIComponent(orderId ?? '')}`)
          .then((r) => (r.ok ? r.json() : { bills: [] }))
          .catch(() => ({ bills: [] })),
        fetch(`/api/m/purchase-orders/admin/orders/${orderId}/portal`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ])
        .then(([data, deliveries, sentBack, invoices, supplierLink]) => {
          if (data?.order) {
            setOrder(data.order)
            setHistory(data.history ?? [])
            setRevisions(data.revisions ?? [])
            setForm(formFromOrder(data.order))
          }
          setReceipts(deliveries?.receipts ?? [])
          setReturns(sentBack?.returns ?? [])
          setBills(invoices?.bills ?? [])
          setPortal(supplierLink ?? null)
          setLoaded(true)
        })
        .catch(() => setLoaded(true)),
    [orderId],
  )

  useEffect(() => {
    if (!orderId) return
    void loadOrder()
  }, [orderId, loadOrder])

  useEffect(() => {
    fetch('/api/m/purchase-orders/admin/suppliers')
      .then((r) => (r.ok ? r.json() : { suppliers: [] }))
      .then((d) => setSuppliers(d.suppliers ?? []))
      .catch(() => setSuppliers([]))
  }, [])

  const supplier = suppliers.find((s) => s.id === form.supplierId) ?? null

  // The same arithmetic the server will do on save, run here only so the person
  // typing watches the numbers move. Nothing on the wire depends on it.
  const totals = useMemo(
    () =>
      orderTotals({
        lines: form.lines.map((l) => ({
          qty: l.qty || '0',
          unitCost: l.unitCost || '0',
          discountPercent: l.discountPercent || '0',
          taxRatePercent: l.taxRatePercent || '0',
        })),
        taxMode: form.taxMode,
        discountAmount: form.discountAmount || '0',
        carriageAmount: form.carriageAmount || '0',
      }),
    [form],
  )

  function setLine(key: string, patch: Partial<LineForm>) {
    setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }))
  }

  function removeLine(key: string) {
    setForm((f) => ({
      ...f,
      lines: f.lines.length > 1 ? f.lines.filter((l) => l.key !== key) : f.lines,
    }))
  }

  function body() {
    return {
      supplierId: form.supplierId,
      shipToKind: form.shipToKind,
      shipTo: {
        name: form.shipToName,
        contact: form.shipToContact,
        phone: form.shipToPhone,
        address: {
          line1: form.shipToLine1,
          line2: form.shipToLine2,
          city: form.shipToCity,
          region: form.shipToRegion,
          postcode: form.shipToPostcode,
          country: form.shipToCountry,
        },
        instructions: form.shipToInstructions,
      },
      currency: form.currency,
      baseCurrency: form.baseCurrency,
      fxRate: form.fxRate || '1',
      taxMode: form.taxMode,
      discountAmount: form.discountAmount || '0',
      carriageAmount: form.carriageAmount || '0',
      requiredByDate: form.requiredByDate || null,
      expectedDate: form.expectedDate || null,
      paymentTerms: form.paymentTerms || null,
      deliveryTerms: form.deliveryTerms || null,
      notesSupplier: form.notesSupplier || null,
      notesInternal: form.notesInternal || null,
      amendmentReason: amendReason.trim() || undefined,
      lines: form.lines.map((l) => ({
        productId: l.productId,
        productName: l.productName,
        supplierSku: l.supplierSku || null,
        ourSku: l.ourSku || null,
        description: l.description,
        qty: l.qty || '0',
        unit: l.unit || 'each',
        unitCost: l.unitCost || '0',
        discountPercent: l.discountPercent || null,
        taxRatePercent: l.taxRatePercent || '0',
        taxRateCode: null,
        vatTreatment: null,
        categoryId: null,
        expectedDate: l.expectedDate || null,
        qtyCancelled: l.qtyCancelled || '0',
        serviceName: l.serviceName || null,
        serviceCost: l.serviceCost || null,
        sourceOrderItemId: l.sourceOrderItemId,
      })),
    }
  }

  async function save() {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const url = isNew ? '/api/m/purchase-orders/admin/orders' : `/api/m/purchase-orders/admin/orders/${orderId}`
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body()),
      })
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'Could not save that order.')
        return
      }
      if (isNew) {
        const data = await res.json()
        router.push(`${base}/${data.id}`)
        return
      }
      setEditing(false)
      setAmendReason('')
      await loadOrder()
    } finally {
      setSaving(false)
    }
  }

  async function runTransition(transition: PoTransition) {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transition, note: note.trim() || undefined }),
    })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not do that.')
      return
    }
    setNote('')
    await loadOrder()
  }

  async function sendOrder() {
    if (sending) return
    setSending(true)
    setError(null)
    setSent(null)
    try {
      const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note.trim() || undefined }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? 'Could not send that order.')
        return
      }
      setNote('')
      setSent(`Sent to ${data.to}${data.cc?.length ? ` (copied to ${data.cc.join(', ')})` : ''}.`)
      await loadOrder()
    } finally {
      setSending(false)
    }
  }

  // Cancelling the balance of one line, which is NOT an edit: an amendment
  // rewrites every line wholesale and refuses to touch one that has a delivery
  // against it, which is exactly the line somebody wants to give up on.
  async function cancelLine(lineId: string) {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/lines/${lineId}`, { method: 'POST' })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not cancel that line.')
      return
    }
    await loadOrder()
  }

  async function loadPortal() {
    const data = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/portal`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    setPortal(data ?? null)
  }

  async function makePortalLink() {
    setError(null)
    setNewLink(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/portal`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(data.error ?? 'Could not make a link for that one.')
      return
    }
    setNewLink(data.url ?? null)
    await loadPortal()
  }

  async function revokePortalLink(tokenId: string) {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/portal/${tokenId}`, { method: 'DELETE' })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not stop that link.')
      return
    }
    await loadPortal()
  }

  async function revokeAllPortalLinks() {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/portal`, { method: 'DELETE' })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not stop those links.')
      return
    }
    setNewLink(null)
    await loadPortal()
  }

  // Taking the supplier up on a date they offered. The whole order reloads
  // afterwards rather than the date being patched in here, because the date is
  // now on the order and the order is what the screen draws.
  async function applyPortalDate(eventId: string) {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/portal/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId }),
    })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not use that date.')
      return
    }
    await loadOrder()
  }

  async function deleteOrder() {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}`, { method: 'DELETE' })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not delete that order.')
      return
    }
    router.push(base)
  }

  if (!loaded) return <p>Loading…</p>
  if (!isNew && !order) {
    return <div className="alert alert-danger">That purchase order is not here any more.</div>
  }

  const status: PoStatus = order?.status ?? 'DRAFT'
  const mode = editMode(status)
  const canEditNow = isNew || (access.canCreate && mode !== 'refused')
  const amending = !isNew && mode === 'amend'
  const transitions = order ? availableTransitions(status, access) : []
  const sendable = !isNew && access.canCreate && canSend(status, order!.approvalRequired).ok

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
        <div>
          <h1 className="page-title" style={{ marginBottom: '0.25rem' }}>
            {isNew ? 'New purchase order' : order!.number}
            {!isNew && order!.revision > 1 && <span style={{ marginLeft: '0.5rem', fontSize: 'var(--text-sm)' }}>Rev {order!.revision}</span>}
          </h1>
          {!isNew && <StatusBadge status={status} />}
        </div>
        <Link href={base} style={linkButton}>
          Back to orders
        </Link>
      </div>

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      {sent && (
        <div className="alert alert-success" style={{ marginBottom: '1rem' }}>
          {sent}
        </div>
      )}

      {!isNew && order!.approvalRequired && status === 'DRAFT' && (
        <div className="alert alert-warning" style={{ marginBottom: '1rem' }}>
          This order is over your approval threshold, so it needs approving before it can go out.
        </div>
      )}

      {editing ? (
        <>
          <div style={card}>
            <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <Field label="Supplier">
                <select style={input} value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
                  <option value="">Pick a supplier</option>
                  {suppliers
                    .filter((s) => s.status === 'ENABLED' || s.id === form.supplierId)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.status !== 'ENABLED' ? ` (${s.status === 'ON_HOLD' ? 'on hold' : 'disabled'})` : ''}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Currency">
                <input style={input} maxLength={3} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
              </Field>
              <Field
                label="Exchange rate"
                hint={`${form.baseCurrency} per 1 ${form.currency}. Your own expectation - the supplier's invoice carries the rate the books use.`}
              >
                <input style={input} value={form.fxRate} onChange={(e) => setForm({ ...form, fxRate: e.target.value })} />
              </Field>
              <Field label="Prices include tax">
                <select style={input} value={form.taxMode} onChange={(e) => setForm({ ...form, taxMode: e.target.value as Form['taxMode'] })}>
                  <option value="EXCLUSIVE">No - add tax on top</option>
                  <option value="INCLUSIVE">Yes - tax is already in the price</option>
                </select>
              </Field>
              <Field label="Wanted by">
                <input type="date" style={input} value={form.requiredByDate} onChange={(e) => setForm({ ...form, requiredByDate: e.target.value })} />
              </Field>
              <Field label="Expected">
                <input type="date" style={input} value={form.expectedDate} onChange={(e) => setForm({ ...form, expectedDate: e.target.value })} />
              </Field>
              <Field label="Payment terms">
                <input
                  style={input}
                  value={form.paymentTerms}
                  onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })}
                  placeholder={supplier?.paymentTerms ?? ''}
                />
              </Field>
              <Field label="Delivery terms">
                <input style={input} value={form.deliveryTerms} onChange={(e) => setForm({ ...form, deliveryTerms: e.target.value })} />
              </Field>
            </div>

            {supplier?.minimumOrderValue && Number(totals.subtotal) < Number(supplier.minimumOrderValue) && (
              <p style={{ ...muted, marginTop: '0.75rem' }}>
                {supplier.name} has a minimum order of <Money value={supplier.minimumOrderValue} currency={form.currency} />.
              </p>
            )}
          </div>

          <LineEditor
            lines={form.lines}
            currency={form.currency}
            lineTotals={totals.lineTotals}
            hasCatalogue={hasCatalogue}
            supplierId={form.supplierId}
            onChange={setLine}
            onRemove={removeLine}
            onAdd={(patch) => setForm((f) => ({ ...f, lines: [...f.lines, newLine(patch)] }))}
          />

          <div style={card}>
            <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>Deliver to</h2>
            <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
              <Field label="Kind" hint="Drop-ship means straight to your customer, not to you.">
                <select style={input} value={form.shipToKind} onChange={(e) => setForm({ ...form, shipToKind: e.target.value as Form['shipToKind'] })}>
                  <option value="WAREHOUSE">Our own address</option>
                  <option value="CUSTOMER">Straight to the customer</option>
                  <option value="OTHER">Somewhere else</option>
                </select>
              </Field>
              <Field label="Name">
                <input style={input} value={form.shipToName} onChange={(e) => setForm({ ...form, shipToName: e.target.value })} />
              </Field>
              <Field label="Contact">
                <input style={input} value={form.shipToContact} onChange={(e) => setForm({ ...form, shipToContact: e.target.value })} />
              </Field>
              <Field label="Phone">
                <input style={input} value={form.shipToPhone} onChange={(e) => setForm({ ...form, shipToPhone: e.target.value })} />
              </Field>
              <Field label="Line 1">
                <input style={input} value={form.shipToLine1} onChange={(e) => setForm({ ...form, shipToLine1: e.target.value })} />
              </Field>
              <Field label="Line 2">
                <input style={input} value={form.shipToLine2} onChange={(e) => setForm({ ...form, shipToLine2: e.target.value })} />
              </Field>
              <Field label="Town or city">
                <input style={input} value={form.shipToCity} onChange={(e) => setForm({ ...form, shipToCity: e.target.value })} />
              </Field>
              <Field label="County">
                <input style={input} value={form.shipToRegion} onChange={(e) => setForm({ ...form, shipToRegion: e.target.value })} />
              </Field>
              <Field label="Postcode">
                <input style={input} value={form.shipToPostcode} onChange={(e) => setForm({ ...form, shipToPostcode: e.target.value })} />
              </Field>
              <Field label="Country">
                <input style={input} value={form.shipToCountry} onChange={(e) => setForm({ ...form, shipToCountry: e.target.value })} />
              </Field>
            </div>
            <div style={{ marginTop: '0.75rem' }}>
              <Field label="Delivery instructions">
                <textarea rows={2} style={input} value={form.shipToInstructions} onChange={(e) => setForm({ ...form, shipToInstructions: e.target.value })} />
              </Field>
            </div>
          </div>

          <div style={card}>
            <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <Field label="Order discount">
                <input style={input} value={form.discountAmount} onChange={(e) => setForm({ ...form, discountAmount: e.target.value })} />
              </Field>
              <Field label="Carriage">
                <input style={input} value={form.carriageAmount} onChange={(e) => setForm({ ...form, carriageAmount: e.target.value })} />
              </Field>
            </div>
            <div style={{ marginTop: '0.75rem', display: 'grid', gap: '0.75rem' }}>
              <Field label="Notes for the supplier" hint="These print on the order.">
                <textarea rows={3} style={input} value={form.notesSupplier} onChange={(e) => setForm({ ...form, notesSupplier: e.target.value })} />
              </Field>
              <Field label="Notes for us" hint="These never leave the building.">
                <textarea rows={3} style={input} value={form.notesInternal} onChange={(e) => setForm({ ...form, notesInternal: e.target.value })} />
              </Field>
            </div>
            <Totals totals={totals} currency={form.currency} />
          </div>

          {amending && (
            <div style={card}>
              <Field
                label="What has changed"
                hint="The supplier already has this order. Saving files their copy as a revision and gives you a fresh one to send them."
              >
                <input style={input} value={amendReason} onChange={(e) => setAmendReason(e.target.value)} />
              </Field>
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '2rem' }}>
            <button
              className="btn btn-primary"
              onClick={save}
              disabled={saving || !form.supplierId || (amending && !amendReason.trim())}
            >
              {saving ? 'Saving…' : isNew ? 'Create order' : amending ? 'Save as a new revision' : 'Save changes'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                if (isNew) {
                  router.push(base)
                  return
                }
                setForm(formFromOrder(order!))
                setEditing(false)
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <OrderView
          order={order!}
          transitions={transitions}
          note={note}
          onNote={setNote}
          onTransition={runTransition}
          onEdit={canEditNow ? () => setEditing(true) : null}
          onDelete={access.canCreate && status === 'DRAFT' ? deleteOrder : null}
          onSend={sendable ? sendOrder : null}
          sending={sending}
          history={history}
          revisions={revisions}
          receipts={receipts}
          returns={returns}
          bills={bills}
          receivingHref={`/${adminPath}/m/purchase-orders/receiving/${orderId}`}
          returnsBase={`/${adminPath}/m/purchase-orders/returns`}
          billsBase={`/${adminPath}/m/purchase-orders/bills`}
          canReceive={access.canReceive}
          canBills={access.canBills}
          onCancelLine={access.canCreate && mode === 'amend' ? cancelLine : null}
          portal={portal}
          newLink={newLink}
          onMakeLink={access.canCreate ? makePortalLink : null}
          onRevokeLink={access.canCreate ? revokePortalLink : null}
          onRevokeAllLinks={access.canCreate ? revokeAllPortalLinks : null}
          onApplyDate={access.canCreate ? applyPortalDate : null}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function Totals({ totals, currency }: { totals: ReturnType<typeof orderTotals>; currency: string }) {
  return (
    <table style={{ ...table, marginTop: '1rem', maxWidth: 320, marginLeft: 'auto' }}>
      <tbody>
        <tr>
          <td style={td}>Goods</td>
          <td style={tdRight}>
            <Money value={totals.subtotal} currency={currency} />
          </td>
        </tr>
        {Number(totals.discountAmount) !== 0 && (
          <tr>
            <td style={td}>Discount</td>
            <td style={tdRight}>
              −<Money value={totals.discountAmount} currency={currency} />
            </td>
          </tr>
        )}
        {Number(totals.carriageAmount) !== 0 && (
          <tr>
            <td style={td}>Carriage</td>
            <td style={tdRight}>
              <Money value={totals.carriageAmount} currency={currency} />
            </td>
          </tr>
        )}
        <tr>
          <td style={td}>Tax</td>
          <td style={tdRight}>
            <Money value={totals.taxAmount} currency={currency} />
          </td>
        </tr>
        <tr>
          <td style={{ ...td, fontWeight: 600, borderTop: '2px solid var(--color-border)' }}>Total</td>
          <td style={{ ...tdRight, fontWeight: 600, borderTop: '2px solid var(--color-border)' }}>
            <Money value={totals.total} currency={currency} />
          </td>
        </tr>
      </tbody>
    </table>
  )
}

type LineEditorProps = {
  lines: LineForm[]
  currency: string
  lineTotals: string[]
  hasCatalogue: boolean
  supplierId: string
  onChange: (key: string, patch: Partial<LineForm>) => void
  onRemove: (key: string) => void
  onAdd: (patch?: Partial<LineForm>) => void
}

function LineEditor({ lines, currency, lineTotals, hasCatalogue, supplierId, onChange, onRemove, onAdd }: LineEditorProps) {
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<CatalogueProduct[]>([])
  const [onlyThisSupplier, setOnlyThisSupplier] = useState(true)

  // Everything, including clearing the list, happens inside the debounce timer:
  // a bare setResults([]) in the effect body is a synchronous state write during
  // render, and the search is debounced anyway.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!hasCatalogue || term.trim().length < 2) {
        setResults([])
        return
      }
      const params = new URLSearchParams({ q: term.trim() })
      if (supplierId && onlyThisSupplier) {
        params.set('supplierId', supplierId)
        params.set('onlyThisSupplier', 'true')
      }
      fetch(`/api/m/purchase-orders/admin/catalogue?${params.toString()}`)
        .then((r) => (r.ok ? r.json() : { products: [] }))
        .then((d) => setResults(d.products ?? []))
        .catch(() => setResults([]))
    }, 250)
    return () => clearTimeout(timer)
  }, [term, hasCatalogue, supplierId, onlyThisSupplier])

  return (
    <div style={card}>
      <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>Lines</h2>

      <div style={{ overflowX: 'auto' }}>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Description</th>
              <th style={th}>Their code</th>
              <th style={thRight}>Qty</th>
              <th style={th}>Unit</th>
              <th style={thRight}>Cost</th>
              <th style={thRight}>Disc %</th>
              <th style={thRight}>Tax %</th>
              <th style={thRight}>Line total</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={line.key}>
                <td style={{ ...td, minWidth: 220 }}>
                  <input
                    style={input}
                    value={line.description}
                    onChange={(e) => onChange(line.key, { description: e.target.value })}
                    aria-label={`Line ${index + 1} description`}
                  />
                  {line.productId && <span style={muted}>From the catalogue</span>}
                  {/* The delivery service sits under the description rather than
                      in columns of its own: the table is already nine wide, and
                      this reads the way it prints on the document. */}
                  <div style={{ display: 'flex', gap: '0.375rem', marginTop: '0.25rem' }}>
                    <input
                      style={{ ...input, flex: 1, minWidth: 120 }}
                      value={line.serviceName}
                      placeholder="Delivery service"
                      onChange={(e) => onChange(line.key, { serviceName: e.target.value })}
                      aria-label={`Line ${index + 1} delivery service`}
                    />
                    <input
                      style={{ ...input, width: 80, textAlign: 'right' }}
                      value={line.serviceCost}
                      placeholder="Cost"
                      title="What the service costs per unit. It is not in the line total - put it in Carriage as well if the supplier is charging you for it."
                      onChange={(e) => onChange(line.key, { serviceCost: e.target.value })}
                      aria-label={`Line ${index + 1} delivery service cost, per unit`}
                    />
                  </div>
                </td>
                <td style={td}>
                  <input
                    style={{ ...input, minWidth: 100 }}
                    value={line.supplierSku}
                    onChange={(e) => onChange(line.key, { supplierSku: e.target.value })}
                    aria-label={`Line ${index + 1} supplier code`}
                  />
                </td>
                <td style={tdRight}>
                  <input
                    style={{ ...input, width: 80, textAlign: 'right' }}
                    value={line.qty}
                    onChange={(e) => onChange(line.key, { qty: e.target.value })}
                    aria-label={`Line ${index + 1} quantity`}
                  />
                </td>
                <td style={td}>
                  <input
                    style={{ ...input, width: 80 }}
                    value={line.unit}
                    onChange={(e) => onChange(line.key, { unit: e.target.value })}
                    aria-label={`Line ${index + 1} unit`}
                  />
                </td>
                <td style={tdRight}>
                  <input
                    style={{ ...input, width: 100, textAlign: 'right' }}
                    value={line.unitCost}
                    onChange={(e) => onChange(line.key, { unitCost: e.target.value })}
                    aria-label={`Line ${index + 1} unit cost`}
                  />
                </td>
                <td style={tdRight}>
                  <input
                    style={{ ...input, width: 70, textAlign: 'right' }}
                    value={line.discountPercent}
                    onChange={(e) => onChange(line.key, { discountPercent: e.target.value })}
                    aria-label={`Line ${index + 1} discount percent`}
                  />
                </td>
                <td style={tdRight}>
                  <input
                    style={{ ...input, width: 70, textAlign: 'right' }}
                    value={line.taxRatePercent}
                    onChange={(e) => onChange(line.key, { taxRatePercent: e.target.value })}
                    aria-label={`Line ${index + 1} tax rate`}
                  />
                </td>
                <td style={tdRight}>
                  <Money value={lineTotals[index] ?? '0'} currency={currency} />
                </td>
                <td style={td}>
                  <button type="button" onClick={() => onRemove(line.key)} style={{ ...linkButton, color: 'var(--color-danger)' }}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn btn-secondary" onClick={() => onAdd()}>
          Add a line
        </button>
        {hasCatalogue && (
          <>
            <input
              style={{ ...input, width: 'auto', minWidth: 220 }}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Or search your catalogue"
              aria-label="Search the catalogue"
            />
            <label style={{ ...muted, display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
              <input type="checkbox" checked={onlyThisSupplier} onChange={(e) => setOnlyThisSupplier(e.target.checked)} />
              Only this supplier&apos;s products
            </label>
          </>
        )}
      </div>

      {!hasCatalogue && (
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          There is no product catalogue on this site, so lines are typed in. That is perfectly normal - not everything a
          business buys is something it sells.
        </p>
      )}

      {results.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '0.75rem 0 0', padding: 0, borderTop: '1px solid var(--color-border)' }}>
          {results.map((p) => (
            <li key={p.id} style={{ padding: '0.375rem 0', borderBottom: '1px solid var(--color-border)' }}>
              <button
                type="button"
                style={linkButton}
                onClick={() => {
                  onAdd({
                    productId: p.id,
                    productName: p.name,
                    description: p.name,
                    ourSku: p.sku ?? '',
                    // The supplier's own code where the catalogue carries one,
                    // so a line goes out under the code they will recognise.
                    supplierSku: p.supplierSku ?? '',
                    unitCost: p.costPrice ?? '0',
                  })
                  setTerm('')
                }}
              >
                {p.name}
              </button>
              {p.sku && <span style={{ marginLeft: '0.5rem', ...muted }}>{p.sku}</span>}
              {p.costSource === 'CATALOGUE' && (
                <span style={{ marginLeft: '0.5rem', ...muted }}>
                  {p.discontinued
                    ? `No longer sold on ${p.catalogueName}`
                    : `Priced off ${p.catalogueName}`}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

type ViewProps = {
  order: PoOrder
  transitions: PoTransition[]
  note: string
  onNote: (value: string) => void
  onTransition: (transition: PoTransition) => void
  onEdit: (() => void) | null
  onDelete: (() => void) | null
  onSend: (() => void) | null
  sending: boolean
  history: PoAuditEntry[]
  revisions: PoRevisionSummary[]
  receipts: PoReceiptSummary[]
  returns: PoReturnSummary[]
  bills: PoBillSummary[]
  receivingHref: string
  /** `/…/m/purchase-orders/returns`, for the list and for raising a new one. */
  returnsBase: string
  /** `/…/m/purchase-orders/bills`, for the list and for entering a new one. */
  billsBase: string
  canReceive: boolean
  canBills: boolean
  /** Null unless this order is one whose lines can still be given up on. */
  onCancelLine: ((lineId: string) => void) | null
  /** Null until the supplier link has loaded, which is a request of its own. */
  portal: PortalState | null
  /** The link just made, shown once. Only its hash is stored, so this is the
   *  only moment anybody can copy it. */
  newLink: string | null
  onMakeLink: (() => void) | null
  onRevokeLink: ((tokenId: string) => void) | null
  onRevokeAllLinks: (() => void) | null
  onApplyDate: ((eventId: string) => void) | null
}

function OrderView({
  order, transitions, note, onNote, onTransition, onEdit, onDelete, onSend, sending, history, revisions,
  receipts, returns, bills, receivingHref, returnsBase, billsBase, canReceive, canBills,
  onCancelLine, portal, newLink, onMakeLink, onRevokeLink, onRevokeAllLinks, onApplyDate,
}: ViewProps) {
  const totals = {
    subtotal: order.subtotal,
    discountAmount: order.discountAmount,
    carriageAmount: order.carriageAmount,
    taxAmount: order.taxAmount,
    total: order.total,
    lineTotals: order.lines.map((l) => l.lineTotal),
  }

  return (
    <>
      <div style={card}>
        <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <div>
            <div style={muted}>Supplier</div>
            <div>{order.supplierName}</div>
          </div>
          <div>
            <div style={muted}>Raised</div>
            <div>{formatDay(order.raisedDate)}</div>
          </div>
          <div>
            <div style={muted}>Wanted by</div>
            <div>{formatDay(order.requiredByDate)}</div>
          </div>
          <div>
            <div style={muted}>Expected</div>
            <div>{formatDay(order.expectedDate)}</div>
          </div>
          <div>
            <div style={muted}>Payment terms</div>
            <div>{order.paymentTerms ?? '—'}</div>
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
        </div>
      </div>

      <div style={card}>
        <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>Lines</h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Description</th>
                <th style={th}>Their code</th>
                <th style={thRight}>Ordered</th>
                <th style={thRight}>Received</th>
                <th style={thRight}>Still due</th>
                <th style={thRight}>Invoiced</th>
                <th style={thRight}>Cost</th>
                <th style={thRight}>Line total</th>
                {onCancelLine && <th style={th} />}
              </tr>
            </thead>
            <tbody>
              {order.lines.map((l) => {
                const left = outstanding(l)
                return (
                  <tr key={l.id}>
                    <td style={td}>
                      {l.description}
                      {/* Their words head the line, because they are what goes
                          on the sheet they read. Ours sits under it where the
                          two differ, so whoever is checking this against the
                          shop can still tell what it is. */}
                      {l.productName && l.productName !== l.description && (
                        <div style={muted}>{l.productName} in your catalogue</div>
                      )}
                      {l.serviceName && (
                        <div style={muted}>
                          {l.serviceName}
                          {l.serviceCost && (
                            <>
                              {' - '}
                              <Money value={l.serviceCost} currency={order.currency} /> a unit, not in the line total
                            </>
                          )}
                        </div>
                      )}
                      {Number(l.qtyCancelled) > 0 && <div style={muted}>{l.qtyCancelled} cancelled</div>}
                    </td>
                    <td style={td}>{l.supplierSku ?? '—'}</td>
                    <td style={tdRight}>
                      {l.qty} {l.unit}
                    </td>
                    <td style={tdRight}>{l.qtyReceived}</td>
                    <td style={tdRight}>{left > 0 ? left : '—'}</td>
                    <td style={tdRight}>{l.qtyInvoiced}</td>
                    <td style={tdRight}>
                      <Money value={l.unitCost} currency={order.currency} />
                    </td>
                    <td style={tdRight}>
                      <Money value={l.lineTotal} currency={order.currency} />
                    </td>
                    {onCancelLine && (
                      <td style={td}>
                        {left > 0 && (
                          <button
                            style={linkButton}
                            onClick={() => onCancelLine(l.id)}
                            title="The rest of this line is never coming"
                          >
                            Give up on the rest
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <Totals totals={totals} currency={order.currency} />
      </div>

      {(order.notesSupplier || order.notesInternal) && (
        <div style={card}>
          {order.notesSupplier && (
            <>
              <div style={muted}>On the order</div>
              <p style={{ margin: '0 0 0.75rem', whiteSpace: 'pre-wrap' }}>{order.notesSupplier}</p>
            </>
          )}
          {order.notesInternal && (
            <>
              <div style={muted}>For us</div>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{order.notesInternal}</p>
            </>
          )}
        </div>
      )}

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>Deliveries</h2>
          {canReceive && isReceivable(order.status) && (
            <Link href={receivingHref} className="btn btn-secondary btn-sm">
              Book goods in
            </Link>
          )}
        </div>
        {receipts.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
            {isReceivable(order.status)
              ? 'Nothing has turned up against this one yet.'
              : 'Nothing was ever booked in against this order.'}
          </p>
        ) : (
          <table style={table}>
            <tbody>
              {receipts.map((r) => (
                <tr key={r.id}>
                  <td style={td}>{r.number}</td>
                  <td style={td}>{formatDay(r.receivedDate)}</td>
                  <td style={td}>{r.deliveryNoteRef ?? '—'}</td>
                  <td style={td}>{r.receivedByName ?? 'Somebody'}</td>
                  <td style={td}>{r.stockApplied ? 'Added to stock' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Only once something has actually turned up. Nothing can go back that
          never arrived, and a "send something back" button on an order still
          waiting for its first delivery is an invitation to raise a credit claim
          the supplier will refuse. */}
      {(returns.length > 0 || order.lines.some((l) => Number(l.qtyReceived) > 0)) && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>Returns</h2>
            {canReceive && order.lines.some((l) => Number(l.qtyReceived) - Number(l.qtyReturned) > 0) && (
              <Link href={`${returnsBase}/new?orderId=${order.id}`} className="btn btn-secondary btn-sm">
                Send something back
              </Link>
            )}
          </div>
          {returns.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
              Nothing has gone back on this one.
            </p>
          ) : (
            <table style={table}>
              <tbody>
                {returns.map((r) => (
                  <tr key={r.id}>
                    <td style={td}>
                      <Link href={`${returnsBase}/${r.id}`} style={{ color: 'var(--color-primary)' }}>
                        {r.number}
                      </Link>
                    </td>
                    <td style={td}>{formatDay(r.raisedDate)}</td>
                    <td style={td}>
                      <ReturnStatusBadge status={r.status} />
                    </td>
                    <td style={tdRight}>
                      <Money value={r.creditExpected} currency={r.currency} />
                    </td>
                    <td style={td}>{r.creditRef ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Invoices against this order. Shown from the moment the order has gone
          out rather than waiting for a delivery: plenty of suppliers invoice on
          despatch, and a few ask for the money before anything moves at all. */}
      {(bills.length > 0 || order.sentAt) && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>Bills</h2>
            {canBills && (
              <Link href={`${billsBase}/new?orderId=${order.id}`} className="btn btn-secondary btn-sm">
                Enter a bill
              </Link>
            )}
          </div>
          {bills.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
              Nobody has invoiced you for this one yet.
            </p>
          ) : (
            <table style={table}>
              <tbody>
                {bills.map((b) => (
                  <tr key={b.id}>
                    <td style={td}>
                      <Link href={`${billsBase}/${b.id}`} style={{ color: 'var(--color-primary)' }}>
                        {b.supplierInvoiceNumber}
                      </Link>
                    </td>
                    <td style={td}>{formatDay(b.invoiceDate)}</td>
                    <td style={td}>
                      <BillStatusBadge status={b.status} />
                    </td>
                    <td style={td}>
                      <MatchBadge status={b.matchStatus} count={b.varianceCount} />
                    </td>
                    <td style={tdRight}>
                      <Money value={b.total} currency={b.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div style={card}>
        <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>The document</h2>
        <p style={{ margin: '0 0 0.75rem', color: 'var(--color-text-secondary)' }}>
          {order.sentAt
            ? `Last sent ${formatWhen(order.sentAt)}.`
            : 'This order has not been sent to the supplier yet.'}
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {/* Plain links rather than fetches: one is a page to look at and the
              other is a file to save, and the browser does both better than we
              would. The document link redirects through a route that mints its
              own short-lived token, so nothing here has to carry one. */}
          <a
            className="btn btn-secondary"
            href={`/api/m/purchase-orders/admin/orders/${order.id}/document`}
            target="_blank"
            rel="noopener noreferrer"
          >
            View document
          </a>
          <a className="btn btn-secondary" href={`/api/m/purchase-orders/admin/orders/${order.id}/pdf`}>
            Download PDF
          </a>
          {onSend && (
            <button className="btn btn-primary" onClick={onSend} disabled={sending}>
              {sending ? 'Sending…' : order.sentAt ? 'Send the amended order' : 'Email it to the supplier'}
            </button>
          )}
        </div>
        {onSend && (
          <p style={{ ...muted, marginTop: '0.5rem' }}>
            The document goes as a PDF attachment. Anything typed in the note below goes with it.
          </p>
        )}
      </div>

      <SupplierLinkCard
        order={order}
        portal={portal}
        newLink={newLink}
        onMakeLink={onMakeLink}
        onRevokeLink={onRevokeLink}
        onRevokeAllLinks={onRevokeAllLinks}
        onApplyDate={onApplyDate}
      />

      {revisions.length > 0 && (
        <div style={card}>
          <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>Revisions</h2>
          <p style={{ ...muted, marginTop: 0 }}>
            What the supplier was sent before. Each one is kept exactly as it was printed.
          </p>
          <table style={table}>
            <tbody>
              {revisions.map((r) => (
                <tr key={r.id}>
                  <td style={td}>Rev {r.revision}</td>
                  <td style={td}>{r.reason ?? '—'}</td>
                  <td style={td}>{r.createdByName ?? 'Somebody'}</td>
                  <td style={td}>{formatWhen(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={card}>
        <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>What next</h2>
        {transitions.length === 0 && <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>Nothing left to do on this one.</p>}
        {transitions.length > 0 && (
          <>
            <Field label="Note" hint="Optional. Recorded against whatever you do next, and shown in the history below.">
              <input style={input} value={note} onChange={(e) => onNote(e.target.value)} />
            </Field>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
              {transitions.map((t) => (
                <button
                  key={t}
                  className={t === 'cancel' ? 'btn btn-secondary' : 'btn btn-primary'}
                  onClick={() => onTransition(t)}
                >
                  {TRANSITIONS[t].label}
                </button>
              ))}
            </div>
          </>
        )}
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', flexWrap: 'wrap' }}>
          {onEdit && (
            <button className="btn btn-secondary" onClick={onEdit}>
              Edit this order
            </button>
          )}
          {onDelete && (
            <button className="btn btn-secondary" onClick={onDelete} style={{ color: 'var(--color-danger)' }}>
              Delete draft
            </button>
          )}
        </div>
      </div>

      <div style={card}>
        <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>History</h2>
        {history.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>Nothing recorded yet.</p>
        ) : (
          <table style={table}>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td style={td}>{h.action.replace(/^order\./, '').replace(/[._]/g, ' ')}</td>
                  <td style={td}>{h.userName ?? 'Somebody'}</td>
                  <td style={td}>{formatWhen(h.createdAt)}</td>
                  <td style={td}>{typeof h.detail.note === 'string' ? h.detail.note : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------

type SupplierLinkProps = {
  order: PoOrder
  portal: PortalState | null
  newLink: string | null
  onMakeLink: (() => void) | null
  onRevokeLink: ((tokenId: string) => void) | null
  onRevokeAllLinks: (() => void) | null
  onApplyDate: ((eventId: string) => void) | null
}

/**
 * The supplier's own link to this order, and everything they have said through
 * it.
 *
 * Two things worth knowing about this card. The link itself is shown once, at
 * the moment it is made, because only its hash is stored - so there is no screen
 * that can show it again and no backup that leaks it. And what the supplier says
 * is a PROPOSAL: the only button here that changes the order is the one that
 * takes them up on a date, and somebody in this building presses it.
 */
function SupplierLinkCard({ order, portal, newLink, onMakeLink, onRevokeLink, onRevokeAllLinks, onApplyDate }: SupplierLinkProps) {
  // Null while it is still loading. Drawing an empty card first and filling it in
  // afterwards reads as a fault on a fast connection.
  if (!portal) return null

  const live = portal.tokens.filter((token) => token.live)

  return (
    <>
      <div style={card}>
        <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>The supplier&apos;s link</h2>

        {!portal.enabled ? (
          <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
            Supplier links are switched off. Turn them on in Settings, Purchase Orders, and the link goes out with the
            order.
          </p>
        ) : (
          <>
            <p style={{ margin: '0 0 0.75rem', color: 'var(--color-text-secondary)' }}>
              A link to this one order and nothing else. The supplier can read it, accept it, offer a different date or
              tell you something is short. They cannot change a thing on it. Links last {portal.lifetimeDays} days and
              can be stopped at any time.
            </p>

            {newLink && (
              <div style={{ marginBottom: '0.75rem' }}>
                <Field label="The new link" hint="Copy it now. It is not stored, so this is the only time it can be shown.">
                  <input style={input} readOnly value={newLink} onFocus={(e) => e.currentTarget.select()} />
                </Field>
              </div>
            )}

            {portal.tokens.length === 0 ? (
              <p style={{ margin: '0 0 0.75rem', color: 'var(--color-text-secondary)' }}>
                {order.sentAt
                  ? 'No link has been made for this order yet.'
                  : 'Send this order to the supplier and a link goes out with it.'}
              </p>
            ) : (
              <table style={table}>
                <thead>
                  <tr>
                    <th style={th}>Made</th>
                    <th style={th}>By</th>
                    <th style={th}>Until</th>
                    <th style={th}>Opened</th>
                    <th style={th} />
                  </tr>
                </thead>
                <tbody>
                  {portal.tokens.map((token) => (
                    <tr key={token.id}>
                      <td style={td}>{formatWhen(token.createdAt)}</td>
                      <td style={td}>{token.createdByName ?? 'The order email'}</td>
                      <td style={td}>
                        {token.revokedAt ? `Stopped ${formatWhen(token.revokedAt)}` : formatWhen(token.expiresAt)}
                      </td>
                      <td style={td}>
                        {token.useCount === 0 ? 'Never' : `${token.useCount} times, last ${formatWhen(token.lastUsedAt)}`}
                      </td>
                      <td style={td}>
                        {token.live && onRevokeLink && (
                          <button style={{ ...linkButton, color: 'var(--color-danger)' }} onClick={() => onRevokeLink(token.id)}>
                            Stop it
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
              {onMakeLink && (
                <button className="btn btn-secondary" onClick={onMakeLink} disabled={!order.sentAt}>
                  Make a link
                </button>
              )}
              {live.length > 1 && onRevokeAllLinks && (
                <button className="btn btn-secondary" onClick={onRevokeAllLinks} style={{ color: 'var(--color-danger)' }}>
                  Stop every link
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {portal.events.length > 0 && (
        <div style={card}>
          <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>What the supplier said</h2>
          <p style={{ ...muted, marginTop: 0 }}>
            Nothing here has changed the order. A date is yours to accept; anything else is yours to act on.
          </p>
          <table style={table}>
            <tbody>
              {portal.events.map((event) => (
                <tr key={event.id}>
                  <td style={td}>{PO_PORTAL_EVENT_LABELS[event.kind]}</td>
                  <td style={td}>{event.summary}</td>
                  <td style={td}>{formatWhen(event.createdAt)}</td>
                  <td style={td}>
                    {/* Only where it would actually change something. A button
                        that sets the date it is already on is a button that
                        teaches people the buttons do nothing. */}
                    {event.proposedDate && event.proposedDate !== order.expectedDate && onApplyDate && (
                      <button style={linkButton} onClick={() => onApplyDate(event.id)}>
                        Use {event.proposedDate}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
