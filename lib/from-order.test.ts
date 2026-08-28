import { describe, expect, it } from 'vitest'
import {
  CLOSED_SHOP_ORDER_STATUSES,
  carriageFor,
  livePos,
  planFromOrder,
  serviceCostFor,
  serviceNameFor,
  shipToFromShopOrder,
  type PoRaisedFromShopOrder,
  type ShopOrderFacts,
  type ShopOrderItemFacts,
} from './from-order'
import type { ReorderSupplierFacts } from './reordering'

// The traps this file exists to hold shut, in the order they would bite:
//
// 1. A purchase order's cost is the CATALOGUE'S cost price, never what the
//    customer paid. Delivery is fused into the customer's price at checkout, so
//    buying at unit_price pays the supplier our customer's carriage as though it
//    were part of the goods - and then pays the carriage again underneath.
// 2. The service name comes from the resolver's own snapshot, never from the
//    sentence on the line: shop rewrites that sentence when the payment lands.
// 3. `county` becomes `region`, or the county falls off the address printed for
//    the supplier and nobody notices until a parcel does not arrive.
// 4. Nothing is dropped in silence.

function supplier(patch: Partial<ReorderSupplierFacts> = {}): ReorderSupplierFacts {
  return {
    id: 'sup-dynamic',
    name: 'Dynamic Office Solutions',
    nameKey: 'dynamic office solutions',
    status: 'ENABLED',
    currency: 'GBP',
    minimumOrderValue: null,
    carriagePaidOver: null,
    carriageCharge: null,
    defaultVatRateCode: null,
    ...patch,
  }
}

function item(patch: Partial<ShopOrderItemFacts> = {}): ShopOrderItemFacts {
  return {
    itemId: 'item-1',
    productId: 'prod-1',
    productName: 'Impulse Panel End Crescent Corner Office Desk - 180cm / Maple',
    quantity: 1,
    unitPrice: '218.00',
    sku: 'I000456',
    supplierSku: null,
    supplierName: 'Dynamic Office Solutions',
    costPrice: '206.09',
    lineMeta: null,
    ...patch,
  }
}

function order(patch: Partial<ShopOrderFacts> = {}): ShopOrderFacts {
  return {
    id: 'order-1',
    orderNumber: 'DW000135',
    status: 'PAID',
    customerName: 'Christopher Taylor-Guest',
    customerPhone: '07445 164570',
    customerOrganisation: 'Deskwell Limited',
    currency: 'GBP',
    shippingAddress: {
      firstName: 'Chris',
      lastName: 'Taylor-Guest',
      line1: '22 Blackwall Basin Moorings',
      line2: '',
      city: '1 Myers Walk',
      county: 'Greater London',
      postcode: 'E14 5GT',
      country: 'GB',
      phone: '07445 164570',
    },
    items: [item()],
    ...patch,
  }
}

/** A line as advanced shipping actually leaves it: the immutable snapshot in
 *  `data`, the charge, and a `fields` sentence that disagrees with both because
 *  it was rewritten when the payment landed. */
const shippedLineMeta = {
  data: {
    ashDelivery: {
      tierKey: 'standard-pre-built-delivery',
      tierText: 'Pre-Assembled',
      leadDays: 7,
      targetDate: '2026-09-03',
      isPreOrder: false,
    },
  },
  charges: [{ label: 'Delivery', amount: 39 }],
  batch: { id: '2026-09-03', sort: '2026-09-03', heading: 'Arrives by Thursday 3rd of September', uniformHeading: 'SOMETHING ELSE ENTIRELY' },
  fields: [{ label: 'Delivery', value: 'Pre-Assembled - 7 working days from when your payment reaches us' }],
}

describe('grouping a customer order by supplier', () => {
  it('makes one group per supplier, in name order', () => {
    const plan = planFromOrder(
      order({
        items: [
          item({ itemId: 'a', supplierName: 'Dynamic Office Solutions' }),
          item({ itemId: 'b', supplierName: 'Zenith Chairs', productId: 'prod-2' }),
          item({ itemId: 'c', supplierName: 'dynamic  office solutions', productId: 'prod-3' }),
        ],
      }),
      [supplier(), supplier({ id: 'sup-zenith', name: 'Zenith Chairs', nameKey: 'zenith chairs' })],
    )
    expect(plan.groups.map((g) => g.supplierName)).toEqual(['Dynamic Office Solutions', 'Zenith Chairs'])
    // The third line's supplier is the same name with the spacing mangled, and
    // it belongs in the same order - that normalisation is the whole join.
    expect(plan.groups[0]!.lines.map((l) => l.itemId)).toEqual(['a', 'c'])
    expect(plan.skipped).toEqual([])
  })

  it('buys at the catalogue cost price, never at what the customer paid', () => {
    const plan = planFromOrder(order({ items: [item({ unitPrice: '257.00', costPrice: '206.09' })] }), [supplier()])
    expect(plan.groups[0]!.lines[0]!.unitCost).toBe('206.09')
  })

  it('falls back to our own code when the supplier has never given us theirs', () => {
    const plan = planFromOrder(
      order({ items: [item({ supplierSku: null }), item({ itemId: 'two', productId: 'p2', supplierSku: 'DYN-99' })] }),
      [supplier()],
    )
    expect(plan.groups[0]!.lines.map((l) => l.supplierSku)).toEqual(['I000456', 'DYN-99'])
  })
})

describe('the lines that cannot be bought', () => {
  const cases: Array<[string, Partial<ShopOrderItemFacts>, ReorderSupplierFacts[], string]> = [
    ['a product deleted since the order', { productId: null }, [supplier()], 'no longer in the catalogue'],
    ['a product with nobody set to supply it', { supplierName: null }, [supplier()], 'says who supplies it'],
    ['a supplier nobody has set up', {}, [], 'Nobody on your supplier list is called'],
    ['a supplier on hold', {}, [supplier({ status: 'ON_HOLD' })], 'is on hold'],
    ['a supplier switched off', {}, [supplier({ status: 'DISABLED' })], 'switched off'],
  ]

  for (const [name, patch, suppliers, fragment] of cases) {
    it(`reports ${name} rather than dropping it`, () => {
      const plan = planFromOrder(order({ items: [item(patch)] }), suppliers)
      expect(plan.groups).toEqual([])
      expect(plan.skipped).toHaveLength(1)
      expect(plan.skipped[0]!.reason).toContain(fragment)
      // Named, so somebody can go and fix the one line rather than the order.
      expect(plan.skipped[0]!.productName).toBe(item().productName)
    })
  }

  it('keeps the rest of the order when one line cannot be bought', () => {
    const plan = planFromOrder(
      order({ items: [item({ itemId: 'good' }), item({ itemId: 'bad', productId: 'p2', supplierName: null })] }),
      [supplier()],
    )
    expect(plan.groups[0]!.lines.map((l) => l.itemId)).toEqual(['good'])
    expect(plan.skipped.map((s) => s.itemId)).toEqual(['bad'])
  })
})

describe('the delivery service on a line', () => {
  it('is built from the resolver snapshot, not from the sentence on the line', () => {
    const name = serviceNameFor(shippedLineMeta)
    expect(name).toBe('Pre-Assembled, expected by 3 September 2026')
    // The two things that get rewritten when the payment lands.
    expect(name).not.toContain('SOMETHING ELSE ENTIRELY')
    expect(name).not.toContain('working days')
  })

  it('states the service alone when no date was recorded', () => {
    expect(serviceNameFor({ data: { ashDelivery: { tierText: 'Flat-Pack' } } })).toBe('Flat-Pack')
    expect(serviceNameFor({ data: { ashDelivery: { tierText: 'Flat-Pack', targetDate: 'soonish' } } })).toBe('Flat-Pack')
  })

  it('is absent on a line no resolver ever touched', () => {
    expect(serviceNameFor(null)).toBeNull()
    expect(serviceNameFor({ fields: [{ label: 'Delivery', value: 'Pre-Assembled - by Thursday' }] })).toBeNull()
  })

  it('costs what the charge says, per unit, to four decimal places', () => {
    expect(serviceCostFor(shippedLineMeta)).toBe('39.0000')
    expect(serviceCostFor({ charges: [{ label: 'delivery', amount: 12.345678 }] })).toBe('12.3457')
    expect(serviceCostFor({ charges: [{ label: 'Delivery', base: 45, amount: 39 }] })).toBe('45.0000')
  })

  it('has no cost on an order placed before shop kept one', () => {
    // Every order older than shop v0.1.356, and every order converted from a
    // quote. The NAME is what the supplier acts on, so this is a degradation
    // and not a failure.
    const before = { data: shippedLineMeta.data, fields: shippedLineMeta.fields }
    expect(serviceNameFor(before)).toBe('Pre-Assembled, expected by 3 September 2026')
    expect(serviceCostFor(before)).toBeNull()
    expect(serviceCostFor({ charges: [{ label: 'Gift wrap', amount: 4 }] })).toBeNull()
  })

  it('sums into the order carriage, per unit times quantity', () => {
    expect(carriageFor([{ qty: 12, serviceCost: '39.0000' }, { qty: 1, serviceCost: null }])).toBe('468.00')
    expect(carriageFor([{ qty: 3, serviceCost: '0.3333' }])).toBe('1.00')
    expect(carriageFor([])).toBe('0.00')
  })

  it('carries the service and its cost onto the line, and the sum onto the group', () => {
    const plan = planFromOrder(order({ items: [item({ quantity: 2, lineMeta: shippedLineMeta })] }), [supplier()])
    expect(plan.groups[0]!.lines[0]!.serviceName).toBe('Pre-Assembled, expected by 3 September 2026')
    expect(plan.groups[0]!.lines[0]!.serviceCost).toBe('39.0000')
    expect(plan.groups[0]!.carriageAmount).toBe('78.00')
  })
})

describe('the drop-ship address', () => {
  it('maps county onto region, which is the one name the two shapes disagree on', () => {
    const shipTo = shipToFromShopOrder(order())
    expect(shipTo.address.region).toBe('Greater London')
    expect(shipTo.address).toEqual({
      line1: '22 Blackwall Basin Moorings',
      line2: '',
      // Copied verbatim: the customer typed a street into the town box, and a
      // purchase order that tidies that up is a parcel going somewhere else.
      city: '1 Myers Walk',
      region: 'Greater London',
      postcode: 'E14 5GT',
      country: 'GB',
    })
    expect(shipTo.name).toBe('Deskwell Limited')
    expect(shipTo.contact).toBe('Chris Taylor-Guest')
    expect(shipTo.phone).toBe('07445 164570')
  })

  it('heads the label with the company on the address where the shop kept it there', () => {
    const shipTo = shipToFromShopOrder(
      order({
        customerOrganisation: null,
        shippingAddress: { firstName: 'Chris', lastName: 'Taylor-Guest', company: 'Weff Ltd', line1: '1 The Yard' },
      }),
    )
    expect(shipTo.name).toBe('Weff Ltd')
    expect(shipTo.contact).toBe('Chris Taylor-Guest')
  })

  it('leaves the person heading the label when nobody gave a company', () => {
    const shipTo = shipToFromShopOrder(
      order({
        customerOrganisation: null,
        shippingAddress: { firstName: 'Chris', lastName: 'Taylor-Guest', line1: '1 The Yard' },
      }),
    )
    expect(shipTo.name).toBe('Chris Taylor-Guest')
    expect(shipTo.contact).toBe('Chris Taylor-Guest')
  })

  it('falls back to the order when the address names nobody', () => {
    const shipTo = shipToFromShopOrder(
      order({
        customerOrganisation: null,
        shippingAddress: { line1: '1 The Yard', city: 'Leeds', postcode: 'LS1 1AA', country: 'GB' },
      }),
    )
    expect(shipTo.name).toBe('Christopher Taylor-Guest')
    expect(shipTo.contact).toBe('Christopher Taylor-Guest')
    expect(shipTo.phone).toBe('07445 164570')
    expect(shipTo.address.region).toBe('')
  })
})

describe('the idempotency guard', () => {
  function po(patch: Partial<PoRaisedFromShopOrder> = {}): PoRaisedFromShopOrder {
    return {
      id: 'po-1',
      number: 'PO-00001',
      status: 'DRAFT',
      supplierId: 'sup-dynamic',
      supplierName: 'Dynamic Office Solutions',
      currency: 'GBP',
      total: '245.09',
      createdAt: '2026-08-27T00:00:00.000Z',
      raisedAutomatically: false,
      ...patch,
    }
  }

  it('counts a draft, because pressing the button twice must not order twice', () => {
    expect(livePos([po()])).toHaveLength(1)
  })

  it('does not count a cancelled one, so a cancelled order can be raised again', () => {
    expect(livePos([po({ status: 'CANCELLED' })])).toEqual([])
    expect(livePos([po({ status: 'CANCELLED' }), po({ id: 'po-2', status: 'SENT' })]).map((p) => p.id)).toEqual(['po-2'])
  })

  it('counts every other status, received and closed included', () => {
    const statuses = ['AWAITING_APPROVAL', 'APPROVED', 'SENT', 'ACKNOWLEDGED', 'PART_RECEIVED', 'RECEIVED', 'CLOSED', 'ON_HOLD'] as const
    for (const status of statuses) expect(livePos([po({ status })])).toHaveLength(1)
  })
})

describe('the customer orders that have stopped being worth buying for', () => {
  // The panel hides its button on these, but the panel is not the only way to
  // the route, so the run checks the same set. One set, two readers: a status
  // added to one and not the other is a cancelled order somebody buys for.
  it('names cancelled and refunded, and nothing else', () => {
    expect([...CLOSED_SHOP_ORDER_STATUSES].sort()).toEqual(['CANCELLED', 'REFUNDED'])
  })

  it('leaves every status somebody is still owed goods on alone', () => {
    for (const status of ['PENDING', 'PROCESSING', 'SHIPPED', 'COMPLETED', 'PARTIALLY_REFUNDED', 'ON_HOLD']) {
      expect(CLOSED_SHOP_ORDER_STATUSES.has(status)).toBe(false)
    }
  })
})
