import { describe, expect, it } from 'vitest'
import {
  carrierForHost, dayIn, isBarePublicSuffix, isTrustedTrackingLink, linkFamily, normalisePostcode, ownLines, readTrackingLink, recogniseTracking,
  registrableDomain, slotIn, trackingKeyOf,
} from './tracking-recognise'

// Synthetic emails only, shaped like the three kinds that reach a purchasing
// mailbox: a delivery firm writing on the supplier's behalf, a parcel
// carrier's notification, and the supplier replying on the order's thread.
// Every name, address, number and code here is made up.

const TODAY = '2026-09-28'

const deliveryFirmBooked = `
Example Haulage
2-Person Home Delivery
DELIVERING ON BEHALF OF
EXAMPLE FURNITURE LTD
Your order is now with Example Haulage
Hello A Customer,
We have received your order details and will contact you shortly to arrange the next steps.
Step 1 - Order received<https://cdn.haulage.example/static/Step_1.png>
Order summary
Order number\t123456\t
Consignment\tF12345678901\t
Delivery address\t1 Example Street, Exampletown
AB1 2DE\t
Contact numbers\tHome: 00000 000000
Track your order <https://haulage.example/track-your-order>
Use consignment number: F12345678901
Terms and conditions <https://haulage.example/delivery-terms>
`

const deliveryFirmTimeslot = `
Example Haulage
DELIVERY TIMESLOT CONFIRMED
Delivery details
SERVICE
Delivery
DELIVERY DATE
TUE 08/09/2026
DELIVERY TIMESLOT
10:00-13:00
Your Delivery from EXAMPLE FURNITURE LTD is scheduled for TUE
08/09/2026 between 10:00-13:00.
Track your delivery
https://multidrop.link/Q9XZ7A/AB12DE
Please do not reply to this automated message.
`

const parcelCarrier = `
[https://cdn.carrier.example/images/logo.png]
We're expecting your Example Trading Co parcel. We'll be in touch when
we have it and it's out for delivery

Show my options [https://www.dpd.co.uk/d/AbC123dEf456]
How did we do? [https://www.dpd.co.uk/d/AbC123dEf456?rate=like] [https://www.dpd.co.uk/d/AbC123dEf456?rate=dislike]

Your parcel: 1234 5678 901 234

Get the app [https://www.dpd.co.uk/lp/yourdpd/index.html]
Find more information in our privacy notice [https://www.dpd.co.uk/dpo-privacy-notice-1.jsp].
[https://u000.ct.sendgrid.net/wf/open?upn=abcdef123456]
`

const supplierReply = `
Hi,
The order is out for delivery today, current ETA is 1-4pm.
Kind Regards,
Pat
www.supplier.example<http://www.supplier.example/>
From: Buyer <buying@our-shop.example>
Sent: 27 September 2026 09:00
Subject: Purchase order PO-00027
Any news on this one? Last time it came with https://www.dpd.co.uk/d/OLDOLD999999
`

describe('reading tracking out of an email', () => {
  it('reads a delivery firm’s booking: consignment, their order number, the postcode, and no generic page', () => {
    const found = recogniseTracking({ subject: 'Your Example Furniture Ltd Delivery - Products Received', bodyText: deliveryFirmBooked, today: TODAY })
    expect(found.candidates).toEqual([{ carrier: null, trackingNumber: 'F12345678901', trackingUrl: null, shortCode: null }])
    expect(found.supplierRefs).toEqual(['123456'])
    expect(found.postcodes).toEqual(['AB1 2DE'])
    expect(found.deliveryDate).toBeNull()
    expect(found.deliverySlot).toBeNull()
  })

  it('reads a delivery firm’s timeslot email: a label above its value, the day hand-parsed, the link’s code and postcode', () => {
    const found = recogniseTracking({ subject: 'Your Home Delivery Timeslot', bodyText: deliveryFirmTimeslot, today: TODAY })
    expect(found.deliveryDate).toBe('2026-09-08')
    expect(found.deliverySlot).toEqual(['10:00', '13:00'])
    expect(found.candidates).toEqual([
      { carrier: null, trackingNumber: null, trackingUrl: 'https://multidrop.link/Q9XZ7A/AB12DE', shortCode: 'Q9XZ7A' },
    ])
    expect(found.postcodes).toEqual(['AB1 2DE'])
    expect(found.supplierRefs).toEqual([])
  })

  it('reads a parcel carrier: the spaced parcel number and the follow-my-parcel link as one parcel, no pixels', () => {
    const found = recogniseTracking({ subject: 'We’re expecting your Example Trading Co parcel', bodyText: parcelCarrier, today: TODAY })
    expect(found.candidates).toEqual([
      { carrier: 'DPD', trackingNumber: '12345678901234', trackingUrl: 'https://www.dpd.co.uk/d/AbC123dEf456', shortCode: 'AbC123dEf456' },
    ])
  })

  it('reads a supplier reply for the day and window, and never the quoted history below it', () => {
    const found = recogniseTracking({ subject: 'RE: Purchase order PO-00027', bodyText: supplierReply, today: TODAY })
    expect(found.candidates).toEqual([])
    expect(found.deliveryDate).toBe(TODAY)
    expect(found.deliverySlot).toEqual(['13:00', '16:00'])
  })

  it('takes no window from opening hours: a slot needs a day', () => {
    const found = recogniseTracking({
      subject: 'RE: Purchase order PO-00031',
      bodyText: 'Hi, the carrier say this can be collected from them Monday to Friday between 11- 6 pm.',
      today: TODAY,
    })
    expect(found.deliverySlot).toBeNull()
    expect(found.deliveryDate).toBeNull()
  })

  it('keeps the looser reference labels apart: on a courier’s email they are the courier’s own numbers', () => {
    const found = recogniseTracking({ subject: 'x', bodyText: 'Your order: 55667788\nOur ref: AB-9988\nOrder number 123456', today: TODAY })
    expect(found.supplierRefs).toEqual(['123456'])
    expect(found.looseRefs).toEqual(['55667788', 'AB-9988'])
  })

  it('keeps the address postcodes apart from the ones that came in a link', () => {
    const found = recogniseTracking({ subject: 'x', bodyText: 'Delivery address\nLS1 4AP\nhttps://multidrop.link/Q9XZ7A/AB12DE', today: TODAY })
    expect(found.postcodes).toEqual(['LS1 4AP', 'AB1 2DE'])
    expect(found.addressPostcodes).toEqual(['LS1 4AP'])
  })

  it('takes their sales order number out of the subject', () => {
    const found = recogniseTracking({ subject: 'Sales Order 0000123456 - PO-00012', bodyText: '', today: TODAY })
    expect(found.supplierRefs).toEqual(['0000123456'])
  })

  it('finds nothing in an email about something else', () => {
    const found = recogniseTracking({
      subject: 'Updated data sheets',
      bodyText: 'Hi, here are our product datasets: https://content.supplier.example/s/WLobKQN5fh3aAT0\nThe parcel of samples is in the post.',
      today: TODAY,
    })
    expect(found).toEqual({
      candidates: [], deliveryDate: null, deliverySlot: null, supplierRefs: [], looseRefs: [], postcodes: [], addressPostcodes: [],
    })
  })

  it('keeps two parcels apart when an email carries two links and two numbers', () => {
    const found = recogniseTracking({
      subject: 'Two parcels',
      bodyText: 'Parcel number: 11112222333344\nhttps://www.dpd.co.uk/d/FirstCode11\nParcel number: 55556666777788\nhttps://www.dpd.co.uk/d/SecondCode2',
      today: TODAY,
    })
    expect(found.candidates.map((c) => c.shortCode ?? c.trackingNumber)).toEqual([
      'FirstCode11', 'SecondCode2', '11112222333344', '55556666777788',
    ])
  })
})

describe('links', () => {
  it('names a carrier off its host and needs a parcel in the address', () => {
    expect(readTrackingLink('https://www.royalmail.com/track-your-item#/tracking-results/AB123456789GB')).toMatchObject({ carrier: 'Royal Mail' })
    expect(readTrackingLink('https://tracking.example-courier.com/track?ref=ZX9988776655')).toMatchObject({ carrier: null })
    expect(readTrackingLink('https://example-courier.com/track-your-order')).toBeNull()
    expect(readTrackingLink('https://track.dpd.co.uk/parcels/12345678901234*00001')).toMatchObject({ carrier: 'DPD', trackingNumber: '12345678901234' })
  })

  it('ignores pixels, click counters, the small print and the survey', () => {
    for (const url of [
      'https://u1.ct.sendgrid.net/wf/open?upn=tracking12345',
      'https://list.example/track/click?u=abc123456&id=def789',
      'https://carrier.example/track/unsubscribe?id=123456789',
      'https://carrier.example/tracking/feedback/123456789',
      'https://www.trustpilot.com/evaluate/carrier.example?track=123456',
      'https://carrier.example/tracking/123456789/logo.png',
      'https://ads.platform.example/Redirect/Track?turl=https%3a%2f%2fads.platform.example%2fcampaign%3fid%3d123456&tracking=abc123456',
      'https://www.dpd.co.uk/d/AbC123dEf456?rate=like',
    ]) expect(readTrackingLink(url)).toBeNull()
  })

  it('reads a Multidrop-style link with or without its postcode', () => {
    expect(readTrackingLink('https://multidrop.link/Z1Y2X3/SW1A1AA')).toMatchObject({ shortCode: 'Z1Y2X3', postcode: 'SW1A 1AA' })
    expect(readTrackingLink('https://multidrop.link/Z1Y2X3')).toMatchObject({ shortCode: 'Z1Y2X3', postcode: null })
  })
})

describe('AIT Home Delivery', () => {
  const aitDespatch = `
Your order from Example Furniture Ltd is on its way
Our partner AIT Home Delivery will be in touch to book a day.
Track your delivery: https://aithd.com/kzqvwrx?utm_source=email
Kind regards
`

  it('reads their short link, a code with no digits in it, as the parcel', () => {
    expect(readTrackingLink('https://aithd.com/kzqvwrx')).toEqual({
      carrier: 'AIT', trackingNumber: null, trackingUrl: 'https://aithd.com/kzqvwrx', shortCode: 'kzqvwrx', postcode: null,
    })
    expect(readTrackingLink('https://aithd.com/kz0vkrz')).toMatchObject({ shortCode: 'kz0vkrz' })
    // The German site keeps its own address; 'www.' and a query come off.
    expect(readTrackingLink('https://www.aithd.de/AbCdEfG/?ref=sms')).toMatchObject({ trackingUrl: 'https://aithd.de/AbCdEfG', shortCode: 'AbCdEfG' })
  })

  it('refuses their long address, a code too short, and the survey', () => {
    expect(readTrackingLink('https://aithd.com/exampleclient/123456789')).toBeNull()
    expect(readTrackingLink('https://aithd.com/abc')).toBeNull()
    expect(readTrackingLink('https://aithd.com/')).toBeNull()
    expect(readTrackingLink('https://aithd.com/kzqvwrx?rate=5')).toBeNull()
  })

  it('reads a despatch email from their own domain, and believes the link', () => {
    const read = recogniseTracking({ subject: 'Your delivery', bodyText: aitDespatch, today: TODAY })
    expect(read.candidates).toEqual([
      { carrier: 'AIT', trackingNumber: null, trackingUrl: 'https://aithd.com/kzqvwrx', shortCode: 'kzqvwrx' },
    ])
    expect(isTrustedTrackingLink('https://aithd.com/kzqvwrx', 'noreply@aitworldwide.com')).toBe(true)
    // Their despatch emails come from their parent company's domain: named AIT too.
    expect(carrierForHost('mail.aitworldwide.com')).toBe('AIT')
    // A known carrier, so believed whoever forwards it on.
    expect(isTrustedTrackingLink('https://aithd.de/kzqvwrx', 'despatch@supplier.example')).toBe(true)
    expect(isTrustedTrackingLink('https://aithd.com.evil.example/kzqvwrx', 'noreply@aitworldwide.com')).toBe(false)
  })

  it('keys a code per site', () => {
    expect(linkFamily('https://www.aithd.com/kzqvwrx')).toBe('aithd.com')
    expect(linkFamily('https://aithd.de/kzqvwrx')).toBe('aithd.de')
    expect(trackingKeyOf({ trackingNumber: null, shortCode: 'kzqvwrx', trackingUrl: 'https://aithd.com/kzqvwrx' })).toBe('CODE:aithd.com:kzqvwrx')
  })
})

describe('whose links to believe', () => {
  it('believes known carriers, the sender’s own domain and listed hosts, and nobody else', () => {
    expect(isTrustedTrackingLink('https://www.dpd.co.uk/d/AbC123dEf456', 'noreply@evil.example')).toBe(true)
    expect(isTrustedTrackingLink('https://multidrop.link/Q9XZ7A/AB12DE', 'noreply@evil.example')).toBe(true)
    expect(isTrustedTrackingLink('https://tracking.justshoutgfs.com/ParcelLink.asp?ConsNumber=123456', 'x@evil.example')).toBe(true)
    expect(isTrustedTrackingLink('https://haulage.example/track?c=F12345678901', 'delivery@mail.haulage.example')).toBe(true)
    expect(isTrustedTrackingLink('https://evil.example/track/F12345678901', 'noreply@courier.example')).toBe(false)
    expect(isTrustedTrackingLink('https://evil.example/track/F12345678901', 'noreply@courier.example', ['evil.example'])).toBe(true)
    // A look-alike is not the carrier.
    expect(isTrustedTrackingLink('https://dpd.co.uk.evil.example/d/AbC123dEf456', 'x@courier.example')).toBe(false)
  })

  it('never trusts a link for sharing a free email service with its sender', () => {
    expect(isTrustedTrackingLink('https://www.icloud.com/track/ABC123456', 'bob@icloud.com')).toBe(false)
    expect(isTrustedTrackingLink('https://mail.gmail.com/track/ABC123456', 'someone@gmail.com')).toBe(false)
    // A firm's own domain still is.
    expect(isTrustedTrackingLink('https://track.haulage.example/F12345678901', 'noreply@haulage.example')).toBe(true)
  })

  it('ignores a bare public suffix listed as a trusted host', () => {
    expect(isBarePublicSuffix('co.uk')).toBe(true)
    expect(isBarePublicSuffix('com')).toBe(true)
    expect(isBarePublicSuffix('.org.uk')).toBe(true)
    expect(isBarePublicSuffix('courier.co.uk')).toBe(false)
    // Shared hosting: anybody can have a site under these in minutes.
    for (const shared of ['vercel.app', 'github.io', 'netlify.app', 's3.amazonaws.com', '.pages.dev']) {
      expect(isBarePublicSuffix(shared)).toBe(true)
    }
    expect(isBarePublicSuffix('mycourier.github.io')).toBe(false)
    expect(isTrustedTrackingLink('https://evil.co.uk/track/F12345678901', 'x@stranger.example', ['co.uk'])).toBe(false)
    expect(isTrustedTrackingLink('https://track.courier.co.uk/F12345678901', 'x@stranger.example', ['courier.co.uk'])).toBe(true)
  })

  it('names a domain by what it is registered under, and a code by whose it is', () => {
    expect(registrableDomain('mail.haulage.co.uk')).toBe('haulage.co.uk')
    expect(registrableDomain('track.example.com')).toBe('example.com')
    expect(linkFamily('https://www.dpdlocal.co.uk/d/X')).toBe('dpd')
    expect(linkFamily('https://multidrop.link/X/Y')).toBe('multidrop')
    expect(linkFamily('https://Track.Example.com/a')).toBe('track.example.com')
  })
})

describe('days, windows and the rest', () => {
  it('reads a day the British way, and refuses one that does not exist', () => {
    expect(dayIn('TUE 08/09/2026', TODAY)).toBe('2026-09-08')
    expect(dayIn('08/09/26', TODAY)).toBe('2026-09-08')
    expect(dayIn('31/02/2026', TODAY)).toBeNull()
    expect(dayIn('Tuesday 3rd November', TODAY)).toBe('2026-11-03')
    expect(dayIn('5 January', '2026-12-30')).toBe('2027-01-05')
    expect(dayIn('tomorrow', TODAY)).toBe('2026-09-29')
  })

  it('reads a window, and the half of the day a loose one is in', () => {
    expect(slotIn('between 10:00 and 13:00')).toEqual(['10:00', '13:00'])
    expect(slotIn('ETA 1-4pm')).toEqual(['13:00', '16:00'])
    expect(slotIn('11-2pm')).toEqual(['11:00', '14:00'])
    expect(slotIn('9am - 12pm')).toEqual(['09:00', '12:00'])
    expect(slotIn('13:00-10:00')).toBeNull()
  })

  it('normalises a postcode and drops quoted history', () => {
    expect(normalisePostcode('ab12de')).toBe('AB1 2DE')
    expect(normalisePostcode('not one')).toBeNull()
    expect(ownLines('Hello\n> quoted\nOn Mon, 1 Sep 2026, Somebody wrote:\nolder')).toEqual(['Hello'])
  })

  it('keys a parcel on its number, else its code', () => {
    expect(trackingKeyOf({ trackingNumber: '1234 5678-90', shortCode: 'abc' })).toBe('1234567890')
    // A code only means something to the service that issued it.
    expect(trackingKeyOf({ trackingNumber: null, shortCode: 'Q9XZ7A', trackingUrl: 'https://multidrop.link/Q9XZ7A/AB12DE' })).toBe('CODE:multidrop:Q9XZ7A')
    expect(trackingKeyOf({ trackingNumber: null, shortCode: 'Q9XZ7A', trackingUrl: 'https://www.dpd.co.uk/d/Q9XZ7A' })).toBe('CODE:dpd:Q9XZ7A')
    expect(trackingKeyOf({ trackingNumber: null, shortCode: null })).toBeNull()
  })
})
