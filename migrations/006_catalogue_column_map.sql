-- Purchase Orders - which row the headings are on, and which column is which.
--
-- A supplier's price list is an export from something, and exports are not
-- tidy: a title on row two, a row of merged group headings on row three, the
-- actual headings on row four, and eighty-nine columns of which three matter.
-- The import works that out for itself now, but working it out is a guess, and
-- a guess about which column is the price is not a guess anybody should have to
-- live with. These two columns are where somebody's correction is kept, so it
-- is made once rather than every month.
--
-- Written only when somebody actually picks the columns by hand. A list read
-- automatically leaves both NULL and goes on being read automatically, which
-- matters: automatic reading follows the HEADINGS, so a supplier who inserts a
-- column changes nothing. A pinned mapping carries the heading beside the
-- position for the same reason.
--
-- 004 has already run wherever price lists exist, so editing it in place would
-- never re-run. The columns arrive here, and 004 carries them as well for a site
-- installing today - idempotent either way, the same reasoning 005 sets out.
--
-- Column types stay inside the set the backup serialiser has a branch for:
-- integer and text. The map is JSON held as TEXT rather than as jsonb - it is
-- read and written whole, never queried into, and text is one less thing for a
-- restore to get wrong.

ALTER TABLE "po_supplier_catalogues" ADD COLUMN IF NOT EXISTS "header_row" INTEGER;
ALTER TABLE "po_supplier_catalogues" ADD COLUMN IF NOT EXISTS "column_map" TEXT;
