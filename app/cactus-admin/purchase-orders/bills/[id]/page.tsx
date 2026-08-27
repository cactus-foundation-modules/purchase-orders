import { getSessionFromCookie } from '@/lib/auth/session'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import PurchaseOrdersNav from '@/modules/purchase-orders/components/admin/PurchaseOrdersNav'
import { BillScreen } from '@/modules/purchase-orders/components/admin/BillScreen'

export const metadata = { title: 'Bill — Purchase Orders — Admin' }

type Params = { params: Promise<{ id: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }

// `bills/new` and `bills/new?orderId=...` are both served by this page rather
// than by a sibling of their own. resolveModulePage walks the generated loaders
// in sorted order and `[id]` sorts before any literal sibling, so a
// bills/new/page.tsx would never be reached - the orders and returns screens do
// the same thing for the same reason.
export default async function BillPage({ params, searchParams }: Params) {
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

  if (isNew && !access.canBills) {
    return <div className="alert alert-danger">You do not have permission to enter a supplier bill.</div>
  }

  return (
    <div>
      <PurchaseOrdersNav />
      <BillScreen billId={isNew ? null : id} orderId={orderId} canBills={access.canBills} />
    </div>
  )
}
