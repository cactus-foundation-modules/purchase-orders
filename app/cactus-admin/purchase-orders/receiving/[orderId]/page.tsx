import { getSessionFromCookie } from '@/lib/auth/session'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getPoConfig } from '@/modules/purchase-orders/lib/config'
import { stockBlockedReason } from '@/modules/purchase-orders/lib/inventory'
import PurchaseOrdersNav from '@/modules/purchase-orders/components/admin/PurchaseOrdersNav'
import { BookInScreen } from '@/modules/purchase-orders/components/admin/BookInScreen'

export const metadata = { title: 'Book in — Purchase Orders — Admin' }

type Params = { params: Promise<{ orderId: string }> }

// Whether stock is even offered is decided here, on the server, off the two
// facts that matter: the owner asked for it, and something on this site keeps
// counts. The screen never guesses, and the route checks again anyway.
export default async function BookInPage({ params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getPoAccess(user)
  if (!access.canAccess) {
    return <div className="alert alert-danger">You do not have permission to see purchasing.</div>
  }

  const { orderId } = await params
  const [config, blocked] = await Promise.all([getPoConfig(), stockBlockedReason()])

  return (
    <div>
      <PurchaseOrdersNav />
      <BookInScreen
        orderId={orderId}
        canReceive={access.canReceive}
        stockOffered={blocked === null}
        stockBlockedReason={blocked}
        overReceiptTolerancePercent={config.overReceiptTolerancePercent}
      />
    </div>
  )
}
