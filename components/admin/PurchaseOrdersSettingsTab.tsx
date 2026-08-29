'use client'

import { useEffect, useState } from 'react'
import type { ModuleSettingsTabProps } from '@/lib/modules/hosted-settings'
import type { PoConfig } from '@/modules/purchase-orders/lib/config'
import type { PoCapabilities } from '@/modules/purchase-orders/lib/capabilities'
import { card, Field, input, muted } from './ui'

// Purchase Orders' own settings tab. Nothing here belongs on a core settings
// page, and nothing core owns belongs here.
//
// One slot is published for other modules' settings panels (`host` on their
// manifest settingsTabs entry - see lib/modules/hosted-settings.ts): anything
// that has something to say about the emails this module sends. The Unified
// Inbox uses it to ask which address purchasing writes from. Empty on a site
// without one, and an empty slot renders nothing at all - no heading, no gap.
const HOSTED_EMAIL_SLOT = 'purchase-orders.settings-emails'

const rowGrid = { display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' } as const

export function PurchaseOrdersSettingsTab({ hostedSettingsSlots }: ModuleSettingsTabProps = {}) {
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

  function setOrganisation(patch: Partial<PoConfig['organisation']>) {
    setConfig((prev) => (prev ? { ...prev, organisation: { ...prev.organisation, ...patch } } : prev))
  }

  function setWording(patch: Partial<PoConfig['wording']>) {
    setConfig((prev) => (prev ? { ...prev, wording: { ...prev.wording, ...patch } } : prev))
  }

  function setPackingSlipWording(patch: Partial<PoConfig['packingSlipWording']>) {
    setConfig((prev) => (prev ? { ...prev, packingSlipWording: { ...prev.packingSlipWording, ...patch } } : prev))
  }

  function setReturnWording(patch: Partial<PoConfig['returnWording']>) {
    setConfig((prev) => (prev ? { ...prev, returnWording: { ...prev.returnWording, ...patch } } : prev))
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
          <Field label="Despatch prefix" hint="What the supplier says they have sent. Its own series, because what left them and what you booked in are different things.">
            <input style={input} value={config.shipmentNumberPrefix} onChange={(e) => set('shipmentNumberPrefix', e.target.value)} />
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
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.75rem' }}>
          <input
            type="checkbox"
            checked={config.postApprovedBillsToBooks}
            disabled={!capabilities?.hasBooks}
            onChange={(e) => set('postApprovedBillsToBooks', e.target.checked)}
          />
          Put approved bills straight into the books
        </label>
        <p style={{ ...muted, marginTop: '0.375rem' }}>
          {capabilities?.hasBooks
            ? 'Approving a supplier invoice files it as an expense, with its VAT and their own invoice attached. Turn it off if somebody else keys purchases in and you would rather not have them twice. Supplier credits follow the same setting.'
            : 'There are no books on this site, so approved bills stop at approved. Install the UK Bookkeeping module and they carry through.'}
        </p>
      </div>

      <div style={card}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-base)' }}>Who is buying</h3>
        <p style={{ ...muted, marginTop: 0, marginBottom: '0.75rem' }}>
          What prints at the top of a purchase order as your own details. Leave a box empty and, where you run the Shop
          module, whatever you put on your invoices is used instead - so there is no need to type your VAT number twice.
        </p>
        <div style={rowGrid}>
          <Field label="Business name">
            <input style={input} value={config.organisation.name} onChange={(e) => setOrganisation({ name: e.target.value })} />
          </Field>
          <Field label="Who to ask for">
            <input style={input} value={config.organisation.contactName} onChange={(e) => setOrganisation({ contactName: e.target.value })} />
          </Field>
          <Field label="Email">
            <input style={input} value={config.organisation.email} onChange={(e) => setOrganisation({ email: e.target.value })} />
          </Field>
          <Field label="Phone">
            <input style={input} value={config.organisation.phone} onChange={(e) => setOrganisation({ phone: e.target.value })} />
          </Field>
          <Field label="VAT number">
            <input style={input} value={config.organisation.vatNumber} onChange={(e) => setOrganisation({ vatNumber: e.target.value })} />
          </Field>
          <Field label="Company number">
            <input style={input} value={config.organisation.companyNumber} onChange={(e) => setOrganisation({ companyNumber: e.target.value })} />
          </Field>
        </div>
        <div style={{ marginTop: '0.75rem' }}>
          <Field label="Address" hint="One line each.">
            <textarea rows={4} style={input} value={config.organisation.address} onChange={(e) => setOrganisation({ address: e.target.value })} />
          </Field>
        </div>
        <div style={{ marginTop: '0.75rem', maxWidth: 320 }}>
          <Field label="PDF filename starts with" hint="A saved order is named after this and its number.">
            <input style={input} value={config.pdfFilenamePrefix} onChange={(e) => set('pdfFilenamePrefix', e.target.value)} />
          </Field>
        </div>
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
        <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-base)' }}>Wording on a returns note</h3>
        <p style={{ margin: '0 0 0.75rem', color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
          Its own wording, because &ldquo;please supply the following&rdquo; on a note about goods going back is quite the mixed message.
        </p>
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <Field label="Heading">
            <input style={input} value={config.returnWording.heading} onChange={(e) => setReturnWording({ heading: e.target.value })} />
          </Field>
          <Field label="Opening line">
            <textarea rows={2} style={input} value={config.returnWording.intro} onChange={(e) => setReturnWording({ intro: e.target.value })} />
          </Field>
          <Field label="Terms" hint="Your standing terms about credits - when you expect them and in what condition goods go back.">
            <textarea rows={3} style={input} value={config.returnWording.terms} onChange={(e) => setReturnWording({ terms: e.target.value })} />
          </Field>
        </div>
        <div style={{ marginTop: '0.75rem', maxWidth: 320 }}>
          <Field label="PDF filename starts with" hint="A saved returns note is named after this and its number.">
            <input style={input} value={config.returnPdfFilenamePrefix} onChange={(e) => set('returnPdfFilenamePrefix', e.target.value)} />
          </Field>
        </div>
      </div>

      <div style={card}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-base)' }}>Wording on a packing slip</h3>
        <p style={{ margin: '0 0 0.75rem', color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
          The sheet that goes in the box. On an order you have drop-shipped, the person who opens that box is your
          customer - so it carries no prices at all and never names your supplier.
        </p>
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <Field label="Heading">
            <input style={input} value={config.packingSlipWording.heading} onChange={(e) => setPackingSlipWording({ heading: e.target.value })} />
          </Field>
          <Field label="Opening line">
            <textarea rows={2} style={input} value={config.packingSlipWording.intro} onChange={(e) => setPackingSlipWording({ intro: e.target.value })} />
          </Field>
          <Field label="If anything is wrong" hint="What somebody should do when the box is short or damaged. Printed under the items.">
            <textarea rows={3} style={input} value={config.packingSlipWording.terms} onChange={(e) => setPackingSlipWording({ terms: e.target.value })} />
          </Field>
        </div>
        <div style={{ marginTop: '0.75rem', maxWidth: 320 }}>
          <Field label="PDF filename starts with" hint="A saved packing slip is named after this and its despatch number.">
            <input style={input} value={config.packingSlipFilenamePrefix} onChange={(e) => set('packingSlipFilenamePrefix', e.target.value)} />
          </Field>
        </div>
      </div>

      <div style={card}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-base)' }}>Reordering</h3>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={config.reorderAutomatic}
            disabled={!capabilities?.hasCatalogue}
            onChange={(e) => set('reorderAutomatic', e.target.checked)}
          />
          Raise draft orders automatically overnight
        </label>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          {capabilities?.hasCatalogue
            ? 'Off, the Reorder tab still works out what needs buying and you raise it yourself. On, the drafts are waiting for you in the morning. Either way nothing is ever sent to a supplier without somebody sending it, and an order under a supplier’s minimum is left to grow rather than raised.'
            : 'There is no product catalogue on this site, so nothing is keeping the counts this would work from. Install the Shop module and this switches on.'}
        </p>
      </div>

      <div style={card}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-base)' }}>Buying for customer orders</h3>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={config.autoDraftFromPaidOrders}
            disabled={!capabilities?.hasCatalogue}
            onChange={(e) => set('autoDraftFromPaidOrders', e.target.checked)}
          />
          Draft the purchase orders as soon as a customer pays
        </label>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          {capabilities?.hasCatalogue
            ? 'Off, you press Raise on the customer order when you are ready. On, the drafts are typed for you the moment the money lands - one per supplier, going straight to the customer\u2019s address. Nothing is approved and nothing is sent: a supplier still hears from you only when you send it. If something on the order could not be matched to a supplier you are emailed about that one, and only about that one.'
            : 'There is no shop on this site, so there are no customer orders to buy for. Install the Shop module and this switches on.'}
        </p>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          Switching this on does not go back through your history. Orders paid in the last week that never had anything
          raised against them are picked up overnight; anything older than that is left alone, which is rather the
          point.
        </p>
      </div>

      <div style={card}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-base)' }}>Suppliers&rsquo; price lists</h3>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={config.supplierCatalogues}
            onChange={(e) => set('supplierCatalogues', e.target.checked)}
          />
          Price orders off suppliers&rsquo; own price lists
        </label>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          Off, an order line is drafted at what the product says it costs. On, a line for a code one of that
          supplier&rsquo;s lists names is drafted at THEIR price instead, and the line says which list it came from. You
          can keep lists on file either way - the Catalogues tab works with this off, and nothing is priced off them
          until you switch it on.
        </p>
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
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.75rem' }}>
          <input
            type="checkbox"
            checked={config.portalUploadsEnabled}
            disabled={!config.portalEnabled}
            onChange={(e) => set('portalUploadsEnabled', e.target.checked)}
          />
          Let suppliers send you their proforma and their order acknowledgement through the link
        </label>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem' }}>
          <input
            type="checkbox"
            checked={config.portalDespatchEnabled}
            disabled={!config.portalEnabled}
            onChange={(e) => set('portalDespatchEnabled', e.target.checked)}
          />
          Let suppliers say what they have sent, and take away a packing slip for each delivery
        </label>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          With the link on, every order you send carries one of its own. The supplier can read that order, download it,
          accept it, offer a date line by line or say something is short - and change none of it. Each link is listed
          on the order itself and can be stopped there. The two switches above are worth a thought: a file arriving
          through the link is the one place on this site where somebody with no account can put something on it. Every
          file is checked for what it really is and capped in size, and nothing is ever run - but if you would rather
          those came by email, turn it off and the page says so. With chasing on, a supplier who is late gets a short
          note asking where the order has got to - once, and then on the repeat above; set the repeat to zero to ask
          only the once. Either way the Reports tab works out who is late, and you can send one from there yourself.
        </p>
      </div>

      {/* Rendered by the core config page, so this tab hands it the space and
          asks nothing else about it. Whatever the panel needs - its own fetch,
          its own save, its own permission check - is its own module's business. */}
      {hostedSettingsSlots?.[HOSTED_EMAIL_SLOT]}

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <button className="btn btn-primary btn-sm" onClick={save}>
          Save settings
        </button>
        {saved && <span style={{ color: 'var(--color-success)', fontSize: 'var(--text-sm)' }}>Saved</span>}
      </div>
    </div>
  )
}
