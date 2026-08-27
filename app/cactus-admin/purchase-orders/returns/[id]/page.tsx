import { getSessionFromCookie } from '@/lib/auth/session'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import PurchaseOrdersNav from '@/modules/purchase-orders/components/admin/PurchaseOrdersNav'
import { ReturnScreen } from '@/modules/purchase-orders/components/admin/ReturnScreen'

export const metadata = { title: 'Return — Purchase Orders — Admin' }

type Params = { params: Promise<{ id: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }

// `returns/new?orderId=...` is served by this page rather than by a sibling of
// its own. resolveModulePage walks the generated loaders in sorted order and
// `[id]` sorts before any literal sibling, so a returns/new/page.tsx would never
// be reached - the orders screen does the same thing for the same reason.
export default async function ReturnPage({ params, searchParams }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getPoAccess(user)
  if (!access.canAccess) {
    return <div className="alert alert-danger">You do not have permission to see purchasing.</div>
  }

  const { id } = await params
  const query = (await searchParams) ?? {}
  const isNew = id === 'new'
  const orderId = typeof query.orderId === 'string' ? query.orderId : null

  if (isNew && !orderId) {
    return (
      <div>
        <PurchaseOrdersNav />
        <div className="alert alert-warning">
          A return has to be raised against a purchase order. Open the order and use &ldquo;Send something back&rdquo;.
        </div>
      </div>
    )
  }
  if (isNew && !access.canReceive) {
    return <div className="alert alert-danger">You do not have permission to raise a return.</div>
  }

  return (
    <div>
      <PurchaseOrdersNav />
      <ReturnScreen
        returnId={isNew ? null : id}
        orderId={orderId}
        canReceive={access.canReceive}
        canBills={access.canBills}
      />
    </div>
  )
}
