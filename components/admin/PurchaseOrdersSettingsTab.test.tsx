import { describe, expect, it } from 'vitest'
import { PURCHASE_ORDER_SETTINGS_TABS } from './PurchaseOrdersSettingsTab'

describe('Purchase Orders settings tabs', () => {
  it('keeps the long settings form in focused sections', () => {
    expect(PURCHASE_ORDER_SETTINGS_TABS).toEqual([
      { id: 'buying', label: 'Buying basics' },
      { id: 'documents', label: 'Documents' },
      { id: 'automation', label: 'Automation' },
    ])
  })
})
