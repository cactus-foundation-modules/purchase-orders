import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import type { TestDatabase, TestRole, VpsConfig } from '@/lib/backup/vps-database'
import { splitStatements } from '@/modules/purchase-orders/lib/sql-statements.test-support'

// Sending automatic drafts by themselves, ACTUALLY EXECUTED against Postgres.
//
// Every statement behind the queue is raw SQL that no typecheck, lint or build
// runs: migration 019, putting a fresh draft in the queue, holding it when a
// person changes it, the claim that has to stop two runs at once emailing one
// order twice, the bounded retries, the refusal report taken once, the edit
// record beside the switch, and the customer order re-read at send time. So
// this runs them all, through the paid-order run and the job themselves, with
// only the mailer stood in for (and the capability probe, which would
// otherwise go looking for other modules' code).
//
// The customer orders are real shop rows: shop's own migrations are applied to
// the throwaway database, so the raw SQL that reads them (lib/from-order.ts) is
// run against the schema it reads in life. Test-only - nothing in this module
// imports shop.
//
// Its own throwaway database on the self-hosted Postgres VPS (`cactus_rt_*`,
// a throwaway role, both dropped afterwards). Opt-in, same switch as the
// module's other live suites:
//
//   RUN_PO_SQL=1 vitest run modules/purchase-orders/lib/auto-send.live.test.ts --testTimeout 300000
const shouldRun = process.env.RUN_PO_SQL === '1'
if (shouldRun) {
  try {
    ;(process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - the guard below fails the suite loudly rather than skipping.
  }
}

const suite = shouldRun ? describe : describe.skip
if (shouldRun) vi.setConfig({ testTimeout: 120_000 })

// The mailer, stood in for: every purchase order "sent", and every report.
const mailer = vi.hoisted(() => ({
  sent: [] as Array<{ number: string; kind: string }>,
  failWith: null as string | null,
  /** Run while the email is "going" - for a person acting mid-send. */
  during: null as null | (() => Promise<void>),
  reports: [] as Array<{ to: string; whatHappened: string; lines: string }>,
}))
vi.mock('@/modules/purchase-orders/lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/purchase-orders/lib/email')>()
  return {
    ...actual,
    sendOrderToSupplier: async (ctx: { order: { number: string } }, _to: unknown, kind: string) => {
      // A beat inside the send, so two runs at once genuinely overlap.
      await new Promise((r) => setTimeout(r, 250))
      if (mailer.during) await mailer.during()
      if (mailer.failWith) throw new Error(mailer.failWith)
      mailer.sent.push({ number: ctx.order.number, kind })
    },
    sendAutoSendReport: async (to: string, report: { whatHappened: string; lines: string }) => {
      mailer.reports.push({ to, ...report })
    },
  }
})
vi.mock('@/modules/purchase-orders/lib/capabilities', () => ({
  getCapabilities: async () => ({ hasCatalogue: true, hasInventory: false, hasBooks: false, hasInbox: false }),
}))

const CORE_SQL = readFileSync(path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql'), 'utf8')
const MIGRATIONS = path.join(process.cwd(), 'modules', 'purchase-orders', 'migrations')
const SHOP_MIGRATIONS = path.join(process.cwd(), 'modules', 'shop', 'migrations')

function migrationSql(only?: string): string[] {
  return readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql') && (!only || file === only))
    .sort()
    .flatMap((file) => splitStatements(readFileSync(path.join(MIGRATIONS, file), 'utf8')))
}

suite('sending automatic drafts by themselves, against a real Postgres', () => {
  let cfg: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let shop: Client
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const dbName = `cactus_rt_po_as_${stamp}`
  const roleName = `cactus_rt_role_po_as_${stamp}`

  type Loaded = {
    prisma: typeof import('@/lib/db/prisma')
    db: typeof import('@/modules/purchase-orders/lib/db')
    config: typeof import('@/modules/purchase-orders/lib/config')
    raise: typeof import('@/modules/purchase-orders/lib/from-order-run')
    queue: typeof import('@/modules/purchase-orders/lib/auto-send-queue')
    run: typeof import('@/modules/purchase-orders/lib/auto-send-run')
    report: typeof import('@/modules/purchase-orders/lib/auto-send-report')
    document: typeof import('@/modules/purchase-orders/lib/document')
    audit: typeof import('@/modules/purchase-orders/lib/audit')
    exporter: typeof import('@/modules/purchase-orders/lib/export')
  }
  let mod: Loaded
  let vps: typeof import('@/lib/backup/vps-database')
  const ids: Record<string, string> = {}
  const farOff = () => Date.now() + 120_000

  async function sql<T = Record<string, unknown>>(text: string, ...values: unknown[]): Promise<T[]> {
    return mod.prisma.prisma.$queryRawUnsafe<T[]>(text, ...values)
  }

  async function po(id: string) {
    return (await sql(`SELECT * FROM "po_orders" WHERE "id" = $1`, id))[0]!
  }

  let customers = 0
  /** A paid customer order for these products, as shop writes one. */
  async function customerOrder(items: Array<[productId: string, name: string, qty: number]>): Promise<{ id: string; number: string }> {
    customers++
    const id = `ord-${customers}`
    const number = `SO-${1000 + customers}`
    await shop.query(
      `INSERT INTO "shp_orders" (
        "id","order_number","customer_email","customer_name","shipping_address",
        "subtotal","tax_amount","total","tax_mode","payment_method","payment_status","status","paid_at"
      ) VALUES ($1,$2,'buyer@example.test','A Buyer','{"postcode":"AB1 2DE","line1":"1 Road","city":"Exampletown","country":"GB"}',
        '100.00','20.00','120.00','EXCLUSIVE','BANK_TRANSFER','PAID','PROCESSING',CURRENT_TIMESTAMP)`,
      [id, number],
    )
    let line = 0
    for (const [productId, name, qty] of items) {
      line++
      await shop.query(
        `INSERT INTO "shp_order_items" (
          "id","order_id","product_id","product_name","product_type","quantity","unit_price","tax_rate","tax_amount","total"
        ) VALUES ($1,$2,$3,$4,'PHYSICAL',$5,'100.00','0.2000','20.00','100.00')`,
        [`${id}-item-${line}`, id, productId, name, qty],
      )
    }
    return { id, number }
  }

  /** Raise it as the money landing does: no session, so automatic. */
  async function draftFor(items: Array<[string, string, number]>) {
    const customer = await customerOrder(items)
    const result = await mod.raise.raisePurchaseOrdersFromShopOrder({ orderId: customer.id, userId: null })
    return { customer, result, acme: result.ordersCreated.find((p) => p.supplierName === 'Acme Supplies') }
  }

  beforeAll(async () => {
    process.env.SITE_URL = 'https://example.test'
    vps = await import('@/lib/backup/vps-database')
    cfg = vps.vpsConfigFromEnv()
    role = await vps.createTestRole(cfg, roleName)
    database = await vps.createTestDatabase(cfg, dbName, role)
    process.env.DATABASE_URL = database.connectionUri
    process.env.DIRECT_URL = database.connectionUri

    mod = {
      prisma: await import('@/lib/db/prisma'),
      db: await import('@/modules/purchase-orders/lib/db'),
      config: await import('@/modules/purchase-orders/lib/config'),
      raise: await import('@/modules/purchase-orders/lib/from-order-run'),
      queue: await import('@/modules/purchase-orders/lib/auto-send-queue'),
      run: await import('@/modules/purchase-orders/lib/auto-send-run'),
      report: await import('@/modules/purchase-orders/lib/auto-send-report'),
      document: await import('@/modules/purchase-orders/lib/document'),
      audit: await import('@/modules/purchase-orders/lib/audit'),
      exporter: await import('@/modules/purchase-orders/lib/export'),
    }

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
    for (const statement of migrationSql()) await mod.prisma.prisma.$executeRawUnsafe(statement)

    // Shop's own schema, whole files at a time, exactly as an install has it.
    shop = new Client({ connectionString: `${database.connectionUri}&uselibpqcompat=true` })
    await shop.connect()
    await shop.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    for (const file of readdirSync(SHOP_MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
      await shop.query(readFileSync(path.join(SHOP_MIGRATIONS, file), 'utf8'))
    }
  }, 300_000)

  afterAll(async () => {
    await shop?.end().catch(() => {})
    await mod?.prisma.prisma.$disconnect().catch(() => {})
    if (!cfg) return
    if (database) await vps.dropTestDatabase(cfg, database.name).catch(() => {})
    if (role) await vps.dropTestRole(cfg, role.name).catch(() => {})
  }, 300_000)

  it('takes migration 019, and every migration, a second time without complaint', async () => {
    for (const statement of migrationSql('019_auto_send.sql')) await mod.prisma.prisma.$executeRawUnsafe(statement)
    for (const statement of migrationSql()) await mod.prisma.prisma.$executeRawUnsafe(statement)
    const check = await sql<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'po_orders_auto_send_state_check'`,
    )
    expect(check).toHaveLength(1)
    expect(check[0]!.def).toContain('REFUSED')
    const indexes = await sql<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname LIKE 'po_orders_auto_send_%' ORDER BY indexname`,
    )
    expect(indexes.map((i) => i.indexname)).toEqual([
      'po_orders_auto_send_claimed_idx',
      'po_orders_auto_send_queued_idx',
      'po_orders_auto_send_unreported_idx',
    ])
  })

  it('sets up two suppliers, one switched on, their products in the shop, and the switches', async () => {
    const base = {
      shopSupplierId: null, shopSupplierName: null, accountNumber: null, contactName: null, phone: null,
      emailCc: null, accountsEmail: null, proformaPaidToAccounts: false, dropships: true,
      address: { line1: '', line2: '', city: '', region: '', postcode: '', country: '' },
      currency: 'GBP', paymentTerms: null, paymentTermsDays: 30, accountTerms: 'CREDIT' as const,
      leadTimeDays: null, minimumOrderValue: null, carriagePaidOver: null, carriageCharge: null,
      surchargeThreshold: null, surchargeRates: [], discountPercent: null, defaultCategoryId: null,
      defaultVatTreatment: null, defaultVatRateCode: null, taxRegistrationNumber: null,
      deliveryInstructions: null, portalNote: null, inboundSenders: [], status: 'ENABLED' as const, notes: null,
    }
    ids.acme = await mod.db.createSupplier({ ...base, name: 'Acme Supplies', email: 'orders@acme.example', autoSend: true })
    ids.beta = await mod.db.createSupplier({ ...base, name: 'Beta Ltd', email: 'sales@beta.example' })
    expect((await mod.db.getSupplier(ids.acme))?.autoSend).toBe(true)
    expect((await mod.db.getSupplier(ids.beta))?.autoSend).toBe(false)

    // An edit that leaves the switch out keeps it where it was.
    const acme = (await mod.db.getSupplier(ids.acme))!
    const { autoSend: _omit, ...withoutSwitch } = { ...acme, notes: 'Edited' }
    void _omit
    await mod.db.updateSupplier(ids.acme, withoutSwitch)
    expect((await mod.db.getSupplier(ids.acme))?.autoSend).toBe(true)

    for (const [id, name, supplier, cost] of [
      ['prod-desk', 'Oak desk', 'Acme Supplies', '120.00'],
      ['prod-lamp', 'Brass lamp', 'Acme Supplies', '40.00'],
      ['prod-chair', 'Task chair', 'Beta Ltd', '80.00'],
      ['prod-mystery', 'Mystery thing', null, '10.00'],
    ] as const) {
      await shop.query(
        `INSERT INTO "shp_products" ("id","name","slug","type","price","sku","supplier","supplier_sku","cost_price")
         VALUES ($1,$2,$1,'PHYSICAL','100.00',$3,$4,$5,$6)`,
        [id, name, `SKU-${id}`, supplier, `SUP-${id}`, cost],
      )
    }

    await mod.config.updatePoConfig({
      autoSendEnabled: true,
      autoSendHoldMinutes: 60,
      organisation: { ...mod.config.PO_CONFIG_DEFAULTS.organisation, email: 'buying@example.test' },
    })
  })

  it('queues an automatic draft to a switched-on supplier, and only that one', async () => {
    const { customer, result, acme } = await draftFor([['prod-desk', 'Oak desk', 1], ['prod-chair', 'Task chair', 1]])
    expect(result.refused).toBeNull()
    expect(result.ordersCreated).toHaveLength(2)
    ids.first = acme!.id
    ids.firstCustomer = customer.id
    const beta = result.ordersCreated.find((p) => p.supplierName === 'Beta Ltd')!
    expect((await po(acme!.id)).auto_send_state).toBe('QUEUED')
    expect((await po(beta.id)).auto_send_state).toBeNull()

    // On the screen: when it goes.
    const order = await mod.db.getOrder(acme!.id)
    expect(order?.autoSendState).toBe('QUEUED')
    expect(new Date(order!.autoSendDueAt!).getTime() - new Date(order!.createdAt).getTime()).toBe(60 * 60_000)
  })

  it('leaves a draft somebody pressed Raise for alone', async () => {
    const customer = await customerOrder([['prod-lamp', 'Brass lamp', 1]])
    const result = await mod.raise.raisePurchaseOrdersFromShopOrder({ orderId: customer.id, userId: 'user-pat' })
    expect((await po(result.ordersCreated[0]!.id)).auto_send_state).toBeNull()
    await sql(`UPDATE "po_orders" SET "status" = 'CANCELLED' WHERE "id" = $1`, result.ordersCreated[0]!.id)
  })

  it('refuses straight away where something on the customer order could not be drafted', async () => {
    const { acme } = await draftFor([['prod-lamp', 'Brass lamp', 1], ['prod-mystery', 'Mystery thing', 1]])
    const row = await po(acme!.id)
    expect(row.auto_send_state).toBe('REFUSED')
    expect(row.auto_send_note).toMatch(/One thing on customer order SO-\d+ could not be drafted/)
    ids.skipped = acme!.id
  })

  it('sends nothing before the hold is up', async () => {
    expect(await mod.run.claimDue(60)).toEqual([])
    // ...but the refusal above is still waiting to be reported.
    expect(await mod.run.anythingToDo(60)).toBe(true)
  })

  it('holds a draft for good once a person changes it', async () => {
    const { acme } = await draftFor([['prod-lamp', 'Brass lamp', 2]])
    ids.held = acme!.id
    // What the order route does before saving the change.
    expect(await mod.queue.holdAutoSend({ id: acme!.id, autoSendState: 'QUEUED' }, 'Pat Buyer')).toBe('ok')
    await mod.audit.recordAudit('order', acme!.id, 'order.updated', { total: '90.00' }, 'user-pat')
    const row = await po(acme!.id)
    expect(row.auto_send_state).toBe('HELD')
    expect(row.auto_send_note).toBe('Changed by Pat Buyer, so a person sends it.')
    // A second person who read it as held changes nothing about the hold.
    expect(await mod.queue.holdAutoSend({ id: acme!.id, autoSendState: 'HELD' }, 'Somebody Else')).toBe('ok')
    expect((await po(acme!.id)).auto_send_note).toBe('Changed by Pat Buyer, so a person sends it.')
    // One who read it as still queued is told it moved under them.
    expect(await mod.queue.holdAutoSend({ id: acme!.id, autoSendState: 'QUEUED' }, 'Somebody Else')).toBe('busy')
  })

  it('sends a due draft exactly once when two runs go at the same moment', async () => {
    await mod.config.updatePoConfig({ autoSendHoldMinutes: 0 })
    mailer.sent.length = 0
    const [one, two] = await Promise.all([
      mod.run.runAutoSend({ deadline: farOff() }),
      mod.run.runAutoSend({ deadline: farOff() }),
    ])
    expect(one.sent + two.sent).toBe(1)
    expect(one.claimed + two.claimed).toBe(1)
    expect(mailer.sent).toEqual([{ number: (await po(ids.first!)).number, kind: 'sent' }])

    const row = await po(ids.first!)
    expect(row.status).toBe('SENT')
    expect(row.auto_send_state).toBe('SENT')
    expect(row.auto_send_note).toBe('Sent automatically.')
    expect(row.approved_automatically).toBe(true)
    expect(row.approved_at).not.toBeNull()
    expect(row.approved_by_user_id).toBeNull()
    expect(row.sent_at).not.toBeNull()

    // The history says the job did it, and that sending approved it.
    const history = await sql<{ action: string; detail: { by?: string }; user_id: string | null }>(
      `SELECT "action", "detail", "user_id" FROM "po_audit_log" WHERE "entity_id" = $1 AND "action" IN ('order.approved', 'order.sent') ORDER BY "created_at"`,
      ids.first,
    )
    expect(history.map((h) => [h.action, h.detail.by, h.user_id])).toEqual([
      ['order.approved', 'AUTO', null],
      ['order.sent', 'AUTO', null],
    ])

    // And the paperwork prints the truth where a name would be.
    const ctx = await mod.document.loadPoDocContext(ids.first!)
    expect(ctx?.order.approvedByName).toBe('Sent automatically')
    expect(ctx?.order.approvedAt).not.toBeNull()

    // A third run finds nothing to send.
    expect(await mod.run.runAutoSend({ deadline: farOff() })).toMatchObject({ claimed: 0, sent: 0 })
    expect(mailer.sent).toHaveLength(1)
    // The held draft never went.
    expect((await po(ids.held!)).status).toBe('DRAFT')
  })

  it('says "Sent automatically" in the orders export', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const file = await mod.exporter.buildExport('orders', '2000-01-01', today)
    const at = file.columns.indexOf('approved_by')
    const number = (await po(ids.first!)).number as string
    const row = file.rows.find((r) => r[0] === number)!
    expect(row[at]).toBe('Sent automatically')
  })

  it('tries mail that will not go three times, then refuses it with the mailer’s words', async () => {
    const { acme } = await draftFor([['prod-desk', 'Oak desk', 1]])
    mailer.failWith = '421 Service not available'
    try {
      for (const expected of [1, 2]) {
        const run = await mod.run.runAutoSend({ deadline: farOff() })
        expect(run.retrying).toBe(1)
        const row = await po(acme!.id)
        expect(row.auto_send_state).toBe('QUEUED')
        expect(row.auto_send_attempts).toBe(expected)
        expect(row.auto_send_claimed_at).toBeNull()
      }
      await mod.run.runAutoSend({ deadline: farOff() })
      const row = await po(acme!.id)
      expect(row.auto_send_state).toBe('REFUSED')
      expect(row.auto_send_attempts).toBe(3)
      expect(row.auto_send_note).toBe('The email would not go after 3 tries. The mail server said: 421 Service not available')
      expect(row.status).toBe('DRAFT')
      expect(row.sent_at).toBeNull()
    } finally {
      mailer.failWith = null
    }
    // Nothing more is tried.
    expect(await mod.run.runAutoSend({ deadline: farOff() })).toMatchObject({ claimed: 0 })
  })

  it('refuses where the customer order was refunded in the hold, or refunded in part', async () => {
    const refunded = await draftFor([['prod-desk', 'Oak desk', 1]])
    await shop.query(`UPDATE "shp_orders" SET "status" = 'REFUNDED', "payment_status" = 'REFUNDED' WHERE "id" = $1`, [refunded.customer.id])
    const partial = await draftFor([['prod-desk', 'Oak desk', 2]])
    await shop.query(`UPDATE "shp_order_items" SET "refunded_qty" = 1 WHERE "order_id" = $1`, [partial.customer.id])

    mailer.sent.length = 0
    const run = await mod.run.runAutoSend({ deadline: farOff() })
    expect(run).toMatchObject({ claimed: 2, refused: 2, sent: 0 })
    expect(mailer.sent).toEqual([])
    expect((await po(refunded.acme!.id)).auto_send_note).toBe(
      `Customer order ${refunded.customer.number} has been refunded since this was drafted.`,
    )
    expect((await po(partial.acme!.id)).auto_send_note).toMatch(/Part of customer order SO-\d+ has been refunded/)
    expect((await po(partial.acme!.id)).status).toBe('DRAFT')
  })

  it('refuses a price not off the supplier’s current list, and one over the approval threshold', async () => {
    const unlisted = await draftFor([['prod-lamp', 'Brass lamp', 1]])
    const dear = await draftFor([['prod-desk', 'Oak desk', 1]])
    await sql(`UPDATE "po_orders" SET "approval_required" = true WHERE "id" = $1`, dear.acme!.id)
    await mod.config.updatePoConfig({ supplierCatalogues: true })
    try {
      await mod.run.runAutoSend({ deadline: farOff() })
    } finally {
      await mod.config.updatePoConfig({ supplierCatalogues: false })
    }
    expect((await po(unlisted.acme!.id)).auto_send_note).toMatch(/not on Acme Supplies's current price list/)
    // Price lists are checked after the approval, so this one says approval.
    expect((await po(dear.acme!.id)).auto_send_note).toMatch(/approval threshold/)
  })

  it('refuses everything queued once the site-wide switch goes off', async () => {
    const { acme } = await draftFor([['prod-desk', 'Oak desk', 1]])
    await mod.config.updatePoConfig({ autoSendEnabled: false })
    try {
      await mod.run.runAutoSend({ deadline: farOff() })
    } finally {
      await mod.config.updatePoConfig({ autoSendEnabled: true })
    }
    expect((await po(acme!.id)).auto_send_note).toMatch(/switched off in settings/)
  })

  it('reports every refusal once, in one email, and never again', async () => {
    mailer.reports.length = 0
    expect(await mod.report.reportAutoSendRefusals()).toBe(7)
    expect(mailer.reports).toHaveLength(1)
    expect(mailer.reports[0]!.to).toBe('buying@example.test')
    expect(mailer.reports[0]!.whatHappened).toBe('7 drafts were not sent automatically.')
    expect(mailer.reports[0]!.lines).toContain('could not be drafted')
    expect(mailer.reports[0]!.lines).toContain('421 Service not available')

    expect(await mod.report.reportAutoSendRefusals()).toBe(0)
    expect(mailer.reports).toHaveLength(1)
    expect(await mod.run.anythingToDo(0)).toBe(false)
    // The refusals are in each order's history too.
    const refusals = await sql<{ count: bigint }>(`SELECT count(*) FROM "po_audit_log" WHERE "action" = 'order.auto-send-refused'`)
    expect(Number(refusals[0]!.count)).toBe(7)
  })

  it('keeps the edit record beside the switch', async () => {
    const records = await mod.queue.autoDraftRecords()
    // Acme: every automatic draft above; one of them changed by a person.
    const acme = records.get(ids.acme!)!
    const autoDrafts = await sql<{ count: bigint }>(
      `SELECT count(*) FROM "po_audit_log" a JOIN "po_orders" o ON o."id" = a."entity_id"
        WHERE a."action" = 'order.created' AND a."detail"->>'raisedBy' = 'AUTO' AND o."supplier_id" = $1`,
      ids.acme,
    )
    expect(acme.drafts).toBe(Math.min(10, Number(autoDrafts[0]!.count)))
    expect(acme.changed).toBe(1)
    // Beta had one, never changed.
    expect(records.get(ids.beta!)).toEqual({ drafts: 1, changed: 0 })

    // An edit AFTER the send does not count against it.
    await mod.audit.recordAudit('order', ids.first!, 'order.updated', { total: '1.00' }, 'user-pat')
    expect((await mod.queue.autoDraftRecords()).get(ids.acme!)?.changed).toBe(1)
  })

  it('lets a person send a queued draft by hand, leaving it sent by them', async () => {
    await mod.config.updatePoConfig({ autoSendHoldMinutes: 600 })
    const { acme } = await draftFor([['prod-desk', 'Oak desk', 1]])
    const { sendOrderRun } = await import('@/modules/purchase-orders/lib/send-run')
    const result = await sendOrderRun({ orderId: acme!.id, userId: 'user-pat', by: 'USER' })
    expect(result.outcome).toBe('sent')
    const row = await po(acme!.id)
    expect(row.auto_send_state).toBe('SENT')
    expect(row.auto_send_note).toBe('Sent by hand.')
    expect(row.approved_by_user_id).toBe('user-pat')
    expect(row.approved_automatically).toBe(false)
  })
  // ---------------------------------------------------------------------
  // Fix round 1: a person and the job never act on one draft at once, and
  // nothing the job does after an email has gone sends it again.
  // ---------------------------------------------------------------------

  async function emailsFor(orderId: string): Promise<number> {
    const number = (await po(orderId)).number as string
    return mailer.sent.filter((m) => m.number === number).length
  }

  it('emails a draft once when the job and a person press Send at the same moment', async () => {
    await mod.config.updatePoConfig({ autoSendHoldMinutes: 0 })
    const { sendOrderRun } = await import('@/modules/purchase-orders/lib/send-run')
    for (const head of [0, 120]) {
      const { acme } = await draftFor([['prod-desk', 'Oak desk', 1]])
      mailer.sent.length = 0
      const person = async () => {
        await new Promise((r) => setTimeout(r, head))
        return sendOrderRun({ orderId: acme!.id, userId: 'user-pat', by: 'USER', personName: 'Pat', seenSentAt: null })
      }
      const [job, hand] = await Promise.all([mod.run.runAutoSend({ deadline: farOff() }), person()])
      expect(await emailsFor(acme!.id)).toBe(1)
      expect(job.sent + (hand.outcome === 'sent' ? 1 : 0)).toBe(1)
      if (hand.outcome !== 'sent') {
        expect(hand).toMatchObject({ outcome: 'refused', status: 409 })
      }
      const row = await po(acme!.id)
      expect(row.status).toBe('SENT')
      expect(row.auto_send_state).toBe('SENT')
      expect(row.auto_send_claimed_at).toBeNull()
    }
  })

  it('refuses a person a second send of an order the job sent after their screen was drawn', async () => {
    const { acme } = await draftFor([['prod-desk', 'Oak desk', 1]])
    await mod.run.runAutoSend({ deadline: farOff() })
    expect((await po(acme!.id)).status).toBe('SENT')
    mailer.sent.length = 0
    const { sendOrderRun } = await import('@/modules/purchase-orders/lib/send-run')
    const late = await sendOrderRun({ orderId: acme!.id, userId: 'user-pat', by: 'USER', personName: 'Pat', seenSentAt: null })
    expect(late).toMatchObject({ outcome: 'refused', status: 409 })
    expect(late.outcome === 'refused' && late.reason).toMatch(/just been sent automatically/)
    expect(mailer.sent).toEqual([])
  })

  it('refuses a person’s change while the job is emailing the draft, and sends what it checked', async () => {
    const { acme } = await draftFor([['prod-desk', 'Oak desk', 1]])
    const verdicts: string[] = []
    mailer.during = async () => {
      // What the order screen's Save does first, mid-send.
      verdicts.push(await mod.queue.holdAutoSend({ id: acme!.id, autoSendState: 'QUEUED' }, 'Pat'))
      verdicts.push(await mod.queue.holdAutoSend({ id: acme!.id, autoSendState: 'SENT' }, 'Pat'))
    }
    try {
      await mod.run.runAutoSend({ deadline: farOff() })
    } finally {
      mailer.during = null
    }
    expect(verdicts).toEqual(['busy', 'busy'])
    const row = await po(acme!.id)
    expect(row.status).toBe('SENT')
    expect(row.auto_send_state).toBe('SENT')
    // Done and let go: a change now is an ordinary amendment, not refused.
    expect(await mod.queue.holdAutoSend({ id: acme!.id, autoSendState: 'SENT' }, 'Pat')).toBe('ok')
  })

  it('sends nothing when the draft was written to, or its claim lapsed, after the job read it', async () => {
    const { sendOrderRun, rowStamp } = await import('@/modules/purchase-orders/lib/send-run')
    const { acme } = await draftFor([['prod-desk', 'Oak desk', 1]])
    const stamp = await rowStamp(acme!.id)
    expect(await mod.run.claimDue(0)).toEqual([acme!.id])
    // Something writes to it after the job read it.
    await sql(`UPDATE "po_orders" SET "notes_internal" = 'touched', "updated_at" = now() WHERE "id" = $1`, acme!.id)
    mailer.sent.length = 0
    expect(await sendOrderRun({ orderId: acme!.id, userId: null, by: 'AUTO', autoStamp: stamp })).toEqual({ outcome: 'stale' })
    expect(mailer.sent).toEqual([])
    expect((await po(acme!.id)).auto_send_state).toBe('QUEUED')

    // Read afresh, but the claim is long gone.
    await sql(`UPDATE "po_orders" SET "auto_send_claimed_at" = now() - interval '11 minutes' WHERE "id" = $1`, acme!.id)
    expect(await sendOrderRun({ orderId: acme!.id, userId: null, by: 'AUTO', autoStamp: await rowStamp(acme!.id) })).toEqual({
      outcome: 'stale',
    })
    expect(mailer.sent).toEqual([])

    // Through the job, which lets go of it on 'stale' and sends it next time.
    await sql(`UPDATE "po_orders" SET "auto_send_claimed_at" = NULL WHERE "id" = $1`, acme!.id)
    await mod.run.runAutoSend({ deadline: farOff() })
    expect(await emailsFor(acme!.id)).toBe(1)
  })

  it('never emails again a draft whose recording failed after the email went', async () => {
    const { acme } = await draftFor([['prod-desk', 'Oak desk', 1]])
    // Test-only: make marking this one order SENT fail, after the email.
    await shop.query(`
      CREATE OR REPLACE FUNCTION cactus_rt_break_send() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW."status" = 'SENT' AND NEW."id" = '${acme!.id}' THEN RAISE EXCEPTION 'disk full'; END IF;
        RETURN NEW;
      END $f$`)
    await shop.query(`CREATE TRIGGER cactus_rt_break_send BEFORE UPDATE ON "po_orders" FOR EACH ROW EXECUTE FUNCTION cactus_rt_break_send()`)
    mailer.sent.length = 0
    try {
      const run = await mod.run.runAutoSend({ deadline: farOff() })
      expect(run).toMatchObject({ sent: 0, refused: 1 })
    } finally {
      await shop.query(`DROP TRIGGER IF EXISTS cactus_rt_break_send ON "po_orders"`)
    }
    expect(mailer.sent).toHaveLength(1)
    const row = await po(acme!.id)
    expect(row.auto_send_state).toBe('REFUSED')
    expect(row.auto_send_note).toMatch(/^The email went to the supplier.*do not send it again\.$/)
    // Every later run leaves it alone.
    await mod.run.runAutoSend({ deadline: farOff() })
    await mod.run.runAutoSend({ deadline: farOff() })
    expect(mailer.sent).toHaveLength(1)
  })

  it('refuses, never re-sends, a send a dead run left part way', async () => {
    const { acme } = await draftFor([['prod-desk', 'Oak desk', 1]])
    // A run that marked it as being emailed and then died.
    await sql(
      `UPDATE "po_orders" SET "auto_send_state" = 'SENT', "auto_send_note" = 'Being emailed now.',
              "auto_send_claimed_at" = now() - interval '11 minutes' WHERE "id" = $1`,
      acme!.id,
    )
    expect(await mod.run.anythingToDo(0)).toBe(true)
    mailer.sent.length = 0
    expect(await mod.run.runAutoSend({ deadline: farOff() })).toMatchObject({ refused: 1, sent: 0 })
    expect(mailer.sent).toEqual([])
    const row = await po(acme!.id)
    expect(row.auto_send_state).toBe('REFUSED')
    expect(row.auto_send_note).toBe(mod.run.ABANDONED_SEND)
    expect(row.status).toBe('DRAFT')
  })

  it('refuses a customer order on hold, a total today’s threshold catches, and a discontinued line', async () => {
    const onHold = await draftFor([['prod-desk', 'Oak desk', 1]])
    await shop.query(`UPDATE "shp_orders" SET "status" = 'ON_HOLD' WHERE "id" = $1`, [onHold.customer.id])
    const unpaid = await draftFor([['prod-desk', 'Oak desk', 1]])
    await shop.query(`UPDATE "shp_orders" SET "payment_status" = 'FAILED' WHERE "id" = $1`, [unpaid.customer.id])
    await mod.run.runAutoSend({ deadline: farOff() })
    expect((await po(onHold.acme!.id)).auto_send_note).toBe(
      `Customer order ${onHold.customer.number} is on hold, so a person decides whether to buy for it.`,
    )
    expect((await po(unpaid.acme!.id)).auto_send_note).toMatch(/payment is failed/)

    const dear = await draftFor([['prod-desk', 'Oak desk', 1]])
    expect((await po(dear.acme!.id)).approval_required).toBe(false)
    await mod.config.updatePoConfig({ approvalRequired: true, approvalThreshold: 50 })
    try {
      await mod.run.runAutoSend({ deadline: farOff() })
    } finally {
      await mod.config.updatePoConfig({ approvalRequired: false, approvalThreshold: 0 })
    }
    expect((await po(dear.acme!.id)).auto_send_note).toMatch(/approval threshold as things stand now/)

    const { catalogueSkuKey } = await import('@/modules/purchase-orders/lib/catalogue-import')
    const catalogue = await sql<{ id: string }>(
      `INSERT INTO "po_supplier_catalogues" ("supplier_id", "name", "name_key") VALUES ($1, 'Desks', 'desks') RETURNING "id"`,
      ids.acme,
    )
    await sql(
      `INSERT INTO "po_catalogue_items" ("catalogue_id", "supplier_sku", "supplier_sku_key", "unit_cost", "discontinued")
       VALUES ($1, 'SUP-prod-desk', $2, 120.00, true)`,
      catalogue[0]!.id, catalogueSkuKey('SUP-prod-desk'),
    )
    const gone = await draftFor([['prod-desk', 'Oak desk', 1]])
    await mod.config.updatePoConfig({ supplierCatalogues: true })
    try {
      await mod.run.runAutoSend({ deadline: farOff() })
    } finally {
      await mod.config.updatePoConfig({ supplierCatalogues: false })
    }
    expect((await po(gone.acme!.id)).auto_send_note).toMatch(/is marked discontinued on Acme Supplies's current price list/)
  })
})
