'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { PO_STATUSES, PO_STATUS_LABELS, type PoOrderSummary, type PoStatus } from '@/modules/purchase-orders/lib/types'
import { formatDay, input, Money, OrderStatusBadge, table, td, tdRight, th, thRight } from './ui'

type StatusFilter = PoStatus | 'ALL' | 'OPEN'

export function OrdersScreen({ canCreate }: { canCreate: boolean }) {
  const adminPath = useAdminPath()
  const base = `/${adminPath}/m/purchase-orders/orders`

  const [orders, setOrders] = useState<PoOrderSummary[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<StatusFilter>('OPEN')
  const [search, setSearch] = useState('')
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    const params = new URLSearchParams({ status })
    if (search.trim()) params.set('search', search.trim())
    const res = await fetch(`/api/m/purchase-orders/admin/orders?${params.toString()}`)
    if (res.ok) {
      const data = await res.json()
      setOrders(data.orders ?? [])
      setTotal(data.total ?? 0)
    }
    setLoaded(true)
  }, [status, search])

  // Debounced so typing a supplier name is not one request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh()
    }, 200)
    return () => clearTimeout(timer)
  }, [refresh])

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 className="page-title">Purchase orders</h1>
        {canCreate && (
          <Link href={`${base}/new`} className="btn btn-primary">
            New purchase order
          </Link>
        )}
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <select
          style={{ ...input, width: 'auto' }}
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          aria-label="Filter by status"
        >
          <option value="OPEN">Still open</option>
          <option value="ALL">Everything</option>
          {PO_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PO_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <input
          style={{ ...input, width: 'auto', minWidth: 240 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Order number, supplier, note"
          aria-label="Search purchase orders"
        />
      </div>

      {loaded && orders.length === 0 && (
        <p style={{ color: 'var(--color-text-secondary)' }}>
          {status === 'OPEN'
            ? 'Nothing outstanding. Either everything has turned up, or nobody has ordered anything yet.'
            : 'No purchase orders match that.'}
        </p>
      )}

      {orders.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Number</th>
                <th style={th}>Supplier</th>
                <th style={th}>Status</th>
                <th style={th}>Raised</th>
                <th style={th}>Wanted by</th>
                <th style={th}>Expected</th>
                <th style={thRight}>Lines</th>
                <th style={thRight}>Total</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td style={td}>
                    <Link href={`${base}/${o.id}`} style={{ color: 'var(--color-primary)' }}>
                      {o.number}
                    </Link>
                    {o.revision > 1 && <span style={{ marginLeft: '0.375rem' }}>Rev {o.revision}</span>}
                  </td>
                  <td style={td}>{o.supplierName}</td>
                  <td style={td}>
                    <OrderStatusBadge order={o} />
                  </td>
                  <td style={td}>{formatDay(o.raisedDate)}</td>
                  <td style={td}>{formatDay(o.requiredByDate)}</td>
                  <td style={td}>{formatDay(o.expectedDate)}</td>
                  <td style={tdRight}>{o.lineCount}</td>
                  <td style={tdRight}>
                    <Money value={o.total} currency={o.currency} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ marginTop: '0.75rem', color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
            {orders.length === total ? `${total} order${total === 1 ? '' : 's'}.` : `Showing ${orders.length} of ${total}.`}
          </p>
        </div>
      )}
    </div>
  )
}
