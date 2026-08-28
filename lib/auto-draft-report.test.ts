import { describe, expect, it } from 'vitest'
import { autoDraftReport, autoDraftReportHtml, autoDraftReportSummary } from './auto-draft-report'
import type { FromOrderRunResult } from './from-order-run'

// A run nobody started, watched by nobody. These pin the only two questions that
// matter about it: when does somebody get told, and can a product name off a
// supplier's spreadsheet put markup in the email.

function result(patch: Partial<FromOrderRunResult> = {}): FromOrderRunResult {
  return { ordersCreated: [], skipped: [], refused: null, ...patch }
}

function raised(patch: Partial<FromOrderRunResult['ordersCreated'][number]> = {}) {
  return {
    id: 'po-1',
    number: 'PO-00042',
    supplierId: 'sup-1',
    supplierName: 'Dynamic Office Solutions',
    currency: 'GBP',
    total: '245.09',
    lineCount: 2,
    ...patch,
  }
}

describe('autoDraftReport', () => {
  it('says nothing at all when everything was bought', () => {
    expect(autoDraftReport('SO-1001', result({ ordersCreated: [raised()] }))).toBeNull()
  })

  it('says nothing when there was nothing on the order to buy and no complaint about it', () => {
    expect(autoDraftReport('SO-1001', result())).toBeNull()
  })

  it('speaks up when a line could not be bought, even though the rest was', () => {
    const report = autoDraftReport(
      'SO-1001',
      result({
        ordersCreated: [raised()],
        skipped: [{ itemId: 'i1', productName: 'Gas lift, black', reason: 'No supplier is filed against it.' }],
      }),
    )
    expect(report).not.toBeNull()
    expect(report!.raised).toHaveLength(1)
    expect(report!.skipped[0]!.productName).toBe('Gas lift, black')
  })

  it('speaks up when the run was refused, even where the refusal is the correct one', () => {
    // "Already raised" is a perfectly right answer and still worth an email: a
    // caller nobody is watching cannot tell "fine" from "did nothing" on its
    // own, and the sentence is what lets a person decide.
    const report = autoDraftReport('SO-1001', result({ refused: 'PO-00001 has already been raised for SO-1001.' }))
    expect(report!.refused).toBe('PO-00001 has already been raised for SO-1001.')
  })
})

describe('autoDraftReportSummary', () => {
  it('leads with the refusal where there is one', () => {
    const report = autoDraftReport('SO-1001', result({ refused: 'SO-1001 is refunded, so nothing is being ordered for it.' }))!
    expect(autoDraftReportSummary(report)).toBe('SO-1001 is refunded, so nothing is being ordered for it.')
  })

  it('counts what was left behind, and what still came out', () => {
    const report = autoDraftReport(
      'SO-1001',
      result({
        ordersCreated: [raised(), raised({ number: 'PO-00043' })],
        skipped: [{ itemId: 'i1', productName: 'Gas lift', reason: 'No supplier.' }],
      }),
    )!
    expect(autoDraftReportSummary(report)).toBe(
      '1 thing on it could not be ordered. The rest was drafted as 2 purchase orders.',
    )
  })

  it('says so plainly when nothing at all was drafted', () => {
    const report = autoDraftReport(
      'SO-1001',
      result({
        skipped: [
          { itemId: 'i1', productName: 'Gas lift', reason: 'No supplier.' },
          { itemId: 'i2', productName: 'Castors', reason: 'No supplier.' },
        ],
      }),
    )!
    expect(autoDraftReportSummary(report)).toBe('2 things on it could not be ordered, and nothing was drafted.')
  })
})

describe('autoDraftReportHtml', () => {
  it('escapes a product name rather than printing it as markup', () => {
    const report = autoDraftReport(
      'SO-1001',
      result({
        skipped: [{ itemId: 'i1', productName: '<script>alert(1)</script>', reason: 'No supplier & no code.' }],
      }),
    )!
    const html = autoDraftReportHtml(report)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
  })

  it('lists the drafts that did come out alongside what did not', () => {
    const report = autoDraftReport(
      'SO-1001',
      result({
        ordersCreated: [raised()],
        skipped: [{ itemId: 'i1', productName: 'Gas lift', reason: 'No supplier.' }],
      }),
    )!
    const html = autoDraftReportHtml(report)
    expect(html).toContain('PO-00042')
    expect(html).toContain('Dynamic Office Solutions')
    expect(html).toContain('Gas lift')
  })

  it('returns nothing at all rather than an empty table', () => {
    const report = autoDraftReport('SO-1001', result({ refused: 'Nothing matched a supplier.' }))!
    expect(autoDraftReportHtml(report)).toBe('')
  })
})
