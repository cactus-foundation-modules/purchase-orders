'use client'

import type { Dispatch, SetStateAction } from 'react'
import type { orderTotals } from '@/modules/purchase-orders/lib/totals'
import type { PoSupplier } from '@/modules/purchase-orders/lib/types'
import { card, Field, input, Money, muted } from '../ui'
import { newLine, type Form, type LineForm } from './form'
import { LineEditor } from './LineEditor'
import { Totals } from './Totals'

type Props = {
  form: Form
  setForm: Dispatch<SetStateAction<Form>>
  suppliers: PoSupplier[]
  totals: ReturnType<typeof orderTotals>
  hasCatalogue: boolean
}

const heading = { margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' } as const
const grid = { display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))' } as const

/**
 * The order, as a form. No buttons of its own: Save and Cancel are in the bar at
 * the top with everything else, where they stay in reach however long the list
 * of lines gets.
 *
 * In the order somebody fills it in. Who and when, then what, then what it comes
 * to, then where it is going, then anything to say about it. Currency and tax
 * come last because on nearly every order they are already right.
 */
export function OrderEditForm({ form, setForm, suppliers, totals, hasCatalogue }: Props) {
  const supplier = suppliers.find((s) => s.id === form.supplierId) ?? null
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))

  function setLine(key: string, patch: Partial<LineForm>) {
    setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }))
  }

  function removeLine(key: string) {
    setForm((f) => ({
      ...f,
      lines: f.lines.length > 1 ? f.lines.filter((l) => l.key !== key) : f.lines,
    }))
  }

  // Shown only where it means something: a rate of 1 between a currency and
  // itself is not a decision anybody needs asking about. An order already
  // carrying some other rate still shows it, so it can be seen and put right.
  const foreign = form.currency !== form.baseCurrency || (form.fxRate !== '' && Number(form.fxRate) !== 1)

  return (
    <>
      <div style={card}>
        <h2 style={heading}>Supplier and dates</h2>
        <div style={grid}>
          <Field label="Supplier">
            <select style={input} value={form.supplierId} onChange={(e) => set({ supplierId: e.target.value })}>
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
          <Field label="Wanted by">
            <input type="date" style={input} value={form.requiredByDate} onChange={(e) => set({ requiredByDate: e.target.value })} />
          </Field>
          <Field label="Expected">
            <input type="date" style={input} value={form.expectedDate} onChange={(e) => set({ expectedDate: e.target.value })} />
          </Field>
          <Field label="Payment terms">
            <input
              style={input}
              value={form.paymentTerms}
              onChange={(e) => set({ paymentTerms: e.target.value })}
              placeholder={supplier?.paymentTerms ?? ''}
            />
          </Field>
          <Field label="Delivery terms">
            <input style={input} value={form.deliveryTerms} onChange={(e) => set({ deliveryTerms: e.target.value })} />
          </Field>
        </div>

        {supplier?.minimumOrderValue && Number(totals.subtotal) < Number(supplier.minimumOrderValue) && (
          <p style={{ ...muted, margin: '0.75rem 0 0' }}>
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
        <h2 style={heading}>What it comes to</h2>
        {/* The two boxes that move the total sit beside the total they move. */}
        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div style={{ ...grid, flex: '1 1 320px', maxWidth: 480 }}>
            <Field label="Order discount" hint="An amount off the whole order, not a percentage.">
              <input style={input} inputMode="decimal" value={form.discountAmount} onChange={(e) => set({ discountAmount: e.target.value })} />
            </Field>
            <Field label="Carriage" hint="What the supplier charges you for delivery.">
              <input style={input} inputMode="decimal" value={form.carriageAmount} onChange={(e) => set({ carriageAmount: e.target.value })} />
            </Field>
            <Field label="Surcharge" hint="A supplier's sale-clearance surcharge, where one applies.">
              <input style={input} inputMode="decimal" value={form.surchargeAmount} onChange={(e) => set({ surchargeAmount: e.target.value })} />
            </Field>
          </div>
          <div style={{ flex: '0 1 320px' }}>
            <Totals totals={totals} currency={form.currency} />
          </div>
        </div>
      </div>

      <div style={card}>
        <h2 style={heading}>Deliver to</h2>
        <div style={grid}>
          <Field label="Where" hint="Straight to the customer means it never comes to you.">
            <select style={input} value={form.shipToKind} onChange={(e) => set({ shipToKind: e.target.value as Form['shipToKind'] })}>
              <option value="WAREHOUSE">Our own address</option>
              <option value="CUSTOMER">Straight to the customer</option>
              <option value="OTHER">Somewhere else</option>
            </select>
          </Field>
          <Field label="Name">
            <input style={input} value={form.shipToName} onChange={(e) => set({ shipToName: e.target.value })} />
          </Field>
          <Field label="Contact">
            <input style={input} value={form.shipToContact} onChange={(e) => set({ shipToContact: e.target.value })} />
          </Field>
          <Field label="Phone">
            <input style={input} value={form.shipToPhone} onChange={(e) => set({ shipToPhone: e.target.value })} />
          </Field>
          <Field label="Line 1">
            <input style={input} value={form.shipToLine1} onChange={(e) => set({ shipToLine1: e.target.value })} />
          </Field>
          <Field label="Line 2">
            <input style={input} value={form.shipToLine2} onChange={(e) => set({ shipToLine2: e.target.value })} />
          </Field>
          <Field label="Town or city">
            <input style={input} value={form.shipToCity} onChange={(e) => set({ shipToCity: e.target.value })} />
          </Field>
          <Field label="County">
            <input style={input} value={form.shipToRegion} onChange={(e) => set({ shipToRegion: e.target.value })} />
          </Field>
          <Field label="Postcode">
            <input style={input} value={form.shipToPostcode} onChange={(e) => set({ shipToPostcode: e.target.value })} />
          </Field>
          <Field label="Country">
            <input style={input} value={form.shipToCountry} onChange={(e) => set({ shipToCountry: e.target.value })} />
          </Field>
        </div>
        <div style={{ marginTop: '0.75rem' }}>
          <Field label="Delivery instructions" hint="These print on the order.">
            <textarea rows={2} style={input} value={form.shipToInstructions} onChange={(e) => set({ shipToInstructions: e.target.value })} />
          </Field>
        </div>
      </div>

      <div style={card}>
        <h2 style={heading}>Notes</h2>
        <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))' }}>
          <Field label="For the supplier" hint="These print on the order.">
            <textarea rows={4} style={input} value={form.notesSupplier} onChange={(e) => set({ notesSupplier: e.target.value })} />
          </Field>
          <Field label="For us" hint="These never leave the building.">
            <textarea rows={4} style={input} value={form.notesInternal} onChange={(e) => set({ notesInternal: e.target.value })} />
          </Field>
        </div>
      </div>

      <div style={{ ...card, marginBottom: '2rem' }}>
        <h2 style={heading}>Currency and tax</h2>
        <div style={grid}>
          <Field label="Currency">
            <input style={input} maxLength={3} value={form.currency} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} />
          </Field>
          {foreign && (
            <Field
              label="Exchange rate"
              hint={`${form.baseCurrency} per 1 ${form.currency}. Your own expectation - the supplier's invoice carries the rate the books use.`}
            >
              <input style={input} inputMode="decimal" value={form.fxRate} onChange={(e) => set({ fxRate: e.target.value })} />
            </Field>
          )}
          <Field label="Prices include tax">
            <select style={input} value={form.taxMode} onChange={(e) => set({ taxMode: e.target.value as Form['taxMode'] })}>
              <option value="EXCLUSIVE">No - add tax on top</option>
              <option value="INCLUSIVE">Yes - tax is already in the price</option>
            </select>
          </Field>
        </div>
      </div>
    </>
  )
}
