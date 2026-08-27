import { getSessionFromCookie } from '@/lib/auth/session'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getPoConfig } from '@/modules/purchase-orders/lib/config'
import PurchaseOrdersNav from '@/modules/purchase-orders/components/admin/PurchaseOrdersNav'
import { CataloguesScreen } from '@/modules/purchase-orders/components/admin/CataloguesScreen'

export const metadata = { title: 'Catalogues — Purchase Orders — Admin' }

// Unlike Reorder, this tab needs no other module to be useful: a supplier's
// price list is a purchasing thing, and a site with no shop still buys from
// people who publish one. The shop only comes into it for two conveniences -
// picking one of shop's own catalogue bookmarks, and comparing the shop's
// products against the list - and both say so on the screen when it is absent.
export default async function CataloguesPage() {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getPoAccess(user)
  if (!access.canAccess) {
    return <div className="alert alert-danger">You do not have permission to see purchasing.</div>
  }

  const config = await getPoConfig()

  return (
    <div>
      <PurchaseOrdersNav />
      <CataloguesScreen enabled={config.supplierCatalogues} canEdit={access.canCatalogues} />
    </div>
  )
}
