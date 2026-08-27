import { getSessionFromCookie } from '@/lib/auth/session'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import PurchaseOrdersNav from '@/modules/purchase-orders/components/admin/PurchaseOrdersNav'
import { BillsScreen } from '@/modules/purchase-orders/components/admin/BillsScreen'

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
      <BillsScreen canBills={access.canBills} />
    </div>
  )
}
