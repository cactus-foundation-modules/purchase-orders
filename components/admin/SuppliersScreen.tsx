'use client'

import { useCallback, useEffect, useState } from 'react'
import type { PoAddress } from '@/modules/purchase-orders/lib/config'
import type { PoSupplier, SupplierStatus } from '@/modules/purchase-orders/lib/types'
import { card, Field, input, linkButton, muted, table, td, th, thRight } from './ui'

type ShopSupplier = { id: string; name: string; email: string | null; accountNumber: string | null }

type Form = {
  name: string
  shopSupplierId: string
  accountNumber: string
  contactName: string
  phone: string
  email: string
  emailCc: string
  address: PoAddress
  currency: string
  paymentTerms: string
  paymentTermsDays: string
  leadTimeDays: string
  minimumOrderValue: string
  carriagePaidOver: string
  carriageCharge: string
  taxRegistrationNumber: string
  deliveryInstructions: string
  status: SupplierStatus
  notes: string
}

const EMPTY_ADDRESS: PoAddress = { line1: '', line2: '', city: '', region: '', postcode: '', country: '' }

const EMPTY_FORM: Form = {
  name: '',
  shopSupplierId: '',
  accountNumber: '',
  contactName: '',
  phone: '',
  email: '',
  emailCc: '',
  address: EMPTY_ADDRESS,
  currency: 'GBP',
  paymentTerms: '',
  paymentTermsDays: '',
  leadTimeDays: '',
  minimumOrderValue: '',
  carriagePaidOver: '',
  carriageCharge: '',
  taxRegistrationNumber: '',
  deliveryInstructions: '',
  status: 'ENABLED',
  notes: '',
}

function intOrNull(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function moneyOrNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function textOrNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export function SuppliersScreen({ canEdit }: { canEdit: boolean }) {
  const [suppliers, setSuppliers] = useState<PoSupplier[]>([])
  const [shopSuppliers, setShopSuppliers] = useState<ShopSupplier[]>([])
  const [hasCatalogue, setHasCatalogue] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [form, setForm] = useState<Form | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A promise chain rather than an async body, so every setState lands in a
  // callback rather than synchronously inside the effect that starts it.
  const refresh = useCallback(
    () =>
      fetch('/api/m/purchase-orders/admin/suppliers')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data) {
            setSuppliers(data.suppliers ?? [])
            setShopSuppliers(data.shopSuppliers ?? [])
            setHasCatalogue(Boolean(data.capabilities?.hasCatalogue))
          }
          setLoaded(true)
        })
        .catch(() => setLoaded(true)),
    [],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  function startEdit(supplier?: PoSupplier) {
    setError(null)
    if (!supplier) {
      setEditingId(null)
      setForm({ ...EMPTY_FORM })
      return
    }
    setEditingId(supplier.id)
    setForm({
      name: supplier.name,
      shopSupplierId: supplier.shopSupplierId ?? '',
      accountNumber: supplier.accountNumber ?? '',
      contactName: supplier.contactName ?? '',
      phone: supplier.phone ?? '',
      email: supplier.email ?? '',
      emailCc: supplier.emailCc ?? '',
      address: supplier.address,
      currency: supplier.currency,
      paymentTerms: supplier.paymentTerms ?? '',
      paymentTermsDays: supplier.paymentTermsDays == null ? '' : String(supplier.paymentTermsDays),
      leadTimeDays: supplier.leadTimeDays == null ? '' : String(supplier.leadTimeDays),
      minimumOrderValue: supplier.minimumOrderValue ?? '',
      carriagePaidOver: supplier.carriagePaidOver ?? '',
      carriageCharge: supplier.carriageCharge ?? '',
      taxRegistrationNumber: supplier.taxRegistrationNumber ?? '',
      deliveryInstructions: supplier.deliveryInstructions ?? '',
      status: supplier.status,
      notes: supplier.notes ?? '',
    })
  }

  function setAddress(patch: Partial<PoAddress>) {
    setForm((f) => (f ? { ...f, address: { ...f.address, ...patch } } : f))
  }

  async function save() {
    if (!form || saving) return
    setSaving(true)
    setError(null)
    try {
      const linked = shopSuppliers.find((s) => s.id === form.shopSupplierId) ?? null
      const body = {
        name: form.name,
        // The name is snapshotted alongside the id, so a shop rename or delete
        // leaves this record perfectly readable.
        shopSupplierId: textOrNull(form.shopSupplierId),
        shopSupplierName: linked?.name ?? null,
        accountNumber: textOrNull(form.accountNumber),
        contactName: textOrNull(form.contactName),
        phone: textOrNull(form.phone),
        email: textOrNull(form.email),
        emailCc: textOrNull(form.emailCc),
        address: form.address,
        currency: form.currency,
        paymentTerms: textOrNull(form.paymentTerms),
        paymentTermsDays: intOrNull(form.paymentTermsDays),
        leadTimeDays: intOrNull(form.leadTimeDays),
        minimumOrderValue: moneyOrNull(form.minimumOrderValue),
        carriagePaidOver: moneyOrNull(form.carriagePaidOver),
        carriageCharge: moneyOrNull(form.carriageCharge),
        defaultCategoryId: null,
        defaultVatTreatment: null,
        defaultVatRateCode: null,
        taxRegistrationNumber: textOrNull(form.taxRegistrationNumber),
        deliveryInstructions: textOrNull(form.deliveryInstructions),
        status: form.status,
        notes: textOrNull(form.notes),
      }
      const url = editingId
        ? `/api/m/purchase-orders/admin/suppliers/${editingId}`
        : '/api/m/purchase-orders/admin/suppliers'
      const res = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'Could not save that supplier.')
        return
      }
      setForm(null)
      setEditingId(null)
      await refresh()
    } finally {
      setSaving(false)
    }
  }

  async function remove(supplier: PoSupplier) {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/suppliers/${supplier.id}`, { method: 'DELETE' })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not delete that supplier.')
      return
    }
    await refresh()
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 className="page-title">Suppliers</h1>
        {canEdit && (
          <button onClick={() => startEdit()} className="btn btn-primary">
            New supplier
          </button>
        )}
      </div>

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      {loaded && suppliers.length === 0 && !form && (
        <p style={{ color: 'var(--color-text-secondary)' }}>
          Nobody in the list yet. Add whoever you buy from and they become pickable on every purchase order.
        </p>
      )}

      {suppliers.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Name</th>
                <th style={th}>Account no.</th>
                <th style={th}>Contact</th>
                <th style={th}>Terms</th>
                <th style={thRight}>Lead time</th>
                <th style={thRight}>Orders</th>
                <th style={th}>Status</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) => (
                <tr key={s.id}>
                  <td style={td}>
                    {s.name}
                    {s.shopSupplierId && (
                      <div style={muted}>
                        {s.shopLinkLive
                          ? `Linked to ${s.shopSupplierName ?? 'a catalogue supplier'}`
                          : `Was linked to ${s.shopSupplierName ?? 'a catalogue supplier'}, which is no longer there`}
                      </div>
                    )}
                  </td>
                  <td style={td}>{s.accountNumber ?? '—'}</td>
                  <td style={td}>
                    {s.contactName ?? '—'}
                    {s.email && <div style={muted}>{s.email}</div>}
                    {s.phone && <div style={muted}>{s.phone}</div>}
                  </td>
                  <td style={td}>{s.paymentTerms ?? '—'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {s.leadTimeDays == null ? '—' : `${s.leadTimeDays} days`}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>{s.orderCount}</td>
                  <td style={td}>
                    {s.status === 'ENABLED' ? 'Enabled' : s.status === 'ON_HOLD' ? 'On hold' : 'Disabled'}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {canEdit && (
                      <>
                        <button onClick={() => startEdit(s)} style={linkButton}>
                          Edit
                        </button>
                        <button
                          onClick={() => remove(s)}
                          style={{ ...linkButton, marginLeft: '0.75rem', color: 'var(--color-danger)' }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {form && (
        <div style={{ ...card, marginTop: '1rem', maxWidth: 720 }}>
          <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>
            {editingId ? 'Edit supplier' : 'New supplier'}
          </h2>

          <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <Field label="Name">
              <input style={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Northern Clay Co." />
            </Field>
            <Field label="Account number">
              <input style={input} value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} />
            </Field>
            {hasCatalogue && (
              <Field
                label="Linked catalogue supplier"
                hint="Optional. Links this record to the supplier name your products are filed under, so the line editor can offer their products first."
              >
                <select style={input} value={form.shopSupplierId} onChange={(e) => setForm({ ...form, shopSupplierId: e.target.value })}>
                  <option value="">Not linked</option>
                  {shopSuppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Status">
              <select
                style={input}
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as SupplierStatus })}
              >
                <option value="ENABLED">Enabled</option>
                <option value="ON_HOLD">On hold</option>
                <option value="DISABLED">Disabled</option>
              </select>
            </Field>
            <Field label="Contact person">
              <input style={input} value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
            </Field>
            <Field label="Phone">
              <input style={input} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </Field>
            <Field label="Email" hint="Where their purchase orders go.">
              <input type="email" style={input} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Copy to">
              <input type="email" style={input} value={form.emailCc} onChange={(e) => setForm({ ...form, emailCc: e.target.value })} />
            </Field>
            <Field label="Currency">
              <input style={input} maxLength={3} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
            </Field>
            <Field label="Payment terms" hint='However you say it: "Net 30", "End of month plus 30".'>
              <input style={input} value={form.paymentTerms} onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })} />
            </Field>
            <Field label="Payment terms (days)">
              <input type="number" min={0} style={input} value={form.paymentTermsDays} onChange={(e) => setForm({ ...form, paymentTermsDays: e.target.value })} />
            </Field>
            <Field label="Lead time (days)">
              <input type="number" min={0} style={input} value={form.leadTimeDays} onChange={(e) => setForm({ ...form, leadTimeDays: e.target.value })} />
            </Field>
            <Field label="Minimum order value">
              <input style={input} value={form.minimumOrderValue} onChange={(e) => setForm({ ...form, minimumOrderValue: e.target.value })} placeholder="e.g. 250.00" />
            </Field>
            <Field label="Carriage paid over">
              <input style={input} value={form.carriagePaidOver} onChange={(e) => setForm({ ...form, carriagePaidOver: e.target.value })} placeholder="e.g. 500.00" />
            </Field>
            <Field label="Carriage charge">
              <input style={input} value={form.carriageCharge} onChange={(e) => setForm({ ...form, carriageCharge: e.target.value })} placeholder="e.g. 12.50" />
            </Field>
            <Field label="VAT registration number">
              <input style={input} value={form.taxRegistrationNumber} onChange={(e) => setForm({ ...form, taxRegistrationNumber: e.target.value })} />
            </Field>
          </div>

          <fieldset style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: '0.75rem', margin: '1rem 0 0' }}>
            <legend style={{ padding: '0 0.375rem', fontSize: 'var(--text-sm)' }}>Address</legend>
            <div style={{ display: 'grid', gap: '0.5rem', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
              <Field label="Line 1">
                <input style={input} value={form.address.line1} onChange={(e) => setAddress({ line1: e.target.value })} />
              </Field>
              <Field label="Line 2">
                <input style={input} value={form.address.line2} onChange={(e) => setAddress({ line2: e.target.value })} />
              </Field>
              <Field label="Town or city">
                <input style={input} value={form.address.city} onChange={(e) => setAddress({ city: e.target.value })} />
              </Field>
              <Field label="County">
                <input style={input} value={form.address.region} onChange={(e) => setAddress({ region: e.target.value })} />
              </Field>
              <Field label="Postcode">
                <input style={input} value={form.address.postcode} onChange={(e) => setAddress({ postcode: e.target.value })} />
              </Field>
              <Field label="Country">
                <input style={input} value={form.address.country} onChange={(e) => setAddress({ country: e.target.value })} />
              </Field>
            </div>
          </fieldset>

          <div style={{ marginTop: '0.75rem', display: 'grid', gap: '0.75rem' }}>
            <Field label="Delivery instructions">
              <textarea rows={2} style={input} value={form.deliveryInstructions} onChange={(e) => setForm({ ...form, deliveryInstructions: e.target.value })} />
            </Field>
            <Field label="Notes" hint="For you, not for them. Nothing here goes on a purchase order.">
              <textarea rows={3} style={input} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </Field>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
            <button onClick={save} className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save supplier'}
            </button>
            <button
              onClick={() => {
                setForm(null)
                setEditingId(null)
              }}
              className="btn btn-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
