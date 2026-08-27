import { describe, it, expect } from 'vitest'
import type { OrderLineInput } from './db'
import { OrderLineBody, OrderBody, toOrderInput } from './order-body'
import { orderTotals } from './totals'

// The delivery service rides ON the product line. That decision is only safe as
// long as it stays out of the arithmetic: the moment service_cost leaks into a
// line total, every order this module has ever raised disagrees with the
// supplier's invoice by the carriage. So the two things worth pinning are that
// the fields survive the form untouched, and that the totals cannot see them.

const line = {
  description: 'Oak desk 1600mm, silver legs',
  qty: '12',
  unitCost: '165.0000',
  taxRatePercent: '20',
}

describe('the delivery service on a line', () => {
  it('is absent by default, so an older client and the reorder job are unchanged', () => {
    const parsed = OrderLineBody.parse(line)
    expect(parsed.serviceName).toBeNull()
    expect(parsed.serviceCost).toBeNull()
  })

  it('survives the form and reaches the order input unchanged', () => {
    const input = toOrderInput(
      OrderBody.parse({
        supplierId: 'supplier-1',
        lines: [{ ...line, serviceName: 'Pre-assembled delivery, two-man', serviceCost: '39.0000' }],
      }),
    )
    expect(input.lines[0]!.serviceName).toBe('Pre-assembled delivery, two-man')
    expect(input.lines[0]!.serviceCost).toBe('39.0000')
  })

  it('treats a box somebody emptied as no service at all, not as an empty one', () => {
    const input = toOrderInput(
      OrderBody.parse({
        supplierId: 'supplier-1',
        lines: [{ ...line, serviceName: '   ', serviceCost: '' }],
      }),
    )
    expect(input.lines[0]!.serviceName).toBeNull()
    expect(input.lines[0]!.serviceCost).toBeNull()
  })

  it('refuses a cost that is not a number', () => {
    // The column is NUMERIC(12,4). Left as a free string, "39 + delivery" is a
    // 500 from the database rather than a message beside the box.
    expect(() => OrderLineBody.parse({ ...line, serviceCost: '39 + delivery' })).toThrow()
    expect(() => OrderLineBody.parse({ ...line, serviceCost: '39.00001' })).toThrow()
  })

  it('changes no total: the service is carriage, not goods', () => {
    // Fed the way the create route feeds it - the whole OrderInput line, service
    // and all. TotalsLineInput cannot even name the two fields, which is the
    // real guarantee here; this is the behaviour that guarantee buys.
    const totals = (lines: OrderLineInput[]) => orderTotals({ taxMode: 'EXCLUSIVE', lines })
    const parsed = (patch: Record<string, string>) =>
      toOrderInput(OrderBody.parse({ supplierId: 'supplier-1', lines: [{ ...line, ...patch }] })).lines

    expect(totals(parsed({ serviceName: 'Two-man', serviceCost: '39.0000' }))).toEqual(totals(parsed({})))
  })

  it('reaches the money only where Stage 3 puts it - the order carriage', () => {
    // 12 x £39 of delivery service, summed into carriageAmount, taxed at the
    // highest rate on the order exactly as any other carriage is.
    const totals = orderTotals({
      taxMode: 'EXCLUSIVE',
      carriageAmount: '468.00',
      lines: [{ qty: '12', unitCost: '165.0000', taxRatePercent: '20' }],
    })
    expect(totals.subtotal).toBe('1980.00')
    expect(totals.carriageAmount).toBe('468.00')
    expect(totals.taxAmount).toBe('489.60')
    expect(totals.total).toBe('2937.60')
  })
})
