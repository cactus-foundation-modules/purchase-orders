'use client'

import { input, linkButton, table, td, th, thRight } from './ui'

// The row editor for a supplier's sale-surcharge categories - a much smaller
// version of order/LineEditor.tsx's add/remove-row pattern: two text boxes
// per row (what the category is called, what it costs per unit), no catalogue
// search, because a surcharge rate is not a product to look up.

export type SurchargeRateRow = { key: string; category: string; ratePerUnit: string }

let counter = 0
export function newSurchargeRate(patch: Partial<SurchargeRateRow> = {}): SurchargeRateRow {
  counter += 1
  return { key: `rate-${counter}`, category: '', ratePerUnit: '', ...patch }
}

type SupplierSurchargeRatesProps = {
  rates: SurchargeRateRow[]
  onChange: (key: string, patch: Partial<SurchargeRateRow>) => void
  onRemove: (key: string) => void
  onAdd: () => void
}

export function SupplierSurchargeRates({ rates, onChange, onRemove, onAdd }: SupplierSurchargeRatesProps) {
  return (
    <div>
      {rates.length > 0 && (
        <div style={{ overflowX: 'auto', marginBottom: '0.5rem' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Category</th>
                <th style={thRight}>Rate per unit</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {rates.map((rate, index) => (
                <tr key={rate.key}>
                  <td style={td}>
                    <input
                      style={input}
                      value={rate.category}
                      onChange={(e) => onChange(rate.key, { category: e.target.value })}
                      placeholder="e.g. Seating"
                      aria-label={`Category ${index + 1}`}
                    />
                  </td>
                  <td style={td}>
                    <input
                      style={{ ...input, textAlign: 'right' }}
                      value={rate.ratePerUnit}
                      onChange={(e) => onChange(rate.key, { ratePerUnit: e.target.value })}
                      placeholder="e.g. 6.00"
                      aria-label={`Rate ${index + 1}`}
                    />
                  </td>
                  <td style={td}>
                    <button type="button" onClick={() => onRemove(rate.key)} style={{ ...linkButton, color: 'var(--color-danger)' }}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" className="btn btn-secondary" onClick={onAdd}>
        Add a category rate
      </button>
    </div>
  )
}
