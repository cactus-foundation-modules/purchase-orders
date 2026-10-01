import { describe, expect, it } from 'vitest'
import { PoConfigSchema, trackingLinkHostList } from './config'

// "Also trust tracking links to" is refused at save time when it lists a bare
// public suffix, which would trust every site registered under it.

describe('the trusted tracking hosts setting', () => {
  it('refuses a bare public suffix', () => {
    for (const text of ['co.uk', 'com', 'tracking.courier.co.uk\norg.uk', 'https://co.uk/', 'vercel.app', 'github.io']) {
      expect(PoConfigSchema.partial().safeParse({ trackingLinkHosts: text }).success).toBe(false)
    }
  })

  it('takes whole websites, one per line or comma separated', () => {
    const parsed = PoConfigSchema.partial().safeParse({ trackingLinkHosts: 'tracking.courier.co.uk, https://track.example.com/x' })
    expect(parsed.success).toBe(true)
    expect(trackingLinkHostList('tracking.courier.co.uk, https://track.example.com/x')).toEqual(['tracking.courier.co.uk', 'track.example.com'])
  })
})
