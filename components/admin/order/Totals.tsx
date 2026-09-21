'use client'

import type { orderTotals } from '@/modules/purchase-orders/lib/totals'
import { Money, table, td, tdRight } from '../ui'

export function Totals({ totals, currency }: { totals: ReturnType<typeof orderTotals>; currency: string }) {
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
