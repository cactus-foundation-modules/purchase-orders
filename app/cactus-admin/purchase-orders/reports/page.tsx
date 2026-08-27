import { getSessionFromCookie } from '@/lib/auth/session'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import PurchaseOrdersNav from '@/modules/purchase-orders/components/admin/PurchaseOrdersNav'
import { ReportsScreen } from '@/modules/purchase-orders/components/admin/ReportsScreen'

export const metadata = { title: 'Reports — Purchase Orders — Admin' }

// The one tab that needs nothing else installed. Committed spend, late orders,
// the two accruals and what is being spent with whom all come out of this
// module's own tables - a shop makes the lines easier to type and the books put
// names on the categories, and neither is required for any of it to be true.
export default async function ReportsPage() {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getPoAccess(user)
  if (!access.canAccess) {
    return <div className="alert alert-danger">You do not have permission to see purchasing.</div>
  }

  return (
    <div>
      <PurchaseOrdersNav />
      <ReportsScreen />
    </div>
  )
}
