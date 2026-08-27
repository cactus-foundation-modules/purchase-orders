import { describe, expect, it } from 'vitest'
import {
  commitmentBySupplier,
  daysBetween,
  defaultSpendRange,
  dueDateOf,
  invoicedNotReceived,
  monthLabel,
  monthsBetween,
  overdueOrders,
  receivedNotInvoiced,
  spendByMonth,
  toBasePence,
  type ReportLineFact,
} from './reporting'

const BASE: ReportLineFact = {
  orderId: 'o1',
  orderNumber: 'PO-1',
  orderStatus: 'SENT',
  supplierId: 's1',
  supplierName: 'Dynamic',
  currency: 'GBP',
  fxRate: '1',
  taxMode: 'EXCLUSIVE',
  sentAt: '2026-08-01T09:00:00.000Z',
  expectedDate: '2026-08-10',
  requiredByDate: '2026-08-12',
  description: 'Task chair',
  qty: '10.000',
  qtyCancelled: '0.000',
  qtyReceived: '0.000',
  qtyInvoiced: '0.000',
  qtyReturned: '0.000',
  unitCost: '25.0000',
  discountPercent: null,
  taxRatePercent: '20.00',
}

function fact(patch: Partial<ReportLineFact>): ReportLineFact {
  return { ...BASE, ...patch }
}

describe('toBasePence', () => {
  it('leaves a rate of one alone', () => {
    expect(toBasePence(12_345, '1')).toBe(12_345)
  })

  it('converts at the stored rate', () => {
    // 100.00 EUR at 0.85 = 85.00
    expect(toBasePence(10_000, '0.85000000')).toBe(8_500)
  })

  it('treats a missing or nonsense rate as one rather than as zero', () => {
    expect(toBasePence(10_000, null)).toBe(10_000)
    expect(toBasePence(10_000, '0')).toBe(10_000)
  })
})

describe('commitmentBySupplier', () => {
  it('counts what is still to come on a sent order', () => {
    const result = commitmentBySupplier([fact({})])
    expect(result.total).toBe('250.00')
    expect(result.orderCount).toBe(1)
    expect(result.suppliers[0]).toMatchObject({ supplierName: 'Dynamic', value: '250.00', lineCount: 1 })
  })

  it('leaves an order nobody has sent out of it', () => {
    expect(commitmentBySupplier([fact({ sentAt: null, orderStatus: 'APPROVED' })]).total).toBe('0.00')
  })

  it('leaves cancelled and closed orders out of it', () => {
    expect(commitmentBySupplier([fact({ orderStatus: 'CANCELLED' })]).total).toBe('0.00')
    expect(commitmentBySupplier([fact({ orderStatus: 'CLOSED' })]).total).toBe('0.00')
  })

  it('takes off what has arrived and puts back what went home again', () => {
    // Six of ten arrived, two of those went back: four plus two still to come.
    const result = commitmentBySupplier([fact({ qtyReceived: '6.000', qtyReturned: '2.000' })])
    expect(result.total).toBe('150.00')
  })

  it('ignores a cancelled balance', () => {
    const result = commitmentBySupplier([fact({ qtyCancelled: '4.000' })])
    expect(result.total).toBe('150.00')
  })

  it('adds a euro order in at the rate it was raised at', () => {
    const result = commitmentBySupplier([fact({ currency: 'EUR', fxRate: '0.85' })])
    expect(result.total).toBe('212.50')
  })

  it('nets a line discount off before it counts', () => {
    const result = commitmentBySupplier([fact({ discountPercent: '10.00' })])
    expect(result.total).toBe('225.00')
  })

  it('groups several orders under one supplier and counts each order once', () => {
    const result = commitmentBySupplier([
      fact({}),
      fact({ orderId: 'o2', orderNumber: 'PO-2', qty: '4.000' }),
      fact({ orderId: 'o2', orderNumber: 'PO-2', qty: '4.000', description: 'Second line' }),
    ])
    expect(result.orderCount).toBe(2)
    expect(result.suppliers).toHaveLength(1)
    expect(result.suppliers[0]!.orderCount).toBe(2)
    expect(result.suppliers[0]!.lineCount).toBe(3)
    expect(result.suppliers[0]!.value).toBe('450.00')
  })

  it('puts the biggest supplier first', () => {
    const result = commitmentBySupplier([
      fact({ supplierId: 'small', supplierName: 'Small', qty: '1.000' }),
      fact({ supplierId: 'big', supplierName: 'Big', qty: '20.000' }),
    ])
    expect(result.suppliers.map((s) => s.supplierName)).toEqual(['Big', 'Small'])
  })
})

describe('receivedNotInvoiced', () => {
  it('is the goods here that nobody has billed for', () => {
    const result = receivedNotInvoiced([fact({ qtyReceived: '10.000', qtyInvoiced: '4.000' })])
    expect(result.total).toBe('150.00')
    expect(result.rows[0]).toMatchObject({ orderNumber: 'PO-1', qty: '6.000', value: '150.00' })
  })

  it('takes off anything sent back before it accrues', () => {
    const result = receivedNotInvoiced([fact({ qtyReceived: '10.000', qtyReturned: '3.000' })])
    expect(result.total).toBe('175.00')
  })

  it('is nothing when the invoice has caught up', () => {
    expect(receivedNotInvoiced([fact({ qtyReceived: '10.000', qtyInvoiced: '10.000' })]).total).toBe('0.00')
  })

  it('keeps a CLOSED order but drops a cancelled one', () => {
    const received = { qtyReceived: '10.000', qtyInvoiced: '0.000' }
    expect(receivedNotInvoiced([fact({ ...received, orderStatus: 'CLOSED' })]).total).toBe('250.00')
    expect(receivedNotInvoiced([fact({ ...received, orderStatus: 'CANCELLED' })]).total).toBe('0.00')
  })

  it('does not count an order that has not been sent out of the accrual - goods are goods', () => {
    const result = receivedNotInvoiced([fact({ sentAt: null, orderStatus: 'DRAFT', qtyReceived: '10.000' })])
    expect(result.total).toBe('250.00')
  })
})

describe('invoicedNotReceived', () => {
  it('is what a supplier has billed for and not delivered', () => {
    const result = invoicedNotReceived([fact({ qtyInvoiced: '10.000', qtyReceived: '4.000' })])
    expect(result.total).toBe('150.00')
  })

  it('counts goods that came in and went back as not here', () => {
    const result = invoicedNotReceived([fact({ qtyInvoiced: '10.000', qtyReceived: '10.000', qtyReturned: '2.000' })])
    expect(result.total).toBe('50.00')
  })

  it('is nothing the ordinary way round', () => {
    expect(invoicedNotReceived([fact({ qtyReceived: '10.000', qtyInvoiced: '4.000' })]).total).toBe('0.00')
  })
})

describe('dueDateOf', () => {
  it('prefers the date the supplier agreed to', () => {
    expect(dueDateOf({ expectedDate: '2026-08-10', requiredByDate: '2026-08-01' })).toBe('2026-08-10')
  })

  it('falls back to the date we wanted', () => {
    expect(dueDateOf({ expectedDate: null, requiredByDate: '2026-08-01' })).toBe('2026-08-01')
  })

  it('is nothing at all when nobody put a date on it', () => {
    expect(dueDateOf({ expectedDate: null, requiredByDate: null })).toBeNull()
  })
})

describe('daysBetween', () => {
  it('counts forwards', () => {
    expect(daysBetween('2026-08-10', '2026-08-13')).toBe(3)
  })

  it('counts backwards as a negative', () => {
    expect(daysBetween('2026-08-13', '2026-08-10')).toBe(-3)
  })

  it('crosses a British summer time boundary without losing an hour', () => {
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2)
  })
})

describe('overdueOrders', () => {
  const today = '2026-08-20'

  it('lists an order past its date with something still owing', () => {
    const rows = overdueOrders([fact({})], today)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ orderNumber: 'PO-1', dueDate: '2026-08-10', daysLate: 10, outstandingValue: '250.00' })
  })

  it('leaves out one that is not due yet', () => {
    expect(overdueOrders([fact({ expectedDate: '2026-08-25' })], today)).toHaveLength(0)
  })

  it('leaves out one with no date to be late against', () => {
    expect(overdueOrders([fact({ expectedDate: null, requiredByDate: null })], today)).toHaveLength(0)
  })

  it('leaves out one that has fully arrived', () => {
    expect(overdueOrders([fact({ qtyReceived: '10.000' })], today)).toHaveLength(0)
  })

  it('rolls several lines of one order into a single row', () => {
    const rows = overdueOrders([fact({}), fact({ description: 'Second line', qty: '2.000' })], today)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.outstandingLines).toBe(2)
    expect(rows[0]!.outstandingValue).toBe('300.00')
  })

  it('carries the last chase through', () => {
    const rows = overdueOrders([fact({})], today, { o1: '2026-08-15T06:00:00.000Z' })
    expect(rows[0]!.lastChasedAt).toBe('2026-08-15T06:00:00.000Z')
  })

  it('puts the worst first', () => {
    const rows = overdueOrders(
      [fact({ orderId: 'a', orderNumber: 'PO-A', expectedDate: '2026-08-18' }), fact({ orderId: 'b', orderNumber: 'PO-B', expectedDate: '2026-07-01' })],
      today,
    )
    expect(rows.map((r) => r.orderNumber)).toEqual(['PO-B', 'PO-A'])
  })
})

describe('months', () => {
  it('names a month the way anybody would write it', () => {
    expect(monthLabel('2026-08')).toBe('Aug 2026')
  })

  it('walks a range inclusively, across a year end', () => {
    expect(monthsBetween('2026-11-14', '2027-02-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02'])
  })

  it('is empty when the range runs backwards', () => {
    expect(monthsBetween('2026-08-01', '2026-07-01')).toEqual([])
  })

  it('opens on a whole year ending today', () => {
    expect(defaultSpendRange('2026-08-27')).toEqual({ from: '2025-09-01', to: '2026-08-27' })
  })
})

describe('spendByMonth', () => {
  it('fills in the quiet months rather than skipping them', () => {
    const points = spendByMonth(
      [{ month: '2026-08', value: '1000.00' }],
      [{ month: '2026-08', value: '150.00' }],
      '2026-06-01',
      '2026-08-31',
    )
    expect(points.map((p) => p.key)).toEqual(['2026-06', '2026-07', '2026-08'])
    expect(points[0]).toMatchObject({ billed: '0.00', credited: '0.00', net: '0.00' })
    expect(points[2]).toMatchObject({ billed: '1000.00', credited: '150.00', net: '850.00' })
  })

  it('adds several rows for the same month together', () => {
    const points = spendByMonth(
      [{ month: '2026-08', value: '10.00' }, { month: '2026-08', value: '5.50' }],
      [],
      '2026-08-01',
      '2026-08-31',
    )
    expect(points[0]!.net).toBe('15.50')
  })
})
