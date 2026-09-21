import type { PoOrder } from '@/modules/purchase-orders/lib/types'

// The order form: its shape, how it is filled from an order, and what it sends
// back. Its own file so the screen that owns the state, the editor that draws
// it and the line table can all agree on one definition.

export type LineForm = {
  key: string
  productId: string | null
  productName: string | null
  supplierSku: string
  ourSku: string
  description: string
  qty: string
  unit: string
  unitCost: string
  discountPercent: string
  taxRatePercent: string
  expectedDate: string
  qtyCancelled: string
  // The delivery service this line has to go on, and what it costs per unit.
  // The cost is not in the line total - it is summed into the order's carriage.
  serviceName: string
  serviceCost: string
  // Never edited, never shown: the customer order line this was bought for. It
  // is carried through the form only so that saving an order raised off a shop
  // order does not throw the link away.
  sourceOrderItemId: string | null
}

export type Form = {
  supplierId: string
  shipToKind: 'WAREHOUSE' | 'CUSTOMER' | 'OTHER'
  shipToName: string
  shipToContact: string
  shipToPhone: string
  shipToLine1: string
  shipToLine2: string
  shipToCity: string
  shipToRegion: string
  shipToPostcode: string
  shipToCountry: string
  shipToInstructions: string
  currency: string
  baseCurrency: string
  fxRate: string
  taxMode: 'EXCLUSIVE' | 'INCLUSIVE'
  discountAmount: string
  carriageAmount: string
  requiredByDate: string
  expectedDate: string
  paymentTerms: string
  deliveryTerms: string
  notesSupplier: string
  notesInternal: string
  lines: LineForm[]
}

let lineCounter = 0
export function newLine(patch: Partial<LineForm> = {}): LineForm {
  lineCounter += 1
  return {
    key: `line-${lineCounter}`,
    productId: null,
    productName: null,
    supplierSku: '',
    ourSku: '',
    description: '',
    qty: '1',
    unit: 'each',
    unitCost: '0',
    discountPercent: '',
    taxRatePercent: '20',
    expectedDate: '',
    qtyCancelled: '0',
    serviceName: '',
    serviceCost: '',
    sourceOrderItemId: null,
    ...patch,
  }
}

export function emptyForm(defaults: FormDefaults): Form {
  return {
    supplierId: '',
    shipToKind: defaults.defaultShipToKind,
    shipToName: defaults.warehouseName,
    shipToContact: defaults.warehouseContact,
    shipToPhone: defaults.warehousePhone,
    shipToLine1: defaults.warehouseLine1,
    shipToLine2: defaults.warehouseLine2,
    shipToCity: defaults.warehouseCity,
    shipToRegion: defaults.warehouseRegion,
    shipToPostcode: defaults.warehousePostcode,
    shipToCountry: defaults.warehouseCountry,
    shipToInstructions: defaults.warehouseInstructions,
    currency: defaults.baseCurrency,
    baseCurrency: defaults.baseCurrency,
    fxRate: '1',
    taxMode: 'EXCLUSIVE',
    discountAmount: '0',
    carriageAmount: '0',
    requiredByDate: '',
    expectedDate: '',
    paymentTerms: '',
    deliveryTerms: '',
    notesSupplier: '',
    notesInternal: '',
    lines: [newLine()],
  }
}

export function formFromOrder(order: PoOrder): Form {
  return {
    supplierId: order.supplierId,
    shipToKind: order.shipToKind,
    shipToName: order.shipTo.name,
    shipToContact: order.shipTo.contact,
    shipToPhone: order.shipTo.phone,
    shipToLine1: order.shipTo.address.line1,
    shipToLine2: order.shipTo.address.line2,
    shipToCity: order.shipTo.address.city,
    shipToRegion: order.shipTo.address.region,
    shipToPostcode: order.shipTo.address.postcode,
    shipToCountry: order.shipTo.address.country,
    shipToInstructions: order.shipTo.instructions,
    currency: order.currency,
    baseCurrency: order.baseCurrency,
    fxRate: order.fxRate,
    taxMode: order.taxMode,
    discountAmount: order.discountAmount,
    carriageAmount: order.carriageAmount,
    requiredByDate: order.requiredByDate ?? '',
    expectedDate: order.expectedDate ?? '',
    paymentTerms: order.paymentTerms ?? '',
    deliveryTerms: order.deliveryTerms ?? '',
    notesSupplier: order.notesSupplier ?? '',
    notesInternal: order.notesInternal ?? '',
    lines: order.lines.map((l) =>
      newLine({
        productId: l.productId,
        productName: l.productName,
        supplierSku: l.supplierSku ?? '',
        ourSku: l.ourSku ?? '',
        description: l.description,
        qty: l.qty,
        unit: l.unit,
        unitCost: l.unitCost,
        discountPercent: l.discountPercent ?? '',
        taxRatePercent: l.taxRatePercent,
        expectedDate: l.expectedDate ?? '',
        qtyCancelled: l.qtyCancelled,
        serviceName: l.serviceName ?? '',
        serviceCost: l.serviceCost ?? '',
        sourceOrderItemId: l.sourceOrderItemId,
      }),
    ),
  }
}

export type FormDefaults = {
  baseCurrency: string
  defaultShipToKind: 'WAREHOUSE' | 'CUSTOMER' | 'OTHER'
  warehouseName: string
  warehouseContact: string
  warehousePhone: string
  warehouseLine1: string
  warehouseLine2: string
  warehouseCity: string
  warehouseRegion: string
  warehousePostcode: string
  warehouseCountry: string
  warehouseInstructions: string
  approvalRequired: boolean
  approvalThreshold: number
}

/** What the save sends. `amendReason` rides along only on an amendment - an
 *  order the supplier is already holding - and is ignored everywhere else. */
export function formBody(form: Form, amendReason: string) {
  return {
    supplierId: form.supplierId,
    shipToKind: form.shipToKind,
    shipTo: {
      name: form.shipToName,
      contact: form.shipToContact,
      phone: form.shipToPhone,
      address: {
        line1: form.shipToLine1,
        line2: form.shipToLine2,
        city: form.shipToCity,
        region: form.shipToRegion,
        postcode: form.shipToPostcode,
        country: form.shipToCountry,
      },
      instructions: form.shipToInstructions,
    },
    currency: form.currency,
    baseCurrency: form.baseCurrency,
    fxRate: form.fxRate || '1',
    taxMode: form.taxMode,
    discountAmount: form.discountAmount || '0',
    carriageAmount: form.carriageAmount || '0',
    requiredByDate: form.requiredByDate || null,
    expectedDate: form.expectedDate || null,
    paymentTerms: form.paymentTerms || null,
    deliveryTerms: form.deliveryTerms || null,
    notesSupplier: form.notesSupplier || null,
    notesInternal: form.notesInternal || null,
    amendmentReason: amendReason.trim() || undefined,
    lines: form.lines.map((l) => ({
      productId: l.productId,
      productName: l.productName,
      supplierSku: l.supplierSku || null,
      ourSku: l.ourSku || null,
      description: l.description,
      qty: l.qty || '0',
      unit: l.unit || 'each',
      unitCost: l.unitCost || '0',
      discountPercent: l.discountPercent || null,
      taxRatePercent: l.taxRatePercent || '0',
      taxRateCode: null,
      vatTreatment: null,
      categoryId: null,
      expectedDate: l.expectedDate || null,
      qtyCancelled: l.qtyCancelled || '0',
      serviceName: l.serviceName || null,
      serviceCost: l.serviceCost || null,
      sourceOrderItemId: l.sourceOrderItemId,
    })),
  }
}
