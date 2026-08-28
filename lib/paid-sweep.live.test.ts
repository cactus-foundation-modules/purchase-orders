import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  connectionUri,
  createTestDatabase,
  createTestRole,
  dropStaleTestObjects,
  dropTestDatabase,
  dropTestRole,
  vpsConfigFromEnv,
  type TestRole,
  type VpsConfig,
} from '@/lib/backup/vps-database'

// The two queries behind the paid-order sweep, run against a real Postgres.
//
// They need this more than most raw SQL in the module does, for one reason:
// BOTH ARE WRAPPED IN A CATCH that degrades to "nothing to sweep". That is the
// right behaviour for a shop too old to carry the columns, and it is also a
// perfect place for a typo to hide - a broken query would simply never draft
// anything, silently, for ever, and the cron would go on reporting success.
// `tsc` and `eslint` have nothing whatever to say about either statement.
//
// Rows as well as syntax, because "it parses" is not "it picks the right ones".
// The interesting cases are all near-misses: an order already raised for, one
// whose only purchase order was cancelled, one a week too old, one refunded.
//
// Gated on the same OVH credentials the backup round-trip needs, and bound to
// the same `cactus_rt_` prefix, which is the only thing this file may ever
// create or drop.
//
//   RUN_PO_SQL=1 npx vitest run modules/purchase-orders/lib/paid-sweep.live.test.ts

const enabled = process.env.RUN_PO_SQL === '1'
const suite = enabled ? describe : describe.skip

const stamp = process.env.PO_SQL_STAMP ?? 'x'
const dbName = `cactus_rt_po_${stamp}`
const roleName = `cactus_rt_role_po_${stamp}`

/** The sweep's first query, character for character as lib/paid-sweep.ts sends
 *  it - Prisma's `${}` become `$1`, and nothing else changes. A copy that has
 *  drifted from the original proves nothing about the original. */
const PAID_WITH_NOTHING_RAISED = `
  SELECT o."id", o."order_number"
    FROM "shp_orders" o
   WHERE o."payment_status" = 'PAID'
     AND o."status" NOT IN ('CANCELLED', 'REFUNDED')
     AND o."paid_at" IS NOT NULL
     AND o."paid_at" >= now() - make_interval(days => $1)
     AND NOT EXISTS (
           SELECT 1 FROM "po_orders" p
            WHERE p."source_kind" = 'FROM_ORDER'
              AND p."source_ref"->>'orderId' = o."id"
              AND p."status" <> 'CANCELLED'
         )
   ORDER BY o."paid_at" ASC
`

const LIVE_FOR_DEAD_ORDERS = `
  SELECT p."number", p."status", o."order_number", o."status" AS "order_status",
         s."name" AS "supplier_name"
    FROM "po_orders" p
    JOIN "shp_orders" o ON o."id" = p."source_ref"->>'orderId'
    LEFT JOIN "po_suppliers" s ON s."id" = p."supplier_id"
   WHERE p."source_kind" = 'FROM_ORDER'
     AND p."status" NOT IN ('CANCELLED', 'CLOSED')
     AND o."status" IN ('CANCELLED', 'REFUNDED')
   ORDER BY p."created_at" ASC
`

const SWEEP_DAYS = 7

suite('the paid-order sweep, against a real Postgres', () => {
  let cfg: VpsConfig
  let role: TestRole
  let client: Client

  beforeAll(async () => {
    cfg = vpsConfigFromEnv()
    await dropStaleTestObjects(cfg)
    role = await createTestRole(cfg, roleName)
    await createTestDatabase(cfg, dbName, role)
    // The box's certificate names db.dwoffice.furniture rather than the VPS
    // hostname OVH_SERVER carries, and recent `pg` treats sslmode=require as
    // verify-full. Same reasoning as stock-import's own live test: the
    // connection is still encrypted, and this is a scratch database created
    // seconds ago on a host reached by SSH.
    client = new Client({
      connectionString: connectionUri(cfg, dbName, role).replace('?sslmode=require', ''),
      ssl: { rejectUnauthorized: false },
    })
    await client.connect()

    // Only the shp_orders columns these two statements actually touch. The shop
    // module's own migration is not this module's to run - and this module is
    // built to work on a site that has never had one.
    await client.query(`
      CREATE TABLE "shp_orders" (
        "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "order_number" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'PENDING',
        "payment_status" TEXT NOT NULL DEFAULT 'PENDING',
        "paid_at" TIMESTAMP(3)
      );
    `)

    const dir = join(process.cwd(), 'modules/purchase-orders/migrations')
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      await client.query(readFileSync(join(dir, file), 'utf8'))
    }

    await client.query(`INSERT INTO "po_suppliers" ("id","name","name_key") VALUES ('s1','Dynamic','dynamic')`)
  }, 180_000)

  afterAll(async () => {
    await client?.end().catch(() => {})
    if (!cfg) return
    await dropTestDatabase(cfg, dbName).catch(() => {})
    await dropTestRole(cfg, roleName).catch(() => {})
  }, 120_000)

  it('applies every migration a second time without complaint', async () => {
    // 005 adds columns and re-adds two CHECK constraints. A second pass is what
    // an install with a purged migration ledger does, and it has to be a no-op.
    const dir = join(process.cwd(), 'modules/purchase-orders/migrations')
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      await expect(client.query(readFileSync(join(dir, file), 'utf8'))).resolves.toBeTruthy()
    }
  }, 120_000)

  it('takes the new columns 005 adds, and refuses a discount over 100', async () => {
    await client.query(`UPDATE "po_suppliers" SET "discount_percent" = 25.5 WHERE "id" = 's1'`)
    const read = await client.query(`SELECT "discount_percent" FROM "po_suppliers" WHERE "id" = 's1'`)
    expect(Number(read.rows[0].discount_percent)).toBe(25.5)

    await expect(
      client.query(`UPDATE "po_suppliers" SET "discount_percent" = 101 WHERE "id" = 's1'`),
    ).rejects.toThrow(/discount_percent_check/)

    await client.query(`
      INSERT INTO "po_supplier_catalogues" ("id","supplier_id","name","name_key")
      VALUES ('c1','s1','Seating','seating')
    `)
    const basis = await client.query(`SELECT "price_basis" FROM "po_supplier_catalogues" WHERE "id" = 'c1'`)
    expect(basis.rows[0].price_basis, 'existing lists must keep reading as trade net').toBe('NET')
    await expect(
      client.query(`UPDATE "po_supplier_catalogues" SET "price_basis" = 'RRP' WHERE "id" = 'c1'`),
    ).rejects.toThrow(/price_basis_check/)
  })

  it('picks up a paid order with nothing standing against it, and nothing else', async () => {
    await client.query(`DELETE FROM "po_orders"`)
    await client.query(`DELETE FROM "shp_orders"`)
    await client.query(`
      INSERT INTO "shp_orders" ("id","order_number","status","payment_status","paid_at") VALUES
        ('o-new',    'SO-1', 'PROCESSING', 'PAID',    now() - interval '1 day'),
        ('o-raised', 'SO-2', 'PROCESSING', 'PAID',    now() - interval '1 day'),
        ('o-old',    'SO-3', 'PROCESSING', 'PAID',    now() - interval '30 days'),
        ('o-gone',   'SO-4', 'REFUNDED',   'PAID',    now() - interval '2 days'),
        ('o-unpaid', 'SO-5', 'PENDING',    'PENDING', NULL),
        ('o-retry',  'SO-6', 'PROCESSING', 'PAID',    now() - interval '3 days')
    `)
    await client.query(`
      INSERT INTO "po_orders" ("id","number","status","supplier_id","source_kind","source_ref") VALUES
        ('p1','PO-1','DRAFT',    's1','FROM_ORDER','{"orderId":"o-raised"}'::jsonb),
        ('p2','PO-2','SENT',     's1','FROM_ORDER','{"orderId":"o-gone"}'::jsonb),
        ('p3','PO-3','CANCELLED','s1','FROM_ORDER','{"orderId":"o-retry"}'::jsonb),
        ('p4','PO-4','DRAFT',    's1','MANUAL',     NULL)
    `)

    const rows = await client.query(PAID_WITH_NOTHING_RAISED, [SWEEP_DAYS])
    expect(rows.rows.map((r) => r.id)).toEqual(['o-retry', 'o-new'])
  })

  it('reports a live purchase order against an order that has since died', async () => {
    const rows = await client.query(LIVE_FOR_DEAD_ORDERS)
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].number).toBe('PO-2')
    expect(rows.rows[0].order_number).toBe('SO-4')
    expect(rows.rows[0].supplier_name).toBe('Dynamic')
  })

  it('stops reporting one that has been cancelled or closed since', async () => {
    await client.query(`UPDATE "po_orders" SET "status" = 'CANCELLED' WHERE "id" = 'p2'`)
    expect((await client.query(LIVE_FOR_DEAD_ORDERS)).rowCount).toBe(0)
    await client.query(`UPDATE "po_orders" SET "status" = 'CLOSED' WHERE "id" = 'p2'`)
    expect((await client.query(LIVE_FOR_DEAD_ORDERS)).rowCount).toBe(0)
  })
})
