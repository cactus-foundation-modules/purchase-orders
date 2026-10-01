-- Purchase Orders Module - Initial Migration
-- Table prefix: po_
-- Applied once by the Cactus module migration runner during build.
--
-- The WHOLE schema lands here, including tables whose screens arrive in a later
-- release. Editing an already-applied migration never re-runs on an existing
-- install, so anything forgotten here needs a new numbered file later - and a
-- half-schema is how a module ends up with a receiving screen that cannot save.
--
-- Column types are restricted to text / integer / numeric / boolean / date /
-- timestamptz / jsonb so the backup serialiser already has a branch for every
-- one of them. No generated and no identity columns anywhere: the backup dump
-- excludes them and their values are lost on restore, so every derived figure
-- is computed in application code and stored plain.
--
-- No foreign key ever points at another module's table. Shop may not be
-- installed, and a shop supplier can be renamed or deleted underneath us.

-- ---------------------------------------------------------------------------
-- Numbering sequences
--
-- Sequences are not tables: information_schema.tables never sees them, and a
-- forgotten one restores at 1 and collides on the next insert.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS "po_number_seq" START 1;
CREATE SEQUENCE IF NOT EXISTS "po_receipt_number_seq" START 1;
CREATE SEQUENCE IF NOT EXISTS "po_return_number_seq" START 1;
CREATE SEQUENCE IF NOT EXISTS "po_shipment_number_seq" START 1;

-- ---------------------------------------------------------------------------
-- Settings (singleton row, JSONB config validated by lib/config.ts)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "po_settings" (
    "id"         TEXT        NOT NULL DEFAULT 'singleton',
    "config"     JSONB       NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "po_settings_pkey" PRIMARY KEY ("id")
);
INSERT INTO "po_settings" ("id", "config") VALUES ('singleton', '{}')
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Suppliers
--
-- This module always owns its own supplier row, whether or not shop is
-- installed. shop_supplier_id/shop_supplier_name are a link plus a snapshot,
-- never a foreign key: shop links products to suppliers by NAME, and that name
-- can be renamed or deleted while POs filed against it stay perfectly valid.
-- name_key is the normalised lowercase name, which is what matches
-- shp_products.supplier when the catalogue is there to match against.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "po_suppliers" (
    "id"                      TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "name"                    TEXT        NOT NULL,
    "name_key"                TEXT        NOT NULL,
    "shop_supplier_id"        TEXT,
    "shop_supplier_name"      TEXT,
    "account_number"          TEXT,
    "contact_name"            TEXT,
    "phone"                   TEXT,
    "email"                   TEXT,
    "email_cc"                TEXT,
    -- Their accounts department, and whether the "we have paid your proforma"
    -- note goes there instead of to the people who take the orders. Everything
    -- else still goes to the ordering address. (Also in 010.)
    "accounts_email"          TEXT,
    "proforma_paid_to_accounts" BOOLEAN   NOT NULL DEFAULT false,
    -- Whether what is bought from them goes straight to the customer and never
    -- comes here. Switches off booking in and despatches on their orders, and
    -- checks their invoices against what was ordered. (Also in 014.)
    "dropships"               BOOLEAN     NOT NULL DEFAULT false,
    "address"                 JSONB       NOT NULL DEFAULT '{}',
    "currency"                TEXT        NOT NULL DEFAULT 'GBP',
    "payment_terms"           TEXT,
    "payment_terms_days"      INTEGER,
    -- How we buy from them. CREDIT is an account; PROFORMA means they invoice
    -- first and confirm nothing until it is paid. See 007, where this column
    -- arrives for installs that already have 001.
    "account_terms"           TEXT        NOT NULL DEFAULT 'CREDIT',
    "lead_time_days"          INTEGER,
    "minimum_order_value"     NUMERIC(12,2),
    "carriage_paid_over"      NUMERIC(12,2),
    "carriage_charge"         NUMERIC(12,2),
    -- Net value below which a sale-surcharge applies, and the rates it applies
    -- at live on their own table, po_supplier_surcharge_rates. NULL is "no
    -- surcharge", same convention as carriage_paid_over above. See 015, where
    -- this column arrives for installs that already have 001.
    "surcharge_threshold"     NUMERIC(12,2),
    -- Trade discount off list, as a percentage, and what a retail price list is
    -- imported at. NULL is "none recorded", which is not the same as 0% - see
    -- 005, where this column arrives for installs that already have 001.
    "discount_percent"        NUMERIC(5,2),
    "default_category_id"     TEXT,
    "default_vat_treatment"   TEXT,
    "default_vat_rate_code"   TEXT,
    "tax_registration_number" TEXT,
    "delivery_instructions"   TEXT,
    -- Shown to this supplier at the top of their own portal page, and nowhere
    -- else. See 008, where this column arrives for installs that already
    -- have 001.
    "portal_note"             TEXT,
    -- Extra addresses or domains their emailed paperwork comes from, beyond the
    -- email and copy-to above. See 017.
    "inbound_senders"         TEXT[]      NOT NULL DEFAULT '{}',
    -- Whether this supplier's automatic drafts are emailed to them by
    -- themselves, after the hold. Off unless the owner says so. See 019.
    "auto_send"               BOOLEAN     NOT NULL DEFAULT false,
    "status"                  TEXT        NOT NULL DEFAULT 'ENABLED',
    "notes"                   TEXT,
    "created_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "po_suppliers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_suppliers_status_check" CHECK ("status" IN ('ENABLED','DISABLED','ON_HOLD')),
    CONSTRAINT "po_suppliers_account_terms_check" CHECK ("account_terms" IN ('CREDIT','PROFORMA')),
    CONSTRAINT "po_suppliers_discount_percent_check"
        CHECK ("discount_percent" IS NULL OR ("discount_percent" >= 0 AND "discount_percent" <= 100))
);
CREATE UNIQUE INDEX IF NOT EXISTS "po_suppliers_name_key_unique" ON "po_suppliers" ("name_key");
CREATE INDEX IF NOT EXISTS "po_suppliers_status_idx" ON "po_suppliers" ("status");

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "po_orders" (
    "id"                  TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "number"              TEXT        NOT NULL,
    "revision"            INTEGER     NOT NULL DEFAULT 1,
    "status"              TEXT        NOT NULL DEFAULT 'DRAFT',
    "supplier_id"         TEXT        NOT NULL,
    -- Frozen at first send, so a later supplier edit never rewrites what the
    -- supplier was actually sent.
    "supplier_snapshot"   JSONB       NOT NULL DEFAULT '{}',
    "ship_to_kind"        TEXT        NOT NULL DEFAULT 'WAREHOUSE',
    "ship_to"             JSONB       NOT NULL DEFAULT '{}',
    "source_kind"         TEXT        NOT NULL DEFAULT 'MANUAL',
    -- Shop order id and number when this PO was raised off a customer order.
    -- Deliberately not a foreign key - shop may not be installed at all.
    "source_ref"          JSONB,
    "currency"            TEXT        NOT NULL DEFAULT 'GBP',
    "base_currency"       TEXT        NOT NULL DEFAULT 'GBP',
    -- Base currency per 1 unit of the supplier's currency, at the moment the PO
    -- was raised. The buyer's own expectation and nothing more: the BILL carries
    -- the rate the books ever see.
    "fx_rate"             NUMERIC(18,8) NOT NULL DEFAULT 1,
    "tax_mode"            TEXT        NOT NULL DEFAULT 'EXCLUSIVE',
    "subtotal"            NUMERIC(12,2) NOT NULL DEFAULT 0,
    "discount_amount"     NUMERIC(12,2) NOT NULL DEFAULT 0,
    "carriage_amount"     NUMERIC(12,2) NOT NULL DEFAULT 0,
    -- A supplier's small-order fee on clearance stock, worked out and totalled
    -- exactly like carriage above - see lib/from-order.ts surchargeFor. See
    -- 015, where this column arrives for installs that already have 001.
    "surcharge_amount"    NUMERIC(12,2) NOT NULL DEFAULT 0,
    "tax_amount"          NUMERIC(12,2) NOT NULL DEFAULT 0,
    "total"               NUMERIC(12,2) NOT NULL DEFAULT 0,
    "raised_date"         DATE,
    "required_by_date"    DATE,
    "expected_date"       DATE,
    "payment_terms"       TEXT,
    "delivery_terms"      TEXT,
    "notes_supplier"      TEXT,
    "notes_internal"      TEXT,
    "wording"             JSONB       NOT NULL DEFAULT '{}',
    "approval_required"   BOOLEAN     NOT NULL DEFAULT false,
    "approved_by_user_id" TEXT,
    "approved_at"         TIMESTAMPTZ,
    "approval_note"       TEXT,
    "sent_at"             TIMESTAMPTZ,
    "sent_to"             JSONB       NOT NULL DEFAULT '[]',
    "acknowledged_at"     TIMESTAMPTZ,
    "acknowledged_note"   TEXT,
    -- The proforma dance, for a supplier who is not on credit. Frozen onto the
    -- order rather than read off the supplier every time: moving them onto an
    -- account next year must not rewrite what an order raised last year was
    -- waiting for. The media ids are plain columns and never foreign keys -
    -- core owns Media, and this module holds no key into a table it does not
    -- own. (Also in 007, for installs that predate it.)
    "proforma_required"   BOOLEAN     NOT NULL DEFAULT false,
    "proforma_media_id"   TEXT,
    "proforma_ref"        TEXT,
    "proforma_amount"     NUMERIC(12,2),
    "proforma_received_at" TIMESTAMPTZ,
    "proforma_paid_at"    TIMESTAMPTZ,
    "proforma_paid_by_user_id" TEXT,
    "proforma_payment_ref" TEXT,
    -- The screenshot or remittance we send them to prove the money left, and
    -- when it went with the payment email. (Also in 009.)
    "proforma_payment_proof_media_id" TEXT,
    "proforma_proof_sent_at" TIMESTAMPTZ,
    -- When somebody said they had checked the bank details on a proforma that
    -- arrived by email flagged as revised or disagreeing. Warnings filed before
    -- it are answered; one filed after it is live again. See 017.
    "proforma_warning_cleared_at" TIMESTAMPTZ,
    -- A warning on a proforma sent through the supplier's own link that
    -- replaced one already on the order, and when. Answered by the same check
    -- as the ones from email. See 017.
    "proforma_warning"    TEXT,
    "proforma_warning_at" TIMESTAMPTZ,
    -- The supplier's own order acknowledgement, attached when they confirm.
    "ack_media_id"        TEXT,
    "ack_ref"             TEXT,
    "cancelled_at"        TIMESTAMPTZ,
    "cancel_reason"       TEXT,
    "closed_at"           TIMESTAMPTZ,
    "close_reason"        TEXT,
    -- The automatic queue: NULL for an order never in it, else QUEUED, SENT,
    -- HELD (a person changed it) or REFUSED, with the sentence. The claim, the
    -- failed tries and the report keep the job honest. `approved_automatically`
    -- is an order the job sent, which approves it with no person's name. See 019.
    "auto_send_state"     TEXT,
    "auto_send_note"      TEXT,
    "auto_send_claimed_at" TIMESTAMPTZ,
    "auto_send_attempts"  INTEGER     NOT NULL DEFAULT 0,
    "auto_send_reported_at" TIMESTAMPTZ,
    "approved_automatically" BOOLEAN  NOT NULL DEFAULT false,
    "created_by_user_id"  TEXT,
    "updated_by_user_id"  TEXT,
    "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "po_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_orders_number_unique" UNIQUE ("number"),
    CONSTRAINT "po_orders_status_check" CHECK ("status" IN ('DRAFT','AWAITING_APPROVAL','APPROVED','SENT','ACKNOWLEDGED','PART_RECEIVED','RECEIVED','PENDING_CLOSE','CLOSED','CANCELLED','ON_HOLD')),
    CONSTRAINT "po_orders_ship_to_kind_check" CHECK ("ship_to_kind" IN ('WAREHOUSE','CUSTOMER','OTHER')),
    CONSTRAINT "po_orders_source_kind_check" CHECK ("source_kind" IN ('MANUAL','FROM_ORDER','REORDER')),
    CONSTRAINT "po_orders_tax_mode_check" CHECK ("tax_mode" IN ('EXCLUSIVE','INCLUSIVE')),
    CONSTRAINT "po_orders_auto_send_state_check"
        CHECK ("auto_send_state" IS NULL OR "auto_send_state" IN ('QUEUED','SENT','HELD','REFUSED')),
    CONSTRAINT "po_orders_supplier_fk" FOREIGN KEY ("supplier_id") REFERENCES "po_suppliers" ("id") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "po_orders_supplier_idx" ON "po_orders" ("supplier_id");
CREATE INDEX IF NOT EXISTS "po_orders_status_idx" ON "po_orders" ("status");
CREATE INDEX IF NOT EXISTS "po_orders_expected_date_idx" ON "po_orders" ("expected_date");
CREATE INDEX IF NOT EXISTS "po_orders_auto_send_queued_idx"
    ON "po_orders" ("created_at") WHERE "auto_send_state" = 'QUEUED';
CREATE INDEX IF NOT EXISTS "po_orders_auto_send_unreported_idx"
    ON "po_orders" ("updated_at") WHERE "auto_send_state" = 'REFUSED' AND "auto_send_reported_at" IS NULL;
CREATE INDEX IF NOT EXISTS "po_orders_auto_send_claimed_idx"
    ON "po_orders" ("auto_send_claimed_at") WHERE "auto_send_claimed_at" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Order lines
--
-- Ordered quantity lives here. Received, invoiced and returned are SUMs over
-- po_receipt_lines / po_bill_lines / po_return_lines - see lib/progress.ts.
-- There is deliberately no qty_received column: a stored counter drifts the
-- first time a receipt is deleted, and POs are far too low-volume for the join
-- to matter.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "po_order_lines" (
    "id"                   TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "order_id"             TEXT        NOT NULL,
    "position"             INTEGER     NOT NULL DEFAULT 0,
    "product_id"           TEXT,
    "product_name"         TEXT,
    "supplier_sku"         TEXT,
    "our_sku"              TEXT,
    "description"          TEXT        NOT NULL,
    "qty"                  NUMERIC(12,3) NOT NULL,
    "unit"                 TEXT        NOT NULL DEFAULT 'each',
    -- Four decimal places: supplier costs routinely go below the penny.
    "unit_cost"            NUMERIC(12,4) NOT NULL DEFAULT 0,
    "discount_percent"     NUMERIC(5,2),
    "tax_rate_percent"     NUMERIC(5,2) NOT NULL DEFAULT 0,
    "tax_rate_code"        TEXT,
    "vat_treatment"        TEXT,
    "category_id"          TEXT,
    "line_total"           NUMERIC(12,2) NOT NULL DEFAULT 0,
    "expected_date"        DATE,
    "qty_cancelled"        NUMERIC(12,3) NOT NULL DEFAULT 0,
    -- The delivery service this line has to be sent on, and what it costs. Not
    -- in the line total: service_cost is summed into po_orders.carriage_amount.
    -- Also in 003, for installs that predate it.
    "service_name"         TEXT,
    "service_cost"         NUMERIC(12,4),
    "source_order_item_id" TEXT,
    "created_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "po_order_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_order_lines_qty_check" CHECK ("qty" > 0),
    CONSTRAINT "po_order_lines_order_fk" FOREIGN KEY ("order_id") REFERENCES "po_orders" ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "po_order_lines_order_position_idx" ON "po_order_lines" ("order_id", "position");
CREATE INDEX IF NOT EXISTS "po_order_lines_product_idx" ON "po_order_lines" ("product_id");

-- ---------------------------------------------------------------------------
-- Revisions
--
-- Once a PO is SENT, an edit bumps po_orders.revision and writes the PREVIOUS
-- state here. What the supplier was sent is never rewritten.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "po_revisions" (
    "id"                 TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "order_id"           TEXT        NOT NULL,
    "revision"           INTEGER     NOT NULL,
    "snapshot"           JSONB       NOT NULL,
    "reason"             TEXT,
    "created_by_user_id" TEXT,
    "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "po_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_revisions_order_revision_unique" UNIQUE ("order_id", "revision"),
    CONSTRAINT "po_revisions_order_fk" FOREIGN KEY ("order_id") REFERENCES "po_orders" ("id") ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Receipts
--
-- stock_applied is what makes the stock write idempotent: a receipt can be
-- saved without stock ever being touched (the toggle is off by default, and a
-- site may have no catalogue at all), and applying it later is one guarded
-- transition rather than a second write.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "po_receipts" (
    "id"                  TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "number"              TEXT        NOT NULL,
    "order_id"            TEXT        NOT NULL,
    "received_date"       DATE        NOT NULL,
    "delivery_note_ref"   TEXT,
    "carrier"             TEXT,
    "notes"               TEXT,
    "received_by_user_id" TEXT,
    "stock_applied"       BOOLEAN     NOT NULL DEFAULT false,
    "stock_applied_at"    TIMESTAMPTZ,
    "stock_result"        JSONB       NOT NULL DEFAULT '{}',
    "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "po_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_receipts_number_unique" UNIQUE ("number"),
    CONSTRAINT "po_receipts_order_fk" FOREIGN KEY ("order_id") REFERENCES "po_orders" ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "po_receipts_order_idx" ON "po_receipts" ("order_id");

CREATE TABLE IF NOT EXISTS "po_receipt_lines" (
    "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "receipt_id"     TEXT NOT NULL,
    "order_line_id"  TEXT NOT NULL,
    "qty_accepted"   NUMERIC(12,3) NOT NULL DEFAULT 0,
    "qty_rejected"   NUMERIC(12,3) NOT NULL DEFAULT 0,
    "reject_reason"  TEXT,
    "condition_note" TEXT,
    CONSTRAINT "po_receipt_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_receipt_lines_receipt_fk" FOREIGN KEY ("receipt_id") REFERENCES "po_receipts" ("id") ON DELETE CASCADE,
    CONSTRAINT "po_receipt_lines_order_line_fk" FOREIGN KEY ("order_line_id") REFERENCES "po_order_lines" ("id") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "po_receipt_lines_receipt_idx" ON "po_receipt_lines" ("receipt_id");
CREATE INDEX IF NOT EXISTS "po_receipt_lines_order_line_idx" ON "po_receipt_lines" ("order_line_id");

-- ---------------------------------------------------------------------------
-- Returns and debit notes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "po_returns" (
    "id"                 TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "number"             TEXT        NOT NULL,
    "order_id"           TEXT        NOT NULL,
    "supplier_id"        TEXT        NOT NULL,
    "status"             TEXT        NOT NULL DEFAULT 'DRAFT',
    "reason"             TEXT,
    "raised_date"        DATE,
    "sent_at"            TIMESTAMPTZ,
    "credit_expected"    NUMERIC(12,2) NOT NULL DEFAULT 0,
    "credit_received"    NUMERIC(12,2) NOT NULL DEFAULT 0,
    "credit_ref"         TEXT,
    "currency"           TEXT,
    "fx_rate"            NUMERIC(18,8),
    "notes"              TEXT,
    "books_outcome"      JSONB       NOT NULL DEFAULT '{}',
    -- Whether the goods going back have been taken off the shelf, and what
    -- happened when they were. Claimed in a conditional UPDATE before anything
    -- moves, exactly as po_receipts does it, so two clicks cannot deduct twice.
    -- (Added by 002 as well, for installs that already ran this file.)
    "stock_applied"      BOOLEAN     NOT NULL DEFAULT false,
    "stock_applied_at"   TIMESTAMPTZ,
    "stock_result"       JSONB       NOT NULL DEFAULT '{}',
    "created_by_user_id" TEXT,
    "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "po_returns_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_returns_number_unique" UNIQUE ("number"),
    CONSTRAINT "po_returns_status_check" CHECK ("status" IN ('DRAFT','SENT','CREDIT_EXPECTED','CREDITED','CLOSED','CANCELLED')),
    CONSTRAINT "po_returns_order_fk" FOREIGN KEY ("order_id") REFERENCES "po_orders" ("id") ON DELETE RESTRICT,
    CONSTRAINT "po_returns_supplier_fk" FOREIGN KEY ("supplier_id") REFERENCES "po_suppliers" ("id") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "po_returns_order_idx" ON "po_returns" ("order_id");
CREATE INDEX IF NOT EXISTS "po_returns_supplier_idx" ON "po_returns" ("supplier_id");

CREATE TABLE IF NOT EXISTS "po_return_lines" (
    "id"               TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "return_id"        TEXT NOT NULL,
    "order_line_id"    TEXT NOT NULL,
    -- Which receipt the goods came in on, when that is known. No foreign key:
    -- a receipt line may be revised away while the return stays meaningful.
    "receipt_line_id"  TEXT,
    "qty"              NUMERIC(12,3) NOT NULL,
    "unit_cost"        NUMERIC(12,4) NOT NULL,
    "tax_rate_percent" NUMERIC(5,2) NOT NULL DEFAULT 0,
    "line_total"       NUMERIC(12,2) NOT NULL DEFAULT 0,
    CONSTRAINT "po_return_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_return_lines_return_fk" FOREIGN KEY ("return_id") REFERENCES "po_returns" ("id") ON DELETE CASCADE,
    CONSTRAINT "po_return_lines_order_line_fk" FOREIGN KEY ("order_line_id") REFERENCES "po_order_lines" ("id") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "po_return_lines_return_idx" ON "po_return_lines" ("return_id");
CREATE INDEX IF NOT EXISTS "po_return_lines_order_line_idx" ON "po_return_lines" ("order_line_id");

-- ---------------------------------------------------------------------------
-- Supplier bills
--
-- A bill may arrive with no purchase order behind it at all, which is why
-- order_id is nullable and set null rather than cascading.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "po_bills" (
    "id"                      TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "order_id"                TEXT,
    "supplier_id"             TEXT        NOT NULL,
    "supplier_invoice_number" TEXT        NOT NULL,
    -- The tax point, not the day it was typed in.
    "invoice_date"            DATE        NOT NULL,
    "due_date"                DATE,
    "currency"                TEXT        NOT NULL DEFAULT 'GBP',
    -- The rate at the invoice date. This is the only rate the books ever see.
    "fx_rate"                 NUMERIC(18,8) NOT NULL DEFAULT 1,
    "subtotal"                NUMERIC(12,2) NOT NULL DEFAULT 0,
    "carriage_amount"         NUMERIC(12,2) NOT NULL DEFAULT 0,
    -- A supplier's sale surcharge, as on the order. See 016.
    "surcharge_amount"        NUMERIC(12,2) NOT NULL DEFAULT 0,
    "tax_amount"              NUMERIC(12,2) NOT NULL DEFAULT 0,
    "total"                   NUMERIC(12,2) NOT NULL DEFAULT 0,
    -- What their own document says it comes to, kept apart from "total", which
    -- is our arithmetic over the order's prices. The two disagreeing is a fact
    -- worth a flag; overwriting one with the other is how it disappears. Also
    -- in 011, for installs that predate it.
    "stated_total"            NUMERIC(12,2),
    -- Who filed it: somebody here, a supplier through their own link, or the
    -- inbox reading their emailed invoice (017).
    "source"                  TEXT        NOT NULL DEFAULT 'ADMIN',
    "status"                  TEXT        NOT NULL DEFAULT 'DRAFT',
    "match_status"            TEXT        NOT NULL DEFAULT 'NOT_MATCHED',
    "variance"                JSONB       NOT NULL DEFAULT '[]',
    "query_note"              TEXT,
    "approved_by_user_id"     TEXT,
    "approved_at"             TIMESTAMPTZ,
    "posted_at"               TIMESTAMPTZ,
    "books_outcome"           JSONB       NOT NULL DEFAULT '{}',
    -- The supplier's own PDF, in core Media. No foreign key, exactly as core's
    -- own optional image references do it.
    "attachment_media_id"     TEXT,
    -- One line about that file where it is more than this invoice: "page 2 of
    -- 3 in the attached file". See 017.
    "attachment_note"         TEXT,
    "created_by_user_id"      TEXT,
    "created_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "po_bills_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_bills_status_check" CHECK ("status" IN ('DRAFT','QUERIED','APPROVED','POSTED','VOID')),
    CONSTRAINT "po_bills_match_status_check" CHECK ("match_status" IN ('NOT_MATCHED','MATCHED','VARIANCE')),
    CONSTRAINT "po_bills_source_check" CHECK ("source" IN ('ADMIN','PORTAL','INBOX')),
    CONSTRAINT "po_bills_order_fk" FOREIGN KEY ("order_id") REFERENCES "po_orders" ("id") ON DELETE SET NULL,
    CONSTRAINT "po_bills_supplier_fk" FOREIGN KEY ("supplier_id") REFERENCES "po_suppliers" ("id") ON DELETE RESTRICT
);
-- One supplier cannot bill the same invoice number twice, however they capitalise it.
CREATE UNIQUE INDEX IF NOT EXISTS "po_bills_supplier_invoice_unique"
    ON "po_bills" ("supplier_id", lower("supplier_invoice_number"));
CREATE INDEX IF NOT EXISTS "po_bills_order_idx" ON "po_bills" ("order_id");
CREATE INDEX IF NOT EXISTS "po_bills_status_idx" ON "po_bills" ("status");

CREATE TABLE IF NOT EXISTS "po_bill_lines" (
    "id"               TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "bill_id"          TEXT NOT NULL,
    "order_line_id"    TEXT,
    "description"      TEXT NOT NULL,
    "qty"              NUMERIC(12,3) NOT NULL,
    "unit_cost"        NUMERIC(12,4) NOT NULL,
    "tax_rate_percent" NUMERIC(5,2) NOT NULL DEFAULT 0,
    "tax_rate_code"    TEXT,
    "vat_treatment"    TEXT,
    "category_id"      TEXT,
    "line_total"       NUMERIC(12,2) NOT NULL DEFAULT 0,
    CONSTRAINT "po_bill_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_bill_lines_bill_fk" FOREIGN KEY ("bill_id") REFERENCES "po_bills" ("id") ON DELETE CASCADE,
    CONSTRAINT "po_bill_lines_order_line_fk" FOREIGN KEY ("order_line_id") REFERENCES "po_order_lines" ("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "po_bill_lines_bill_idx" ON "po_bill_lines" ("bill_id");
CREATE INDEX IF NOT EXISTS "po_bill_lines_order_line_idx" ON "po_bill_lines" ("order_line_id");

-- ---------------------------------------------------------------------------
-- Reorder rules (one per catalogue product)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "po_reorder_rules" (
    "id"                TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "product_id"        TEXT        NOT NULL,
    "supplier_id"       TEXT,
    "reorder_point"     INTEGER     NOT NULL DEFAULT 0,
    "reorder_qty"       INTEGER     NOT NULL DEFAULT 0,
    "enabled"           BOOLEAN     NOT NULL DEFAULT true,
    "last_suggested_at" TIMESTAMPTZ,
    "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "po_reorder_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_reorder_rules_product_unique" UNIQUE ("product_id"),
    CONSTRAINT "po_reorder_rules_supplier_fk" FOREIGN KEY ("supplier_id") REFERENCES "po_suppliers" ("id") ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- Supplier portal
--
-- Only the sha256 of a token is ever stored. The raw token exists once, in the
-- link the supplier is emailed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "po_portal_tokens" (
    "id"                 TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "order_id"           TEXT        NOT NULL,
    "token_hash"         TEXT        NOT NULL,
    "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    "expires_at"         TIMESTAMPTZ NOT NULL,
    "revoked_at"         TIMESTAMPTZ,
    "last_used_at"       TIMESTAMPTZ,
    "use_count"          INTEGER     NOT NULL DEFAULT 0,
    "created_by_user_id" TEXT,
    CONSTRAINT "po_portal_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_portal_tokens_hash_unique" UNIQUE ("token_hash"),
    CONSTRAINT "po_portal_tokens_order_fk" FOREIGN KEY ("order_id") REFERENCES "po_orders" ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "po_portal_tokens_order_idx" ON "po_portal_tokens" ("order_id");

CREATE TABLE IF NOT EXISTS "po_portal_events" (
    "id"         TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "token_id"   TEXT        NOT NULL,
    "order_id"   TEXT        NOT NULL,
    "kind"       TEXT        NOT NULL,
    "payload"    JSONB       NOT NULL DEFAULT '{}',
    "ip_hash"    TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "po_portal_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_portal_events_kind_check" CHECK ("kind" IN ('ACKNOWLEDGED','DATE_PROPOSED','SHORTAGE','MESSAGE','PROFORMA','DESPATCHED','INVOICED')),
    CONSTRAINT "po_portal_events_token_fk" FOREIGN KEY ("token_id") REFERENCES "po_portal_tokens" ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "po_portal_events_order_idx" ON "po_portal_events" ("order_id", "created_at");

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
-- cascaded: a revoked link must not take the despatch with it.
-- (Also in 007, for installs that predate it.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "po_shipments" (
    "id"                 TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "number"             TEXT        NOT NULL,
    "order_id"           TEXT        NOT NULL,
    "despatched_date"    DATE        NOT NULL,
    "carrier"            TEXT,
    "tracking_ref"       TEXT,
    "tracking_url"       TEXT,
    "notes"              TEXT,
    -- Who filed it: the supplier through their own link, somebody here typing
    -- it in, or an email carrying the tracking (see 018).
    "source"             TEXT        NOT NULL DEFAULT 'PORTAL',
    "token_id"           TEXT,
    "created_by_user_id" TEXT,
    -- For a despatch from email: the parcel's number with its spaces out, or
    -- the follow-my-parcel code where there is no number (one despatch per
    -- parcel per order, by the unique index below); that code; the day and
    -- slot the carrier gave; the email; and a fingerprint of what the rest of
    -- the site was last told about it, and whether it still has to be told.
    -- All in 018 for installs that predate it.
    "tracking_key"       TEXT,
    "tracking_code"      TEXT,
    "delivery_date"      DATE,
    "delivery_slot_start" TEXT,
    "delivery_slot_end"  TEXT,
    "source_message_id"  TEXT,
    "announced"          TEXT,
    "announce_pending"   BOOLEAN     NOT NULL DEFAULT false,
    "announce_attempts"  INTEGER     NOT NULL DEFAULT 0,
    "announce_tried_at"  TIMESTAMPTZ,
    "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "po_shipments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_shipments_number_unique" UNIQUE ("number"),
    CONSTRAINT "po_shipments_source_check" CHECK ("source" IN ('PORTAL','ADMIN','INBOX')),
    CONSTRAINT "po_shipments_order_fk" FOREIGN KEY ("order_id") REFERENCES "po_orders" ("id") ON DELETE CASCADE,
    CONSTRAINT "po_shipments_token_fk" FOREIGN KEY ("token_id") REFERENCES "po_portal_tokens" ("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "po_shipments_order_idx" ON "po_shipments" ("order_id", "despatched_date");
CREATE UNIQUE INDEX IF NOT EXISTS "po_shipments_order_tracking_key_unique"
    ON "po_shipments" ("order_id", "tracking_key") WHERE "tracking_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "po_shipments_tracking_key_idx"
    ON "po_shipments" ("tracking_key") WHERE "tracking_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "po_shipments_tracking_code_idx"
    ON "po_shipments" ("tracking_code") WHERE "tracking_code" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "po_shipments_announce_pending_idx"
    ON "po_shipments" ("announce_tried_at") WHERE "announce_pending";

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
-- Supplier paperwork arriving by email (017)
--
-- A PDF from a supplier's address, queued by the inbox handler and read on the
-- half-hourly job. page_from 0 is the file as it arrived; each document found
-- in it gets a row keyed by its first page. The unique key is the idempotency:
-- the inbox may offer one email twice, and every insert is ON CONFLICT DO
-- NOTHING. See 017 for the rest.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "po_inbound_documents" (
    "id"                 TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    -- The inbox's own ids, kept as plain text: the message, its conversation
    -- (for a link back to it) and the attachment.
    "message_id"         TEXT        NOT NULL,
    "thread_id"          TEXT,
    "attachment_id"      TEXT        NOT NULL,
    -- The file as the inbox stored it. NULL when the inbox could not fetch it
    -- from the mail server, which is said on the Paperwork list rather than
    -- guessed round.
    "source_media_id"    TEXT,
    "filename"           TEXT        NOT NULL DEFAULT '',
    "subject"            TEXT        NOT NULL DEFAULT '',
    "from_address"       TEXT        NOT NULL DEFAULT '',
    -- The date on the email.
    "received_at"        TIMESTAMPTZ,
    -- Every supplier the sender could be. Usually one; two where two suppliers
    -- share a domain, and the purchase order number on the document decides.
    "supplier_ids"       TEXT[]      NOT NULL DEFAULT '{}',
    -- 0 for the file as a whole, else the first page of the document this row
    -- is about (1-based).
    "page_from"          INTEGER     NOT NULL DEFAULT 0,
    "page_to"            INTEGER,
    "page_count"         INTEGER,
    -- What was read off it. Kind is proforma, acknowledgement, invoice,
    -- credit-note or unknown, as lib/supplier-document.ts names them.
    "kind"               TEXT,
    "supplier_ref"       TEXT,
    "our_po_numbers"     TEXT[]      NOT NULL DEFAULT '{}',
    "total"              NUMERIC(12,2),
    "doc_date"           DATE,
    -- The file could not be read page by page, so this document is all of it.
    "whole_file"         BOOLEAN     NOT NULL DEFAULT false,
    -- Where it went.
    "order_id"           TEXT,
    "filed_as"           TEXT,
    "filed_media_id"     TEXT,
    "bill_id"            TEXT,
    -- Something about a filed document worth a person's eye: their proforma
    -- comes to more than the order does, or its total could not be read.
    "flag"               TEXT,
    -- Whether that flag is worth an email: a total that disagrees, a revised
    -- proforma replacing one already on the order, a bill with nothing
    -- attached. A total that merely could not be read is said on the order and
    -- is not.
    "flag_alert"         BOOLEAN     NOT NULL DEFAULT false,
    -- For a proforma: what the order held BEFORE this one replaced it, taken
    -- once, before the replacing write. A retry after a failure part way
    -- through compares with this rather than with the order - which by then
    -- holds this very document and would find nothing to warn about.
    "prior_captured_at"      TIMESTAMPTZ,
    "prior_proforma_media_id" TEXT,
    "prior_proforma_ref"     TEXT,
    "prior_proforma_amount"  NUMERIC(12,2),
    -- QUEUED waiting to be read or filed; READ for a file whose documents now
    -- have rows of their own; FILED; NEEDS_EYES with `reason` the sentence
    -- saying why; IGNORED by a person, with `reason` saying which way.
    "outcome"            TEXT        NOT NULL DEFAULT 'QUEUED',
    "reason"             TEXT,
    -- Who is working on it, so two runs never file one document twice, and how
    -- often it has been tried, so a file that breaks the reader stops being
    -- tried.
    "claimed_at"         TIMESTAMPTZ,
    "attempts"           INTEGER     NOT NULL DEFAULT 0,
    -- When the problem report email mentioned it, so it is mentioned once.
    "reported_at"        TIMESTAMPTZ,
    "handled_by_user_id" TEXT,
    -- A tracking row (kind 'tracking'): what was read out of the email, and
    -- the despatch it became. See 018.
    "tracking"           JSONB,
    "shipment_id"        TEXT,
    "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    "handled_at"         TIMESTAMPTZ,
    CONSTRAINT "po_inbound_documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_inbound_documents_outcome_check"
        CHECK ("outcome" IN ('QUEUED','READ','FILED','NEEDS_EYES','IGNORED')),
    CONSTRAINT "po_inbound_documents_order_fk" FOREIGN KEY ("order_id") REFERENCES "po_orders" ("id") ON DELETE SET NULL,
    CONSTRAINT "po_inbound_documents_bill_fk" FOREIGN KEY ("bill_id") REFERENCES "po_bills" ("id") ON DELETE SET NULL,
    CONSTRAINT "po_inbound_documents_shipment_fk" FOREIGN KEY ("shipment_id") REFERENCES "po_shipments" ("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "po_inbound_documents_attachment_page_unique"
    ON "po_inbound_documents" ("attachment_id", "page_from");
CREATE INDEX IF NOT EXISTS "po_inbound_documents_message_idx" ON "po_inbound_documents" ("message_id");
CREATE INDEX IF NOT EXISTS "po_inbound_documents_order_idx" ON "po_inbound_documents" ("order_id");
-- The cron's first question, answered off this alone: is anything waiting?
CREATE INDEX IF NOT EXISTS "po_inbound_documents_queued_idx"
    ON "po_inbound_documents" ("created_at") WHERE "outcome" = 'QUEUED';
CREATE INDEX IF NOT EXISTS "po_inbound_documents_needs_eyes_idx"
    ON "po_inbound_documents" ("created_at") WHERE "outcome" = 'NEEDS_EYES';
-- The problem report's question, so it is not a whole-table UPDATE every
-- half hour: what is worth telling somebody and has not been told yet.
CREATE INDEX IF NOT EXISTS "po_inbound_documents_unreported_idx"
    ON "po_inbound_documents" ("created_at")
    WHERE "reported_at" IS NULL AND ("outcome" = 'NEEDS_EYES' OR "flag_alert");

-- ---------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "po_audit_log" (
    "id"          TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "entity_type" TEXT        NOT NULL,
    "entity_id"   TEXT        NOT NULL,
    "action"      TEXT        NOT NULL,
    "detail"      JSONB       NOT NULL DEFAULT '{}',
    "user_id"     TEXT,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "po_audit_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "po_audit_log_entity_idx" ON "po_audit_log" ("entity_type", "entity_id", "created_at");
