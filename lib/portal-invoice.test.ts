import { describe, expect, it } from 'vitest'

import { anythingToInvoice, leftToInvoice, portalInvoiceLines } from './portal-invoice'
import type { PoBillableLine } from './types'

function line(patch: Partial<PoBillableLine> = {}): PoBillableLine {
  return {
    orderLineId: 'l1',
    description: 'Oak desk',
    supplierSku: 'OD-1',
    unit: 'each',
    unitCost: '120.0000',
    taxRatePercent: '20.00',
    taxRateCode: 'STANDARD',
    vatTreatment: 'UK_GOODS',
    categoryId: 'cat-1',
    qtyOrdered: '10',
    qtyCancelled: '0',
    qtyReceived: '10',
    qtyInvoiced: '0',
    ...patch,
  }
}

describe('leftToInvoice', () => {
  it('is what was ordered, less what was given up on and what is already billed', () => {
    expect(leftToInvoice(line())).toBe(10)
    expect(leftToInvoice(line({ qtyInvoiced: '4' }))).toBe(6)
    expect(leftToInvoice(line({ qtyCancelled: '2', qtyInvoiced: '4' }))).toBe(4)
  })

  it('never goes below nothing, however over-invoiced a line already is', () => {
    expect(leftToInvoice(line({ qtyInvoiced: '14' }))).toBe(0)
  })

  it('does not care what has been delivered', () => {
    // An invoice ahead of the lorry is somebody else's argument, and it is a
    // flag on the bill rather than a refusal here.
    expect(leftToInvoice(line({ qtyReceived: '0' }))).toBe(10)
  })
})

describe('portalInvoiceLines', () => {
  it('prices every line off the order rather than off anything sent', () => {
    const result = portalInvoiceLines([line()], [{ lineId: 'l1', qty: '4' }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]!.unitCost).toBe('120.0000')
    expect(result.lines[0]!.taxRatePercent).toBe('20.00')
    expect(result.lines[0]!.qty).toBe('4')
    expect(result.lines[0]!.description).toBe('Oak desk')
  })

  it('falls back to the site defaults where the order line says nothing', () => {
    const bare = line({ categoryId: null, vatTreatment: null, taxRateCode: null })
    const result = portalInvoiceLines([bare], [{ lineId: 'l1', qty: '1' }], {
      categoryId: 'cat-default',
      vatTreatment: 'UK_GOODS',
      vatRateCode: 'STANDARD',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines[0]!.categoryId).toBe('cat-default')
    expect(result.lines[0]!.vatTreatment).toBe('UK_GOODS')
    expect(result.lines[0]!.taxRateCode).toBe('STANDARD')
  })

  it('refuses a line that is not on this order', () => {
    const result = portalInvoiceLines([line()], [{ lineId: 'somebody-elses', qty: '1' }])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('not on this order')
  })

  it('refuses the same line twice', () => {
    const result = portalInvoiceLines([line()], [
      { lineId: 'l1', qty: '1' },
      { lineId: 'l1', qty: '2' },
    ])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('twice')
  })

  it('refuses more than is left to invoice', () => {
    const result = portalInvoiceLines([line({ qtyInvoiced: '8' })], [{ lineId: 'l1', qty: '3' }])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('left to invoice')
  })

  it('refuses a line that has already been invoiced in full', () => {
    const result = portalInvoiceLines([line({ qtyInvoiced: '10' })], [{ lineId: 'l1', qty: '1' }])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('already been invoiced in full')
  })

  it('refuses an invoice with nothing on it', () => {
    expect(portalInvoiceLines([line()], []).ok).toBe(false)
  })
})

describe('anythingToInvoice', () => {
  it('is true while any line has something left on it', () => {
    expect(anythingToInvoice([line({ qtyInvoiced: '9' })])).toBe(true)
  })

  it('is false once the whole order has been billed', () => {
    expect(anythingToInvoice([line({ qtyInvoiced: '10' })])).toBe(false)
  })

  it('is false on an order whose every line was cancelled', () => {
    expect(anythingToInvoice([line({ qtyCancelled: '10' })])).toBe(false)
  })
})
