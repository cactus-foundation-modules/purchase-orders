'use client'

import { useEffect, useState } from 'react'
import type { PoConfig } from '@/modules/purchase-orders/lib/config'
import type { PoCapabilities } from '@/modules/purchase-orders/lib/capabilities'
import { card, Field, input, muted } from './ui'

// Purchase Orders' own settings tab. Nothing here belongs on a core settings
// page, and nothing core owns belongs here.

const rowGrid = { display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' } as const

export function PurchaseOrdersSettingsTab() {
  const [config, setConfig] = useState<PoConfig | null>(null)
  const [capabilities, setCapabilities] = useState<PoCapabilities | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/m/purchase-orders/admin/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return
        setConfig(d.config)
        setCapabilities(d.capabilities)
      })
      .catch(() => setError('Could not load your purchasing settings.'))
  }, [])

  function set<K extends keyof PoConfig>(key: K, value: PoConfig[K]) {
    setConfig((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  function setWarehouse(patch: Partial<PoConfig['warehouse']>) {
    setConfig((prev) => (prev ? { ...prev, warehouse: { ...prev.warehouse, ...patch } } : prev))
  }

  function setWarehouseAddress(patch: Partial<PoConfig['warehouse']['address']>) {
    setConfig((prev) =>
      prev ? { ...prev, warehouse: { ...prev.warehouse, address: { ...prev.warehouse.address, ...patch } } } : prev,
    )
  }

  function setWording(patch: Partial<PoConfig['wording']>) {
    setConfig((prev) => (prev ? { ...prev, wording: { ...prev.wording, ...patch } } : prev))
  }

  async function save() {
    if (!config) return
    setError(null)
    const res = await fetch('/api/m/purchase-orders/admin/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not save that.')
      return
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  if (!config) return <p>Loading…</p>

  return (
    <div style={{ maxWidth: 760 }}>
      {error && (
        <div className="alert alert-danger" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      <div style={card}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-base)' }}>Numbering</h3>
        <div style={rowGrid}>
          <Field label="Order number prefix">
            <input style={input} value={config.orderNumberPrefix} onChange={(e) => set('orderNumberPrefix', e.target.value)} />
          </Field>
          <Field label="Goods received prefix">
            <input style={input} value={config.receiptNumberPrefix} onChange={(e) => set('receiptNumberPrefix', e.target.value)} />
          </Field>
          <Field label="Returns prefix">
            <input style={input} value={config.returnNumberPrefix} onChange={(e) => set('returnNumberPrefix', e.target.value)} />
          </Field>
        </div>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          Changing a prefix only affects what comes next. Everything already raised keeps the number it was given.
        </p>
      </div>

      <div style={card}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-base)' }}>Approvals</h3>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.75rem' }}>
          <input type="checkbox" checked={config.approvalRequired} onChange={(e) => set('approvalRequired', e.target.checked)} />
          Big orders need approving before they go out
        </label>
        {config.approvalRequired && (
          <Field
            label="Approval threshold"
            hint="Orders at or above this total wait for somebody who can approve them. Set it to 0 to have every order approved."
          >
            <input
              type="number"
              min={0}
              step="0.01"
              style={input}
              value={config.approvalThreshold}
              onChange={(e) => set('approvalThreshold', Number(e.target.value))}
            />
          </Field>
        )}
      </div>

      <div style={card}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-base)' }}>Checking what arrives</h3>
        <div style={rowGrid}>
          <Field label="Over-delivery allowed (%)" hint="More than this over what you ordered gets flagged.">
            <input
              type="number"
              min={0}
              max={100}
              style={input}
              value={config.overReceiptTolerancePercent}
              onChange={(e) => set('overReceiptTolerancePercent', Number(e.target.value))}
            />
          </Field>
          <Field label="Price difference allowed (%)" hint="How far a supplier's invoice may drift from your order before it is queried.">
            <input
              type="number"
              min={0}
              max={100}
              style={input}
              value={config.priceVarianceTolerancePercent}
              onChange={(e) => set('priceVarianceTolerancePercent', Number(e.target.value))}
            />
          </Field>
          <Field label="Quantity difference allowed (%)">
            <input
              type="number"
              min={0}
              max={100}
              style={input}
              value={config.quantityVarianceTolerancePercent}
              onChange={(e) => set('quantityVarianceTolerancePercent', Number(e.target.value))}
            />
          </Field>
        </div>

        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.75rem' }}>
          <input
            type="checkbox"
            checked={config.stockOnReceipt}
            disabled={!capabilities?.hasInventory}
            onChange={(e) => set('stockOnReceipt', e.target.checked)}
          />
          Add goods to stock when they arrive
        </label>
        {!capabilities?.hasInventory && (
          <p style={{ ...muted, marginTop: '0.375rem' }}>
            Nothing on this site keeps stock counts, so there is nothing to add to. Install the Shop module and this
            switches on.
          </p>
        )}
      </div>

      <div style={card}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-base)' }}>Where goods normally go</h3>
        <Field label="Default delivery">
          <select
            style={input}
            value={config.defaultShipToKind}
            onChange={(e) => set('defaultShipToKind', e.target.value as PoConfig['defaultShipToKind'])}
          >
            <option value="WAREHOUSE">Our own address</option>
            <option value="CUSTOMER">Straight to the customer</option>
            <option value="OTHER">Somewhere else</option>
          </select>
        </Field>
        <div style={{ ...rowGrid, marginTop: '0.75rem' }}>
          <Field label="Name">
            <input style={input} value={config.warehouse.name} onChange={(e) => setWarehouse({ name: e.target.value })} />
          </Field>
          <Field label="Contact">
            <input style={input} value={config.warehouse.contact} onChange={(e) => setWarehouse({ contact: e.target.value })} />
          </Field>
          <Field label="Phone">
            <input style={input} value={config.warehouse.phone} onChange={(e) => setWarehouse({ phone: e.target.value })} />
          </Field>
          <Field label="Line 1">
            <input style={input} value={config.warehouse.address.line1} onChange={(e) => setWarehouseAddress({ line1: e.target.value })} />
          </Field>
          <Field label="Line 2">
            <input style={input} value={config.warehouse.address.line2} onChange={(e) => setWarehouseAddress({ line2: e.target.value })} />
          </Field>
          <Field label="Town or city">
            <input style={input} value={config.warehouse.address.city} onChange={(e) => setWarehouseAddress({ city: e.target.value })} />
          </Field>
          <Field label="County">
            <input style={input} value={config.warehouse.address.region} onChange={(e) => setWarehouseAddress({ region: e.target.value })} />
          </Field>
          <Field label="Postcode">
            <input style={input} value={config.warehouse.address.postcode} onChange={(e) => setWarehouseAddress({ postcode: e.target.value })} />
          </Field>
          <Field label="Country">
            <input style={input} value={config.warehouse.address.country} onChange={(e) => setWarehouseAddress({ country: e.target.value })} />
          </Field>
        </div>
        <div style={{ marginTop: '0.75rem' }}>
          <Field label="Standing delivery instructions">
            <textarea rows={2} style={input} value={config.warehouse.instructions} onChange={(e) => setWarehouse({ instructions: e.target.value })} />
          </Field>
        </div>
      </div>

      <div style={card}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-base)' }}>Money</h3>
        <div style={rowGrid}>
          <Field label="Your own currency" hint="What you keep your books in. Suppliers may of course bill you in theirs.">
            <input style={input} maxLength={3} value={config.baseCurrency} onChange={(e) => set('baseCurrency', e.target.value.toUpperCase())} />
          </Field>
          <Field label="Default bookkeeping category">
            <input
              style={input}
              value={config.defaultCategoryId}
              disabled={!capabilities?.hasBooks}
              onChange={(e) => set('defaultCategoryId', e.target.value)}
            />
          </Field>
        </div>
        {!capabilities?.hasBooks && (
          <p style={{ ...muted, marginTop: '0.375rem' }}>
            There are no books on this site, so approved bills stop at approved. Install the UK Bookkeeping module and
            they carry through.
          </p>
        )}
      </div>

      <div style={card}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-base)' }}>Wording on the order</h3>
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <Field label="Heading">
            <input style={input} value={config.wording.heading} onChange={(e) => setWording({ heading: e.target.value })} />
          </Field>
          <Field label="Opening line">
            <textarea rows={2} style={input} value={config.wording.intro} onChange={(e) => setWording({ intro: e.target.value })} />
          </Field>
          <Field label="Terms">
            <textarea rows={3} style={input} value={config.wording.terms} onChange={(e) => setWording({ terms: e.target.value })} />
          </Field>
          <Field label="Footer note">
            <textarea rows={2} style={input} value={config.wording.footerNote} onChange={(e) => setWording({ footerNote: e.target.value })} />
          </Field>
        </div>
      </div>

      <div style={card}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-base)' }}>Chasing and the supplier link</h3>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input type="checkbox" checked={config.chaseEnabled} onChange={(e) => set('chaseEnabled', e.target.checked)} />
          Chase suppliers about orders that are late
        </label>
        <div style={{ ...rowGrid, marginTop: '0.75rem' }}>
          <Field label="Chase after (days late)">
            <input type="number" min={0} style={input} value={config.chaseAfterDays} onChange={(e) => set('chaseAfterDays', Number(e.target.value))} />
          </Field>
          <Field label="Then every (days)">
            <input type="number" min={0} style={input} value={config.chaseRepeatDays} onChange={(e) => set('chaseRepeatDays', Number(e.target.value))} />
          </Field>
        </div>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.75rem' }}>
          <input type="checkbox" checked={config.portalEnabled} onChange={(e) => set('portalEnabled', e.target.checked)} />
          Give suppliers a link to see their own order
        </label>
        <div style={{ marginTop: '0.75rem', maxWidth: 260 }}>
          <Field label="Link lasts (days)">
            <input
              type="number"
              min={1}
              max={365}
              style={input}
              value={config.portalTokenLifetimeDays}
              onChange={(e) => set('portalTokenLifetimeDays', Number(e.target.value))}
            />
          </Field>
        </div>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          Chasing and the supplier link are both switched on here and arrive with a later release. Nothing is sent to
          anybody in the meantime.
        </p>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <button className="btn btn-primary btn-sm" onClick={save}>
          Save settings
        </button>
        {saved && <span style={{ color: 'var(--color-success)', fontSize: 'var(--text-sm)' }}>Saved</span>}
      </div>
    </div>
  )
}
