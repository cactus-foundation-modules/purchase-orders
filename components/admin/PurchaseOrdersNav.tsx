'use client'

import { usePathname } from 'next/navigation'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { TabStrip } from '@/components/admin/TabStrip'

// One sidebar link, eight tabs behind it. The tabs whose screens arrive in a
// later release are here from the start, each with an honest empty state saying
// so - a tab that appears later reads as a surprise, and one that is missing
// reads as a module that cannot do the job.
//
// Catalogues is here whether or not price lists are switched on, for that same
// reason: the tab says it is switched off and where the switch is, which beats
// a tab that materialises the day somebody flicks it.

const TABS = [
  { label: 'Orders', segment: 'orders' },
  { label: 'Receiving', segment: 'receiving' },
  { label: 'Bills', segment: 'bills' },
  { label: 'Returns', segment: 'returns' },
  { label: 'Suppliers', segment: 'suppliers' },
  { label: 'Catalogues', segment: 'catalogues' },
  { label: 'Reorder', segment: 'reorder' },
  { label: 'Reports', segment: 'reports' },
]

export default function PurchaseOrdersNav() {
  const pathname = usePathname()
  const adminPath = useAdminPath()
  const base = `/${adminPath}/m/purchase-orders`

  return (
    <TabStrip
      style={{ marginBottom: '1.5rem' }}
      items={TABS.map((tab) => {
        const href = `${base}/${tab.segment}`
        return { key: tab.segment, label: tab.label, href, active: !!pathname?.startsWith(href) }
      })}
    />
  )
}
