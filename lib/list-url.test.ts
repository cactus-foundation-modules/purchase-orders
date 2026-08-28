import { describe, it, expect } from 'vitest'
import { assertSafeListUrl, isGoogleSheet, isPrivateHost, looksLikeHtml, toDownloadUrl } from './list-url'

// Reading a price list off an address on file is the one thing in this module
// that makes the server go somewhere, so these are all about it going only where
// it is meant to - and about fetching the FILE rather than the page that shows
// it, which is the difference between twenty thousand prices and one column of
// HTML.

describe('assertSafeListUrl', () => {
  it('takes an ordinary https address', () => {
    expect(assertSafeListUrl('https://supplier.example/prices.csv').toString()).toBe(
      'https://supplier.example/prices.csv',
    )
  })

  it('refuses anything that is not http or https', () => {
    expect(() => assertSafeListUrl('file:///etc/passwd')).toThrow(/https/)
    expect(() => assertSafeListUrl('javascript:alert(1)')).toThrow(/https/)
    expect(() => assertSafeListUrl('not a url at all')).toThrow(/web address/)
  })

  it('refuses an address pointing back inside', () => {
    for (const url of [
      'http://localhost:3000/prices.csv',
      'http://127.0.0.1/prices.csv',
      'http://10.0.0.4/prices.csv',
      'http://192.168.1.9/prices.csv',
      'http://169.254.169.254/latest/meta-data/',
      'http://172.20.3.1/prices.csv',
      'http://db.internal/prices.csv',
      'http://[::1]/prices.csv',
    ]) {
      expect(() => assertSafeListUrl(url), url).toThrow(/back at this server/)
    }
  })
})

describe('isPrivateHost', () => {
  it('lets a real supplier through', () => {
    expect(isPrivateHost('prices.supplier.co.uk')).toBe(false)
    expect(isPrivateHost('docs.google.com')).toBe(false)
    // 172.32 is outside the private block; only 172.16-31 are.
    expect(isPrivateHost('172.32.0.1')).toBe(false)
  })
})

describe('toDownloadUrl', () => {
  it('turns the Google Sheet address off the browser bar into a CSV', () => {
    expect(toDownloadUrl('https://docs.google.com/spreadsheets/d/1AbC-dEf_123/edit#gid=456')).toBe(
      'https://docs.google.com/spreadsheets/d/1AbC-dEf_123/export?format=csv&gid=456',
    )
  })

  it('keeps the tab whichever way the address carries it', () => {
    expect(toDownloadUrl('https://docs.google.com/spreadsheets/d/1AbC/edit?gid=99#gid=99')).toBe(
      'https://docs.google.com/spreadsheets/d/1AbC/export?format=csv&gid=99',
    )
  })

  it('asks for the first tab when the address names none', () => {
    expect(toDownloadUrl('https://docs.google.com/spreadsheets/d/1AbC/edit')).toBe(
      'https://docs.google.com/spreadsheets/d/1AbC/export?format=csv',
    )
  })

  it('leaves an address that already asks for a file alone', () => {
    const exported = 'https://docs.google.com/spreadsheets/d/1AbC/export?format=csv&gid=7'
    expect(toDownloadUrl(exported)).toBe(exported)
    const published = 'https://docs.google.com/spreadsheets/d/e/2PACX-1v/pub?gid=0&single=true&output=csv'
    expect(toDownloadUrl(published)).toBe(published)
  })

  it('leaves everybody else exactly as they are', () => {
    expect(toDownloadUrl('https://supplier.example/trade/prices.csv?v=2')).toBe(
      'https://supplier.example/trade/prices.csv?v=2',
    )
    // Google, but not a spreadsheet - nothing to rewrite it into.
    expect(toDownloadUrl('https://docs.google.com/document/d/1AbC/edit')).toBe(
      'https://docs.google.com/document/d/1AbC/edit',
    )
  })
})

describe('isGoogleSheet', () => {
  it('knows one when it sees one, and does not throw on rubbish', () => {
    expect(isGoogleSheet('https://docs.google.com/spreadsheets/d/1AbC/edit')).toBe(true)
    expect(isGoogleSheet('https://supplier.example/prices.csv')).toBe(false)
    expect(isGoogleSheet('nonsense')).toBe(false)
  })
})

describe('looksLikeHtml', () => {
  it('catches the sign-in page a private sheet answers with', () => {
    expect(looksLikeHtml('<!DOCTYPE html><html><head><title>Sign in')).toBe(true)
    expect(looksLikeHtml('  <html lang="en">')).toBe(true)
    expect(looksLikeHtml('Code,Price\nDS-1,12.50')).toBe(false)
  })
})
