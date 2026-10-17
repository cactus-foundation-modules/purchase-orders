import { describe, expect, it } from 'vitest'
import {
  CLOSED_SHOP_ORDER_STATUSES,
  carriageFor,
  expandKitItems,
  livePos,
  netTotalFor,
  planFromOrder,
  serviceCostFor,
  serviceCostShare,
  serviceNameFor,
  shipToFromShopOrder,
  spendTowardThreshold,
  surchargeFor,
  type KitPartFacts,
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
    surchargeThreshold: null,
    surchargeRates: [],
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
    saleSku: null,
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
    kind: 'SALE',
    status: 'PAID',
    customerName: 'Christopher Taylor-Guest',
    customerPhone: '07445 164570',
    customerOrganisation: 'Deskwell Limited',
    currency: 'GBP',
    deliveryInstructions: 'Gate code 4821. Side entrance off Myers Walk.',
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
    ['a sale line nobody has priced', { saleSku: 'DS-CLR-1' }, [supplier()], 'sale code'],
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

describe('netTotalFor', () => {
  it('matches what orderTotals itself would store as the order net', () => {
    // Same lines, same figure lineAmounts (orderTotals' own per-line function)
    // would produce - this is the whole point of reusing it rather than a
    // second rounding discipline.
    expect(netTotalFor([{ qty: 2, unitCost: '100.00' }, { qty: 1, unitCost: '39.99' }])).toBe('239.99')
    expect(netTotalFor([])).toBe('0.00')
  })
})

describe('spendTowardThreshold', () => {
  it('counts carriage toward the threshold alongside the goods', () => {
    expect(spendTowardThreshold('290.00', '25.90')).toBe('315.90')
    expect(spendTowardThreshold('290.00', '0.00')).toBe('290.00')
  })

  it('£290 of goods with £25.90 carriage clears a £300 threshold - no surcharge', () => {
    const lines = [{ qty: 5, onSale: true, category: 'Seating' }]
    const rates = [{ categoryKey: 'seating', ratePerUnit: '2.0000' }]
    expect(surchargeFor(lines, spendTowardThreshold('290.00', '25.90'), '300.00', rates)).toBe('0.00')
  })

  it('carriage narrows the shortfall when it does not clear it', () => {
    const lines = [{ qty: 10, onSale: true, category: 'Seating' }]
    const rates = [{ categoryKey: 'seating', ratePerUnit: '2.0000' }]
    expect(surchargeFor(lines, spendTowardThreshold('280.00', '15.00'), '300.00', rates)).toBe('5.00')
  })
})

describe('surchargeFor', () => {
  const rates = [{ categoryKey: 'seating', ratePerUnit: '2.0000' }]

  it('3 chairs on sale = 3 surcharges', () => {
    const lines = [{ qty: 3, onSale: true, category: 'Seating' }]
    expect(surchargeFor(lines, '10.00', '1000.00', rates)).toBe('6.00')
  })

  it('6 chairs not on sale + 3 chairs on sale = 3 surcharges', () => {
    const lines = [
      { qty: 6, onSale: false, category: 'Seating' },
      { qty: 3, onSale: true, category: 'Seating' },
    ]
    expect(surchargeFor(lines, '10.00', '1000.00', rates)).toBe('6.00')
  })

  it('order comes to £295 net against a £300 threshold - the surcharge is just the £5 difference', () => {
    // Ten chairs at £2 each would raw out at £20, well over the £5 shortfall.
    const lines = [{ qty: 10, onSale: true, category: 'Seating' }]
    expect(surchargeFor(lines, '295.00', '300.00', rates)).toBe('5.00')
  })

  it('nothing at exactly the threshold, or above it - "under", not "at or under"', () => {
    const lines = [{ qty: 3, onSale: true, category: 'Seating' }]
    expect(surchargeFor(lines, '300.00', '300.00', rates)).toBe('0.00')
    expect(surchargeFor(lines, '301.00', '300.00', rates)).toBe('0.00')
  })

  it('nothing where the supplier has no threshold set, whatever the rates say', () => {
    const lines = [{ qty: 3, onSale: true, category: 'Seating' }]
    expect(surchargeFor(lines, '10.00', null, rates)).toBe('0.00')
  })

  it('nothing where a threshold is set but no rates are, even under it', () => {
    const lines = [{ qty: 3, onSale: true, category: 'Seating' }]
    expect(surchargeFor(lines, '10.00', '1000.00', [])).toBe('0.00')
  })

  it('a rate of exactly zero contributes nothing, without being treated as unmatched', () => {
    const lines = [{ qty: 5, onSale: true, category: 'Seating' }]
    expect(surchargeFor(lines, '10.00', '1000.00', [{ categoryKey: 'seating', ratePerUnit: '0.0000' }])).toBe('0.00')
  })

  it('a sale line whose category nothing prices contributes nothing', () => {
    const lines = [{ qty: 3, onSale: true, category: 'Furniture' }]
    expect(surchargeFor(lines, '10.00', '1000.00', rates)).toBe('0.00')
  })

  it('a sale line with no category on record contributes nothing', () => {
    const lines = [{ qty: 3, onSale: true, category: null }]
    expect(surchargeFor(lines, '10.00', '1000.00', rates)).toBe('0.00')
  })

  it('matches a category case- and space-insensitively', () => {
    const lines = [{ qty: 3, onSale: true, category: '  SEATING ' }]
    expect(surchargeFor(lines, '10.00', '1000.00', rates)).toBe('6.00')
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
    // The order carries `customerOrganisation: 'Deskwell Limited'` and the
    // address names no company, so the PERSON heads the label.
    expect(shipTo.name).toBe('Chris Taylor-Guest')
    expect(shipTo.contact).toBe('Chris Taylor-Guest')
    expect(shipTo.phone).toBe('07445 164570')
  })

  it('never heads the label with the order\'s contact-level organisation', () => {
    const shipTo = shipToFromShopOrder(
      order({
        customerOrganisation: 'Deskwell Limited',
        shippingAddress: { firstName: 'Chris', lastName: 'Taylor-Guest', line1: '1 The Yard' },
      }),
    )
    expect(shipTo.name).toBe('Chris Taylor-Guest')
    expect(shipTo.contact).toBe('Chris Taylor-Guest')
  })

  it('heads the label with the company the customer typed into the delivery address', () => {
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

  // The point of collecting them at all on a shop that drop-ships: the driver
  // works for the supplier, so an instruction that stops at our order screen
  // never reaches the lorry.
  it('carries the customer\'s delivery instructions onto the label', () => {
    const shipTo = shipToFromShopOrder(order())
    expect(shipTo.instructions).toBe('Gate code 4821. Side entrance off Myers Walk.')
  })

  it('trims them, and no more than trims them', () => {
    const shipTo = shipToFromShopOrder(order({ deliveryInstructions: '  leave with number 42  ' }))
    // Not capitalised, not full-stopped: it is the customer's wording about
    // their own front door.
    expect(shipTo.instructions).toBe('leave with number 42')
  })

  it('leaves the label blank where the shop asks for no instructions', () => {
    const shipTo = shipToFromShopOrder(order({ deliveryInstructions: null }))
    // Blank rather than absent - the same blank a purchase order raised by hand
    // starts with, so the box on the order screen behaves identically either way.
    expect(shipTo.instructions).toBe('')
  })
})

describe('the idempotency guard', () => {
  function po(patch: Partial<PoRaisedFromShopOrder> = {}): PoRaisedFromShopOrder {
    return {
      id: 'po-1',
      number: 'PO-00001',
      status: 'DRAFT',
      proformaRequired: false,
      proformaReceived: false,
      proformaPaid: false,
      supplierId: 'sup-dynamic',
      supplierName: 'Dynamic Office Solutions',
      currency: 'GBP',
      total: '245.09',
      createdAt: '2026-08-27T00:00:00.000Z',
      raisedAutomatically: false,
      autoSendState: null,
      autoSendNote: null,
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

// A kit is bought as its parts. The customer's line stays the line they bought
// (so a despatch is news about it), but the purchase order goes to whoever
// supplies each PART, at that part's own code and cost.
describe('kits', () => {
  const seat: KitPartFacts = { productId: 'part-seat', name: 'Chair seat', quantity: 1, sku: 'P-SEAT', supplierSku: 'S-100', supplierName: 'Dynamic Office Solutions', costPrice: '30.00' }
  const base: KitPartFacts = { productId: 'part-base', name: 'Chair base', quantity: 2, sku: 'P-BASE', supplierSku: null, supplierName: 'Other Supplier Ltd', costPrice: '12.50' }
  const kits = new Map([['prod-kit', [seat, base]]])
  const kitItem = (patch: Partial<ShopOrderItemFacts> = {}) =>
    item({ itemId: 'line-kit', productId: 'prod-kit', productName: 'Kit chair', sku: null, supplierName: null, costPrice: null, unitPrice: '99.00', ...patch })

  it('leaves an ordinary line exactly as it was', () => {
    const plain = item()
    expect(expandKitItems([plain], kits)).toEqual([plain])
    expect(expandKitItems([kitItem()], new Map())).toEqual([kitItem()])
  })

  it('turns a kit line into one line per part, scaled by the kits bought', () => {
    const out = expandKitItems([kitItem({ quantity: 3 })], kits)
    expect(out.map((l) => [l.itemId, l.productId, l.productName, l.quantity, l.sku, l.supplierName, l.costPrice])).toEqual([
      ['line-kit', 'part-seat', 'Chair seat', 3, 'P-SEAT', 'Dynamic Office Solutions', '30.00'],
      ['line-kit', 'part-base', 'Chair base', 6, 'P-BASE', 'Other Supplier Ltd', '12.50'],
    ])
    // What the customer paid is nobody's cost, and a kit's sale code names the kit.
    expect(out.every((l) => l.unitPrice === '0' && l.saleSku === null)).toBe(true)
  })

  it('buys each part from its own supplier, in separate draft orders', () => {
    const plan = planFromOrder(
      order({ items: expandKitItems([kitItem({ quantity: 2 })], kits) }),
      [supplier(), supplier({ id: 'sup-other', name: 'Other Supplier Ltd', nameKey: 'other supplier ltd' })],
    )
    expect(plan.skipped).toEqual([])
    const byName = new Map(plan.groups.map((g) => [g.supplierName, g.lines]))
    expect(byName.get('Dynamic Office Solutions')?.map((l) => [l.productName, l.qty, l.supplierSku, l.unitCost, l.itemId])).toEqual([
      ['Chair seat', 2, 'S-100', '30.00', 'line-kit'],
    ])
    // No supplier code on the part: falls back to our own, as any line does.
    expect(byName.get('Other Supplier Ltd')?.map((l) => [l.productName, l.qty, l.supplierSku, l.unitCost])).toEqual([
      ['Chair base', 4, 'P-BASE', '12.50'],
    ])
  })

  it('says which part has nobody to buy it from, and carries on with the rest', () => {
    const noSupplier: KitPartFacts = { ...base, supplierName: null }
    const plan = planFromOrder(order({ items: expandKitItems([kitItem()], new Map([['prod-kit', [seat, noSupplier]]])) }), [supplier()])
    expect(plan.groups[0]?.lines.map((l) => l.productName)).toEqual(['Chair seat'])
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0]?.productName).toBe('Chair base')
  })

  it('charges a kit\'s delivery once, on its first part, per unit of that part', () => {
    const meta = { charges: [{ label: 'Delivery', amount: 24 }], data: { ashDelivery: { tierText: 'Next day' } } }
    const twoSeats: KitPartFacts = { ...seat, quantity: 2 }
    const out = expandKitItems([kitItem({ quantity: 3, lineMeta: meta })], new Map([['prod-kit', [twoSeats, { ...base, supplierName: 'Dynamic Office Solutions' }]]]))
    const plan = planFromOrder(order({ items: out }), [supplier()])
    const lines = plan.groups[0]!.lines
    // 3 kits x 2 seats = 6 seats at 12.00 each is the 3 x 24.00 the customer paid for.
    expect(lines[0]?.serviceCost).toBe('12.0000')
    expect(lines[1]?.serviceCost).toBeNull()
    // The instruction itself goes with every part.
    expect(lines.map((l) => l.serviceName)).toEqual(['Next day', 'Next day'])
    expect(plan.groups[0]?.carriageAmount).toBe('72.00')
  })

  it('serviceCostShare leaves the ordinary case alone', () => {
    expect(serviceCostShare('24.0000', undefined)).toBe('24.0000')
    expect(serviceCostShare(null, 2)).toBeNull()
    expect(serviceCostShare('24.0000', null)).toBeNull()
    expect(serviceCostShare('10.0000', 3)).toBe('3.3333')
  })
})
