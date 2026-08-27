import { describe, it, expect } from 'vitest'
import {
  planReorder,
  reorderNameKey,
  reorderQuantity,
  reorderTaxRate,
  type ReorderFacts,
  type ReorderProductFacts,
  type ReorderRuleRow,
  type ReorderSupplierFacts,
} from './reordering'

// Reordering is a job that spends money while nobody is watching, so every one
// of these is about it NOT doing something: not ordering what is already on its
// way, not ordering from a supplier on hold, not raising the same order again
// tomorrow, and not quietly padding an order out to clear a minimum.

function rule(patch: Partial<ReorderRuleRow> = {}): ReorderRuleRow {
  return {
    id: 'r1',
    productId: 'p1',
    supplierId: 's1',
    reorderPoint: 10,
    reorderQty: 12,
    enabled: true,
    lastSuggestedAt: null,
    ...patch,
  }
}

function product(patch: Partial<ReorderProductFacts> = {}): ReorderProductFacts {
  return {
    id: 'p1',
    name: 'Task chair',
    sku: 'CHR-1',
    supplierName: 'Northern Clay Co.',
    costPrice: '40.00',
    stockCount: 4,
    trackInventory: true,
    ...patch,
  }
}

function supplier(patch: Partial<ReorderSupplierFacts> = {}): ReorderSupplierFacts {
  return {
    id: 's1',
    name: 'Northern Clay Co.',
    nameKey: 'northern clay co.',
    status: 'ENABLED',
    currency: 'GBP',
    minimumOrderValue: null,
    carriagePaidOver: null,
    carriageCharge: null,
    defaultVatRateCode: null,
    ...patch,
  }
}

function facts(patch: Partial<ReorderFacts> = {}): ReorderFacts {
  return {
    rules: [rule()],
    products: { p1: product() },
    suppliers: [supplier()],
    onOrder: {},
    lastCosts: {},
    automatic: true,
    ...patch,
  }
}

describe('reorderQuantity', () => {
  it('buys one lot when the level has just been touched', () => {
    expect(reorderQuantity(10, 10, 12)).toBe(12)
  })

  it('buys whole lots, not an exact top-up', () => {
    // A reorder quantity is usually how the supplier sells the thing.
    expect(reorderQuantity(9, 10, 12)).toBe(12)
    expect(reorderQuantity(-20, 10, 12)).toBe(36)
  })

  it('buys enough lots to get back above the level', () => {
    // The whole point: one lot would leave it under, and the job would suggest
    // the same thing again tomorrow and the day after.
    expect(reorderQuantity(0, 100, 12)).toBe(108)
    expect(9 * 12).toBe(108)
  })

  it('buys nothing when there is enough', () => {
    expect(reorderQuantity(11, 10, 12)).toBe(0)
  })

  it('buys nothing when nobody said how many', () => {
    expect(reorderQuantity(0, 10, 0)).toBe(0)
  })
})

describe('reorderTaxRate', () => {
  it('drafts at the standard rate by default', () => {
    expect(reorderTaxRate(supplier())).toBe('20')
    expect(reorderTaxRate(supplier({ defaultVatRateCode: 'standard' }))).toBe('20')
  })

  it('drafts a zero-rated supplier at zero', () => {
    expect(reorderTaxRate(supplier({ defaultVatRateCode: 'zero' }))).toBe('0')
    expect(reorderTaxRate(supplier({ defaultVatRateCode: 'exempt' }))).toBe('0')
    expect(reorderTaxRate(supplier({ defaultVatRateCode: 'outside_scope' }))).toBe('0')
  })
})

describe('reorderNameKey', () => {
  it('matches the catalogue supplier name however it was typed', () => {
    expect(reorderNameKey('  Northern   Clay  Co. ')).toBe('northern clay co.')
  })
})

describe('planReorder', () => {
  it('suggests a product that has dropped to its level', () => {
    const { suggestions, plans, restingCount } = planReorder(facts())
    expect(restingCount).toBe(0)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({
      productId: 'p1',
      inStock: 4,
      onOrder: 0,
      available: 4,
      suggestedQty: 12,
      unitCost: '40.00',
      lineValue: '480.00',
      blockedReason: null,
    })
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ supplierId: 's1', goodsValue: '480.00', auto: true, holdReason: null })
  })

  it('leaves a product that has enough alone, and does not list it', () => {
    const { suggestions, plans, restingCount } = planReorder(
      facts({ products: { p1: product({ stockCount: 40 }) } }),
    )
    expect(suggestions).toEqual([])
    expect(plans).toEqual([])
    expect(restingCount).toBe(1)
  })

  it('counts what is already on order, so the same thing is not bought twice', () => {
    // The one that matters: without this the job raises an identical draft every
    // night until somebody notices there are fourteen of them.
    const { suggestions, restingCount } = planReorder(facts({ onOrder: { p1: 12 } }))
    expect(suggestions).toEqual([])
    expect(restingCount).toBe(1)
  })

  it('still buys when what is on order does not get it back over the level', () => {
    const { suggestions } = planReorder(
      facts({ products: { p1: product({ stockCount: 0 }) }, onOrder: { p1: 2 } }),
    )
    expect(suggestions[0]?.available).toBe(2)
    expect(suggestions[0]?.suggestedQty).toBe(12)
  })

  it('ignores a rule that is switched off', () => {
    const { suggestions, restingCount } = planReorder(facts({ rules: [rule({ enabled: false })] }))
    expect(suggestions).toEqual([])
    expect(restingCount).toBe(0)
  })

  it('prefers what this supplier last charged over the catalogue cost', () => {
    const { suggestions } = planReorder(
      facts({ lastCosts: { 'p1::s1': { unitCost: '37.5000', supplierSku: 'NC-9' } } }),
    )
    expect(suggestions[0]?.unitCost).toBe('37.5000')
    expect(suggestions[0]?.supplierSku).toBe('NC-9')
    expect(suggestions[0]?.lineValue).toBe('450.00')
  })

  it('does not borrow another supplier`s price', () => {
    const { suggestions } = planReorder(
      facts({ lastCosts: { 'p1::s9': { unitCost: '1.0000', supplierSku: 'X' } } }),
    )
    expect(suggestions[0]?.unitCost).toBe('40.00')
  })

  it('falls back to the catalogue supplier name when the rule names nobody', () => {
    const { suggestions } = planReorder(facts({ rules: [rule({ supplierId: null })] }))
    expect(suggestions[0]).toMatchObject({ supplierId: 's1', blockedReason: null })
  })

  it('explains itself when nobody supplies the thing', () => {
    const { suggestions, plans } = planReorder(
      facts({ rules: [rule({ supplierId: null })], products: { p1: product({ supplierName: null }) } }),
    )
    expect(suggestions[0]?.blockedReason).toContain('Nobody is set to supply')
    expect(plans).toEqual([])
  })

  it('explains itself when the catalogue names a supplier nobody has added', () => {
    const { suggestions } = planReorder(
      facts({
        rules: [rule({ supplierId: null })],
        products: { p1: product({ supplierName: 'Somebody Else Ltd' }) },
      }),
    )
    expect(suggestions[0]?.blockedReason).toContain('Somebody Else Ltd')
  })

  it('buys nothing from a supplier on hold', () => {
    const { suggestions, plans } = planReorder(facts({ suppliers: [supplier({ status: 'ON_HOLD' })] }))
    expect(suggestions[0]?.blockedReason).toContain('on hold')
    expect(plans).toEqual([])
  })

  it('buys nothing from a supplier who has been switched off', () => {
    const { suggestions } = planReorder(facts({ suppliers: [supplier({ status: 'DISABLED' })] }))
    expect(suggestions[0]?.blockedReason).toContain('switched off')
  })

  it('says so when the product has left the catalogue', () => {
    const { suggestions } = planReorder(facts({ products: {} }))
    expect(suggestions[0]?.blockedReason).toContain('no longer in your catalogue')
    expect(suggestions[0]?.productName).toBe('p1')
  })

  it('says so when nothing is counting the product', () => {
    const { suggestions } = planReorder(
      facts({ products: { p1: product({ trackInventory: false, stockCount: null }) } }),
    )
    expect(suggestions[0]?.blockedReason).toContain('keeping a count')
  })

  it('says so when nobody set how many to buy', () => {
    const { suggestions } = planReorder(facts({ rules: [rule({ reorderQty: 0 })] }))
    expect(suggestions[0]?.blockedReason).toContain('how many to buy')
  })

  it('holds an order that is under the supplier`s minimum, and says why', () => {
    const { plans } = planReorder(facts({ suppliers: [supplier({ minimumOrderValue: '600.00' })] }))
    expect(plans[0]).toMatchObject({
      goodsValue: '480.00',
      shortOfMinimum: '120.00',
      auto: false,
    })
    expect(plans[0]?.holdReason).toContain('less than Northern Clay Co. will take')
  })

  it('does not pad an order out to clear the minimum', () => {
    const { plans } = planReorder(facts({ suppliers: [supplier({ minimumOrderValue: '600.00' })] }))
    expect(plans[0]?.lines).toHaveLength(1)
    expect(plans[0]?.lines[0]?.suggestedQty).toBe(12)
  })

  it('clears the minimum when the order is big enough', () => {
    const { plans } = planReorder(facts({ suppliers: [supplier({ minimumOrderValue: '400.00' })] }))
    expect(plans[0]?.shortOfMinimum).toBeNull()
    expect(plans[0]?.auto).toBe(true)
  })

  it('adds carriage under the free-carriage threshold', () => {
    const { plans } = planReorder(
      facts({ suppliers: [supplier({ carriagePaidOver: '500.00', carriageCharge: '12.50' })] }),
    )
    expect(plans[0]).toMatchObject({ carriageAmount: '12.50', carriagePaid: false })
  })

  it('leaves carriage off once the order has earned it', () => {
    const { plans } = planReorder(
      facts({ suppliers: [supplier({ carriagePaidOver: '400.00', carriageCharge: '12.50' })] }),
    )
    expect(plans[0]).toMatchObject({ carriageAmount: '0.00', carriagePaid: true })
  })

  it('charges carriage every time where there is no threshold at all', () => {
    const { plans } = planReorder(facts({ suppliers: [supplier({ carriageCharge: '9.99' })] }))
    expect(plans[0]).toMatchObject({ carriageAmount: '9.99', carriagePaid: false })
  })

  it('holds everything while automatic reordering is switched off', () => {
    const { plans } = planReorder(facts({ automatic: false }))
    expect(plans[0]?.auto).toBe(false)
    expect(plans[0]?.holdReason).toContain('switched off')
  })

  it('groups several products onto one order per supplier', () => {
    const { plans } = planReorder(
      facts({
        rules: [rule(), rule({ id: 'r2', productId: 'p2' }), rule({ id: 'r3', productId: 'p3', supplierId: 's2' })],
        products: {
          p1: product(),
          p2: product({ id: 'p2', name: 'Desk', costPrice: '100.00', stockCount: 0 }),
          p3: product({ id: 'p3', name: 'Lamp', costPrice: '20.00', stockCount: 0, supplierName: 'Other Co.' }),
        },
        suppliers: [supplier(), supplier({ id: 's2', name: 'Other Co.', nameKey: 'other co.' })],
      }),
    )
    expect(plans).toHaveLength(2)
    expect(plans.map((p) => p.supplierName)).toEqual(['Northern Clay Co.', 'Other Co.'])
    expect(plans[0]?.lines).toHaveLength(2)
    expect(plans[0]?.goodsValue).toBe('1680.00')
  })
})
