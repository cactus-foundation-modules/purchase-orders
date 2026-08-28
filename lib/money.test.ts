import { describe, it, expect } from 'vitest'
import { formatQtyUnit, serviceExtendedCost, serviceLineName, serviceLineText, unitLabel, withUnit } from './money'

// The delivery service is the one thing on a purchase order line the supplier
// has to act on differently from every other order, and its price is the one
// figure a single carriage total at the foot cannot attribute. Both are printed
// on the line, and both are printed by this function - the document and the
// email share it so they cannot word the same line two ways.

describe('the delivery service sentence', () => {
  it('says the price and says it is carriage, not goods', () => {
    expect(serviceLineText('Pre-Assembled, expected 3 September 2026', '39.0000', 1, 'GBP'))
      .toBe('Pre-Assembled, expected 3 September 2026 - £39.00 in carriage')
  })

  it('gives the unit rate and the extended figure where there is more than one', () => {
    expect(serviceLineText('Pre-Assembled', '39.0000', 2, 'GBP'))
      .toBe('Pre-Assembled - £39.00 a unit, £78.00 in carriage')
  })

  it('rounds the extended figure to the penny, from a rate carried to four places', () => {
    expect(serviceLineText('Installation', '3.7550', 3, 'GBP'))
      .toBe('Installation - £3.76 a unit, £11.27 in carriage')
  })

  it('prints the service alone when it cost nothing - a free delivery is still a promise', () => {
    expect(serviceLineText('Flat-Pack, expected 8 September 2026', null, 1, 'GBP'))
      .toBe('Flat-Pack, expected 8 September 2026')
    expect(serviceLineText('Flat-Pack', '0.0000', 1, 'GBP')).toBe('Flat-Pack')
  })

  it('names a charge with no service rather than printing a bare figure', () => {
    expect(serviceLineText(null, '12.0000', 1, 'GBP')).toBe('Delivery - £12.00 in carriage')
  })

  it('is nothing at all on a line with no service and no charge', () => {
    expect(serviceLineText(null, null, 1, 'GBP')).toBeNull()
    expect(serviceLineText('   ', null, 1, 'GBP')).toBeNull()
  })

  it('follows the order into another currency', () => {
    expect(serviceLineText('Delivery', '10.0000', 1, 'PLN')).toBe('Delivery - zł 10.00 in carriage')
  })
})

// The printed document has money columns to put those figures in, so it names
// the service and prices it beside the goods instead of saying it in a sentence.
// Same two figures, arrived at the same way.

describe('the delivery service in the money columns', () => {
  it('names the service with no money in it', () => {
    expect(serviceLineName('Pre-Assembled, expected 3 September 2026', '39.0000'))
      .toBe('Pre-Assembled, expected 3 September 2026')
  })

  it('calls a bare charge Delivery rather than printing a figure under nothing', () => {
    expect(serviceLineName(null, '12.0000')).toBe('Delivery')
    expect(serviceLineName(null, null)).toBeNull()
    expect(serviceLineName('   ', null)).toBeNull()
  })

  it('extends the rate over the quantity, rounded to the penny once', () => {
    expect(serviceExtendedCost('39.0000', 2)).toBe('78.00')
    expect(serviceExtendedCost('3.7550', 3)).toBe('11.27')
    expect(serviceExtendedCost('49.9500', 1)).toBe('49.95')
  })

  it('has no figure to print where nothing was charged', () => {
    expect(serviceExtendedCost(null, 3)).toBeNull()
    expect(serviceExtendedCost('0.0000', 3)).toBeNull()
  })

  it('treats a missing quantity as one rather than as nothing', () => {
    expect(serviceExtendedCost('12.0000', null)).toBe('12.00')
  })
})

describe('unitLabel', () => {
  it('swallows the column default and nothing else', () => {
    // 'each' is what every line raised without touching the unit box carries, so
    // printing it put the word after every quantity in the module.
    for (const same of ['each', 'Each', 'EACH', '  each  ']) expect(unitLabel(same)).toBe('')
    expect(unitLabel(null)).toBe('')
    expect(unitLabel('')).toBe('')
    // Anything somebody actually typed still prints - it changes what the
    // number means.
    expect(unitLabel('m')).toBe('m')
    expect(unitLabel('boxes')).toBe('boxes')
    expect(unitLabel('ea')).toBe('ea')
    expect(unitLabel(' pallets ')).toBe('pallets')
  })
})

describe('formatQtyUnit and withUnit', () => {
  it('prints a bare count for the default unit', () => {
    expect(formatQtyUnit('4.000', 'each')).toBe('4')
    expect(formatQtyUnit('4.000', null)).toBe('4')
    expect(withUnit('4', 'each')).toBe('4')
  })

  it('keeps a real unit beside the figure', () => {
    expect(formatQtyUnit('2.500', 'm')).toBe('2.5 m')
    expect(withUnit('2.5', 'm')).toBe('2.5 m')
  })

  it('leaves an already-rendered figure exactly as the caller wrote it', () => {
    expect(withUnit('0.50', 'boxes')).toBe('0.50 boxes')
  })
})
