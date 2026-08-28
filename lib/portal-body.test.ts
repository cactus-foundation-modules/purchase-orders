import { describe, expect, it } from 'vitest'
import { PortalActionBody } from '@/modules/purchase-orders/lib/portal-body'

function message(patch: Record<string, unknown> = {}) {
  return { token: 'a-link-they-were-sent', action: 'message', text: 'When is this going out?', ...patch }
}

// The despatch a supplier files through their own link, which is the only write
// on this module with nobody signed in behind it.
function despatch(patch: Record<string, unknown> = {}) {
  return {
    token: 'a-link-they-were-sent',
    action: 'despatch',
    date: '2026-04-21',
    lines: [{ lineId: 'line-1', qty: '8' }],
    ...patch,
  }
}

describe('a supplier telling us what has left them', () => {
  it('takes their tracking page and tidies it', () => {
    const parsed = PortalActionBody.parse(despatch({ trackingUrl: 'track.example.com/PW-882' }))
    expect(parsed).toMatchObject({ trackingUrl: 'https://track.example.com/PW-882' })
  })

  it('is happy without one', () => {
    expect(PortalActionBody.safeParse(despatch()).success).toBe(true)
    const blank = PortalActionBody.parse(despatch({ trackingUrl: '' }))
    expect(blank).toMatchObject({ trackingUrl: null })
  })

  it('refuses one that is not a web address', () => {
    expect(PortalActionBody.safeParse(despatch({ trackingUrl: 'ring us' })).success).toBe(false)
    // Whoever holds the link is outside the building, and this string becomes an
    // href on the order screen inside it.
    expect(PortalActionBody.safeParse(despatch({ trackingUrl: 'javascript:alert(1)' })).success).toBe(false)
    expect(
      PortalActionBody.safeParse(despatch({ trackingUrl: 'data:text/html,<script>alert(1)</script>' })).success,
    ).toBe(false)
  })
})

describe('a supplier messaging us about it', () => {
  it('takes a message with no lines at all - that is the whole order', () => {
    const parsed = PortalActionBody.parse(message())
    expect(parsed.action).toBe('message')
    expect('lines' in parsed && parsed.lines).toBeFalsy()
  })

  it('takes the lines they picked', () => {
    const parsed = PortalActionBody.parse(message({ lines: ['line-1', 'line-4'] }))
    expect(parsed).toMatchObject({ lines: ['line-1', 'line-4'] })
  })

  it('still refuses an empty message, picked lines or not', () => {
    expect(PortalActionBody.safeParse(message({ text: '' })).success).toBe(false)
    expect(PortalActionBody.safeParse(message({ text: '', lines: ['line-1'] })).success).toBe(false)
  })
})
