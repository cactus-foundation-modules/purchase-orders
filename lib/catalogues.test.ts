import { describe, it, expect } from 'vitest'
import { parseCsv } from './csv'
import {
  applyRetailDiscount,
  catalogueNameKey,
  catalogueSkuKey,
  parseCatalogueCsv,
  parseListFlag,
  parseListMoney,
  type CatalogueImportItem,
} from './catalogue-import'
import { buyingCode, countChanges, diffCatalogue, reconcileCatalogue } from './catalogue-matching'
import { unitCostFor, type ReorderProductFacts } from './reordering'
import { planFromOrder, type ShopOrderFacts } from './from-order'
import type { ReorderSupplierFacts } from './reordering'
import type { PoCatalogueCost } from './types'

// A price list decides what a supplier gets paid, so every one of these is about
// it NOT quietly doing something: not importing a column of retail prices, not
// dropping a row in silence, not calling two chairs a rename, and not pricing
// anything at all on a site that has not asked for it.

function item(patch: Partial<CatalogueImportItem> = {}): CatalogueImportItem {
  return {
    supplierSku: 'DS-1234',
    supplierSkuKey: 'DS1234',
    description: 'Task chair, black',
    unitCost: '40.0000',
    packSize: null,
    minimumOrderQty: null,
    leadTimeDays: null,
    discountGroup: null,
    discontinued: false,
    ...patch,
  }
}

function cost(patch: Partial<PoCatalogueCost> = {}): PoCatalogueCost {
  return {
    catalogueId: 'c1',
    catalogueName: 'Seating 2026',
    supplierSku: 'DS-1234',
    description: 'Task chair, black',
    unitCost: '40.0000',
    discontinued: false,
    leadTimeDays: null,
    minimumOrderQty: null,
    ...patch,
  }
}

describe('parseCsv', () => {
  it('reads quoted fields, doubled quotes and commas inside them', () => {
    expect(parseCsv('a,"b,c","he said ""no"""')).toEqual([['a', 'b,c', 'he said "no"']])
  })

  it('reads CRLF and LF alike, and a trailing newline adds no row', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(parseCsv('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('reads a newline inside a quoted field as part of it', () => {
    expect(parseCsv('a,"line one\nline two"')).toEqual([['a', 'line one\nline two']])
  })

  it('strips the byte order mark Excel writes', () => {
    // Left in, it becomes part of the first header and nothing matches it.
    expect(parseCsv('﻿Code,Price')).toEqual([['Code', 'Price']])
  })
})

describe('catalogueSkuKey', () => {
  it('matches the same code however the supplier punctuated it', () => {
    expect(catalogueSkuKey('DS-1234')).toBe('DS1234')
    expect(catalogueSkuKey('ds 1234')).toBe('DS1234')
    expect(catalogueSkuKey(' ds.1234 ')).toBe('DS1234')
  })
})

describe('catalogueNameKey', () => {
  it('treats one list typed two ways as one list', () => {
    expect(catalogueNameKey('  Seating   2026 ')).toBe('seating 2026')
  })
})

describe('parseListMoney', () => {
  it('reads what a spreadsheet actually contains', () => {
    expect(parseListMoney('£1,234.50')).toBe('1234.5000')
    expect(parseListMoney(' 40 ')).toBe('40.0000')
    expect(parseListMoney('(12.50)')).toBe('-12.5000')
  })

  it('is blank for a blank cell and REFUSES anything that is not a number', () => {
    // The refusal matters: a price list silently full of zeroes is how a
    // purchase order goes out at nothing.
    expect(parseListMoney('')).toBeNull()
    expect(parseListMoney('POA')).toBeUndefined()
    expect(parseListMoney('39 + delivery')).toBeUndefined()
  })

  it('rounds to the four places the column holds', () => {
    expect(parseListMoney('1.23456')).toBe('1.2346')
  })
})

describe('parseListFlag', () => {
  it('reads a discontinued column however it was said', () => {
    expect(parseListFlag('Yes')).toBe(true)
    expect(parseListFlag('TRUE')).toBe(true)
    expect(parseListFlag('discontinued')).toBe(true)
    expect(parseListFlag('')).toBe(false)
    expect(parseListFlag('no')).toBe(false)
  })

  it('takes anything it does not recognise as still sold', () => {
    // Marking a live product discontinued on a typo stops it being ordered,
    // which is the more expensive way to be wrong.
    expect(parseListFlag('probably?')).toBe(false)
  })
})

/** A supplier's export, in miniature: a blank line, a title, a row of merged
 *  group headings, and the columns on row four. Two codes that could both be
 *  "the" code, and a price column called RRP. All of it copied from a real one. */
const SHEET = [
  ',,,',
  'Seating Dataset,,,',
  ',,Dimensions (mm),',
  'SKU,Catalogue Code,Product Name,RRP',
  'AC000001,CHIROARMS,Chiro arm set,84',
  'AC000002,ISOARMS,ISO arm set,43',
].join('\n')

describe('parseCatalogueCsv', () => {
  it('reads a two-column list', () => {
    const result = parseCatalogueCsv('Code,Price\nDS-1234,40.00\nDS-5678,55.50\n')
    expect(result.problems).toEqual([])
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({ supplierSku: 'DS-1234', supplierSkuKey: 'DS1234', unitCost: '40.0000' })
  })

  it('takes the headers a supplier actually uses', () => {
    const result = parseCatalogueCsv(
      'Supplier SKU,Product Name,Trade Price,Pack Size,MOQ,Lead time (days),Discount Group,Discontinued\n' +
        'DS-1234,Task chair,40.00,2,4,21,B,Yes\n',
    )
    expect(result.columns.unitCost).toBe('Trade Price')
    expect(result.items[0]).toMatchObject({
      description: 'Task chair',
      unitCost: '40.0000',
      packSize: '2.000',
      minimumOrderQty: '4.000',
      leadTimeDays: 21,
      discountGroup: 'B',
      discontinued: true,
    })
  })

  it('prefers the trade price over the retail one', () => {
    // A list carrying both must not be imported at retail.
    const result = parseCatalogueCsv('Code,Price,Trade Price\nDS-1234,120.00,40.00\n')
    expect(result.columns.unitCost).toBe('Trade Price')
    expect(result.items[0]!.unitCost).toBe('40.0000')
  })

  it('refuses a file with nothing that looks like a code', () => {
    const result = parseCatalogueCsv('Colour,Price\nBlack,40.00\n')
    expect(result.items).toEqual([])
    expect(result.problems[0]!.message).toContain('product code')
  })

  it('reports a bad row by its spreadsheet row number and imports the rest', () => {
    const result = parseCatalogueCsv('Code,Price\nDS-1,40.00\nDS-2,POA\nDS-3,55.00\n')
    expect(result.items.map((i) => i.supplierSku)).toEqual(['DS-1', 'DS-3'])
    expect(result.problems).toEqual([{ row: 3, message: 'DS-2: "POA" is not a price.' }])
  })

  it('reports a row with no code at all', () => {
    const result = parseCatalogueCsv('Code,Price\n,40.00\n')
    expect(result.items).toEqual([])
    expect(result.problems[0]!.message).toContain('No supplier code')
  })

  it('counts blank rows rather than complaining about them', () => {
    const result = parseCatalogueCsv('Code,Price\nDS-1,40.00\n\n\nDS-2,50.00\n')
    expect(result.items).toHaveLength(2)
    expect(result.blankRows).toBe(2)
    expect(result.problems).toEqual([])
  })

  it('keeps the first of a repeated code, and only complains when the repeat disagrees', () => {
    const same = parseCatalogueCsv('Code,Price\nDS-1,40.00\nds 1,40.00\n')
    expect(same.items).toHaveLength(1)
    expect(same.duplicateRows).toBe(1)
    expect(same.problems).toEqual([])

    const different = parseCatalogueCsv('Code,Price\nDS-1,40.00\nDS-1,45.00\n')
    expect(different.items).toHaveLength(1)
    expect(different.items[0]!.unitCost).toBe('40.0000')
    expect(different.problems[0]!.message).toContain('twice saying two different things')
  })

  it('finds the headings on row four, under a title and a row of group headings', () => {
    // What a supplier's export actually looks like: a blank line, a title, a row
    // of merged group headings, and only then the columns. Reading row one and
    // giving up is how a perfectly good price list imports as nothing at all.
    const result = parseCatalogueCsv(SHEET)
    expect(result.headerRow).toBe(4)
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({ description: 'Chiro arm set', unitCost: '84.0000' })
  })

  it('takes the row and the columns somebody picked by hand', () => {
    // The case no amount of guessing settles: a sheet carrying both "SKU" and
    // "Catalogue Code". Which one goes on the purchase order is a fact about the
    // supplier, not about the file, so somebody has to be able to say.
    expect(parseCatalogueCsv(SHEET).columns.supplierSku).toBe('Catalogue Code')

    const result = parseCatalogueCsv(SHEET, {
      headerRow: 4,
      columns: { supplierSku: { index: 0 }, description: { index: 2 }, unitCost: { index: 3 } },
    })
    expect(result.columns.supplierSku).toBe('SKU')
    expect(result.items[0]!.supplierSku).toBe('AC000001')
    expect(result.mapping).toEqual({
      headerRow: 4,
      columns: {
        supplierSku: { index: 0, header: 'SKU' },
        description: { index: 2, header: 'Product Name' },
        unitCost: { index: 3, header: 'RRP' },
      },
    })
  })

  it('treats a mapping as the whole truth, so a column can be said not to be there', () => {
    // Otherwise "no, that is not the price" is unsayable, and every correction
    // leaves whatever was guessed before still in place underneath it.
    const result = parseCatalogueCsv('Code,Price\nDS-1,40.00\n', { headerRow: 1, columns: { supplierSku: { index: 0 } } })
    expect(result.items[0]).toMatchObject({ supplierSku: 'DS-1', unitCost: null })
  })

  it('follows a heading that has moved down the sheet rather than the row number', () => {
    // A supplier adding a line above their headings shifts every row number and
    // renames nothing. Pinning the number alone would read the group headings.
    const result = parseCatalogueCsv(`,,,\n${SHEET}`, {
      headerRow: 4,
      columns: { supplierSku: { index: 0, header: 'SKU' } },
    })
    expect(result.headerRow).toBe(5)
    expect(result.items[0]!.supplierSku).toBe('AC000001')
  })

  it('follows the heading rather than the position when a column is inserted', () => {
    const result = parseCatalogueCsv('Note,Code,Price\nx,DS-1,40.00\n', {
      headerRow: 1,
      columns: { supplierSku: { index: 0, header: 'Code' }, unitCost: { index: 1, header: 'Price' } },
    })
    expect(result.items[0]).toMatchObject({ supplierSku: 'DS-1', unitCost: '40.0000' })
  })

  it('hands back the top of the file so somebody can point at the right columns', () => {
    const result = parseCatalogueCsv('Colour,Shade\nBlack,Dark\n')
    expect(result.headerRow).toBe(0)
    expect(result.items).toEqual([])
    expect(result.topRows).toEqual([
      ['Colour', 'Shade'],
      ['Black', 'Dark'],
    ])
  })

  it('does not let one column fill two fields', () => {
    // "Code" is an alias for the supplier code; it must not also be read as a
    // discount group on a list that has no discount group.
    const result = parseCatalogueCsv('Code,Price\nDS-1,40.00\n')
    expect(result.columns.supplierSku).toBe('Code')
    expect(result.columns.discountGroup).toBeNull()
    expect(result.items[0]!.discountGroup).toBeNull()
  })
})

describe('applyRetailDiscount', () => {
  it('takes the supplier discount off every price', () => {
    const out = applyRetailDiscount([item({ unitCost: '100.0000' }), item({ supplierSkuKey: 'B', unitCost: '41.6700' })], '25')
    expect(out[0]!.unitCost).toBe('75.0000')
    expect(out[1]!.unitCost).toBe('31.2525')
  })

  it('works in whole ten-thousandths rather than in floating point', () => {
    // 0.1 + 0.2 arithmetic on this one gives 31.252499999999998 and a price a
    // hundredth of a penny light on every line of a twenty thousand row list.
    expect(applyRetailDiscount([item({ unitCost: '41.6700' })], '25.00')[0]!.unitCost).toBe('31.2525')
    // 12.5% of 19.99 is 2.49875, and it is the DISCOUNT that rounds - half up,
    // exactly as a line discount does in lib/totals.ts - so the price left is
    // 17.4912 rather than the 17.4913 rounding the answer would give.
    expect(applyRetailDiscount([item({ unitCost: '19.9900' })], '12.5')[0]!.unitCost).toBe('17.4912')
  })

  it('hands the list straight back when there is no discount to take', () => {
    const items = [item()]
    expect(applyRetailDiscount(items, null)).toBe(items)
    expect(applyRetailDiscount(items, '0')).toBe(items)
    expect(applyRetailDiscount(items, undefined)).toBe(items)
  })

  it('leaves a row with no price without one, rather than inventing a zero', () => {
    expect(applyRetailDiscount([item({ unitCost: null })], '25')[0]!.unitCost).toBeNull()
  })

  it('changes nothing else about the row', () => {
    const [out] = applyRetailDiscount([item({ description: 'Task chair', discontinued: true })], '10')
    expect(out!.description).toBe('Task chair')
    expect(out!.discontinued).toBe(true)
    expect(out!.supplierSkuKey).toBe('DS1234')
  })
})

describe('diffCatalogue', () => {
  const previous = [
    { supplierSku: 'DS-1', supplierSkuKey: 'DS1', description: 'Task chair', unitCost: '40.0000', discontinued: false },
    { supplierSku: 'DS-2', supplierSkuKey: 'DS2', description: 'Desk', unitCost: '80.0000', discontinued: false },
  ]

  it('calls a code that has come back under a new number a rename', () => {
    const changes = diffCatalogue(previous, [
      item({ supplierSku: 'DS-1A', supplierSkuKey: 'DS1A', description: 'Task chair', unitCost: '42.0000' }),
      item({ supplierSku: 'DS-2', supplierSkuKey: 'DS2', description: 'Desk', unitCost: '80.0000' }),
    ])
    const renamed = changes.find((c) => c.kind === 'RENAMED')
    expect(renamed).toMatchObject({ supplierSku: 'DS-1', becomes: 'DS-1A' })
    // And it is not ALSO reported as an addition and a removal.
    expect(changes.filter((c) => c.kind === 'ADDED' || c.kind === 'REMOVED')).toEqual([])
  })

  it('refuses to guess when two codes share one description', () => {
    // A range renumbering. Pairing the wrong two would be acted on.
    const changes = diffCatalogue(
      [
        { supplierSku: 'A-1', supplierSkuKey: 'A1', description: 'Task chair', unitCost: '40.0000', discontinued: false },
        { supplierSku: 'A-2', supplierSkuKey: 'A2', description: 'Task chair', unitCost: '41.0000', discontinued: false },
      ],
      [
        item({ supplierSku: 'B-1', supplierSkuKey: 'B1', description: 'Task chair' }),
        item({ supplierSku: 'B-2', supplierSkuKey: 'B2', description: 'Task chair' }),
      ],
    )
    expect(changes.filter((c) => c.kind === 'RENAMED')).toEqual([])
    expect(countChanges(changes)).toMatchObject({ ADDED: 2, REMOVED: 2, RENAMED: 0 })
  })

  it('reports a price that has moved, and does not report 12.5 becoming 12.5000', () => {
    const changes = diffCatalogue(previous, [
      item({ supplierSku: 'DS-1', supplierSkuKey: 'DS1', description: 'Task chair', unitCost: '40' }),
      item({ supplierSku: 'DS-2', supplierSkuKey: 'DS2', description: 'Desk', unitCost: '84.0000' }),
    ])
    expect(changes.filter((c) => c.kind === 'REPRICED').map((c) => c.supplierSku)).toEqual(['DS-2'])
  })

  it('reports a code the supplier has stopped selling, and one they have started again', () => {
    const stopped = diffCatalogue(previous, [
      item({ supplierSku: 'DS-1', supplierSkuKey: 'DS1', description: 'Task chair', discontinued: true }),
      item({ supplierSku: 'DS-2', supplierSkuKey: 'DS2', description: 'Desk', unitCost: '80.0000' }),
    ])
    expect(stopped.find((c) => c.kind === 'DISCONTINUED')?.supplierSku).toBe('DS-1')

    const restarted = diffCatalogue(
      [{ supplierSku: 'DS-1', supplierSkuKey: 'DS1', description: 'Task chair', unitCost: '40.0000', discontinued: true }],
      [item({ supplierSku: 'DS-1', supplierSkuKey: 'DS1', description: 'Task chair' })],
    )
    expect(restarted.find((c) => c.kind === 'RESTORED')?.supplierSku).toBe('DS-1')
  })

  it('reports a first import as all additions and nothing else', () => {
    const changes = diffCatalogue([], [item(), item({ supplierSku: 'DS-5', supplierSkuKey: 'DS5' })])
    expect(countChanges(changes)).toEqual({ ADDED: 2, REMOVED: 0, RENAMED: 0, REPRICED: 0, DISCONTINUED: 0, RESTORED: 0 })
  })
})

describe('buyingCode', () => {
  it('uses the supplier’s own code, and falls back to ours', () => {
    expect(buyingCode({ id: 'p', name: 'x', sku: 'CHR-1', supplierSku: 'DS-1234', costPrice: null })).toBe('DS-1234')
    expect(buyingCode({ id: 'p', name: 'x', sku: 'CHR-1', supplierSku: null, costPrice: null })).toBe('CHR-1')
    expect(buyingCode({ id: 'p', name: 'x', sku: null, supplierSku: null, costPrice: null })).toBeNull()
  })
})

describe('reconcileCatalogue', () => {
  const costs = new Map<string, PoCatalogueCost>([['DS1234', cost()]])

  it('says nothing about a product whose code and price both agree', () => {
    const report = reconcileCatalogue(
      's1',
      'Dynamic',
      [{ id: 'p1', name: 'Task chair', sku: 'CHR-1', supplierSku: 'DS-1234', costPrice: '40.00' }],
      costs,
      2,
    )
    expect(report.findings).toEqual([])
    expect(report.matchedCount).toBe(1)
  })

  it('flags a code the list does not name', () => {
    const report = reconcileCatalogue(
      's1',
      'Dynamic',
      [{ id: 'p1', name: 'Task chair', sku: 'CHR-1', supplierSku: 'DS-9999', costPrice: '40.00' }],
      costs,
      2,
    )
    expect(report.findings[0]).toMatchObject({ kind: 'UNKNOWN_CODE', code: 'DS-9999' })
    expect(report.matchedCount).toBe(0)
  })

  it('flags a code they have stopped selling, and says nothing else about it', () => {
    const report = reconcileCatalogue(
      's1',
      'Dynamic',
      [{ id: 'p1', name: 'Task chair', sku: 'CHR-1', supplierSku: 'DS-1234', costPrice: '99.00' }],
      new Map([['DS1234', cost({ discontinued: true })]]),
      2,
    )
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]!.kind).toBe('DISCONTINUED')
  })

  it('flags a price that has drifted past the tolerance and ignores one inside it', () => {
    const inside = reconcileCatalogue(
      's1',
      'Dynamic',
      [{ id: 'p1', name: 'Task chair', sku: 'CHR-1', supplierSku: 'DS-1234', costPrice: '40.40' }],
      costs,
      2,
    )
    expect(inside.findings).toEqual([])

    const outside = reconcileCatalogue(
      's1',
      'Dynamic',
      [{ id: 'p1', name: 'Task chair', sku: 'CHR-1', supplierSku: 'DS-1234', costPrice: '48.00' }],
      costs,
      2,
    )
    expect(outside.findings[0]).toMatchObject({ kind: 'PRICE_MOVED', ourCost: '48.00', theirCost: '40.0000' })
  })

  it('says nothing about a product with no code at all', () => {
    const report = reconcileCatalogue(
      's1',
      'Dynamic',
      [{ id: 'p1', name: 'Bought on the phone', sku: null, supplierSku: null, costPrice: '40.00' }],
      costs,
      2,
    )
    expect(report.findings).toEqual([])
  })

  it('counts the codes they sell that we do not, rather than listing them', () => {
    const report = reconcileCatalogue('s1', 'Dynamic', [], costs, 2)
    expect(report.findings).toEqual([])
    expect(report.unsoldCodeCount).toBe(1)
  })
})

describe('unitCostFor', () => {
  function product(patch: Partial<ReorderProductFacts> = {}): ReorderProductFacts {
    return {
      id: 'p1',
      name: 'Task chair',
      sku: 'CHR-1',
      supplierSku: 'DS-1234',
      supplierName: 'Dynamic',
      costPrice: '40.00',
      stockCount: 1,
      trackInventory: true,
      ...patch,
    }
  }

  it('prices off the supplier’s current list before anything else', () => {
    const priced = unitCostFor(product(), 's1', '38.00', { 's1::DS1234': cost({ unitCost: '42.0000' }) })
    expect(priced).toMatchObject({ unitCost: '42.0000', costSource: 'CATALOGUE', catalogueName: 'Seating 2026' })
  })

  it('falls back to what they last charged, then to the product', () => {
    expect(unitCostFor(product(), 's1', '38.00', {})).toMatchObject({ unitCost: '38.00', costSource: 'PRODUCT' })
    expect(unitCostFor(product(), 's1', null, {})).toMatchObject({ unitCost: '40.00', costSource: 'PRODUCT' })
    expect(unitCostFor(product({ costPrice: null }), 's1', null, {})).toMatchObject({ unitCost: '0', costSource: 'NONE' })
  })

  it('behaves exactly as it did before price lists on a site with none', () => {
    // The whole feature is off by default: absent costs must change nothing.
    expect(unitCostFor(product(), 's1', '38.00', undefined).unitCost).toBe('38.00')
  })

  it('does not let a list entry with no price on it win', () => {
    const priced = unitCostFor(product(), 's1', '38.00', { 's1::DS1234': cost({ unitCost: null }) })
    expect(priced).toMatchObject({ unitCost: '38.00', costSource: 'PRODUCT' })
  })

  it('does not price off ANOTHER supplier’s list', () => {
    const priced = unitCostFor(product(), 's1', '38.00', { 's2::DS1234': cost({ unitCost: '42.0000' }) })
    expect(priced.unitCost).toBe('38.00')
  })

  it('brings back their own words for the thing, price or no price', () => {
    // The description comes off the LIST, not off the price on it: a code they
    // have recorded without a figure is still a code they have a name for.
    expect(unitCostFor(product(), 's1', '38.00', { 's1::DS1234': cost({ unitCost: '42.0000' }) }).catalogueDescription)
      .toBe('Task chair, black')
    expect(unitCostFor(product(), 's1', '38.00', { 's1::DS1234': cost({ unitCost: null }) }).catalogueDescription)
      .toBe('Task chair, black')
    expect(unitCostFor(product(), 's1', '38.00', { 's1::DS1234': cost({ description: '  ' }) }).catalogueDescription)
      .toBeNull()
    expect(unitCostFor(product(), 's1', '38.00', {}).catalogueDescription).toBeNull()
  })
})

describe('planFromOrder with a price list', () => {
  const supplier: ReorderSupplierFacts = {
    id: 's1',
    name: 'Dynamic',
    nameKey: 'dynamic',
    status: 'ENABLED',
    currency: 'GBP',
    minimumOrderValue: null,
    carriagePaidOver: null,
    carriageCharge: null,
    defaultVatRateCode: null,
  }

  const order: ShopOrderFacts = {
    id: 'o1',
    orderNumber: 'DW000135',
    status: 'PAID',
    customerName: 'A Customer',
    customerPhone: null,
    customerOrganisation: null,
    currency: 'GBP',
    shippingAddress: null,
    items: [
      {
        itemId: 'i1',
        productId: 'p1',
        productName: 'Task chair',
        quantity: 1,
        unitPrice: '162.00',
        sku: 'CHR-1',
        supplierSku: 'DS-1234',
        supplierName: 'Dynamic',
        costPrice: '153.18',
        lineMeta: null,
      },
    ],
  }

  it('still prices off the product when no list is handed over', () => {
    // The default, and what every site that has not switched lists on gets.
    const plan = planFromOrder(order, [supplier])
    expect(plan.groups[0]!.lines[0]).toMatchObject({ unitCost: '153.18', costSource: 'PRODUCT', catalogueName: null })
  })

  it('prices off the supplier’s list when there is one, and never off the price the customer paid', () => {
    const plan = planFromOrder(order, [supplier], new Map([['s1::DS1234', cost({ unitCost: '149.9900' })]]))
    const line = plan.groups[0]!.lines[0]!
    expect(line.unitCost).toBe('149.9900')
    expect(line.costSource).toBe('CATALOGUE')
    expect(line.catalogueName).toBe('Seating 2026')
    expect(line.unitCost).not.toBe('162.00')
  })

  it('marks a line whose code the supplier has stopped selling, and still drafts it', () => {
    const plan = planFromOrder(order, [supplier], new Map([['s1::DS1234', cost({ discontinued: true })]]))
    expect(plan.groups[0]!.lines[0]).toMatchObject({ discontinued: true })
    expect(plan.skipped).toEqual([])
  })

  it('carries the supplier’s own name for the thing, and keeps ours alongside it', () => {
    // Our listing title is our own invention and means nothing on their order
    // form. Theirs goes on the line; ours stays on it for the receiving screen
    // and the reports to match against.
    const plan = planFromOrder(order, [supplier], new Map([['s1::DS1234', cost()]]))
    const line = plan.groups[0]!.lines[0]!
    expect(line.catalogueDescription).toBe('Task chair, black')
    expect(line.productName).toBe('Task chair')
  })

  it('has no name of theirs to use when their list does not carry the code', () => {
    expect(planFromOrder(order, [supplier]).groups[0]!.lines[0]!.catalogueDescription).toBeNull()
    const blank = planFromOrder(order, [supplier], new Map([['s1::DS1234', cost({ description: '' })]]))
    expect(blank.groups[0]!.lines[0]!.catalogueDescription).toBeNull()
  })
})
