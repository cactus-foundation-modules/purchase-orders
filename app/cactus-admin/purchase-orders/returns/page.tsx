import { getSessionFromCookie } from '@/lib/auth/session'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import PurchaseOrdersNav from '@/modules/purchase-orders/components/admin/PurchaseOrdersNav'
import { ReturnsScreen } from '@/modules/purchase-orders/components/admin/ReturnsScreen'

export const metadata = { title: 'Returns — Purchase Orders — Admin' }

export default async function ReturnsPage() {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getPoAccess(user)
  if (!access.canAccess) {
    return <div className="alert alert-danger">You do not have permission to see purchasing.</div>
  }

  return (
    <div>
      <PurchaseOrdersNav />
      <ReturnsScreen canReceive={access.canReceive} />
    </div>
  )
}
