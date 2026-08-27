import { describe, expect, it } from 'vitest'
import { csvFilename, toCsv, toCsvField, toCsvRow } from './csv'

describe('toCsvField', () => {
  it('leaves ordinary text alone', () => {
    expect(toCsvField('Task chair')).toBe('Task chair')
  })

  it('quotes anything with a comma, a quote or a line break in it', () => {
    expect(toCsvField('Chair, black')).toBe('"Chair, black"')
    expect(toCsvField('The 24" one')).toBe('"The 24"" one"')
    expect(toCsvField('Line one\nLine two')).toBe('"Line one\nLine two"')
  })

  it('defuses a cell a spreadsheet would run as a formula', () => {
    expect(toCsvField('=1+1')).toBe("'=1+1")
    expect(toCsvField('@SUM(A1)')).toBe("'@SUM(A1)")
  })

  it('leaves a negative number as a number', () => {
    expect(toCsvField('-12.50')).toBe('-12.50')
  })
})

describe('toCsvRow and toCsv', () => {
  it('joins cells with commas', () => {
    expect(toCsvRow(['PO-1', 'Dynamic', '250.00'])).toBe('PO-1,Dynamic,250.00')
  })

  it('writes a header and its rows, CRLF between them', () => {
    const csv = toCsv(['a', 'b'], [['1', '2'], ['3', '4']])
    expect(csv).toBe('a,b\r\n1,2\r\n3,4')
  })

  it('writes a header on its own when there is nothing to report', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b')
  })
})

describe('csvFilename', () => {
  it('stamps the day on it', () => {
    expect(csvFilename('orders', '2026-08-27T09:00:00.000Z')).toBe('purchasing-orders-2026-08-27.csv')
  })
})
