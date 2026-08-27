import { getSessionFromCookie } from '@/lib/auth/session'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getCapabilities } from '@/modules/purchase-orders/lib/capabilities'
import PurchaseOrdersNav from '@/modules/purchase-orders/components/admin/PurchaseOrdersNav'
import { ReorderScreen } from '@/modules/purchase-orders/components/admin/ReorderScreen'
import { NotYet } from '@/modules/purchase-orders/components/admin/ui'

export const metadata = { title: 'Reorder — Purchase Orders — Admin' }

// The one tab whose usefulness genuinely depends on another module: reordering
// against stock levels needs stock levels. It still appears, and still says why.
export default async function ReorderPage() {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getPoAccess(user)
  if (!access.canAccess) {
    return <div className="alert alert-danger">You do not have permission to see purchasing.</div>
  }

  const { hasCatalogue } = await getCapabilities()

  return (
    <div>
      <PurchaseOrdersNav />
      {hasCatalogue ? (
        <ReorderScreen canEdit={access.canCreate} />
      ) : (
        <>
          <div className="page-header">
            <h1 className="page-title">Reorder</h1>
          </div>
          <NotYet
            title="Reordering needs a product catalogue"
            message="This works out what to buy from what you have left, so it needs something keeping count. Install the Shop module and this tab wakes up. Everything else here works perfectly well without it."
          />
        </>
      )}
    </div>
  )
}
