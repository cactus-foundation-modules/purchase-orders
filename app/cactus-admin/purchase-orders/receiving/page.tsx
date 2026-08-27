import { getSessionFromCookie } from '@/lib/auth/session'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import PurchaseOrdersNav from '@/modules/purchase-orders/components/admin/PurchaseOrdersNav'
import { NotYet } from '@/modules/purchase-orders/components/admin/ui'

export const metadata = { title: 'Receiving — Purchase Orders — Admin' }

export default async function ReceivingPage() {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getPoAccess(user)
  if (!access.canAccess) {
    return <div className="alert alert-danger">You do not have permission to see purchasing.</div>
  }

  return (
    <div>
      <PurchaseOrdersNav />
      <div className="page-header"><h1 className="page-title">Receiving</h1></div>
      <NotYet
        title="Booking goods in arrives in the next release"
        message="This is where you will tick off what actually turned up against what you ordered, note anything damaged or short, and - if you keep stock counts - have them go up on their own."
      />
    </div>
  )
}
