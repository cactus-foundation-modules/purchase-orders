import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TestDatabase, TestRole, VpsConfig } from '@/lib/backup/vps-database'
import { splitStatements } from '@/modules/purchase-orders/lib/sql-statements.test-support'
import type { DespatchRecordedEvent } from '@/modules/purchase-orders/lib/despatch-hooks'
import type { TrackingMessage } from '@/modules/purchase-orders/lib/inbound-tracking'

// Delivery tracking from email, ACTUALLY EXECUTED against Postgres.
//
// Everything lib/inbound-tracking.ts writes is raw SQL - the row lock on the
// order, the insert ON CONFLICT against the partial unique index, the
// compare-and-set on what was announced, the tracking rows on the Paperwork
// list - and no other gate runs any of it. So this does: migration 018 applied
// more than once, a delivery firm's booking recorded by their reference, the
// same email offered five times at once, a second carrier email about the same
// parcel arriving at the same moment, a timeslot email matched by postcode
// alone and agreed by a person, later news updating the despatch and being
// announced once, and a despatch to our own warehouse announced to nobody.
//
// The emails are synthetic: every name, number, code and postcode is made up.
//
// Its own throwaway database on the self-hosted Postgres VPS (`cactus_rt_*`,
// a throwaway role, both dropped afterwards). Opt-in, same switch as the
// module's other live suites:
//
//   RUN_PO_SQL=1 vitest run modules/purchase-orders/lib/inbound-tracking.live.test.ts --testTimeout 300000
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

const CORE_SQL = readFileSync(path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql'), 'utf8')
const MIGRATIONS = path.join(process.cwd(), 'modules', 'purchase-orders', 'migrations')

function migrationSql(only?: string): string[] {
  return readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql') && (!only || file === only))
    .sort()
    .flatMap((file) => splitStatements(readFileSync(path.join(MIGRATIONS, file), 'utf8')))
}

const TZ = 'Europe/London'

suite('delivery tracking from email, against a real Postgres', () => {
  let cfg: VpsConfig
  let role: TestRole
  let database: TestDatabase
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const dbName = `cactus_rt_po_${stamp}`
  const roleName = `cactus_rt_role_po_${stamp}`

  type Loaded = {
    prisma: typeof import('@/lib/db/prisma')
    tracking: typeof import('@/modules/purchase-orders/lib/inbound-tracking')
    run: typeof import('@/modules/purchase-orders/lib/inbound-run')
    handler: typeof import('@/modules/purchase-orders/lib/inbound-handler')
    shipments: typeof import('@/modules/purchase-orders/lib/shipments')
  }
  let mod: Loaded
  let vps: typeof import('@/lib/backup/vps-database')

  const announced: DespatchRecordedEvent[] = []
  const observers = [async (event: DespatchRecordedEvent) => { announced.push(event) }]
  const ids: Record<string, string> = {}

  async function sql<T = Record<string, unknown>>(text: string, ...values: unknown[]): Promise<T[]> {
    return mod.prisma.prisma.$queryRawUnsafe<T[]>(text, ...values)
  }

  async function despatchesOn(orderId: string) {
    return sql<Record<string, unknown>>(`SELECT * FROM "po_shipments" WHERE "order_id" = $1 ORDER BY "created_at"`, orderId)
  }

  function mail(id: string, overrides: Partial<TrackingMessage>): TrackingMessage {
    return {
      messageId: id,
      threadId: `thread-${id}`,
      fromAddress: 'delivery@haulage.example',
      recipients: ['purchasing@our-shop.example'],
      subject: '',
      bodyText: '',
      sentAt: '2026-09-28T09:00:00.000Z',
      ...overrides,
    }
  }

  const suppliers = () => mod.run.senderSuppliers()
  const handle = (message: TrackingMessage) => mod.tracking.handleTrackingMessage(message, suppliers, { timezone: TZ, observers })

  const BOOKED = [
    'Example Haulage',
    'DELIVERING ON BEHALF OF',
    'OUR SHOP LTD',
    'Order summary',
    'Order number\t123456\t',
    'Consignment\tF12345678901\t',
    'Delivery address\t1 Example Street, Exampletown',
    'AB1 2DE',
    'Track your order <https://haulage.example/track-your-order>',
  ].join('\n')

  const TIMESLOT_LINK_ONLY = [
    'DELIVERY TIMESLOT CONFIRMED',
    'DELIVERY DATE',
    'TUE 06/10/2026',
    'DELIVERY TIMESLOT',
    '10:00-13:00',
    'Track your delivery',
    'https://multidrop.link/Q9XZ7A/AB12DE',
  ].join('\n')

  beforeAll(async () => {
    vps = await import('@/lib/backup/vps-database')
    cfg = vps.vpsConfigFromEnv()
    role = await vps.createTestRole(cfg, roleName)
    database = await vps.createTestDatabase(cfg, dbName, role)
    process.env.DATABASE_URL = database.connectionUri
    process.env.DIRECT_URL = database.connectionUri

    mod = {
      prisma: await import('@/lib/db/prisma'),
      tracking: await import('@/modules/purchase-orders/lib/inbound-tracking'),
      run: await import('@/modules/purchase-orders/lib/inbound-run'),
      handler: await import('@/modules/purchase-orders/lib/inbound-handler'),
      shipments: await import('@/modules/purchase-orders/lib/shipments'),
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
  }, 300_000)

  afterAll(async () => {
    await mod?.prisma.prisma.$disconnect().catch(() => {})
    if (!cfg) return
    if (database) await vps.dropTestDatabase(cfg, database.name).catch(() => {})
    if (role) await vps.dropTestRole(cfg, role.name).catch(() => {})
  }, 300_000)

  it('takes migration 018, and every migration, a second and third time without complaint', async () => {
    for (const statement of migrationSql('018_inbox_tracking.sql')) await mod.prisma.prisma.$executeRawUnsafe(statement)
    for (const statement of migrationSql()) await mod.prisma.prisma.$executeRawUnsafe(statement)
    const check = await sql<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'po_shipments_source_check'`,
    )
    expect(check).toHaveLength(1)
    expect(check[0]!.def).toContain('INBOX')
    const index = await sql<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'po_shipments_order_tracking_key_unique'`,
    )
    expect(index[0]!.indexdef).toMatch(/UNIQUE.*\(order_id, tracking_key\).*WHERE \(tracking_key IS NOT NULL\)/)
    const fk = await sql(`SELECT 1 FROM pg_constraint WHERE conname = 'po_inbound_documents_shipment_fk'`)
    expect(fk).toHaveLength(1)
  })

  it('sets up a supplier and its orders: drop-ship, to our warehouse, and two at one postcode', async () => {
    const supplier = await sql<{ id: string }>(
      `INSERT INTO "po_suppliers" ("name", "name_key", "email") VALUES ('Acme Supplies', 'acme supplies', 'orders@acme.example') RETURNING "id"`,
    )
    ids.acme = supplier[0]!.id

    async function order(number: string, opts: { shipTo: 'CUSTOMER' | 'WAREHOUSE'; postcode: string; ackRef?: string; shopOrder?: string }) {
      const rows = await sql<{ id: string }>(
        `INSERT INTO "po_orders" ("number", "supplier_id", "status", "ship_to_kind", "ship_to", "source_kind", "source_ref", "ack_ref", "total")
         VALUES ($1, $2, 'ACKNOWLEDGED', $3, $4::jsonb, $5, $6::jsonb, $7, 100) RETURNING "id"`,
        number, ids.acme, opts.shipTo, JSON.stringify({ address: { postcode: opts.postcode } }),
        opts.shopOrder ? 'FROM_ORDER' : 'MANUAL',
        opts.shopOrder ? JSON.stringify({ orderId: opts.shopOrder, orderNumber: `DW-${opts.shopOrder}` }) : null,
        opts.ackRef ?? null,
      )
      const id = rows[0]!.id
      for (const [position, description, qty, item] of [[0, 'Desk', 1, `${opts.shopOrder}-desk`], [1, 'Chair', 2, `${opts.shopOrder}-chair`]] as const) {
        await sql(
          `INSERT INTO "po_order_lines" ("order_id", "position", "description", "qty", "unit_cost", "source_order_item_id")
           VALUES ($1, $2, $3, $4, 50, $5)`,
          id, position, description, qty, opts.shopOrder ? item : null,
        )
      }
      return id
    }
    ids.po12 = await order('PO-00012', { shipTo: 'CUSTOMER', postcode: 'ZE1 0AA', ackRef: '0000123456', shopOrder: 'shop-1' })
    ids.po13 = await order('PO-00013', { shipTo: 'CUSTOMER', postcode: 'AB1 2DE', shopOrder: 'shop-2' })
    ids.po14 = await order('PO-00014', { shipTo: 'WAREHOUSE', postcode: 'EH1 1AA', ackRef: '0000777000' })
    ids.po15 = await order('PO-00015', { shipTo: 'CUSTOMER', postcode: 'SW1A 1AA', shopOrder: 'shop-3' })
    ids.po16 = await order('PO-00016', { shipTo: 'CUSTOMER', postcode: 'EH1 2NG', ackRef: '0000616161', shopOrder: 'shop-4' })
    ids.po17 = await order('PO-00017', { shipTo: 'CUSTOMER', postcode: 'EH1 3AB', ackRef: '0000717171', shopOrder: 'shop-5' })
    ids.po18 = await order('PO-00018', { shipTo: 'CUSTOMER', postcode: 'EH1 4AB', ackRef: '0000818181', shopOrder: 'shop-6' })
    ids.po19 = await order('PO-00019', { shipTo: 'CUSTOMER', postcode: 'EH1 5AB', ackRef: '0000919191', shopOrder: 'shop-7' })
    ids.po20 = await order('PO-00020', { shipTo: 'CUSTOMER', postcode: 'EH1 6AB', ackRef: '0000202020', shopOrder: 'shop-8' })
    ids.po21 = await order('PO-00021', { shipTo: 'CUSTOMER', postcode: 'EH1 7AB', ackRef: '0000212121', shopOrder: 'shop-9' })

    const orders = await mod.tracking.trackingOrders()
    expect(orders.find((o) => o.id === ids.po12)).toMatchObject({ dropShip: true, postcode: 'ZE1 0AA', supplierRefs: ['0000123456'], awaitingDespatch: true })
    expect(orders.find((o) => o.id === ids.po14)).toMatchObject({ dropShip: false })
  })

  it('records a delivery firm’s booking by the supplier’s own reference, once, however many offers arrive at once', async () => {
    // Our order PO-00012 is their sales order 0000123456; the firm prints 123456.
    const booked = mail('m-booked', { subject: 'Your Our Shop Ltd Delivery - Products Received', bodyText: BOOKED.replace('AB1 2DE', 'ZE1 0AA') })
    const results = await Promise.all([handle(booked), handle(booked), handle(booked), handle(booked), handle(booked)])
    expect(results.every((r) => r.match?.kind === 'apply' && r.match.rule === 2)).toBe(true)

    const rows = await despatchesOn(ids.po12!)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source: 'INBOX', tracking_ref: 'F12345678901', tracking_key: 'F12345678901', carrier: 'Haulage',
      source_message_id: 'm-booked',
    })
    const despatch = await mod.shipments.getShipment(rows[0]!.id as string)
    expect(despatch?.lines.map((l) => [l.description, Number(l.qty)])).toEqual([['Desk', 1], ['Chair', 2]])
    expect(despatch?.source).toBe('INBOX')

    // Announced, with the customer's own order lines. Five offers at the same
    // moment may each announce it before any marks it done (the observer is
    // idempotent for that); one more offer afterwards announces nothing.
    expect(announced.length).toBeGreaterThanOrEqual(1)
    expect(new Set(announced.map((e) => e.despatchId)).size).toBe(1)
    const settled = announced.length
    await handle(booked)
    expect(announced.length).toBe(settled)
    expect(announced[0]).toMatchObject({
      change: 'new',
      purchaseOrderNumber: 'PO-00012',
      source: { module: 'shop', orderId: 'shop-1' },
      lines: [{ sourceOrderItemId: 'shop-1-desk', qty: 1 }, { sourceOrderItemId: 'shop-1-chair', qty: 2 }],
      trackingNumber: 'F12345678901',
    })

    // One row for the email, and the audit names it.
    const tracked = await sql(`SELECT * FROM "po_inbound_documents" WHERE "message_id" = 'm-booked'`)
    expect(tracked).toHaveLength(1)
    expect(tracked[0]).toMatchObject({ kind: 'tracking', outcome: 'FILED', filed_as: 'despatch', shipment_id: rows[0]!.id })
    const audit = await sql<{ detail: Record<string, unknown> }>(
      `SELECT "detail" FROM "po_audit_log" WHERE "entity_id" = $1 AND "action" = 'order.despatch_from_email'`, ids.po12,
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]!.detail.message).toBe('m-booked')
  })

  it('makes one despatch of two different emails about one parcel arriving together', async () => {
    const a = mail('m-race-a', { bodyText: 'Consignment F55566677788\nOrder number 4040404\nDelivery address\nAB1 2DE', subject: 'x' })
    const b = mail('m-race-b', { bodyText: 'Consignment number: F55566677788\nOrder number 4040404\nDelivery address\nAB1 2DE', subject: 'y' })
    await sql(`UPDATE "po_orders" SET "ack_ref" = '0004040404' WHERE "id" = $1`, ids.po13)
    const before = announced.length
    await Promise.all([handle(a), handle(b), handle(a), handle(b)])
    const rows = await despatchesOn(ids.po13!)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tracking_key).toBe('F55566677788')
    expect(announced.length - before).toBeGreaterThanOrEqual(1)
    const settled = announced.length
    await handle(a)
    expect(announced.length).toBe(settled)
  })

  it('also holds at the database: recording one parcel concurrently makes one row', async () => {
    // Straight at the recorder, past the matcher, with the order lock the only
    // thing in the way - and the unique index behind it.
    await sql(`DELETE FROM "po_shipments" WHERE "order_id" = $1`, ids.po13)
    const record = (messageId: string) => mod.tracking.recordTrackingDespatch({
      orderId: ids.po13!,
      candidate: { carrier: null, trackingNumber: 'F11122233344', trackingUrl: null, shortCode: null },
      deliveryDate: null, deliverySlot: null, sentDay: '2026-09-28', messageId, userId: null,
    })
    const results = await Promise.all(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map(record))
    expect(results.filter((r) => r.kind === 'created')).toHaveLength(1)
    expect(results.filter((r) => r.kind === 'unchanged')).toHaveLength(5)
    expect(await despatchesOn(ids.po13!)).toHaveLength(1)
    await sql(`DELETE FROM "po_shipments" WHERE "order_id" = $1`, ids.po13)
  })

  it('proposes a timeslot email matched by postcode alone, and records it when a person agrees', async () => {
    const before = announced.length
    const result = await handle(mail('m-slot', { subject: 'Your Home Delivery Timeslot', bodyText: TIMESLOT_LINK_ONLY }))
    expect(result.match).toMatchObject({ kind: 'propose', rule: 4, order: { id: ids.po13 } })
    expect(await despatchesOn(ids.po13!)).toHaveLength(0)
    expect(announced.length).toBe(before)

    const list = await mod.run.listPaperwork()
    const item = list.find((i) => i.messageId === 'm-slot')!
    expect(item).toMatchObject({ kind: 'tracking', orderNumber: 'PO-00013', outcome: 'NEEDS_EYES' })
    expect(item.tracking).toMatchObject({ trackingUrl: 'https://multidrop.link/Q9XZ7A/AB12DE', deliveryDate: '2026-10-06', deliverySlot: ['10:00', '13:00'], postcodes: ['AB1 2DE'] })
    expect((await mod.handler.outcomeFor('m-slot'))).toEqual({ note: 'Delivery tracking that may be for PO-00013 is on the Paperwork list in Purchasing' })

    // Not something the paperwork filing will take.
    expect(await mod.run.fileManually(item.id, { orderId: ids.po13!, kind: 'proforma', ref: null }, 'user-1'))
      .toEqual({ ok: false, reason: 'That is delivery tracking, not paperwork.' })

    const applied = await Promise.all([
      mod.tracking.applyTrackingProposal(item.id, 'user-1', observers),
      mod.tracking.applyTrackingProposal(item.id, 'user-2', observers),
    ])
    expect(applied.filter((a) => a.ok)).toHaveLength(1)
    const rows = await despatchesOn(ids.po13!)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tracking_code: 'Q9XZ7A', tracking_key: 'CODE:multidrop:Q9XZ7A', delivery_slot_start: '10:00', delivery_slot_end: '13:00' })
    expect(announced.length - before).toBe(1)
    const after = await sql(`SELECT * FROM "po_inbound_documents" WHERE "message_id" = 'm-slot'`)
    expect(after[0]).toMatchObject({ outcome: 'FILED', handled_by_user_id: expect.stringMatching(/^user-/) })
    expect((await mod.handler.outcomeFor('m-slot'))?.links?.[0]?.recordId).toBe(ids.po13)
  })

  it('updates the despatch with later news about the same parcel, announcing each change once', async () => {
    const before = announced.length
    const timeslot = mail('m-slot-2', {
      subject: 'Your Home Delivery Timeslot',
      bodyText: `Consignment F12345678901\nDELIVERY DATE\n07/10/2026\nDELIVERY TIMESLOT\n14:00-17:00\nhttps://multidrop.link/K7K7K7/ZE10AA`,
    })
    const first = await handle(timeslot)
    expect(first.match).toMatchObject({ kind: 'apply', rule: 3, order: { id: ids.po12 } })
    expect(first.recorded).toMatchObject({ kind: 'updated', changed: ['tracking link', 'delivery day', 'delivery slot'] })
    await handle(timeslot)
    await handle(timeslot)

    const rows = await despatchesOn(ids.po12!)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tracking_url: 'https://multidrop.link/K7K7K7/ZE10AA', tracking_code: 'K7K7K7', delivery_slot_start: '14:00', delivery_slot_end: '17:00',
    })
    expect(String(rows[0]!.delivery_date instanceof Date ? (rows[0]!.delivery_date as Date).toISOString() : rows[0]!.delivery_date).slice(0, 10)).toBe('2026-10-07')
    expect(announced.length - before).toBe(1)
    expect(announced[announced.length - 1]).toMatchObject({ change: 'update', deliveryDate: '2026-10-07', deliverySlot: ['14:00', '17:00'] })

    // The supplier, on the order's own thread, moving the day: their order
    // number is enough, and the order's only despatch takes it.
    const moved = await handle(mail('m-moved', {
      fromAddress: 'pat@acme.example',
      subject: 'RE: Purchase order PO-00012',
      bodyText: 'Hi, this is now out for delivery tomorrow.\nFrom: Buyer <purchasing@our-shop.example>\nAny news? Consignment F99999999999',
    }))
    expect(moved.match).toMatchObject({ kind: 'apply', rule: 1 })
    expect(moved.recorded).toMatchObject({ kind: 'updated', changed: ['delivery day'] })
    expect(announced[announced.length - 1]).toMatchObject({ change: 'update', deliveryDate: '2026-09-29' })
    expect(announced.length - before).toBe(2)
  })

  it('puts a link-only timeslot email on the despatch it is about, once a person agrees, and rebookings find it after', async () => {
    const booked = await handle(mail('m-16-booked', { bodyText: 'Order number 616161\nConsignment F16161616161\nDelivery address\nEH1 2NG' }))
    expect(booked.recorded).toMatchObject({ kind: 'created' })
    const before = announced.length

    // Nothing but the link and the postcode: the order is despatched, so only
    // "still waiting to hear its slot" lets the postcode ask about it.
    const slot = (id: string, when: string, window: string) => mail(id, {
      subject: 'Your Home Delivery Timeslot',
      bodyText: `DELIVERY DATE\n${when}\nDELIVERY TIMESLOT\n${window}\nhttps://multidrop.link/R16R16/EH12NG`,
    })
    const proposed = await handle(slot('m-16-slot', '09/10/2026', '09:00-12:00'))
    expect(proposed.match).toMatchObject({ kind: 'propose', order: { id: ids.po16 } })
    const item = (await mod.run.listPaperwork()).find((i) => i.messageId === 'm-16-slot')!
    expect(await mod.tracking.applyTrackingProposal(item.id, 'user-1', observers)).toEqual({ ok: true, orderNumber: 'PO-00016' })
    let rows = await despatchesOn(ids.po16!)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tracking_ref: 'F16161616161', tracking_code: 'R16R16', delivery_slot_start: '09:00' })
    expect(announced.length - before).toBe(1)
    expect(announced[announced.length - 1]).toMatchObject({ change: 'update', trackingShortCode: 'R16R16' })

    // Rebooked: the same link, a new day - found by its code, applied at once.
    const rebooked = await handle(slot('m-16-rebooked', '12/10/2026', '13:00-16:00'))
    expect(rebooked.match).toMatchObject({ kind: 'apply', rule: 3 })
    rows = await despatchesOn(ids.po16!)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ delivery_slot_start: '13:00', delivery_slot_end: '16:00' })
    expect(announced.length - before).toBe(2)
  })

  it('B2: a stranger’s link to their own page never reaches the despatch, and what is left waits for a person', async () => {
    const before = announced.length
    const phish = mail('m-evil', {
      fromAddress: 'noreply@courier.example',
      bodyText: 'Order number 717171\nTracking number: F71717171717\nTrack it here https://evil.example/track/F71717171717\nDelivery address\nEH1 3AB',
    })
    const result = await handle(phish)
    expect(result.match).toMatchObject({ kind: 'propose', rule: 2, order: { id: ids.po17 } })
    expect(await despatchesOn(ids.po17!)).toHaveLength(0)
    expect(announced.length).toBe(before)
    const item = (await mod.run.listPaperwork()).find((i) => i.messageId === 'm-evil')!
    expect(item.tracking).toMatchObject({ trackingNumber: 'F71717171717', trackingUrl: null })

    // Agreed by a person: recorded with the number, never the link.
    expect(await mod.tracking.applyTrackingProposal(item.id, 'user-1', observers)).toEqual({ ok: true, orderNumber: 'PO-00017' })
    const rows = await despatchesOn(ids.po17!)
    expect(rows[0]).toMatchObject({ tracking_ref: 'F71717171717', tracking_url: null })
    expect(announced[announced.length - 1]).toMatchObject({ trackingUrl: null, trackingNumber: 'F71717171717' })
  })

  it('N4: a despatch is marked announced only once every observer has taken it', async () => {
    const booked = await handle(mail('m-18', { bodyText: 'Order number 818181\nConsignment F81818181818\nDelivery address\nEH1 4AB' }))
    expect(booked.recorded).toMatchObject({ kind: 'created' })
    const id = (booked.recorded as { despatchId: string }).despatchId
    await sql(`UPDATE "po_shipments" SET "announced" = NULL WHERE "id" = $1`, id)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = [async () => { throw new Error('shop had a bad day') }]
    expect(await mod.tracking.announceDespatch(id, failing)).not.toBeNull()
    expect((await sql(`SELECT "announced" FROM "po_shipments" WHERE "id" = $1`, id))[0]!.announced).toBeNull()
    // The next offer tells them again, and then it is done.
    expect(await mod.tracking.announceDespatch(id, observers)).toMatchObject({ change: 'new' })
    expect((await sql(`SELECT "announced" FROM "po_shipments" WHERE "id" = $1`, id))[0]!.announced).not.toBeNull()
    expect(await mod.tracking.announceDespatch(id, observers)).toBeNull()
  })

  it('a passing failure leaves the despatch pending, and the sweep announces it once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const busy = [async () => { throw new Error('the order stayed busy') }]
    const result = await mod.tracking.handleTrackingMessage(
      mail('m-19', { bodyText: 'Order number 919191\nConsignment F91919191919\nDelivery address\nEH1 5AB' }),
      suppliers, { timezone: TZ, observers: busy },
    )
    expect(result.recorded).toMatchObject({ kind: 'created' })
    let row = (await despatchesOn(ids.po19!))[0]!
    expect(row).toMatchObject({ announced: null, announce_pending: true })

    expect(row.announce_attempts).toBe(1)
    const heard: DespatchRecordedEvent[] = []
    const catchUp = [async (event: DespatchRecordedEvent) => { heard.push(event) }]
    // Half an hour on, when the job comes round:
    await sql(`UPDATE "po_shipments" SET "announce_tried_at" = now() - interval '31 minutes' WHERE "id" = $1`, row.id)
    expect(await mod.tracking.announcePendingDespatches({ deadline: Date.now() + 60_000, observers: catchUp })).toBeGreaterThanOrEqual(1)
    expect(heard.filter((e) => e.despatchId === row.id)).toHaveLength(1)
    row = (await despatchesOn(ids.po19!))[0]!
    expect(row.announce_pending).toBe(false)
    expect(row.announced).not.toBeNull()
    // Nothing left to tell: the next sweep tells nobody.
    await mod.tracking.announcePendingDespatches({ deadline: Date.now() + 60_000, observers: catchUp })
    expect(heard.filter((e) => e.despatchId === row.id)).toHaveLength(1)
  })

  it('N2: a despatch that keeps failing backs off, and after ten tries waits for a person', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = [async () => { throw new Error('shop is broken') }]
    await mod.tracking.handleTrackingMessage(
      mail('m-21', { bodyText: 'Order number 212121\nConsignment F21212121212\nDelivery address\nEH1 7AB' }),
      suppliers, { timezone: TZ, observers: broken },
    )
    const id = (await despatchesOn(ids.po21!))[0]!.id as string
    let row = (await despatchesOn(ids.po21!))[0]!
    expect(row).toMatchObject({ announce_pending: true, announce_attempts: 1 })
    expect(row.announce_tried_at).not.toBeNull()

    // Just tried, so the sweep leaves it for now and gets on with the rest.
    const heard: string[] = []
    const listening = [async (event: DespatchRecordedEvent) => { heard.push(event.despatchId) }]
    await mod.tracking.announcePendingDespatches({ deadline: Date.now() + 60_000, observers: listening })
    expect(heard).not.toContain(id)

    // Nine more failures, each once its wait is over.
    for (let n = 2; n <= mod.tracking.MAX_ANNOUNCE_ATTEMPTS; n++) {
      await sql(`UPDATE "po_shipments" SET "announce_tried_at" = now() - interval '1 day' WHERE "id" = $1`, id)
      await mod.tracking.announcePendingDespatches({ deadline: Date.now() + 60_000, observers: broken })
    }
    row = (await despatchesOn(ids.po21!))[0]!
    expect(row.announce_attempts).toBe(mod.tracking.MAX_ANNOUNCE_ATTEMPTS)
    const waiting = (await mod.run.listPaperwork()).find((i) => i.attachmentId === `announce:${id}`)!
    expect(waiting).toMatchObject({ kind: 'announce', orderNumber: 'PO-00021', outcome: 'NEEDS_EYES' })
    expect(waiting.reason).toMatch(/could not be put on the customer's order after 10 tries/)

    // And the job stops trying it, whatever time it is.
    await sql(`UPDATE "po_shipments" SET "announce_tried_at" = now() - interval '1 day' WHERE "id" = $1`, id)
    await mod.tracking.announcePendingDespatches({ deadline: Date.now() + 60_000, observers: listening })
    expect(heard).not.toContain(id)
    // One row, however often it gives up.
    await mod.tracking.announceDespatch(id, broken)
    expect(await sql(`SELECT 1 FROM "po_inbound_documents" WHERE "attachment_id" = $1`, `announce:${id}`)).toHaveLength(1)
  })

  it('reports each job’s problems only while that job is on', async () => {
    // A paperwork problem nobody has been told about, beside the tracking ones.
    await sql(
      `INSERT INTO "po_inbound_documents" ("message_id", "attachment_id", "page_from", "kind", "outcome", "reason")
       VALUES ('m-doc', 'a-doc', 1, 'invoice', 'NEEDS_EYES', 'A paperwork problem.')`,
    )
    const tracking = await mod.run.takeUnreportedProblems({ documents: false, tracking: true })
    expect(tracking.length).toBeGreaterThan(0)
    expect(tracking.some((p) => p.problem === 'A paperwork problem.')).toBe(false)
    expect((await sql(`SELECT "reported_at" FROM "po_inbound_documents" WHERE "attachment_id" = 'a-doc'`))[0]!.reported_at).toBeNull()

    const documents = await mod.run.takeUnreportedProblems({ documents: true, tracking: false })
    expect(documents.map((p) => p.problem)).toContain('A paperwork problem.')
  })

  it('a permanent refusal is taken as done: stamped, and never tried again', async () => {
    // The observer looked and declined (switched off, a cancelled order) - it
    // returns rather than throwing.
    const declined: DespatchRecordedEvent[] = []
    const refusing = [async (event: DespatchRecordedEvent) => { declined.push(event) }]
    await mod.tracking.handleTrackingMessage(
      mail('m-20', { bodyText: 'Order number 202020\nConsignment F20202020202\nDelivery address\nEH1 6AB' }),
      suppliers, { timezone: TZ, observers: refusing },
    )
    const row = (await despatchesOn(ids.po20!))[0]!
    expect(row).toMatchObject({ announce_pending: false })
    expect(row.announced).not.toBeNull()
    const before = declined.length
    await mod.tracking.announcePendingDespatches({ deadline: Date.now() + 60_000, observers: refusing })
    expect(declined.length).toBe(before)
  })

  it('N3: a link already on a despatch is never replaced by a different one', async () => {
    const id = (await despatchesOn(ids.po18!))[0]!.id as string
    await sql(`UPDATE "po_shipments" SET "tracking_url" = 'https://haulage.example/track?c=F81818181818' WHERE "id" = $1`, id)
    const news = await handle(mail('m-18-link', { bodyText: 'Consignment F81818181818\nhttps://www.dpd.co.uk/d/NewCode999' }))
    expect(news.match).toMatchObject({ kind: 'apply', rule: 3 })
    const row = (await despatchesOn(ids.po18!))[0]!
    expect(row).toMatchObject({ tracking_url: 'https://haulage.example/track?c=F81818181818', tracking_code: null })
  })

  it('records on an order to our own warehouse and tells nobody', async () => {
    const before = announced.length
    const result = await handle(mail('m-warehouse', { bodyText: 'Order number 777000\nTracking number: ZX12345678\nDelivery address\nEH1 1AA' }))
    expect(result.recorded).toMatchObject({ kind: 'created' })
    expect(await despatchesOn(ids.po14!)).toHaveLength(1)
    expect(announced.length).toBe(before)
    // Nobody to tell, so nothing is left pending for the sweep.
    expect((await despatchesOn(ids.po14!))[0]!.announce_pending).toBe(false)
  })

  it('leaves alone tracking for an order already wholly despatched under other tracking', async () => {
    const result = await handle(mail('m-other-parcel', { bodyText: 'Order number 777000\nTracking number: QQ98765432' }))
    expect(result.recorded).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/already recorded as despatched under other tracking/) })
    expect(await despatchesOn(ids.po14!)).toHaveLength(1)
    const row = await sql(`SELECT * FROM "po_inbound_documents" WHERE "message_id" = 'm-other-parcel'`)
    expect(row[0]).toMatchObject({ outcome: 'IGNORED' })
  })

  it('ignores colleagues, and a stranger with no tracking, without writing anything', async () => {
    const colleague = await handle(mail('m-colleague', { fromAddress: 'jo@our-shop.example', bodyText: 'Consignment F12345678901' }))
    expect(colleague.match).toBeNull()
    const stranger = await handle(mail('m-stranger', { bodyText: 'Delivery date 08/10/2026' }))
    expect(stranger.match).toBeNull()
    expect(await sql(`SELECT 1 FROM "po_inbound_documents" WHERE "message_id" IN ('m-colleague', 'm-stranger')`)).toHaveLength(0)
  })

  it('keeps tracking off the order’s emailed documents, and lets a person dismiss a proposal', async () => {
    expect((await mod.run.inboundForOrder(ids.po12!)).length).toBe(0)
    const proposal = await handle(mail('m-dismiss', { bodyText: 'Consignment F31313131313\nDelivery address\nSW1A 1AA' }))
    expect(proposal.match?.kind).toBe('propose')
    const item = (await mod.run.listPaperwork()).find((i) => i.messageId === 'm-dismiss')!
    expect(await mod.run.dismissPaperwork(item.id, 'not-ours', 'user-1')).toBe(true)
    expect(await mod.tracking.applyTrackingProposal(item.id, 'user-1', observers)).toEqual({ ok: false, reason: 'Somebody has already dealt with that one.' })
  })
})
