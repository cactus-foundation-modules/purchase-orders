import { describe, expect, it } from 'vitest'

import { billTotals, firstInvoiceCharges, highestTaxRate } from '@/modules/purchase-orders/lib/billing'

// The order's carriage and surcharge on its first invoice, and on no other -
// the one rule the bill screen, the supplier's own link and an invoice from
// their email all follow. The five figures are real supplier invoice totals
// (numbers only), each rebuilt from lines, carriage and surcharge at 20% VAT:
// without the order's own charges not one of them agrees with our arithmetic.

type Case = { total: string; line: string; carriage: string; surcharge: string }

const CASES: Case[] = [
  { total: '124.74', line: '88.95', carriage: '15.00', surcharge: '0' },
  { total: '170.34', line: '121.95', carriage: '15.00', surcharge: '5.00' },
  { total: '281.94', line: '214.95', carriage: '20.00', surcharge: '0' },
  { total: '330.14', line: '250.12', carriage: '25.00', surcharge: '0' },
  { total: '273.48', line: '202.90', carriage: '0', surcharge: '25.00' },
]

describe('firstInvoiceCharges', () => {
  it('puts the order’s carriage and surcharge on the first invoice', () => {
    expect(firstInvoiceCharges({ carriageAmount: '15.00', surchargeAmount: '5.00' }, [{ qtyInvoiced: '0' }])).toEqual({
      carriageAmount: '15.00',
      surchargeAmount: '5.00',
    })
  })

  it('leaves them off once anything on the order has been invoiced', () => {
    expect(firstInvoiceCharges({ carriageAmount: '15.00', surchargeAmount: '5.00' }, [{ qtyInvoiced: '0' }, { qtyInvoiced: '1' }])).toEqual({
      carriageAmount: '0',
      surchargeAmount: '0',
    })
  })

  it.each(CASES)('makes a first invoice come to their $total', ({ total, line, carriage, surcharge }) => {
    const lines = [{ qty: '1', unitCost: line, taxRatePercent: '20', qtyInvoiced: '0' }]
    const charges = firstInvoiceCharges({ carriageAmount: carriage, surchargeAmount: surcharge }, lines)
    const withCharges = billTotals({ lines, ...charges, carriageTaxRatePercent: highestTaxRate(lines) })
    expect(withCharges.total).toBe(total)
    // And the shortfall the rule exists to stop.
    if (Number(carriage) + Number(surcharge) > 0) expect(billTotals({ lines }).total).not.toBe(total)
  })
})

describe('highestTaxRate', () => {
  it('is the highest rate on the lines, or nought', () => {
    expect(highestTaxRate([{ taxRatePercent: '5' }, { taxRatePercent: '20' }])).toBe('20')
    expect(highestTaxRate([])).toBe('0')
  })
})
