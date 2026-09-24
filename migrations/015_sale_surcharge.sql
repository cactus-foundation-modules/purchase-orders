-- A supplier's small-order surcharge on clearance stock, and the field it
-- prices off - three things arriving together because they are one story,
-- the same reasoning 007 gives for bundling.
--
-- Some suppliers put a small-order surcharge on stock bought under a
-- clearance/sale code once the order falls under a value they set - a per-unit
-- fee, different by what's being bought (a chair costs less to handle than a
-- desk), and never more than what closes the gap to their threshold. Nothing
-- about the figures - which supplier, what threshold, what the rates are - is
-- ever written into this module: every site configures its own.
--
-- The rate needs a CATEGORY to key off, and nothing in this module has one -
-- "category" here is deliberately NOT shop's product-category tree (an
-- owner's free-text taxonomy, renamed on a whim) and NOT a fixed list this
-- module invents. It is a new field on the supplier's own uploaded price
-- list, exactly like discount_group already is: whatever the supplier's own
-- sheet calls it, typed in at upload and matched, case- and space-insensitive,
-- against whatever the supplier typed on their surcharge rates.

-- 1. The category a price-list row belongs to, imported the same way
--    discount_group already is (see lib/catalogue-import.ts). Unlike
--    discount_group, this one is read at PRICING time too, not just shown -
--    see catalogueCostsBySupplier() in lib/catalogues.ts.
ALTER TABLE "po_catalogue_items" ADD COLUMN IF NOT EXISTS "category" TEXT;

-- 2. The net value below which the surcharge applies. Nullable, same
--    "unset = off" convention as minimum_order_value/carriage_paid_over on
--    this same table - a supplier with no threshold never gets a surcharge
--    line, whatever else is configured on it.
ALTER TABLE "po_suppliers" ADD COLUMN IF NOT EXISTS "surcharge_threshold" NUMERIC(12,2);

-- 3. What each category costs, per unit. A genuine child table, not a JSONB
--    array - the same choice every other "variable list of rows belonging to
--    one parent" in this module has made (po_order_lines and its siblings).
--    NUMERIC(12,4): the same four-decimal precision unit_cost and
--    service_cost already carry, because a per-unit fee is exactly that kind
--    of figure and two decimal places would round it before it was ever used.
CREATE TABLE IF NOT EXISTS "po_supplier_surcharge_rates" (
    "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "supplier_id"   TEXT NOT NULL,
    -- What the owner typed, kept verbatim so the edit form can show it back.
    "category"      TEXT NOT NULL,
    -- Trimmed and lowercased, the same normalisation catalogueNameKey already
    -- gives every other name-key in this module - what matching actually uses.
    "category_key"  TEXT NOT NULL,
    "rate_per_unit" NUMERIC(12,4) NOT NULL,
    "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "po_supplier_surcharge_rates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_supplier_surcharge_rates_rate_check" CHECK ("rate_per_unit" >= 0),
    CONSTRAINT "po_supplier_surcharge_rates_supplier_fkey" FOREIGN KEY ("supplier_id")
        REFERENCES "po_suppliers" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "po_supplier_surcharge_rates_supplier_category_unique"
    ON "po_supplier_surcharge_rates" ("supplier_id", "category_key");

-- 4. Where the money actually lands on a raised order - a sibling to
--    carriage_amount, worked out and totalled exactly the same way (see
--    lib/totals.ts orderTotals, lib/from-order.ts surchargeFor). Never its
--    own order line, for the same reason carriage never is - see
--    003_line_service.sql's header.
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "surcharge_amount" NUMERIC(12,2) NOT NULL DEFAULT 0;
