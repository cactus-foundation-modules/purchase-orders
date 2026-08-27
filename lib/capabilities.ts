import { prisma } from '@/lib/db/prisma'
import { getInstalledManifests } from '@/lib/modules/live-status'
import { modulePublicExtensionPointComponents } from '@/lib/modules/extension-points.public'

// The ONE place that answers "what else is on this site?".
//
// Purchase Orders is standalone: it works with a shop, with the books, with
// both, or with neither. Every screen and every route degrades off the three
// booleans below, and nothing anywhere else is allowed to ask the question its
// own way - scattered ad-hoc "is shop installed" checks are how a module ends up
// broken on the one install nobody tested.
//
// Presence is probed by TABLE, not by a Module row: the tables are what the raw
// SQL actually needs, and a module row can exist for a whole deploy before its
// migration has run. Nothing here imports from '@/modules/shop/...' or
// '@/modules/uk-bookkeeping/...' - those paths do not exist at build time on an
// install without the module, and a static import would break that build.

export type PoCapabilities = {
  /** A product catalogue to pick order lines from. */
  hasCatalogue: boolean
  /** Somebody is registered to actually move stock when goods arrive. */
  hasInventory: boolean
  /** A set of books an approved bill could be handed to. */
  hasBooks: boolean
}

/** The extension point core publishes for "something that can adjust stock". */
const INVENTORY_POINT = 'core.inventory-adjuster'

let cached: { value: PoCapabilities; at: number } | null = null
const TTL_MS = 30_000

async function hasTables(names: string[]): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ present: bigint }[]>`
    SELECT count(*) AS "present"
      FROM information_schema.tables
     WHERE "table_schema" = 'public' AND "table_name" = ANY(${names}::text[])
  `
  return Number(rows[0]?.present ?? 0) === names.length
}

// Whether any installed module has registered itself as an inventory adjuster.
// Two halves, and both are needed: the generated registry says whose code is in
// this build, and the manifests say who is actually installed.
async function hasInventoryProvider(): Promise<boolean> {
  const registered = modulePublicExtensionPointComponents[INVENTORY_POINT] ?? {}
  if (Object.keys(registered).length === 0) return false

  const modules = await getInstalledManifests()
  for (const mod of modules) {
    const manifest = mod.manifest as { extensionPoints?: Array<{ point: string; id: string }> } | null
    for (const entry of manifest?.extensionPoints ?? []) {
      if (entry.point === INVENTORY_POINT && registered[entry.id]) return true
    }
  }
  return false
}

export async function getCapabilities(): Promise<PoCapabilities> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value

  const [hasCatalogue, hasBooks, hasInventory] = await Promise.all([
    hasTables(['shp_products']),
    hasTables(['bk_transactions']),
    hasInventoryProvider(),
  ])

  const value: PoCapabilities = { hasCatalogue, hasInventory, hasBooks }
  cached = { value, at: Date.now() }
  return value
}

/** Drop the cached probe. Call after anything that installs or removes a module. */
export function resetCapabilitiesCache(): void {
  cached = null
}

/**
 * Wording for a tab that is switched off because the module it needs is not
 * here. An honest empty state naming the missing module, never a silent absence
 * - a tab that simply vanishes reads as a bug, and one that errors reads worse.
 */
export function missingModuleMessage(what: string, moduleName: string): string {
  return `${what} needs the ${moduleName} module, which is not installed on this site.`
}
