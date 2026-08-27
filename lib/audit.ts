import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { PoAuditEntry } from './types'

// Append-only. Nothing in this module ever updates or deletes a row here: the
// point of the log is that it says what happened even when what happened was a
// mistake.
//
// Writing never throws into the caller. An order that was approved but whose log
// line failed to write is a bookkeeping annoyance; an approval that failed
// because the log was busy is an outage.

export type AuditEntityType = 'order' | 'supplier' | 'receipt' | 'return' | 'bill' | 'settings'

export async function recordAudit(
  entityType: AuditEntityType,
  entityId: string,
  action: string,
  detail: Record<string, unknown> = {},
  userId?: string | null,
): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO "po_audit_log" ("entity_type", "entity_id", "action", "detail", "user_id")
      VALUES (${entityType}, ${entityId}, ${action}, ${JSON.stringify(detail)}::jsonb, ${userId ?? null})
    `
  } catch (error) {
    console.error('[purchase-orders] could not write audit entry', { entityType, entityId, action, error })
  }
}

export async function listAudit(
  entityType: AuditEntityType,
  entityId: string,
  limit = 100,
): Promise<PoAuditEntry[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT a."id", a."action", a."detail", a."user_id", a."created_at",
           COALESCE(u."displayName", u."username") AS "user_name"
      FROM "po_audit_log" a
      LEFT JOIN "User" u ON u."id" = a."user_id"
     WHERE a."entity_type" = ${entityType} AND a."entity_id" = ${entityId}
     ORDER BY a."created_at" DESC
     LIMIT ${Prisma.raw(String(Math.max(1, Math.min(500, Math.trunc(limit)))))}
  `
  return rows.map((r) => ({
    id: r.id as string,
    action: r.action as string,
    detail: (r.detail as Record<string, unknown> | null) ?? {},
    userId: (r.user_id as string | null) ?? null,
    userName: (r.user_name as string | null) ?? null,
    createdAt: (r.created_at as Date).toISOString(),
  }))
}
