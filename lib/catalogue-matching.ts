import { catalogueSkuKey, type CatalogueImportItem } from './catalogue-import'
import { scaled } from './totals'
import type {
  PoCatalogueChange,
  PoCatalogueCost,
  PoCatalogueFinding,
  PoCatalogueItem,
  PoCatalogueReconciliation,
} from './types'

// Comparing lists: the one arriving against the one it replaces, and the shop's
// products against whatever the supplier is currently selling.
//
// Pure, for the same reason lib/reordering.ts is. The preview somebody reads
// before pressing import and the record written afterwards come out of the same
// function, and the Catalogues tab cannot show a different answer from the one
// an order is priced with.

/** How close two prices have to be to count as the same one.
 *
 *  A hundredth of a penny. The two figures are the same NUMERIC(12,4) rounded
 *  through two different routes, and a comparison on the strings alone would
 *  call "12.5" and "12.5000" a price rise. */
const SAME_PRICE = 1

function pence4(value: string | null): number | null {
  return value == null || value === '' ? null : scaled(value, 4)
}

function samePrice(a: string | null, b: string | null): boolean {
  const left = pence4(a)
  const right = pence4(b)
  if (left == null || right == null) return left === right
  return Math.abs(left - right) < SAME_PRICE
}

/** A description with the noise taken out, for spotting a code that has been
 *  reissued under a new number. Case, punctuation and runs of spaces go; the
 *  words stay. */
function descriptionKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function money(value: string | null): string {
  return value == null ? 'no price' : `£${Number(value).toFixed(2)}`
}

/**
 * What an incoming price list would change.
 *
 * The comparison an import shows before it does anything. Rename detection is
 * the point of it: a supplier who reissues the same chair under a new code
 * leaves every product still filed against the old one quietly unbuyable, and
 * nothing else on the site would ever say so.
 *
 * A rename is called when a code has gone, a NEW code has arrived, and the two
 * carry the same description word for word. Deliberately strict - a fuzzy match
 * across four hundred office chairs whose descriptions differ by one word would
 * pair the wrong ones, and a wrong rename is worse than a missed one because
 * somebody would act on it. Where several old codes share one description with
 * several new ones, none of them is called: that is a range renumbering, and
 * the ADDED and REMOVED lines say so honestly.
 */
export function diffCatalogue(
  previous: Array<Pick<PoCatalogueItem, 'supplierSku' | 'supplierSkuKey' | 'description' | 'unitCost' | 'discontinued'>>,
  next: CatalogueImportItem[],
): PoCatalogueChange[] {
  const before = new Map(previous.map((item) => [item.supplierSkuKey, item]))
  const after = new Map(next.map((item) => [item.supplierSkuKey, item]))

  const gone = previous.filter((item) => !after.has(item.supplierSkuKey))
  const arrived = next.filter((item) => !before.has(item.supplierSkuKey))

  // Descriptions that appear exactly once on each side are the only ones a
  // rename can be read off. Anything appearing twice is ambiguous and is left
  // to show up as a plain removal and a plain addition.
  const arrivedByDescription = new Map<string, CatalogueImportItem[]>()
  for (const item of arrived) {
    const key = descriptionKey(item.description)
    if (key === '') continue
    const list = arrivedByDescription.get(key)
    if (list) list.push(item)
    else arrivedByDescription.set(key, [item])
  }
  const goneByDescription = new Map<string, number>()
  for (const item of gone) {
    const key = descriptionKey(item.description)
    if (key === '') continue
    goneByDescription.set(key, (goneByDescription.get(key) ?? 0) + 1)
  }

  const changes: PoCatalogueChange[] = []
  const renamedInto = new Set<string>()

  for (const item of gone) {
    const key = descriptionKey(item.description)
    const candidates = key === '' ? undefined : arrivedByDescription.get(key)
    const unique = candidates?.length === 1 && goneByDescription.get(key) === 1 ? candidates[0]! : null

    if (unique) {
      renamedInto.add(unique.supplierSkuKey)
      changes.push({
        kind: 'RENAMED',
        supplierSku: item.supplierSku,
        description: item.description,
        becomes: unique.supplierSku,
        wasCost: item.unitCost,
        nowCost: unique.unitCost,
        message: `${item.supplierSku} is gone and the same thing has arrived as ${unique.supplierSku}. Anything sold under the old code needs pointing at the new one.`,
      })
      continue
    }

    changes.push({
      kind: 'REMOVED',
      supplierSku: item.supplierSku,
      description: item.description,
      becomes: null,
      wasCost: item.unitCost,
      nowCost: null,
      message: `${item.supplierSku} is not in the new list at all.`,
    })
  }

  for (const item of arrived) {
    if (renamedInto.has(item.supplierSkuKey)) continue
    changes.push({
      kind: 'ADDED',
      supplierSku: item.supplierSku,
      description: item.description,
      becomes: null,
      wasCost: null,
      nowCost: item.unitCost,
      message: `${item.supplierSku} is new.`,
    })
  }

  for (const item of next) {
    const was = before.get(item.supplierSkuKey)
    if (!was) continue

    if (!was.discontinued && item.discontinued) {
      changes.push({
        kind: 'DISCONTINUED',
        supplierSku: item.supplierSku,
        description: item.description,
        becomes: null,
        wasCost: was.unitCost,
        nowCost: item.unitCost,
        message: `${item.supplierSku} is marked as no longer sold.`,
      })
    } else if (was.discontinued && !item.discontinued) {
      changes.push({
        kind: 'RESTORED',
        supplierSku: item.supplierSku,
        description: item.description,
        becomes: null,
        wasCost: was.unitCost,
        nowCost: item.unitCost,
        message: `${item.supplierSku} is being sold again.`,
      })
    }

    if (!samePrice(was.unitCost, item.unitCost)) {
      changes.push({
        kind: 'REPRICED',
        supplierSku: item.supplierSku,
        description: item.description,
        becomes: null,
        wasCost: was.unitCost,
        nowCost: item.unitCost,
        message: `${item.supplierSku} was ${money(was.unitCost)} and is now ${money(item.unitCost)}.`,
      })
    }
  }

  return changes
}

/** Every kind counted, so a thousand-line refresh can be summed up in a line. */
export function countChanges(changes: PoCatalogueChange[]): Record<PoCatalogueChange['kind'], number> {
  const counts: Record<PoCatalogueChange['kind'], number> = {
    ADDED: 0,
    REMOVED: 0,
    RENAMED: 0,
    REPRICED: 0,
    DISCONTINUED: 0,
    RESTORED: 0,
  }
  for (const change of changes) counts[change.kind] += 1
  return counts
}

/** One product the shop sells under this supplier's name, as the comparison
 *  needs it. Read by raw SQL - see lib/catalogues.ts. */
export type ShopProductForSupplier = {
  id: string
  name: string
  sku: string | null
  supplierSku: string | null
  costPrice: string | null
}

/** The code a product is bought under. The supplier's own where the shop has
 *  been given one, and our own SKU otherwise - which is what a supplier who has
 *  never sent us a code will be reading it as anyway. Same fallback the
 *  from-order planner uses, so the two cannot disagree. */
export function buyingCode(product: ShopProductForSupplier): string | null {
  const code = product.supplierSku?.trim() || product.sku?.trim() || ''
  return code === '' ? null : code
}

/**
 * The shop's products against what this supplier is currently selling.
 *
 * Three things are worth saying and nothing else is: a code their list does not
 * name, a code their list says is finished, and a price that has moved. A
 * product with no code at all is not a finding - plenty of things are bought on
 * a description and a phone call - and a code in their list that we do not sell
 * is not one either, because a supplier's range is always bigger than ours.
 *
 * `tolerancePercent` is the module's own price-variance tolerance, the same
 * figure the bill match uses. A list that goes up 0.4% across the board on the
 * first of April should not produce four hundred findings.
 */
export function reconcileCatalogue(
  supplierId: string,
  supplierName: string,
  products: ShopProductForSupplier[],
  costs: Map<string, PoCatalogueCost>,
  tolerancePercent: number,
): PoCatalogueReconciliation {
  const findings: PoCatalogueFinding[] = []
  const used = new Set<string>()
  let matchedCount = 0

  for (const product of products) {
    const code = buyingCode(product)
    if (!code) continue

    const key = catalogueSkuKey(code)
    const cost = costs.get(key)

    if (!cost) {
      findings.push({
        kind: 'UNKNOWN_CODE',
        productId: product.id,
        productName: product.name,
        code,
        catalogueName: '',
        ourCost: product.costPrice,
        theirCost: null,
        message: `Nothing in ${supplierName}'s price lists is called ${code}. Either it has been renumbered or the list needs importing again.`,
      })
      continue
    }

    used.add(key)
    matchedCount += 1

    if (cost.discontinued) {
      findings.push({
        kind: 'DISCONTINUED',
        productId: product.id,
        productName: product.name,
        code,
        catalogueName: cost.catalogueName,
        ourCost: product.costPrice,
        theirCost: cost.unitCost,
        message: `${supplierName} have marked ${code} as no longer sold, and it is still on the shop.`,
      })
      continue
    }

    const ours = pence4(product.costPrice)
    const theirs = pence4(cost.unitCost)
    if (ours == null || theirs == null || theirs === 0) continue

    const drift = (Math.abs(ours - theirs) / theirs) * 100
    if (drift > tolerancePercent) {
      findings.push({
        kind: 'PRICE_MOVED',
        productId: product.id,
        productName: product.name,
        code,
        catalogueName: cost.catalogueName,
        ourCost: product.costPrice,
        theirCost: cost.unitCost,
        message: `${code} costs ${money(cost.unitCost)} on ${cost.catalogueName}, and the product says ${money(product.costPrice)}.`,
      })
    }
  }

  return {
    supplierId,
    supplierName,
    productCount: products.length,
    matchedCount,
    findings,
    unsoldCodeCount: [...costs.keys()].filter((key) => !used.has(key)).length,
  }
}
