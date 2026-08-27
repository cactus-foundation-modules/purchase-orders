import { getSessionFromCookie } from '@/lib/auth/session'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import PurchaseOrdersNav from '@/modules/purchase-orders/components/admin/PurchaseOrdersNav'
import { NotYet } from '@/modules/purchase-orders/components/admin/ui'

export const metadata = { title: 'Reports — Purchase Orders — Admin' }

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
      <div className="page-header"><h1 className="page-title">Reports</h1></div>
      <NotYet
        title="Purchasing reports arrive in a later release"
        message="What you have committed to but not yet received, what you spend with whom, what is overdue, and what has arrived but never been invoiced."
      />
    </div>
  )
}
