'use client'

import { useEffect, useState } from 'react'
import type { CatalogueProduct } from '@/modules/purchase-orders/lib/types'
import { card, input, linkButton, Money, muted, table, td, tdRight, th, thRight } from '../ui'
import type { LineForm } from './form'

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

export function LineEditor({ lines, currency, lineTotals, hasCatalogue, supplierId, onChange, onRemove, onAdd }: LineEditorProps) {
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
