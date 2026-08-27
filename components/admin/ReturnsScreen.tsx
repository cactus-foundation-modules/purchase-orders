'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import type { PoReturnSummary } from '@/modules/purchase-orders/lib/types'
import { creditOutstanding } from '@/modules/purchase-orders/lib/returning'
import {
  card, formatDay, formatWhen, input, Money, muted, ReturnStatusBadge, table, td, tdRight, th, thRight,
} from './ui'

// The Returns tab: what has gone back, and how much of the money has come back.
//
// The second half is the whole point. Raising a return is easy and everybody
// does it; noticing six months later that four of them were never credited is
// the thing this screen exists to stop, so what is outstanding is at the top in
// words rather than buried in a column somebody has to add up.

export function ReturnsScreen({ canReceive }: { canReceive: boolean }) {
  const adminPath = useAdminPath()
  const base = `/${adminPath}/m/purchase-orders`

  const [returns, setReturns] = useState<PoReturnSummary[]>([])
  const [credit, setCredit] = useState<{ count: number; expected: string }>({ count: 0, expected: '0.00' })
  const [stockBlocked, setStockBlocked] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [openOnly, setOpenOnly] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(() => {
    const params = new URLSearchParams()
    if (search.trim()) params.set('search', search.trim())
    if (openOnly) params.set('open', '1')
    return fetch(`/api/m/purchase-orders/admin/returns?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          setReturns(data.returns ?? [])
          setCredit(data.credit ?? { count: 0, expected: '0.00' })
          setStockBlocked(data.stockBlocked ?? null)
        }
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [search, openOnly])

  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh()
    }, 200)
    return () => clearTimeout(timer)
  }, [refresh])

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Returns</h1>
      </div>

      <div style={card}>
        {credit.count === 0 ? (
          <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
            Nobody owes you a credit. Either nothing has gone back, or everything that did has been paid for.
          </p>
        ) : (
          <p style={{ margin: 0 }}>
            <strong>
              <Money value={credit.expected} />
            </strong>{' '}
            still to come back on {credit.count === 1 ? 'one return' : `${credit.count} returns`}.
          </p>
        )}
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          style={{ ...input, width: 'auto', minWidth: 260 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Return number, order, supplier, credit reference"
          aria-label="Search returns"
        />
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
          Only the ones still owed
        </label>
      </div>

      <div style={card}>
        {loaded && returns.length === 0 && (
          <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
            Nothing has gone back yet. Open a purchase order and use &ldquo;Send something back&rdquo; when it needs to.
          </p>
        )}
        {returns.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Return</th>
                  <th style={th}>Order</th>
                  <th style={th}>Supplier</th>
                  <th style={th}>Raised</th>
                  <th style={th}>Status</th>
                  <th style={thRight}>Claimed</th>
                  <th style={thRight}>Credited</th>
                  <th style={thRight}>Still owed</th>
                  <th style={th}>Their credit</th>
                </tr>
              </thead>
              <tbody>
                {returns.map((r) => (
                  <tr key={r.id}>
                    <td style={td}>
                      <Link href={`${base}/returns/${r.id}`} style={{ color: 'var(--color-primary)' }}>
                        {r.number}
                      </Link>
                      <div style={muted}>{formatWhen(r.createdAt)}</div>
                    </td>
                    <td style={td}>
                      <Link href={`${base}/orders/${r.orderId}`} style={{ color: 'var(--color-primary)' }}>
                        {r.orderNumber}
                      </Link>
                    </td>
                    <td style={td}>{r.supplierName}</td>
                    <td style={td}>{formatDay(r.raisedDate)}</td>
                    <td style={td}>
                      <ReturnStatusBadge status={r.status} />
                    </td>
                    <td style={tdRight}>
                      <Money value={r.creditExpected} currency={r.currency} />
                    </td>
                    <td style={tdRight}>
                      <Money value={r.creditReceived} currency={r.currency} />
                    </td>
                    <td style={tdRight}>
                      <Money value={creditOutstanding(r.creditExpected, r.creditReceived)} currency={r.currency} />
                    </td>
                    <td style={td}>{r.creditRef ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {stockBlocked && returns.length > 0 && (
          <p style={{ ...muted, marginTop: '0.75rem' }}>
            {stockBlocked} Returns are still recorded in full; only the stock count is left alone.
          </p>
        )}
        {!canReceive && (
          <p style={{ ...muted, marginTop: '0.75rem' }}>You do not have permission to raise a return.</p>
        )}
      </div>
    </div>
  )
}
