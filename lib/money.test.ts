import { describe, it, expect } from 'vitest'
import { serviceLineText } from './money'

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
      .toBe('Pre-Assembled - £39.00 each, £78.00 in carriage')
  })

  it('rounds the extended figure to the penny, from a rate carried to four places', () => {
    expect(serviceLineText('Installation', '3.7550', 3, 'GBP'))
      .toBe('Installation - £3.76 each, £11.27 in carriage')
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
