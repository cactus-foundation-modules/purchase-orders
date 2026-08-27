import { getSessionFromCookie } from '@/lib/auth/session'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getPoConfig } from '@/modules/purchase-orders/lib/config'
import { getCapabilities } from '@/modules/purchase-orders/lib/capabilities'
import PurchaseOrdersNav from '@/modules/purchase-orders/components/admin/PurchaseOrdersNav'
import { OrderScreen } from '@/modules/purchase-orders/components/admin/OrderScreen'

export const metadata = { title: 'Purchase Order — Admin' }

type Params = { params: Promise<{ id: string }> }

// "new" is the create screen. It shares this route rather than having one of its
// own because the module router matches "[id]" before any literal sibling, so a
// separate orders/new page would simply never be reached.
export default async function PurchaseOrderPage({ params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getPoAccess(user)
  if (!access.canAccess) {
    return <div className="alert alert-danger">You do not have permission to see purchasing.</div>
  }

  const { id } = await params
  const isNew = id === 'new'
  if (isNew && !access.canCreate) {
    return <div className="alert alert-danger">You do not have permission to raise a purchase order.</div>
  }

  const [config, capabilities] = await Promise.all([getPoConfig(), getCapabilities()])

  return (
    <div>
      <PurchaseOrdersNav />
      <OrderScreen
        orderId={isNew ? null : id}
        access={access}
        hasCatalogue={capabilities.hasCatalogue}
        defaults={{
          baseCurrency: config.baseCurrency,
          defaultShipToKind: config.defaultShipToKind,
          warehouseName: config.warehouse.name,
          warehouseContact: config.warehouse.contact,
          warehousePhone: config.warehouse.phone,
          warehouseLine1: config.warehouse.address.line1,
          warehouseLine2: config.warehouse.address.line2,
          warehouseCity: config.warehouse.address.city,
          warehouseRegion: config.warehouse.address.region,
          warehousePostcode: config.warehouse.address.postcode,
          warehouseCountry: config.warehouse.address.country,
          warehouseInstructions: config.warehouse.instructions,
          approvalRequired: config.approvalRequired,
          approvalThreshold: config.approvalThreshold,
        }}
      />
    </div>
  )
}
