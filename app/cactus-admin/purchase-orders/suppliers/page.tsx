import { getSessionFromCookie } from '@/lib/auth/session'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import PurchaseOrdersNav from '@/modules/purchase-orders/components/admin/PurchaseOrdersNav'
import { SuppliersScreen } from '@/modules/purchase-orders/components/admin/SuppliersScreen'

export const metadata = { title: 'Purchasing Suppliers — Admin' }

export default async function PurchaseOrderSuppliersPage() {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getPoAccess(user)
  if (!access.canAccess) {
    return <div className="alert alert-danger">You do not have permission to see purchasing.</div>
  }

  return (
    <div>
      <PurchaseOrdersNav />
      <SuppliersScreen canEdit={access.canCreate} />
    </div>
  )
}
