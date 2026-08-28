-- Purchase Orders - the supplier's own price list, held as data.
--
-- Until now a purchase order line was priced off shop's `cost_price`, which is
-- whatever somebody typed when the product was created. A supplier's actual
-- list moves: codes are renamed, lines are discontinued, prices go up in April.
-- These two tables hold that list so an order can be drafted at what the
-- supplier is charging today, and so a code we are still selling under can be
-- flagged the week it stops existing.
--
-- Two new tables and no new columns anywhere, so unlike 002 and 003 nothing is
-- mirrored back into 001_initial.sql - the runner applies every file in this
-- folder in order, on a fresh install exactly as on an updated one, and a table
-- defined twice is a table that can disagree with itself.
--
-- Column types stay inside the set the backup serialiser has a branch for -
-- text / integer / numeric / boolean / date / timestamptz - and there are no
-- generated or identity columns, for the reason 001 gives at length.
--
-- shop_catalogue_id is a SOFT link and deliberately not a foreign key. It names
-- a row in shp_supplier_catalogues, which is another module's table, on a site
-- that may not have a shop at all. The name is snapshotted beside it so the
-- record still reads perfectly well after that row is renamed or deleted -
-- exactly how po_suppliers already holds its link to shp_suppliers.

CREATE TABLE IF NOT EXISTS "po_supplier_catalogues" (
    "id"                  TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "supplier_id"         TEXT        NOT NULL,
    "name"                TEXT        NOT NULL,
    -- Normalised lowercase name, so "Seating" and "seating " are one catalogue.
    -- A stored key rather than an expression index, matching po_suppliers.
    "name_key"            TEXT        NOT NULL,
    -- Where the list came from: a Google Sheet, a supplier's price-list page, or
    -- blank for one that was simply uploaded. Recorded as provenance; nothing
    -- fetches it, and nothing on this platform ever should without being asked.
    "source_url"          TEXT,
    "shop_catalogue_id"   TEXT,
    "shop_catalogue_name" TEXT,
    "currency"            TEXT        NOT NULL DEFAULT 'GBP',
    -- Whether the prices on this list are already trade net, or are retail with
    -- the supplier's discount still to come off. Arrives in 005 for installs
    -- that already have this file; 'NET' is how every list imported before that
    -- was read, so the default changes nothing already on file.
    "price_basis"         TEXT        NOT NULL DEFAULT 'NET',
    -- When the supplier says this list starts applying. Free to leave blank.
    "effective_from"      DATE,
    "last_imported_at"    TIMESTAMPTZ,
    -- How many rows the last import left behind. Stored rather than counted on
    -- read only because it is shown in a list beside every catalogue; it is
    -- written in the same transaction as the rows themselves, so it cannot
    -- drift the way a received-quantity counter would.
    "item_count"          INTEGER     NOT NULL DEFAULT 0,
    "notes"               TEXT,
    -- Which row of the supplier's spreadsheet the headings are on, and which
    -- column feeds which field, where somebody has corrected what the import
    -- worked out for itself. Both arrive in 006 for installs that already have
    -- this file; both NULL means "work it out", which is every list nobody has
    -- had to correct. See 006 for why a pinned map carries headings as well as
    -- positions.
    "header_row"          INTEGER,
    "column_map"          TEXT,
    "created_by_user_id"  TEXT,
    "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "po_supplier_catalogues_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_supplier_catalogues_price_basis_check" CHECK ("price_basis" IN ('NET','RETAIL')),
    CONSTRAINT "po_supplier_catalogues_supplier_fk" FOREIGN KEY ("supplier_id")
        REFERENCES "po_suppliers" ("id") ON DELETE CASCADE
);

-- Two catalogues of the same name under one supplier are a duplicate, not a
-- pair. Across suppliers they are not: everybody's list is called "Seating".
CREATE UNIQUE INDEX IF NOT EXISTS "po_supplier_catalogues_supplier_name_unique"
    ON "po_supplier_catalogues" ("supplier_id", "name_key");
CREATE INDEX IF NOT EXISTS "po_supplier_catalogues_supplier_idx"
    ON "po_supplier_catalogues" ("supplier_id");

-- ---------------------------------------------------------------------------
-- The lines of the list
--
-- One row per supplier code. An import REPLACES a catalogue's rows rather than
-- merging into them: a price list is a statement about the whole range on the
-- day it was published, and a merge quietly keeps last year's codes alive
-- forever, which is the precise failure this table exists to prevent. What was
-- there before is compared against what arrived, and the differences are
-- reported, before the swap happens.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "po_catalogue_items" (
    "id"                TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    "catalogue_id"      TEXT        NOT NULL,
    "supplier_sku"      TEXT        NOT NULL,
    -- Trimmed, uppercased, punctuation-free form of the code, which is what
    -- everything matches on. Supplier lists print the same code as "DS-1234",
    -- "ds1234" and "DS 1234" on three different tabs.
    "supplier_sku_key"  TEXT        NOT NULL,
    "description"       TEXT        NOT NULL DEFAULT '',
    -- Four decimal places, as every other cost in this module: supplier prices
    -- routinely go below the penny.
    "unit_cost"         NUMERIC(12,4),
    "pack_size"         NUMERIC(12,3),
    "minimum_order_qty" NUMERIC(12,3),
    "lead_time_days"    INTEGER,
    "discount_group"    TEXT,
    "discontinued"      BOOLEAN     NOT NULL DEFAULT false,
    "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "po_catalogue_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_catalogue_items_catalogue_fk" FOREIGN KEY ("catalogue_id")
        REFERENCES "po_supplier_catalogues" ("id") ON DELETE CASCADE
);

-- One row per code per catalogue. A list quoting the same code twice at two
-- prices is a list with a mistake in it, and the import says so rather than
-- picking one.
CREATE UNIQUE INDEX IF NOT EXISTS "po_catalogue_items_code_unique"
    ON "po_catalogue_items" ("catalogue_id", "supplier_sku_key");
-- The lookup every priced order line does: this supplier's codes, whatever
-- catalogue of theirs they are in.
CREATE INDEX IF NOT EXISTS "po_catalogue_items_code_idx"
    ON "po_catalogue_items" ("supplier_sku_key");
