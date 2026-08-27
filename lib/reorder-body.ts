import { z } from 'zod'
import type { ReorderRuleInput } from './reorder'

// The reorder rule form, validated once and shared by create and update.
//
// Levels are whole numbers all the way through, unlike the money and quantity
// fields elsewhere in this module: a stock count holds whole things, and a
// reorder level of 2.5 is a level that can never quite be crossed.

export const ReorderRuleBody = z.object({
  productId: z.string().trim().min(1, 'Pick a product').max(100),
  supplierId: z.string().max(100).nullable().default(null),
  reorderPoint: z.number().int('Levels are whole numbers').min(0, 'A level cannot be negative').max(1_000_000),
  reorderQty: z.number().int('Quantities are whole numbers').min(0).max(1_000_000),
  enabled: z.boolean().default(true),
})

export type ReorderRuleBodyInput = z.infer<typeof ReorderRuleBody>

export function toReorderRuleInput(body: ReorderRuleBodyInput): ReorderRuleInput {
  const supplierId = (body.supplierId ?? '').trim()
  return {
    productId: body.productId.trim(),
    supplierId: supplierId === '' ? null : supplierId,
    reorderPoint: body.reorderPoint,
    reorderQty: body.reorderQty,
    enabled: body.enabled,
  }
}

/** The "raise these now" button. An empty list means every supplier the nightly
 *  run would have done on its own; naming suppliers is a person overriding it,
 *  minimum order or no minimum order. */
export const ReorderRaiseBody = z.object({
  supplierIds: z.array(z.string().max(100)).max(200).default([]),
})
