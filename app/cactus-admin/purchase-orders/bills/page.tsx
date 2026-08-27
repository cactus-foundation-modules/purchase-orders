import { getSessionFromCookie } from '@/lib/auth/session'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import PurchaseOrdersNav from '@/modules/purchase-orders/components/admin/PurchaseOrdersNav'
import { NotYet } from '@/modules/purchase-orders/components/admin/ui'

export const metadata = { title: 'Bills — Purchase Orders — Admin' }

export default async function BillsPage() {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getPoAccess(user)
  if (!access.canAccess) {
    return <div className="alert alert-danger">You do not have permission to see purchasing.</div>
  }

  return (
    <div>
      <PurchaseOrdersNav />
      <div className="page-header"><h1 className="page-title">Supplier bills</h1></div>
      <NotYet
        title="Supplier bills arrive in a later release"
        message="This is where a supplier's invoice gets checked against what you ordered and what turned up, before anybody agrees to pay it."
      />
    </div>
  )
}
