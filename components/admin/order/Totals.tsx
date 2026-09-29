'use client'

import { chargedSubtotal, type orderTotals } from '@/modules/purchase-orders/lib/totals'
import { Money, table, td, tdRight } from '../ui'

// Subtotal, tax, total - nothing else. Carriage, surcharge and an order
// discount are line items (rows under the lines, or their own boxes on the
// edit form), and the subtotal counts them.
export function Totals({ totals, currency }: { totals: ReturnType<typeof orderTotals>; currency: string }) {
  return (
    <table style={{ ...table, marginTop: '1rem', maxWidth: 320, marginLeft: 'auto' }}>
      <tbody>
        <tr>
          <td style={td}>Subtotal</td>
          <td style={tdRight}>
            <Money value={chargedSubtotal(totals)} currency={currency} />
          </td>
        </tr>
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
