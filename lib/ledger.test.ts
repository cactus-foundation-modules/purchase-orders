import { describe, expect, it } from 'vitest'
import { billLedgerLines, ledgerTotals, rateCodeFor, returnLedgerLines } from './ledger'

// The arithmetic that decides what a set of books is told a purchase came to.
// Every case below is one that would put a wrong figure on a VAT return.

describe('rateCodeFor', () => {
  it('reads a percentage as the band HMRC would call it', () => {
    expect(rateCodeFor(20)).toBe('standard')
    // It has been 17.5 and 15 within living memory, and both were standard.
    expect(rateCodeFor(17.5)).toBe('standard')
    expect(rateCodeFor(15)).toBe('standard')
    expect(rateCodeFor(12.5)).toBe('reduced')
    expect(rateCodeFor(5)).toBe('reduced')
    expect(rateCodeFor(0)).toBe('zero')
  })
})

describe('billLedgerLines', () => {
  it('gives one line per line on the invoice, keeping its category', () => {
    const lines = billLedgerLines({
      lines: [
        { description: 'Desks', lineTotal: '100.00', taxRatePercent: '20', categoryId: 'cat-a' },
        { description: 'Chairs', lineTotal: '50.00', taxRatePercent: '20', categoryId: 'cat-b' },
      ],
      statedTax: '30.00',
    })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ categoryId: 'cat-a', net: '100.00', tax: '20.00', gross: '120.00' })
    expect(lines[1]).toMatchObject({ categoryId: 'cat-b', net: '50.00', tax: '10.00', gross: '60.00' })
  })

  it('falls back to the category nobody chose per line', () => {
    const lines = billLedgerLines({
      lines: [{ description: 'Sundries', lineTotal: '10.00', taxRatePercent: '20' }],
      defaultCategoryId: 'cat-default',
    })
    expect(lines[0]!.categoryId).toBe('cat-default')
  })

  it('carries the VAT the supplier printed, not the VAT we would have preferred', () => {
    // A supplier rounding line by line lands a penny over ours. The books have
    // to agree with the document HMRC would be shown.
    const lines = billLedgerLines({
      lines: [
        { description: 'A', lineTotal: '10.01', taxRatePercent: '20' },
        { description: 'B', lineTotal: '10.01', taxRatePercent: '20' },
      ],
      statedTax: '4.01',
    })
    expect(ledgerTotals(lines).tax).toBe('4.01')
    // The penny lands on one line, not spread across both.
    expect(lines.map((l) => l.tax).sort()).toEqual(['2.00', '2.01'])
  })

  it('takes every line to nil when the invoice states no VAT at all', () => {
    const lines = billLedgerLines({
      lines: [
        { description: 'A', lineTotal: '100.00', taxRatePercent: '20' },
        { description: 'B', lineTotal: '40.00', taxRatePercent: '20' },
      ],
      statedTax: '0',
    })
    expect(lines.every((l) => l.tax === '0.00')).toBe(true)
    // The rate survives, because the books work a reverse charge out from it.
    expect(lines[0]!.ratePercent).toBe('20.00')
  })

  it('never lets a reverse-charge line carry VAT', () => {
    const lines = billLedgerLines({
      lines: [
        { description: 'Scaffolding', lineTotal: '1000.00', taxRatePercent: '20', vatTreatment: 'domestic_reverse_charge' },
      ],
      statedTax: '0',
    })
    expect(lines[0]).toMatchObject({
      vatTreatment: 'domestic_reverse_charge',
      ratePercent: '20.00',
      tax: '0.00',
      gross: '1000.00',
    })
  })

  it('adds carriage as its own line at the highest rate on the bill', () => {
    const lines = billLedgerLines({
      lines: [
        { description: 'Books', lineTotal: '100.00', taxRatePercent: '0' },
        { description: 'Desks', lineTotal: '100.00', taxRatePercent: '20' },
      ],
      carriageAmount: '10.00',
      statedTax: '22.00',
    })
    expect(lines).toHaveLength(3)
    expect(lines[2]).toMatchObject({ description: 'Carriage', net: '10.00', tax: '2.00' })
  })

  it('never files a line that carries VAT as zero-rated', () => {
    // The books refuse a zero-rated line with VAT on it, and rightly: there
    // would be a figure in box 4 with no rate behind it.
    const lines = billLedgerLines({
      lines: [{ description: 'Mislabelled', lineTotal: '100.00', taxRatePercent: '20', taxRateCode: 'zero' }],
    })
    expect(lines[0]!.vatRateCode).toBe('standard')
  })

  it('leaves a genuinely zero-rated line alone', () => {
    const lines = billLedgerLines({
      lines: [{ description: 'Books', lineTotal: '100.00', taxRatePercent: '0', taxRateCode: 'zero' }],
    })
    expect(lines[0]).toMatchObject({ vatRateCode: 'zero', tax: '0.00', gross: '100.00' })
  })

  it('converts into the site own currency at the rate on the bill', () => {
    const lines = billLedgerLines({
      lines: [{ description: 'Euro desks', lineTotal: '100.00', taxRatePercent: '20' }],
      fxRate: '0.85',
    })
    expect(lines[0]).toMatchObject({ net: '85.00', tax: '17.00', gross: '102.00' })
  })

  it('drops a line that came to nothing at all', () => {
    const lines = billLedgerLines({
      lines: [
        { description: 'Nothing', lineTotal: '0', taxRatePercent: '20' },
        { description: 'Something', lineTotal: '5.00', taxRatePercent: '0' },
      ],
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.description).toBe('Something')
  })

  it('never leaves a line owing more VAT than it is worth', () => {
    // Somebody typing a wild VAT figure must not produce an entry the books
    // will refuse to save - a rejected entry loses the purchase entirely.
    const lines = billLedgerLines({
      lines: [{ description: 'A', lineTotal: '10.00', taxRatePercent: '20' }],
      statedTax: '500.00',
    })
    for (const line of lines) {
      expect(Number(line.tax)).toBeLessThanOrEqual(Number(line.net))
      expect(Number(line.gross)).toBeCloseTo(Number(line.net) + Number(line.tax), 2)
    }
  })
})

describe('returnLedgerLines', () => {
  const goods = [
    { description: 'Damaged desk', lineTotal: '100.00', taxRatePercent: '20', categoryId: 'cat-a' },
    { description: 'Wrong chair', lineTotal: '50.00', taxRatePercent: '20', categoryId: 'cat-b' },
  ]

  it('gives back positive figures - the books do the negating', () => {
    const lines = returnLedgerLines({ lines: goods, creditReceived: '180.00' })
    expect(lines).toHaveLength(2)
    expect(ledgerTotals(lines)).toEqual({ net: '150.00', tax: '30.00', gross: '180.00' })
  })

  it('scales to what the supplier actually credited', () => {
    const lines = returnLedgerLines({ lines: goods, creditReceived: '90.00' })
    const totals = ledgerTotals(lines)
    expect(totals.gross).toBe('90.00')
    // Each line keeps its own rate, so the VAT stays right at half the credit.
    expect(totals.tax).toBe('15.00')
  })

  it('comes to exactly the credit received, pennies and all', () => {
    const lines = returnLedgerLines({
      lines: [
        { description: 'A', lineTotal: '33.33', taxRatePercent: '20' },
        { description: 'B', lineTotal: '33.33', taxRatePercent: '20' },
        { description: 'C', lineTotal: '33.34', taxRatePercent: '20' },
      ],
      creditReceived: '77.77',
    })
    expect(ledgerTotals(lines).gross).toBe('77.77')
  })

  it('records nothing when no credit actually arrived', () => {
    expect(returnLedgerLines({ lines: goods, creditReceived: '0' })).toEqual([])
  })

  it('converts into the site own currency at the return rate', () => {
    const lines = returnLedgerLines({
      lines: [{ description: 'Euro desk', lineTotal: '100.00', taxRatePercent: '20' }],
      creditReceived: '120.00',
      fxRate: '0.85',
    })
    expect(ledgerTotals(lines)).toEqual({ net: '85.00', tax: '17.00', gross: '102.00' })
  })
})
