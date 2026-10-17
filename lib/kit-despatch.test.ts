import { describe, expect, it } from 'vitest'
import { kitUnitsDespatched } from './kit-despatch'

// The parts of a kit leave in whatever parcels the suppliers choose. The
// customer's order line is only dispatched as far as the scarcest part has gone.
describe('kitUnitsDespatched', () => {
  it('is nothing while only some of the parts have gone', () => {
    // The seat is in this parcel; the base has not shipped at all.
    expect(kitUnitsDespatched([
      { perKit: 1, shippedBefore: 0, shippedNow: 3 },
      { perKit: 2, shippedBefore: 0, shippedNow: 0 },
    ])).toBe(0)
  })

  it('counts the kits the parcel that completes the set makes whole', () => {
    expect(kitUnitsDespatched([
      { perKit: 1, shippedBefore: 3, shippedNow: 0 },
      { perKit: 2, shippedBefore: 0, shippedNow: 6 },
    ])).toBe(3)
  })

  it('counts only the new kits when a later parcel adds to the first', () => {
    // 2 kits already whole (4 bases, 2 seats); this parcel brings the 3rd kit's base.
    expect(kitUnitsDespatched([
      { perKit: 1, shippedBefore: 3, shippedNow: 0 },
      { perKit: 2, shippedBefore: 4, shippedNow: 2 },
    ])).toBe(1)
  })

  it('does not round a half-shipped kit up', () => {
    expect(kitUnitsDespatched([{ perKit: 2, shippedBefore: 0, shippedNow: 3 }])).toBe(1)
    expect(kitUnitsDespatched([{ perKit: 4, shippedBefore: 0, shippedNow: 3 }])).toBe(0)
  })

  it('is nothing for a kit with no parts, and never negative', () => {
    expect(kitUnitsDespatched([])).toBe(0)
    expect(kitUnitsDespatched([{ perKit: 1, shippedBefore: 5, shippedNow: 0 }])).toBe(0)
  })
})
