import { hasPermissions, isAdmin } from '@/lib/permissions/check'
import type { SessionUser } from '@/lib/auth/session'

export type PoAccess = {
  isAdminUser: boolean
  canAccess: boolean
  canCreate: boolean
  canApprove: boolean
  canReceive: boolean
  canBills: boolean
  canCatalogues: boolean
  canSettings: boolean
}

const KEYS = [
  'purchase-orders.access',
  'purchase-orders.create',
  'purchase-orders.approve',
  'purchase-orders.receive',
  'purchase-orders.bills',
  'purchase-orders.catalogues',
  'purchase-orders.settings',
]

// One place that resolves the seven permission keys, so a screen and the route
// behind it can never disagree about who is allowed to do what. Admins hold all
// seven implicitly, exactly as they do everywhere else on the platform. One
// round trip, not seven - every admin page in this module asks.
export async function getPoAccess(user: SessionUser): Promise<PoAccess> {
  const isAdminUser = isAdmin(user)
  const granted = await hasPermissions(user, KEYS)
  const has = (key: string) => isAdminUser || granted[key] === true

  const create = has('purchase-orders.create')
  const approve = has('purchase-orders.approve')
  const receive = has('purchase-orders.receive')
  const bills = has('purchase-orders.bills')
  const catalogues = has('purchase-orders.catalogues')

  return {
    isAdminUser,
    // Anybody holding one of the working permissions can see the section, so a
    // role granted only "approve" is not left staring at a forbidden page.
    canAccess: has('purchase-orders.access') || create || approve || receive || bills || catalogues,
    canCreate: create,
    canApprove: approve,
    canReceive: receive,
    canBills: bills,
    // Keeping suppliers' price lists is its own job, and frequently somebody
    // else's: the person who imports the new April list is not necessarily the
    // person allowed to raise an order against it.
    canCatalogues: catalogues,
    canSettings: has('purchase-orders.settings'),
  }
}
