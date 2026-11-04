import { describe, expect, it } from 'vitest'
import { proformaSender, withProformaSender, type FiledProforma } from '@/modules/purchase-orders/lib/proforma-sender'

// The payment note goes to whoever sent the proforma, not the mailbox the order
// went to: sales@ takes the order, anya@ sends the proforma and waits for the
// money.

const supplier = { id: 's1', email: 'sales@supplier.example', emailCc: null, inboundSenders: [] }

const doc = (fromAddress: string, filedMediaId: string | null = 'm1', filedAs = 'proforma'): FiledProforma => ({
  filedAs, filedMediaId, fromAddress,
})

describe('proformaSender', () => {
  it('takes the sender of the proforma at the supplier', () => {
    expect(proformaSender([doc('Anya@Supplier.example')], 'm1', supplier)).toBe('anya@supplier.example')
  })

  it('prefers the proforma the order holds now over a newer filing of something else', () => {
    const filed = [doc('bob@supplier.example', 'm2'), doc('anya@supplier.example', 'm1')]
    expect(proformaSender(filed, 'm1', supplier)).toBe('anya@supplier.example')
  })

  it('falls back to the newest filed proforma', () => {
    const filed = [doc('bob@supplier.example', 'm2'), doc('anya@supplier.example', 'm1')]
    expect(proformaSender(filed, 'uploaded', supplier)).toBe('bob@supplier.example')
  })

  it('ignores acknowledgements and invoices', () => {
    expect(proformaSender([doc('anya@supplier.example', 'm1', 'invoice')], 'm1', supplier)).toBeNull()
  })

  it('never picks a colleague who forwarded it', () => {
    expect(proformaSender([doc('buyer@ourshop.example')], 'm1', supplier)).toBeNull()
  })

  it('takes a listed sender at another domain', () => {
    const listed = { ...supplier, inboundSenders: ['supplier-accounts.example'] }
    expect(proformaSender([doc('anya@supplier-accounts.example')], 'm1', listed)).toBe('anya@supplier-accounts.example')
  })

  it('is null with no supplier or no emailed proforma', () => {
    expect(proformaSender([doc('anya@supplier.example')], 'm1', null)).toBeNull()
    expect(proformaSender([], 'm1', supplier)).toBeNull()
  })
})

describe('withProformaSender', () => {
  it('swaps the ordering address in the copy-to when the note goes to accounts', () => {
    const recipients = { to: 'accounts2@supplier.example', cc: ['sales@supplier.example'] }
    expect(withProformaSender(recipients, 'sales@supplier.example', 'anya@supplier.example')).toEqual({
      to: 'accounts2@supplier.example',
      cc: ['anya@supplier.example'],
    })
  })

  it('swaps the To when the note goes to the ordering desk', () => {
    const recipients = { to: 'Sales@supplier.example', cc: ['buyer@ourshop.example'] }
    expect(withProformaSender(recipients, 'sales@supplier.example', 'anya@supplier.example')).toEqual({
      to: 'anya@supplier.example',
      cc: ['buyer@ourshop.example'],
    })
  })

  it('copies the sender in where the ordering address is not on it', () => {
    const recipients = { to: 'accounts2@supplier.example', cc: [] }
    expect(withProformaSender(recipients, 'sales@supplier.example', 'anya@supplier.example')).toEqual({
      to: 'accounts2@supplier.example',
      cc: ['anya@supplier.example'],
    })
  })

  it('never lists the sender twice', () => {
    const recipients = { to: 'anya@supplier.example', cc: ['sales@supplier.example'] }
    expect(withProformaSender(recipients, 'sales@supplier.example', 'anya@supplier.example')).toEqual({
      to: 'anya@supplier.example',
      cc: [],
    })
  })

  it('changes nothing without a sender', () => {
    const recipients = { to: 'accounts2@supplier.example', cc: ['sales@supplier.example'] }
    expect(withProformaSender(recipients, 'sales@supplier.example', null)).toBe(recipients)
  })
})
