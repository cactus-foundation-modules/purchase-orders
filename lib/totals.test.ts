import { describe, it, expect } from 'vitest'
import { lineAmounts, orderTotals } from './totals'

// The arithmetic on a purchase order is the one thing here that can be quietly
// wrong for months: nothing crashes, the screen looks fine, and the supplier's
// invoice simply never agrees with the order. So it is tested against the cases
// that actually bite rather than against round numbers.

describe('lineAmounts', () => {
  it('rounds once at the line, not once per unit', () => {
    // 250 x £1.005 is £251.25. Rounding the unit price to the penny first gives
    // either £250 or £252.50, and both are wrong.
    const { lineTotal, tax } = lineAmounts({ qty: '250', unitCost: '1.005', taxRatePercent: '20' }, 'EXCLUSIVE')
    expect(lineTotal).toBe('251.25')
    expect(tax).toBe(5025)
  })

  it('takes a line discount off before tax', () => {
    const { lineTotal, tax } = lineAmounts(
      { qty: '10', unitCost: '20.00', discountPercent: '15', taxRatePercent: '20' },
      'EXCLUSIVE',
    )
    expect(lineTotal).toBe('170.00')
    expect(tax).toBe(3400)
  })

  it('pulls tax back out of a price that already includes it', () => {
    const { lineTotal, net, tax } = lineAmounts({ qty: '1', unitCost: '120.00', taxRatePercent: '20' }, 'INCLUSIVE')
    expect(lineTotal).toBe('100.00')
    expect(net).toBe(10000)
    expect(tax).toBe(2000)
  })

  it('handles a fractional quantity', () => {
    const { lineTotal } = lineAmounts({ qty: '2.5', unitCost: '4.4444', taxRatePercent: '0' }, 'EXCLUSIVE')
    expect(lineTotal).toBe('11.11')
  })

  it('treats a missing rate as no tax rather than throwing', () => {
    const { tax } = lineAmounts({ qty: '3', unitCost: '9.99' }, 'EXCLUSIVE')
    expect(tax).toBe(0)
  })
})

describe('orderTotals', () => {
  it('adds the lines up and carries the tax', () => {
    const totals = orderTotals({
      lines: [
        { qty: '2', unitCost: '10.00', taxRatePercent: '20' },
        { qty: '1', unitCost: '5.50', taxRatePercent: '20' },
      ],
      taxMode: 'EXCLUSIVE',
    })
    expect(totals.subtotal).toBe('25.50')
    expect(totals.taxAmount).toBe('5.10')
    expect(totals.total).toBe('30.60')
    expect(totals.lineTotals).toEqual(['20.00', '5.50'])
  })

  it('reduces the tax in proportion to an order-level discount', () => {
    const totals = orderTotals({
      lines: [{ qty: '1', unitCost: '100.00', taxRatePercent: '20' }],
      taxMode: 'EXCLUSIVE',
      discountAmount: '10.00',
    })
    expect(totals.subtotal).toBe('100.00')
    expect(totals.discountAmount).toBe('10.00')
    expect(totals.taxAmount).toBe('18.00')
    expect(totals.total).toBe('108.00')
  })

  it('never discounts more than the goods are worth', () => {
    const totals = orderTotals({
      lines: [{ qty: '1', unitCost: '20.00', taxRatePercent: '0' }],
      taxMode: 'EXCLUSIVE',
      discountAmount: '500.00',
    })
    expect(totals.discountAmount).toBe('20.00')
    expect(totals.total).toBe('0.00')
  })

  it('taxes carriage at the highest rate on the order when none is given', () => {
    const totals = orderTotals({
      lines: [
        { qty: '1', unitCost: '100.00', taxRatePercent: '0' },
        { qty: '1', unitCost: '100.00', taxRatePercent: '20' },
      ],
      taxMode: 'EXCLUSIVE',
      carriageAmount: '10.00',
    })
    expect(totals.carriageAmount).toBe('10.00')
    // 20.00 on the standard-rated line, 2.00 on the carriage.
    expect(totals.taxAmount).toBe('22.00')
    expect(totals.total).toBe('232.00')
  })

  it('adds up an empty order to nothing rather than NaN', () => {
    const totals = orderTotals({ lines: [], taxMode: 'EXCLUSIVE' })
    expect(totals.subtotal).toBe('0.00')
    expect(totals.total).toBe('0.00')
  })
})
