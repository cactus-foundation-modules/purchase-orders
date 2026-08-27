'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

// The button on a customer order, and the only interactive part of the panel
// around it. Everything else that panel shows is server-rendered, so a refresh
// after this succeeds redraws the list of orders raised without this component
// having to know anything about them.

type Raised = { id: string; number: string; supplierName: string }
type Result = { ordersCreated: Raised[]; refused: string | null }

export function RaisePurchaseOrders({ orderId }: { orderId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function raise() {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch('/api/m/purchase-orders/admin/orders/from-shop-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId }),
      })
      const data = (await res.json().catch(() => ({}))) as Partial<Result> & { error?: string }
      if (!res.ok) {
        setMessage(data.error ?? 'That did not work.')
        return
      }
      if (data.refused) {
        setMessage(data.refused)
      } else {
        const count = data.ordersCreated?.length ?? 0
        setMessage(count === 1 ? 'One draft purchase order raised.' : `${count} draft purchase orders raised.`)
      }
      router.refresh()
    } catch {
      setMessage('That did not work.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: '0.5rem' }}>
      <div>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={raise}>
          {busy ? 'Raising…' : 'Raise purchase orders'}
        </button>
      </div>
      {message && <p style={{ margin: 0, fontSize: '0.8125rem' }}>{message}</p>}
    </div>
  )
}
