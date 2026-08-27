'use client'

import { useCallback, useEffect, useState } from 'react'
import type {
  PoReorderPlan,
  PoReorderRule,
  PoReorderSuggestion,
  PoSupplier,
} from '@/modules/purchase-orders/lib/types'
import { card, Field, formatWhen, input, linkButton, Money, muted, table, td, tdRight, th, thRight } from './ui'

// The Reorder tab. Two halves, in the order somebody actually wants them: what
// needs buying today at the top, and the levels that decided it underneath.
//
// The suggestions are worked out fresh on every load rather than stored, so a
// delivery booked in ten minutes ago has already changed the answer.

/** The catalogue product picker's shape. Declared here rather than imported
 *  from lib/reorder.ts: that file reaches for the database, and a client
 *  component must not carry an import edge to it. */
type CatalogueOption = {
  id: string
  name: string
  sku: string | null
  supplier: string | null
  costPrice: string | null
  stockCount: number | null
  lowStockThreshold: number | null
}

type Payload = {
  rules: PoReorderRule[]
  suppliers: PoSupplier[]
  products: CatalogueOption[]
  suggestions: PoReorderSuggestion[]
  plans: PoReorderPlan[]
  restingCount: number
  automatic: boolean
}

type Form = {
  productId: string
  supplierId: string
  reorderPoint: string
  reorderQty: string
  enabled: boolean
}

const EMPTY_FORM: Form = { productId: '', supplierId: '', reorderPoint: '', reorderQty: '', enabled: true }

function intOrZero(value: string): number {
  const n = Number(value.trim())
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0
}

export function ReorderScreen({ canEdit }: { canEdit: boolean }) {
  const [data, setData] = useState<Payload | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(
    (term = '') =>
      fetch(`/api/m/purchase-orders/admin/reorder?q=${encodeURIComponent(term)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((payload: Payload | null) => {
          if (payload) setData(payload)
        })
        .catch(() => setError('Could not load your reorder levels.')),
    [],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  function startEdit(rule?: PoReorderRule) {
    setError(null)
    if (!rule) {
      setEditingId(null)
      setForm({ ...EMPTY_FORM })
      return
    }
    setEditingId(rule.id)
    setForm({
      productId: rule.productId,
      supplierId: rule.supplierId ?? '',
      reorderPoint: String(rule.reorderPoint),
      reorderQty: String(rule.reorderQty),
      enabled: rule.enabled,
    })
  }

  /** Picking a product borrows the shop's own low-stock level and its supplier
   *  name as a starting point. Both are editable; both are usually right. */
  function pickProduct(productId: string) {
    const product = data?.products.find((p) => p.id === productId)
    setForm((f) => {
      if (!f) return f
      const supplier = product?.supplier
        ? data?.suppliers.find((s) => s.name.trim().toLowerCase() === product.supplier!.trim().toLowerCase())
        : undefined
      return {
        ...f,
        productId,
        supplierId: f.supplierId || supplier?.id || '',
        reorderPoint:
          f.reorderPoint || (product?.lowStockThreshold != null ? String(product.lowStockThreshold) : ''),
      }
    })
  }

  async function save() {
    if (!form || busy) return
    setBusy(true)
    setError(null)
    try {
      const body = {
        productId: form.productId,
        supplierId: form.supplierId || null,
        reorderPoint: intOrZero(form.reorderPoint),
        reorderQty: intOrZero(form.reorderQty),
        enabled: form.enabled,
      }
      const url = editingId
        ? `/api/m/purchase-orders/admin/reorder/${editingId}`
        : '/api/m/purchase-orders/admin/reorder'
      const res = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'Could not save that level.')
        return
      }
      setForm(null)
      setEditingId(null)
      await refresh(search)
    } finally {
      setBusy(false)
    }
  }

  async function remove(rule: PoReorderRule) {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/reorder/${rule.id}`, { method: 'DELETE' })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not delete that level.')
      return
    }
    await refresh(search)
  }

  async function raise(supplierIds: string[]) {
    if (busy) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const res = await fetch('/api/m/purchase-orders/admin/reorder/raise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplierIds }),
      })
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'Could not raise those orders.')
        return
      }
      const result = await res.json()
      const count = result.ordersCreated?.length ?? 0
      setNote(
        count === 0
          ? 'Nothing was raised.'
          : count === 1
            ? `Draft order ${result.ordersCreated[0].number} is waiting on the Orders tab.`
            : `${count} draft orders are waiting on the Orders tab.`,
      )
      await refresh(search)
    } finally {
      setBusy(false)
    }
  }

  if (!data) return <p>Loading…</p>

  const blocked = data.suggestions.filter((s) => s.blockedReason)

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 className="page-title">Reorder</h1>
        {canEdit && (
          <button onClick={() => startEdit()} className="btn btn-primary">
            New reorder level
          </button>
        )}
      </div>

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}
      {note && (
        <div className="alert alert-success" style={{ marginBottom: '1rem' }}>
          {note}
        </div>
      )}

      {!data.automatic && data.rules.length > 0 && (
        <p style={{ ...muted, marginBottom: '1rem' }}>
          Orders are not being raised on their own. Everything below is still worked out for you every time you open
          this page; switch on <strong>raise orders automatically</strong> in Settings → Purchase Orders to have the
          drafts waiting for you in the morning instead.
        </p>
      )}

      <h2 style={{ fontSize: 'var(--text-lg)', margin: '0 0 0.5rem' }}>What needs buying</h2>

      {data.plans.length === 0 && blocked.length === 0 && (
        <div style={{ ...card, textAlign: 'center', padding: '2rem 1.25rem' }}>
          <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
            {data.rules.length === 0
              ? 'Nothing to go on yet. Set a level for a product or two and this fills itself in.'
              : `Nothing is under its level. ${data.restingCount === 1 ? 'One product is' : `${data.restingCount} products are`} being watched.`}
          </p>
        </div>
      )}

      {data.plans.map((plan) => (
        <div key={plan.supplierId} style={card}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              gap: '1rem',
              flexWrap: 'wrap',
              marginBottom: '0.75rem',
            }}
          >
            <div>
              <h3 style={{ margin: 0, fontSize: 'var(--text-base)' }}>{plan.supplierName}</h3>
              <div style={muted}>
                {plan.lines.length === 1 ? 'One line' : `${plan.lines.length} lines`}, goods{' '}
                <Money value={plan.goodsValue} currency={plan.currency} />
                {Number(plan.carriageAmount) > 0 && (
                  <>
                    {' '}
                    plus carriage <Money value={plan.carriageAmount} currency={plan.currency} />
                  </>
                )}
                {plan.carriagePaid && ' - carriage paid on this one'}
              </div>
            </div>
            {canEdit && (
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => raise([plan.supplierId])}>
                {busy ? 'Working…' : 'Raise a draft order'}
              </button>
            )}
          </div>

          {plan.holdReason && (
            <p style={{ ...muted, marginTop: 0, marginBottom: '0.75rem' }}>
              {plan.holdReason}
              {plan.shortOfMinimum && (
                <>
                  {' '}
                  Their minimum is <Money value={plan.minimumOrderValue} currency={plan.currency} />, so it is{' '}
                  <Money value={plan.shortOfMinimum} currency={plan.currency} /> short.
                </>
              )}
            </p>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Product</th>
                  <th style={thRight}>In stock</th>
                  <th style={thRight}>On order</th>
                  <th style={thRight}>Level</th>
                  <th style={thRight}>Buy</th>
                  <th style={thRight}>Unit cost</th>
                  <th style={thRight}>Value</th>
                </tr>
              </thead>
              <tbody>
                {plan.lines.map((line) => (
                  <tr key={line.ruleId}>
                    <td style={td}>
                      {line.productName}
                      {line.sku && <div style={muted}>{line.sku}</div>}
                    </td>
                    <td style={tdRight}>{line.inStock ?? '—'}</td>
                    <td style={tdRight}>{line.onOrder || '—'}</td>
                    <td style={tdRight}>{line.reorderPoint}</td>
                    <td style={tdRight}>{line.suggestedQty}</td>
                    <td style={tdRight}>
                      <Money value={line.unitCost} currency={plan.currency} />
                    </td>
                    <td style={tdRight}>
                      <Money value={line.lineValue} currency={plan.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {blocked.length > 0 && (
        <div style={card}>
          <h3 style={{ margin: '0 0 0.5rem', fontSize: 'var(--text-base)' }}>Waiting on something</h3>
          <p style={{ ...muted, marginTop: 0 }}>
            These are under their level and cannot be ordered yet. Nothing here is broken - each one says what it wants.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Product</th>
                  <th style={th}>What is stopping it</th>
                </tr>
              </thead>
              <tbody>
                {blocked.map((line) => (
                  <tr key={line.ruleId}>
                    <td style={td}>
                      {line.productName}
                      {line.sku && <div style={muted}>{line.sku}</div>}
                    </td>
                    <td style={td}>{line.blockedReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <h2 style={{ fontSize: 'var(--text-lg)', margin: '1.5rem 0 0.5rem' }}>Reorder levels</h2>

      {data.rules.length === 0 && !form && (
        <p style={{ color: 'var(--color-text-secondary)' }}>
          A level is two numbers: how few you are willing to have left, and how many to buy when you get there. Nothing
          is bought without one.
        </p>
      )}

      {data.rules.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Product</th>
                <th style={th}>Buy from</th>
                <th style={thRight}>Level</th>
                <th style={thRight}>Buy</th>
                <th style={th}>Last suggested</th>
                <th style={th}>Status</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {data.rules.map((rule) => (
                <tr key={rule.id}>
                  <td style={td}>
                    {rule.productName ?? <span style={muted}>No longer in your catalogue</span>}
                    {rule.sku && <div style={muted}>{rule.sku}</div>}
                  </td>
                  <td style={td}>{rule.supplierName ?? <span style={muted}>Whoever the catalogue says</span>}</td>
                  <td style={tdRight}>{rule.reorderPoint}</td>
                  <td style={tdRight}>{rule.reorderQty}</td>
                  <td style={td}>{rule.lastSuggestedAt ? formatWhen(rule.lastSuggestedAt) : '—'}</td>
                  <td style={td}>{rule.enabled ? 'On' : 'Off'}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {canEdit && (
                      <>
                        <button onClick={() => startEdit(rule)} style={linkButton}>
                          Edit
                        </button>
                        <button
                          onClick={() => remove(rule)}
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
          <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-base)' }}>
            {editingId ? 'Edit reorder level' : 'New reorder level'}
          </h3>

          {!editingId && (
            <Field label="Find a product" hint="Only products something is keeping a count of can have a level.">
              <input
                style={input}
                value={search}
                placeholder="Name or SKU"
                onChange={(e) => {
                  setSearch(e.target.value)
                  void refresh(e.target.value)
                }}
              />
            </Field>
          )}

          <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', marginTop: '0.75rem' }}>
            <Field label="Product">
              <select style={input} value={form.productId} onChange={(e) => pickProduct(e.target.value)}>
                <option value="">Pick a product</option>
                {form.productId && !data.products.some((p) => p.id === form.productId) && (
                  <option value={form.productId}>
                    {data.rules.find((r) => r.productId === form.productId)?.productName ?? form.productId}
                  </option>
                )}
                {data.products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.sku ? ` (${p.sku})` : ''}
                    {p.stockCount != null ? ` - ${p.stockCount} left` : ''}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Buy from" hint="Leave this and whoever the catalogue files the product under is used.">
              <select style={input} value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
                <option value="">Whoever the catalogue says</option>
                {data.suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Order when it drops to" hint="Counting what is already on its way to you.">
              <input
                type="number"
                min={0}
                style={input}
                value={form.reorderPoint}
                onChange={(e) => setForm({ ...form, reorderPoint: e.target.value })}
              />
            </Field>

            <Field label="Buy this many at a time" hint="Whole lots of this are bought, enough to get back above the level.">
              <input
                type="number"
                min={0}
                style={input}
                value={form.reorderQty}
                onChange={(e) => setForm({ ...form, reorderQty: e.target.value })}
              />
            </Field>
          </div>

          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.75rem' }}>
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            Watch this one
          </label>

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
            <button onClick={save} className="btn btn-primary" disabled={busy || !form.productId}>
              {busy ? 'Saving…' : 'Save level'}
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
