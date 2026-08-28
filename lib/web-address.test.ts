import { describe, expect, it } from 'vitest'
import { webAddress } from '@/modules/purchase-orders/lib/web-address'

// The one string on this module that a stranger types and somebody here clicks.
describe('a tracking link somebody has typed', () => {
  it('takes a plain address as it is', () => {
    expect(webAddress('https://track.example.com/PW-882')).toBe('https://track.example.com/PW-882')
    expect(webAddress('  http://track.example.com/PW-882  ')).toBe('http://track.example.com/PW-882')
  })

  it('reads a bare host as https, because that is what they meant', () => {
    expect(webAddress('track.example.com/PW-882')).toBe('https://track.example.com/PW-882')
  })

  it('refuses anything that is not http or https', () => {
    // The whole reason this exists rather than zod's .url(), which waves every
    // one of these through and leaves them sitting in an href in the admin.
    expect(webAddress('javascript:alert(1)')).toBeNull()
    expect(webAddress('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(webAddress('file:///etc/passwd')).toBeNull()
    expect(webAddress('vbscript:msgbox(1)')).toBeNull()
  })

  it('treats an empty box as no address rather than a bad one', () => {
    expect(webAddress('')).toBeNull()
    expect(webAddress('   ')).toBeNull()
    expect(webAddress(null)).toBeNull()
    expect(webAddress(undefined)).toBeNull()
  })

  it('refuses one longer than the column takes', () => {
    expect(webAddress(`https://track.example.com/${'x'.repeat(500)}`)).toBeNull()
  })
})
