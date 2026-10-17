import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import {
  connectionUri,
  createTestDatabase,
  createTestRole,
  dropStaleTestObjects,
  dropTestDatabase,
  dropTestRole,
  testServerFromEnv,
  type TestRole,
  type TestServer,
} from '@/lib/backup/test-database'

// A customer order for a KIT, read and despatched against a real Postgres.
//
// Two statements carry the whole feature on this side: the read that swaps a kit
// line for its parts (lib/from-order.ts, readKitParts) and the one that works out
// how many whole kits a parcel completes (lib/kit-despatch.ts). Both are raw SQL
// joined across this module's tables and the shop's, which is exactly what tsc,
// eslint and the build gate cannot see into - so they are run here.
//
// Gated like the suites beside it; the database is a cactus_rt_* one, dropped
// afterwards, and nothing else on that server is ever named.

const ENABLED = process.env.RUN_LEDGER_GUARDS === '1' || process.env.RUN_PO_SQL === '1'
if (ENABLED) {
  try {
    ;(process as unknown as { loadEnvFile: (path: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - testServerFromEnv below fails the suite loudly rather than here.
  }
}
const suite = ENABLED ? describe : describe.skip

suite('kit orders, against a real database', () => {
  let server: TestServer
  let role: TestRole
  let client: Client
  const databaseName = `cactus_rt_pokit_${process.pid}`
  const roleName = `cactus_rt_role_pokit_${process.pid}`
  let q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

  const addr = JSON.stringify({ firstName: 'A', lastName: 'Buyer', line1: '1 Street', city: 'Town', postcode: 'E1 1AA', country: 'GB' })

  beforeAll(async () => {
    server = testServerFromEnv()
    await dropStaleTestObjects(server)
    role = await createTestRole(server, roleName)
    await createTestDatabase(server, databaseName, role)
    const uri = connectionUri(server, databaseName, role)
    client = new Client({ connectionString: `${uri}&uselibpqcompat=true` })
    await client.connect()
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    await client.query(readFileSync(join(process.cwd(), 'prisma', 'migrations', '20260626000000_init', 'migration.sql'), 'utf8'))
    for (const moduleName of ['shop', 'purchase-orders']) {
      const dir = join(process.cwd(), 'modules', moduleName, 'migrations')
      for (const file of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
        await client.query(readFileSync(join(dir, file), 'utf8'))
      }
    }
    q = async (sql, params = []) => (await client.query(sql, params)).rows
    process.env.DATABASE_URL = uri
    process.env.DIRECT_URL = uri

    const product = (id: string, supplier: string | null, sku: string, cost: string) =>
      q(`INSERT INTO shp_products (id,name,slug,type,price,status,sku,supplier,cost_price,track_inventory,stock_count)
         VALUES ($1,$2,$3,'PHYSICAL','10.00','ACTIVE',$4,$5,$6,true,50)`, [id, `Name ${id}`, `slug-${id}`, sku, supplier, cost])
    await product('seat', 'Dynamic Office Solutions', 'P-SEAT', '30.00')
    await product('base', 'Other Supplier Ltd', 'P-BASE', '12.50')
    await product('plain', 'Dynamic Office Solutions', 'P-PLAIN', '5.00')
    await q(`INSERT INTO shp_products (id,name,slug,type,price,status) VALUES ('kit','Kit chair','kit-chair','PHYSICAL','99.00','ACTIVE')`)
    await q(`INSERT INTO shp_product_components (product_id, component_product_id, quantity) VALUES ('kit','seat',1), ('kit','base',2)`)

    await q(`INSERT INTO shp_orders (id,order_number,customer_email,customer_name,shipping_address,subtotal,total,tax_mode,payment_method)
             VALUES ('ord-1','DW000200','a@example.com','A Buyer',$1::jsonb,297,297,'EXCLUSIVE','STRIPE')`, [addr])
    await q(`INSERT INTO shp_order_items (id,order_id,product_id,product_name,product_type,quantity,unit_price,tax_rate,tax_amount,total)
             VALUES ('line-kit','ord-1','kit','Kit chair','PHYSICAL',3,99,0,0,297),
                    ('line-plain','ord-1','plain','A plain thing','PHYSICAL',2,10,0,0,20)`)
  }, 300_000)

  afterAll(async () => {
    await import('@/lib/db/prisma').then((m) => m.prisma.$disconnect()).catch(() => undefined)
    await client?.end().catch(() => undefined)
    if (server) {
      await dropTestDatabase(server, databaseName).catch(() => undefined)
      await dropTestRole(server, roleName).catch(() => undefined)
    }
  }, 120_000)

  it('reads a kit line as one line per part, and an ordinary line as itself', async () => {
    const { readShopOrder } = await import('@/modules/purchase-orders/lib/from-order')
    const order = await readShopOrder('ord-1')
    expect(order).not.toBeNull()
    const lines = order!.items.map((i) => [i.itemId, i.productId, i.quantity, i.sku, i.supplierName, Number(i.costPrice)])
    expect(lines).toEqual(expect.arrayContaining([
      ['line-kit', 'seat', 3, 'P-SEAT', 'Dynamic Office Solutions', 30],
      ['line-kit', 'base', 6, 'P-BASE', 'Other Supplier Ltd', 12.5],
      ['line-plain', 'plain', 2, 'P-PLAIN', 'Dynamic Office Solutions', 5],
    ]))
    expect(order!.items).toHaveLength(3)
  })

  it('reports a kit as dispatched only once its scarcest part has gone', async () => {
    const { kitAwareDespatchLines } = await import('@/modules/purchase-orders/lib/kit-despatch')

    await q(`INSERT INTO po_suppliers (id,name,name_key) VALUES ('s-a','Dynamic Office Solutions','dynamic office solutions'), ('s-b','Other Supplier Ltd','other supplier ltd')`)
    const po = (id: string, supplier: string, number: string) =>
      q(`INSERT INTO po_orders (id,number,supplier_id,status,source_kind,source_ref)
         VALUES ($1,$2,$3,'SENT','FROM_ORDER',$4::jsonb)`, [id, number, supplier, JSON.stringify({ orderId: 'ord-1', orderNumber: 'DW000200' })])
    await po('po-a', 's-a', 'PO-A')
    await po('po-b', 's-b', 'PO-B')
    await q(`INSERT INTO po_order_lines (id,order_id,product_id,description,qty,source_order_item_id) VALUES
             ('pl-seat','po-a','seat','Chair seat',3,'line-kit'),
             ('pl-plain','po-a','plain','A plain thing',2,'line-plain'),
             ('pl-base','po-b','base','Chair base',6,'line-kit')`)
    const shipment = (id: string, order: string, number: string, at: string) =>
      q(`INSERT INTO po_shipments (id,number,order_id,despatched_date,created_at) VALUES ($1,$2,$3,CURRENT_DATE,$4::timestamptz)`, [id, number, order, at])
    const shipped = (shipmentId: string, lineId: string, qty: number) =>
      q(`INSERT INTO po_shipment_lines (shipment_id,order_line_id,qty) VALUES ($1,$2,$3)`, [shipmentId, lineId, qty])

    // The seats go first, all three, with the plain thing: nothing of the kit
    // is whole yet, but the plain line passes through untouched.
    await shipment('d1', 'po-a', 'SHP-1', '2026-10-01T09:00:00Z')
    await shipped('d1', 'pl-seat', 3)
    await shipped('d1', 'pl-plain', 2)
    expect(await kitAwareDespatchLines('d1', 'ord-1', [
      { sourceOrderItemId: 'line-kit', qty: 3 },
      { sourceOrderItemId: 'line-plain', qty: 2 },
    ])).toEqual([{ sourceOrderItemId: 'line-plain', qty: 2 }])

    // Four of the six bases arrive from the other supplier: two whole kits.
    await shipment('d2', 'po-b', 'SHP-2', '2026-10-02T09:00:00Z')
    await shipped('d2', 'pl-base', 4)
    expect(await kitAwareDespatchLines('d2', 'ord-1', [{ sourceOrderItemId: 'line-kit', qty: 4 }]))
      .toEqual([{ sourceOrderItemId: 'line-kit', qty: 2 }])

    // The last two bases complete the third.
    await shipment('d3', 'po-b', 'SHP-3', '2026-10-03T09:00:00Z')
    await shipped('d3', 'pl-base', 2)
    expect(await kitAwareDespatchLines('d3', 'ord-1', [{ sourceOrderItemId: 'line-kit', qty: 2 }]))
      .toEqual([{ sourceOrderItemId: 'line-kit', qty: 1 }])

    // Telling the first parcel's story again later still says nothing about kits.
    expect(await kitAwareDespatchLines('d1', 'ord-1', [{ sourceOrderItemId: 'line-kit', qty: 3 }])).toEqual([])
  })
})
