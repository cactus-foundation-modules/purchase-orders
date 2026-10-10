'use client'

import { useEffect, useState } from 'react'
import type { ModuleSettingsTabProps } from '@/lib/modules/hosted-settings'
import type { PoConfig } from '@/modules/purchase-orders/lib/config'
import type { PoCapabilities } from '@/modules/purchase-orders/lib/capabilities'
import { TabStrip } from '@/components/admin/TabStrip'
import { SettingsHeaderActions, SettingsHeaderStatus } from '@/components/admin/SettingsHeaderActions'
import { Field, input, muted } from './ui'

// Purchase Orders' own settings tab. Nothing here belongs on a core settings
// page, and nothing core owns belongs here.
//
// One slot is published for other modules' settings panels (`host` on their
// manifest settingsTabs entry - see lib/modules/hosted-settings.ts): anything
// that has something to say about the emails this module sends. The Unified
// Inbox uses it to ask which address purchasing writes from. Empty on a site
// without one, and an empty slot renders nothing at all - no heading, no gap.
const HOSTED_EMAIL_SLOT = 'purchase-orders.settings-emails'

const rowGrid = { display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, max(18rem, calc(50% - 0.75rem))), 1fr))' } as const

export const PURCHASE_ORDER_SETTINGS_TABS = [
  { id: 'buying', label: 'Buying basics' },
  { id: 'documents', label: 'Documents' },
  { id: 'automation', label: 'Automation' },
] as const
type SettingsTab = (typeof PURCHASE_ORDER_SETTINGS_TABS)[number]['id']

export function PurchaseOrdersSettingsTab({ hostedSettingsSlots }: ModuleSettingsTabProps = {}) {
  const [config, setConfig] = useState<PoConfig | null>(null)
  const [capabilities, setCapabilities] = useState<PoCapabilities | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<SettingsTab>('buying')

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
    <div>
      {error && (
        <div className="alert alert-danger" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      <TabStrip
        items={PURCHASE_ORDER_SETTINGS_TABS.map((tab) => ({
          key: tab.id,
          label: tab.label,
          active: activeTab === tab.id,
          onClick: () => setActiveTab(tab.id),
        }))}
      />

      {activeTab === 'buying' && <div className="settings-masonry">
      <div className="card">
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

      <div className="card">
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

      <div className="card">
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

      <div className="card">
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

      <div className="card">
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

      </div>}

      {activeTab === 'documents' && <div className="settings-masonry">
      <div className="card">
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

      <div className="card">
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

      <div className="card">
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

      <div className="card">
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

      </div>}

      {activeTab === 'automation' && <div className="settings-masonry">
      <div className="card">
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

      <div className="card">
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

      <div className="card">
        <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-base)' }}>Sending those drafts by themselves</h3>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={config.autoSendEnabled}
            disabled={!config.autoDraftFromPaidOrders && !config.autoSendEnabled}
            onChange={(e) => set('autoSendEnabled', e.target.checked)}
          />
          Send automatic drafts by themselves, to the suppliers you have switched on
        </label>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          {config.autoDraftFromPaidOrders
            ? 'When on, a draft raised when a customer pays is emailed to its supplier once the wait below is up, exactly as if you had pressed Send - but only for a supplier you have ticked "Send their automatic drafts by themselves" on, under Suppliers. It goes out signed "Sent automatically" where a name would be.'
            : 'This sends the drafts made when a customer pays, so it needs "Draft the purchase orders as soon as a customer pays" switched on first.'}
        </p>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          What it does not do: send a draft anybody has changed (once somebody saves a change, a person sends it), send
          a change to an order already sent, approve anything that needs approving, or send anything it is not sure
          of - a customer order cancelled or refunded in the wait, a price that did not come from the supplier&rsquo;s
          current price list, a price of nothing, a supplier with no email address, or something on the customer
          order that could not be drafted. Each of those stays a draft, says why on the order, and you get one email
          about it. Drafts have often needed their prices changing before they went, which is why each supplier shows
          how many of theirs were changed: that is the number to watch.
        </p>
        <div style={{ marginTop: '0.75rem', maxWidth: 260 }}>
          <Field label="Wait before sending (minutes)">
            <input
              type="number"
              min={0}
              max={10080}
              style={input}
              value={config.autoSendHoldMinutes}
              onChange={(e) => set('autoSendHoldMinutes', Number(e.target.value))}
            />
          </Field>
        </div>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          Time for a refund, a change of mind, or somebody opening the draft and changing it. The check runs every half
          hour, so a draft goes up to thirty minutes after the wait is up.
        </p>
      </div>

      <div className="card">
        <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-base)' }}>Supplier paperwork by email</h3>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={config.inboundFilingEnabled}
            disabled={!capabilities?.hasInbox && !config.inboundFilingEnabled}
            onChange={(e) => set('inboundFilingEnabled', e.target.checked)}
          />
          File suppliers&rsquo; emailed proformas, acknowledgements and invoices by themselves
        </label>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          {capabilities?.hasInbox
            ? 'When on, a PDF arriving in the inbox from one of your suppliers is read within half an hour. A proforma or acknowledgement that quotes exactly one of your order numbers - an order to that same supplier, sent and still open - is filed on it, and their acknowledgement marks the order acknowledged. A VAT invoice whose total matches what is left to invoice becomes a draft bill for it, at the prices on your order, with their total beside it. A daily batch of invoices in one file is cut into one invoice per order.'
            : 'There is no unified inbox on this site, so no email reaches purchasing. Install the Unified Inbox module and this switches on.'}
        </p>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          What it does not do: pay anything, approve anything, send anything to anybody, or put anything in the books.
          Credit notes, anything it cannot place on exactly one order, and anything arriving at an odd moment - an
          invoice for an order you never sent - wait at the top of the Orders tab for you to decide. A proforma that
          comes to more or less than the order, beyond your price tolerance, or replaces one already on the order, is
          filed and you are emailed about it - and a replaced one cannot be marked paid until somebody says they have
          checked the bank details with the supplier. An invoice for part of the order, or for an extra charge, waits
          for you too. Mail from anybody who is not one of your suppliers is ignored.
        </p>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          Switching it off leaves anything already waiting on the Paperwork list as it is, and stops the emails about it.
        </p>
      </div>

      <div className="card">
        <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-base)' }}>Delivery tracking by email</h3>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={config.inboundTrackingEnabled}
            disabled={!capabilities?.hasInbox && !config.inboundTrackingEnabled}
            onChange={(e) => set('inboundTrackingEnabled', e.target.checked)}
          />
          Record a despatch when an email brings the tracking
        </label>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          {capabilities?.hasInbox
            ? 'When on, an email with delivery tracking in it - your supplier replying about an order, or the courier they booked writing to you - is recorded as a despatch on the order it is about, as soon as it arrives. It has to be certain which order: one of your order numbers from that supplier, the supplier’s own order number you already hold, or a parcel already on one of your despatches. Later emails about the same parcel - a delivery day, a timeslot, a better link - update that despatch rather than adding another.'
            : 'There is no unified inbox on this site, so no email reaches purchasing. Install the Unified Inbox module and this switches on.'}
        </p>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          Tracking matched only by the delivery postcode is never recorded by itself: it waits at the top of the Orders
          tab for you to say &ldquo;yes, that one&rdquo;. On an order going straight to a customer, the despatch is
          passed to the shop, which puts it on the customer&rsquo;s order if the shop has been told to (Shop settings,
          Notifications) - and nobody is emailed unless the shop has been told that too. Mail between your own
          colleagues is ignored.
        </p>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          A tracking link from somebody who is not your supplier is only kept when it goes to a known carrier (DPD, Royal
          Mail, Evri, UPS and the like, Multidrop, GFS) or to the sender&rsquo;s own website. Anything else is left out
          and only the parcel number kept, so a stranger&rsquo;s email cannot put a link of theirs in front of your
          customer. And somebody who is not your supplier is never, on their own, the first word that an order has gone:
          unless their email quotes the supplier&rsquo;s order number and the right delivery postcode, it waits for you
          at the top of the Orders tab.
        </p>
        <div style={{ marginTop: '0.75rem' }}>
          <Field label="Also trust tracking links to">
            <textarea
              rows={2}
              style={input}
              value={config.trackingLinkHosts}
              placeholder="tracking.yourcourier.example"
              onChange={(e) => set('trackingLinkHosts', e.target.value)}
            />
          </Field>
          <p style={{ ...muted, marginTop: '0.25rem' }}>
            One website per line, for a courier of yours whose emails link to a tracking site of their own on a
            different address. Leave it empty unless one of their links is being left out.
          </p>
        </div>
      </div>

      <div className="card">
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

      <div className="card">
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
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem' }}>
          <input
            type="checkbox"
            checked={config.portalInvoicesEnabled}
            disabled={!config.portalEnabled || !config.portalUploadsEnabled}
            onChange={(e) => set('portalInvoicesEnabled', e.target.checked)}
          />
          Let suppliers send you their VAT invoice through the link, ticking off what it covers
        </label>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          The invoice switch is the one to think hardest about, which is why it starts off. Everything else a
          supplier can do through that link is a message or a document; this one writes down what you owe them.
          Nothing is ever approved and nothing reaches your books on their say-so - what arrives is a draft with
          their invoice attached, priced at what your order said, for you to read. Once they have invoiced the lot
          the order goes to Pending close, and it stays there until you have approved every invoice on it.
        </p>
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

      </div>}

      <SettingsHeaderActions>
        <SettingsHeaderStatus message={saved ? 'Saved' : null} />
        <button className="btn btn-primary" onClick={save}>
          Save changes
        </button>
      </SettingsHeaderActions>
    </div>
  )
}
