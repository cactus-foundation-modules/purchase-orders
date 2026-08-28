-- Purchase Orders - proforma terms, supplier documents and despatches
--
-- Three things arrive together because they are one story: a supplier who is
-- not on credit sends a proforma before they will confirm anything, they hand
-- back an order acknowledgement when they do confirm, and after that they ship
-- the order in as many drops as suits them - each one with its own packing slip.
--
-- Idempotent throughout: this file lands on installs that already ran 001, and
-- 001 carries the same shape for a fresh one.

-- ---------------------------------------------------------------------------
-- Suppliers: how we buy from them
--
-- CREDIT is what every existing row is, and the default, because that is what
-- an account is until somebody says otherwise. PROFORMA means they invoice
-- first and nothing is confirmed until it is paid.
-- ---------------------------------------------------------------------------
ALTER TABLE "po_suppliers" ADD COLUMN IF NOT EXISTS "account_terms" TEXT NOT NULL DEFAULT 'CREDIT';

-- Dropped and rewritten rather than guarded in a DO block. Two reasons, and the
-- second is not obvious: a CHECK cannot be added IF NOT EXISTS, and the backup
-- round-trip gate skips outright any module whose migrations contain a
-- dollar-quoted body - so a DO block here would quietly take this module's whole
-- schema out of the one test that proves a restore works. (Which is also why
-- this sentence spells it out rather than showing you one.)
ALTER TABLE "po_suppliers" DROP CONSTRAINT IF EXISTS "po_suppliers_account_terms_check";
ALTER TABLE "po_suppliers"
    ADD CONSTRAINT "po_suppliers_account_terms_check"
    CHECK ("account_terms" IN ('CREDIT','PROFORMA'));

-- ---------------------------------------------------------------------------
-- Orders: the proforma, and the paperwork the supplier sends back
--
-- proforma_required is FROZEN onto the order rather than read off the supplier
-- every time. Moving a supplier onto credit next year must not quietly rewrite
-- what an order raised last year was waiting for.
--
-- The two media ids are plain columns and never foreign keys, exactly as
-- po_bills.attachment_media_id is: core owns Media, and a module holds no key
-- into a table it does not own. lib/media-usage-provider.ts is what stops the
-- library offering these up as clutter.
-- ---------------------------------------------------------------------------
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "proforma_required"    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "proforma_media_id"    TEXT;
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "proforma_ref"         TEXT;
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "proforma_amount"      NUMERIC(12,2);
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "proforma_received_at" TIMESTAMPTZ;
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "proforma_paid_at"     TIMESTAMPTZ;
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "proforma_paid_by_user_id" TEXT;
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "proforma_payment_ref" TEXT;
-- The supplier's own order acknowledgement, attached when they confirm.
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "ack_media_id"         TEXT;
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "ack_ref"              TEXT;

-- ---------------------------------------------------------------------------
-- Despatches
--
-- What the SUPPLIER says they have sent, which is a different fact from what
-- turned up (po_receipts) and is never confused with it: a despatch moves no
-- stock, closes no line and changes no status. It exists so a part-shipped
-- order can be tracked drop by drop, and so each drop can carry a packing slip
-- into the box.
--
-- token_id records which supplier link filed it, and is nulled rather than
-- cascaded: a revoked and swept link must not take the despatch with it.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS "po_shipment_number_seq" START 1;

CREATE TABLE IF NOT EXISTS "po_shipments" (
    "id"                 TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "number"             TEXT        NOT NULL,
    "order_id"           TEXT        NOT NULL,
    "despatched_date"    DATE        NOT NULL,
    "carrier"            TEXT,
    "tracking_ref"       TEXT,
    "tracking_url"       TEXT,
    "notes"              TEXT,
    -- Who filed it: the supplier through their own link, or somebody here
    -- typing it in off an email.
    "source"             TEXT        NOT NULL DEFAULT 'PORTAL',
    "token_id"           TEXT,
    "created_by_user_id" TEXT,
    "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "po_shipments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_shipments_number_unique" UNIQUE ("number"),
    CONSTRAINT "po_shipments_source_check" CHECK ("source" IN ('PORTAL','ADMIN')),
    CONSTRAINT "po_shipments_order_fk" FOREIGN KEY ("order_id") REFERENCES "po_orders" ("id") ON DELETE CASCADE,
    CONSTRAINT "po_shipments_token_fk" FOREIGN KEY ("token_id") REFERENCES "po_portal_tokens" ("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "po_shipments_order_idx" ON "po_shipments" ("order_id", "despatched_date");

CREATE TABLE IF NOT EXISTS "po_shipment_lines" (
    "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "shipment_id"   TEXT NOT NULL,
    "order_line_id" TEXT NOT NULL,
    "qty"           NUMERIC(12,3) NOT NULL,
    CONSTRAINT "po_shipment_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_shipment_lines_qty_check" CHECK ("qty" > 0),
    CONSTRAINT "po_shipment_lines_shipment_fk" FOREIGN KEY ("shipment_id") REFERENCES "po_shipments" ("id") ON DELETE CASCADE,
    CONSTRAINT "po_shipment_lines_order_line_fk" FOREIGN KEY ("order_line_id") REFERENCES "po_order_lines" ("id") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "po_shipment_lines_shipment_idx" ON "po_shipment_lines" ("shipment_id");
CREATE INDEX IF NOT EXISTS "po_shipment_lines_order_line_idx" ON "po_shipment_lines" ("order_line_id");

-- ---------------------------------------------------------------------------
-- Portal events: three more things a supplier can say
--
-- A CHECK constraint cannot be widened in place, so it is dropped and rewritten.
-- Nothing is validated against existing rows beyond the new list, which is a
-- superset of the old one - so no stored event can fail it.
-- ---------------------------------------------------------------------------
ALTER TABLE "po_portal_events" DROP CONSTRAINT IF EXISTS "po_portal_events_kind_check";
ALTER TABLE "po_portal_events"
    ADD CONSTRAINT "po_portal_events_kind_check"
    CHECK ("kind" IN ('ACKNOWLEDGED','DATE_PROPOSED','SHORTAGE','MESSAGE','PROFORMA','DESPATCHED'));
