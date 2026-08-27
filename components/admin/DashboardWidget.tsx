import { headers } from 'next/headers'
import { poDashboardSummary } from '@/modules/purchase-orders/lib/reports'
import { formatMoney } from '@/modules/purchase-orders/lib/money'

// Contributed to the core `core.admin-dashboard-widgets` extension point.
// Server component, its own data fetch, permission-filtered by the manifest.
//
// Four figures and no more. A dashboard tile is read in about a second on the
// way to somewhere else, and the only thing worth putting on it is what would
// make somebody change where they were going: money promised and not received,
// something late, an invoice nobody has looked at.
//
// The figures come through the same `lib/reporting.ts` arithmetic the Reports
// tab uses, so the tile and the tab cannot disagree - a tile showing a different
// number from the screen it links to is worse than no tile at all.
export async function purchaseOrdersDashboardWidget() {
  const summary = await poDashboardSummary()
  const adminPath = (await headers()).get('x-cactus-admin-path') ?? ''

  const figures = [
    { value: String(summary.openOrders), label: summary.openOrders === 1 ? 'Order out' : 'Orders out' },
    { value: formatMoney(summary.committedValue, summary.baseCurrency), label: 'Committed' },
    { value: String(summary.overdueCount), label: 'Late' },
    { value: String(summary.billsToLookAt), label: 'Invoices to check' },
  ]

  return (
    <div className="card" style={{ padding: '1.25rem' }}>
      <h2 className="card-title" style={{ margin: '0 0 0.75rem' }}>Purchasing</h2>
      <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        {figures.map((figure) => (
          <div key={figure.label}>
            <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{figure.value}</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{figure.label}</div>
          </div>
        ))}
      </div>
      <a
        href={`/${adminPath}/m/purchase-orders/orders`}
        style={{ fontSize: 'var(--text-sm)', color: 'var(--color-primary)', textDecoration: 'none' }}
      >
        Open Purchasing →
      </a>
    </div>
  )
}
