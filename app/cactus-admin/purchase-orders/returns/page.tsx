import { getSessionFromCookie } from '@/lib/auth/session'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import PurchaseOrdersNav from '@/modules/purchase-orders/components/admin/PurchaseOrdersNav'
import { NotYet } from '@/modules/purchase-orders/components/admin/ui'

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
      <div className="page-header"><h1 className="page-title">Returns</h1></div>
      <NotYet
        title="Sending things back arrives in a later release"
        message="This is where you will raise a return against an order, print a note for the courier, and keep track of the credit you are owed until it turns up."
      />
    </div>
  )
}
