import { describe, it, expect } from 'vitest'
import {
  ShipmentBody, shipmentHeaderFrom, shipmentLinesFrom,
} from '@/modules/purchase-orders/lib/shipment-body'

// The despatch form as it arrives from the admin screen. What matters here is
// what gets DROPPED and what stays a string: a row left at zero must not become
// a database row holding an ON DELETE RESTRICT lock on an order line it was
// never part of, and a quantity must not go anywhere near a float.

function body(patch: Record<string, unknown> = {}) {
  return {
    despatchedDate: '2026-04-21',
    lines: [{ orderLineId: 'line-1', qty: '8' }],
    ...patch,
  }
}

describe('the despatch form', () => {
  it('takes a plain day and refuses anything else', () => {
    expect(ShipmentBody.safeParse(body()).success).toBe(true)
    for (const bad of ['21 April', '2026-4-21', '2026-04-21T00:00:00Z', '']) {
      const result = ShipmentBody.safeParse(body({ despatchedDate: bad }))
      expect(result.success, `${bad} should not parse as a date`).toBe(false)
    }
  })

  it('refuses a despatch with no lines at all', () => {
    expect(ShipmentBody.safeParse(body({ lines: [] })).success).toBe(false)
  })

  it('keeps quantities as strings, to three places', () => {
    const parsed = ShipmentBody.parse(body({ lines: [{ orderLineId: 'line-1', qty: '2.500' }] }))
    expect(parsed.lines[0]!.qty).toBe('2.500')
    expect(ShipmentBody.safeParse(body({ lines: [{ orderLineId: 'line-1', qty: '2.5001' }] })).success).toBe(false)
  })

  it('drops the lines nobody put a quantity against', () => {
    // The screen shows every outstanding line so somebody can tick down the
    // email in front of them. Most of them will be blank on a part despatch.
    const parsed = ShipmentBody.parse(
      body({
        lines: [
          { orderLineId: 'line-1', qty: '8' },
          { orderLineId: 'line-2', qty: '0' },
          { orderLineId: 'line-3', qty: '' },
        ],
      }),
    )
    const lines = shipmentLinesFrom(parsed)
    expect(lines).toEqual([{ orderLineId: 'line-1', qty: '8' }])
  })

  it('reads a blank box as "not given" rather than as blank', () => {
    const parsed = ShipmentBody.parse(body({ carrier: '   ', trackingRef: '', notes: null }))
    expect(shipmentHeaderFrom(parsed)).toEqual({
      despatchedDate: '2026-04-21',
      carrier: null,
      trackingRef: null,
      trackingUrl: null,
      notes: null,
    })
  })

  it('takes a tracking link only when it is one', () => {
    expect(ShipmentBody.safeParse(body({ trackingUrl: 'https://track.example.com/PW-882' })).success).toBe(true)
    // An empty box is not a bad address, it is no address.
    expect(shipmentHeaderFrom(ShipmentBody.parse(body({ trackingUrl: '' }))).trackingUrl).toBeNull()
    expect(ShipmentBody.safeParse(body({ trackingUrl: 'not a link' })).success).toBe(false)
    // A bare host is what most people type, and is a link.
    expect(shipmentHeaderFrom(ShipmentBody.parse(body({ trackingUrl: 'track.example.com/PW-882' }))).trackingUrl)
      .toBe('https://track.example.com/PW-882')
    // And the one that matters: this ends up as an href on the order screen.
    expect(ShipmentBody.safeParse(body({ trackingUrl: 'javascript:alert(1)' })).success).toBe(false)
  })

  it('does not clamp anything itself', () => {
    // What is genuinely left to send needs the database, so the clamp lives in
    // the route - the same one the supplier's own page goes through. A second
    // copy here would be a second answer waiting to disagree.
    const lines = shipmentLinesFrom(ShipmentBody.parse(body({ lines: [{ orderLineId: 'line-1', qty: '9999' }] })))
    expect(lines).toEqual([{ orderLineId: 'line-1', qty: '9999' }])
  })
})
