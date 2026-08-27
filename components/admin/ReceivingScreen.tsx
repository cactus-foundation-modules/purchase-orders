'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import type { PoAwaitingOrder, PoReceiptSummary } from '@/modules/purchase-orders/lib/types'
import { card, formatDay, formatWhen, input, muted, StatusBadge, table, td, tdRight, th, thRight } from './ui'

// The Receiving tab: what is still expected on the left of somebody's morning,
// and what has already turned up on the right of it.
//
// "Still expected" is judged off the lines rather than off the status - an order
// nobody got round to closing is not outstanding if everything on it arrived,
// and one marked received that later had a delivery deleted is outstanding
// again. The status badge is there to be read; the lines are what is counted.

export function ReceivingScreen({ canReceive }: { canReceive: boolean }) {
  const adminPath = useAdminPath()
  const base = `/${adminPath}/m/purchase-orders`

  const [awaiting, setAwaiting] = useState<PoAwaitingOrder[]>([])
  const [receipts, setReceipts] = useState<PoReceiptSummary[]>([])
  const [stockBlocked, setStockBlocked] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    const params = new URLSearchParams()
    if (search.trim()) params.set('search', search.trim())
    const res = await fetch(`/api/m/purchase-orders/admin/receipts?${params.toString()}`)
    if (res.ok) {
      const data = await res.json()
      setAwaiting(data.awaiting ?? [])
      setReceipts(data.receipts ?? [])
      setStockBlocked(data.stockBlocked ?? null)
    }
    setLoaded(true)
  }, [search])

  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh()
    }, 200)
    return () => clearTimeout(timer)
  }, [refresh])

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Receiving</h1>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <input
          style={{ ...input, width: 'auto', minWidth: 260 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Order number, supplier, delivery note"
          aria-label="Search deliveries"
        />
      </div>

      <div style={card}>
        <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>Still to come</h2>
        {loaded && awaiting.length === 0 && (
          <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
            Nothing outstanding. Everything ordered has turned up, which is a rare and pleasant state of affairs.
          </p>
        )}
        {awaiting.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Order</th>
                  <th style={th}>Supplier</th>
                  <th style={th}>Status</th>
                  <th style={th}>Expected</th>
                  <th style={th}>Wanted by</th>
                  <th style={thRight}>Lines short</th>
                  <th style={thRight}>Deliveries</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {awaiting.map((o) => (
                  <tr key={o.id}>
                    <td style={td}>
                      <Link href={`${base}/orders/${o.id}`} style={{ color: 'var(--color-primary)' }}>
                        {o.number}
                      </Link>
                    </td>
                    <td style={td}>{o.supplierName}</td>
                    <td style={td}>
                      <StatusBadge status={o.status} />
                    </td>
                    <td style={td}>{formatDay(o.expectedDate)}</td>
                    <td style={td}>{formatDay(o.requiredByDate)}</td>
                    <td style={tdRight}>{o.outstandingLines}</td>
                    <td style={tdRight}>{o.receiptCount}</td>
                    <td style={td}>
                      {canReceive && (
                        <Link href={`${base}/receiving/${o.id}`} className="btn btn-secondary btn-sm">
                          Book in
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {stockBlocked && (
          <p style={{ ...muted, marginTop: '0.75rem' }}>
            {stockBlocked} Deliveries are still recorded in full; only the stock count is left alone.
          </p>
        )}
      </div>

      <div style={card}>
        <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>What has turned up</h2>
        {loaded && receipts.length === 0 && (
          <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
            Nothing booked in yet.
          </p>
        )}
        {receipts.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Delivery</th>
                  <th style={th}>Order</th>
                  <th style={th}>Supplier</th>
                  <th style={th}>Received</th>
                  <th style={th}>Their note</th>
                  <th style={th}>Booked in by</th>
                  <th style={th}>Stock</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((r) => (
                  <tr key={r.id}>
                    <td style={td}>{r.number}</td>
                    <td style={td}>
                      <Link href={`${base}/orders/${r.orderId}`} style={{ color: 'var(--color-primary)' }}>
                        {r.orderNumber}
                      </Link>
                    </td>
                    <td style={td}>{r.supplierName}</td>
                    <td style={td}>{formatDay(r.receivedDate)}</td>
                    <td style={td}>{r.deliveryNoteRef ?? '—'}</td>
                    <td style={td}>
                      {r.receivedByName ?? 'Somebody'}
                      <div style={muted}>{formatWhen(r.createdAt)}</div>
                    </td>
                    <td style={td}>{r.stockApplied ? 'Added' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
