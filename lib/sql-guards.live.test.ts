import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TestDatabase, TestRole, VpsConfig } from '@/lib/backup/vps-database'

// This module's raw SQL, ACTUALLY EXECUTED by Postgres.
//
// Nothing else runs it. `tsc` sees a template string, `eslint` sees a template
// string, `npm test` never opens a connection, and the module build gate builds
// - which never executes a query either. A statement Postgres will not parse
// therefore passes every gate there is and fails for the first time on a live
// site, with the screen it belongs to unreadable.
//
// What is exercised here is every statement that WRITES or READS a column this
// module has added since the tables were laid down - the proforma documents, the
// proof of payment, the supplier references, the accounts address - plus the
// three list queries that grew columns and the media-usage UNION. Not the whole
// module: the point is the SQL that a type-checker cannot see through, and the
// bits somebody edits when they add a column.
//
// Every value import is dynamic: the shared Prisma client reads DATABASE_URL
// once, when its module first loads, and the database this runs against does not
// exist until beforeAll has made it.
//
// It provisions its OWN throwaway database on the self-hosted Postgres VPS
// (`cactus_rt_*`, owned by a throwaway role, dropped afterwards), so it never
// touches any real database - the live site's sits on the same server and is
// never named, opened or altered. Skipped unless opted into, so a plain
// `npm test` never hits the network:
//
//   npm run test:po-sql
const shouldRun = process.env.RUN_PO_SQL === '1'
if (shouldRun) {
  try {
    ;(process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - the guard below fails the suite loudly rather than skipping.
  }
}

const suite = shouldRun ? describe : describe.skip

const CORE_SQL = readFileSync(path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql'), 'utf8')

/** Split a migration file into statements, dollar-quote aware: core's init does
 *  use `DO $$ ... $$`, and a splitter that is not would cut one in half. */
function splitStatements(sql: string): string[] {
  const out: string[] = []
  let current = ''
  let at = 0
  while (at < sql.length) {
    const rest = sql.slice(at)
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', at)
      at = end === -1 ? sql.length : end + 1
      continue
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', at + 2)
      at = end === -1 ? sql.length : end + 2
      continue
    }
    const char = sql[at]!
    if (char === "'" || char === '"') {
      const end = closingQuote(sql, at, char)
      current += sql.slice(at, end)
      at = end
      continue
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(rest)
    if (dollar) {
      const tag = dollar[0]
      const end = sql.indexOf(tag, at + tag.length)
      const stop = end === -1 ? sql.length : end + tag.length
      current += sql.slice(at, stop)
      at = stop
      continue
    }
    if (char === ';') {
      if (current.trim()) out.push(current.trim())
      current = ''
      at++
      continue
    }
    current += char
    at++
  }
  if (current.trim()) out.push(current.trim())
  return out
}

/** Where a quoted run ends, doubled quotes ('' and "") counting as escapes. */
function closingQuote(sql: string, start: number, quote: string): number {
  let at = start + 1
  while (at < sql.length) {
    if (sql[at] === quote) {
      if (sql[at + 1] === quote) {
        at += 2
        continue
      }
      return at + 1
    }
    at++
  }
  return sql.length
}

function moduleSql(): string[] {
  const dir = path.join(process.cwd(), 'modules', 'purchase-orders', 'migrations')
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .flatMap((file) => splitStatements(readFileSync(path.join(dir, file), 'utf8')))
}

suite('purchase-orders SQL, against a real Postgres', () => {
  let cfg: VpsConfig
  let role: TestRole
  let database: TestDatabase
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const dbName = `cactus_rt_po_${stamp}`
  const roleName = `cactus_rt_role_po_${stamp}`

  type Loaded = {
    prisma: typeof import('@/lib/db/prisma')
    db: typeof import('@/modules/purchase-orders/lib/db')
    proforma: typeof import('@/modules/purchase-orders/lib/proforma')
    fromOrder: typeof import('@/modules/purchase-orders/lib/from-order')
    mediaUsage: typeof import('@/modules/purchase-orders/lib/media-usage-provider')
  }
  let mod: Loaded
  let vps: typeof import('@/lib/backup/vps-database')

  let supplierId = ''
  let orderId = ''

  beforeAll(async () => {
    vps = await import('@/lib/backup/vps-database')
    cfg = vps.vpsConfigFromEnv()
    role = await vps.createTestRole(cfg, roleName)
    database = await vps.createTestDatabase(cfg, dbName, role)
    process.env.DATABASE_URL = database.connectionUri
    process.env.DIRECT_URL = database.connectionUri

    mod = {
      prisma: await import('@/lib/db/prisma'),
      db: await import('@/modules/purchase-orders/lib/db'),
      proforma: await import('@/modules/purchase-orders/lib/proforma'),
      fromOrder: await import('@/modules/purchase-orders/lib/from-order'),
      mediaUsage: await import('@/modules/purchase-orders/lib/media-usage-provider'),
    }

    // A freshly-created database takes a moment to accept connections.
    for (let attempt = 0; ; attempt++) {
      try {
        await mod.prisma.prisma.$queryRawUnsafe('SELECT 1')
        break
      } catch (err) {
        if (attempt >= 15) throw err
        await new Promise((r) => setTimeout(r, 2000))
      }
    }

    for (const statement of splitStatements(CORE_SQL)) await mod.prisma.prisma.$executeRawUnsafe(statement)
    for (const statement of moduleSql()) await mod.prisma.prisma.$executeRawUnsafe(statement)
  }, 300_000)

  afterAll(async () => {
    await mod?.prisma.prisma.$disconnect().catch(() => {})
    if (!cfg) return
    if (database) await vps.dropTestDatabase(cfg, database.name).catch(() => {})
    if (role) await vps.dropTestRole(cfg, role.name).catch(() => {})
  }, 300_000)

  it('writes and reads a supplier, accounts department and all', async () => {
    supplierId = await mod.db.createSupplier({
      name: 'Dynamic Office Seating Ltd',
      shopSupplierId: null,
      shopSupplierName: null,
      accountNumber: 'DESKWELL',
      contactName: 'Megan',
      phone: '01604 586 930',
      email: 'sales@example.invalid',
      emailCc: 'buying@example.invalid',
      accountsEmail: 'accounts2@example.invalid',
      proformaPaidToAccounts: true,
      address: { line1: 'Unit 5 Lodge Way', line2: '', city: 'Northampton', region: '', postcode: 'NN5 7RA', country: 'GB' },
      currency: 'GBP',
      paymentTerms: null,
      paymentTermsDays: null,
      accountTerms: 'PROFORMA',
      leadTimeDays: null,
      minimumOrderValue: null,
      carriagePaidOver: null,
      carriageCharge: null,
      discountPercent: null,
      defaultCategoryId: null,
      defaultVatTreatment: null,
      defaultVatRateCode: null,
      taxRegistrationNumber: null,
      deliveryInstructions: null,
      portalNote: null,
      status: 'ENABLED',
      notes: null,
    })

    const supplier = await mod.db.getSupplier(supplierId)
    expect(supplier?.accountsEmail).toBe('accounts2@example.invalid')
    expect(supplier?.proformaPaidToAccounts).toBe(true)

    // The UPDATE statement is a separate list of columns from the INSERT, and a
    // column left out of one of them is a field that saves and never changes.
    await mod.db.updateSupplier(supplierId, {
      ...supplier!,
      accountsEmail: 'finance@example.invalid',
      proformaPaidToAccounts: false,
    })
    const after = await mod.db.getSupplier(supplierId)
    expect(after?.accountsEmail).toBe('finance@example.invalid')
    expect(after?.proformaPaidToAccounts).toBe(false)

    // And the list query, which selects s.* but maps by hand.
    const listed = await mod.db.listSuppliers()
    expect(listed.find((s) => s.id === supplierId)?.accountsEmail).toBe('finance@example.invalid')
  })

  it('files the proforma, the proof and the acknowledgement', async () => {
    const rows = await mod.prisma.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "po_orders" ("number", "supplier_id", "status", "proforma_required", "total")
      VALUES ('PO-00012', ${supplierId}, 'SENT', true, 160.54)
      RETURNING "id"
    `
    orderId = rows[0]!.id

    expect(await mod.proforma.proformaStatus(orderId)).toEqual({ required: true, received: false, paid: false })

    await mod.proforma.setProformaDocument(orderId, 'media-proforma', '0000008633', '160.54')
    await mod.proforma.setAcknowledgementDocument(orderId, 'media-ack', '0000966554')
    await mod.proforma.setPaymentProofDocument(orderId, 'media-proof')

    const filed = await mod.db.getOrder(orderId)
    expect(filed?.proformaRef).toBe('0000008633')
    expect(filed?.proformaAmount).toBe('160.54')
    expect(filed?.ackRef).toBe('0000966554')
    expect(filed?.proformaPaymentProofMediaId).toBe('media-proof')
    expect(filed?.proformaReceived).toBe(true)

    // An upload must never clear a reference somebody typed: the write COALESCEs.
    await mod.proforma.setProformaDocument(orderId, 'media-proforma-2', null, null)
    expect((await mod.db.getOrder(orderId))?.proformaRef).toBe('0000008633')

    // A correction, which must be able to clear one - the whole reason these are
    // separate statements from the upload's.
    await mod.proforma.setProformaReference(orderId, 'INV-99213')
    await mod.proforma.setAcknowledgementReference(orderId, null)
    await mod.proforma.setProformaAmount(orderId, '245.09')
    const corrected = await mod.db.getOrder(orderId)
    expect(corrected?.proformaRef).toBe('INV-99213')
    expect(corrected?.ackRef).toBeNull()
    expect(corrected?.proformaAmount).toBe('245.09')

    await mod.proforma.setProformaAmount(orderId, null)
    expect((await mod.db.getOrder(orderId))?.proformaAmount).toBeNull()
  })

  it('pays it once, stamps the proof, and takes the lot back', async () => {
    expect(await mod.proforma.markProformaPaid(orderId, 'BACS-99887', 'user-1')).toBe(true)
    // Guarded in the WHERE clause: a second press must not re-date somebody
    // else's payment.
    expect(await mod.proforma.markProformaPaid(orderId, 'BACS-OTHER', 'user-2')).toBe(false)

    await mod.proforma.markProofSent(orderId)
    const paid = await mod.db.getOrder(orderId)
    expect(paid?.proformaPaymentRef).toBe('BACS-99887')
    expect(paid?.proformaProofSentAt).toBeTruthy()
    expect(paid?.proformaPaid).toBe(true)

    await mod.proforma.clearProformaPayment(orderId)
    const unpaid = await mod.db.getOrder(orderId)
    expect(unpaid?.proformaPaidAt).toBeNull()
    // The proof stamp comes off with the payment: a proof recorded as sent
    // against a payment that no longer exists is the one lie worth avoiding.
    expect(unpaid?.proformaProofSentAt).toBeNull()
    // The documents themselves stay exactly where they are.
    expect(unpaid?.proformaPaymentProofMediaId).toBe('media-proof')
  })

  it('carries the proforma facts onto the lists that draw the badge', async () => {
    await mod.proforma.setProformaRequired(orderId, true)
    const { orders } = await mod.db.listOrders({})
    const listed = orders.find((o) => o.id === orderId)
    expect(listed?.proformaRequired).toBe(true)
    expect(listed?.proformaReceived).toBe(true)
    expect(listed?.proformaPaid).toBe(false)

    // Shop's own panel reads a different query for the same three facts.
    await mod.prisma.prisma.$executeRaw`
      UPDATE "po_orders"
         SET "source_kind" = 'FROM_ORDER', "source_ref" = '{"orderId":"shop-1"}'::jsonb
       WHERE "id" = ${orderId}
    `
    const raised = await mod.fromOrder.listPosForShopOrder('shop-1')
    expect(raised).toHaveLength(1)
    expect(raised[0]?.proformaRequired).toBe(true)
    expect(raised[0]?.proformaReceived).toBe(true)
    expect(raised[0]?.proformaPaid).toBe(false)
  })

  it('offers every filed document to the media library as used', async () => {
    const used = await mod.mediaUsage.purchaseOrdersMediaUsageProvider()
    // The proforma has been replaced once, so the first id is genuinely gone.
    expect(used).toContain('media-proforma-2')
    expect(used).toContain('media-ack')
    expect(used).toContain('media-proof')
  })
})
