-- Purchase Orders - the delivery service a line has to be sent on.
--
-- A drop-shipped line is not just "twelve chairs". It is twelve chairs on a
-- pre-assembled installation, or on a two-man delivery, and the supplier can
-- only act on that if it travels with the line. 001 has already run on every
-- install that has this module, so the columns arrive here and 001 carries them
-- as well for a site installing today. Both are idempotent.
--
-- They sit ON the product line rather than on a shipping line of their own. A
-- separate line would be outstanding forever: receiving, chasing, billing and
-- the reports all count lines, and none of them can ever mark a delivery
-- service as arrived. Two columns change no line count and touch no aggregate.
--
-- service_cost is deliberately NOT in the line total. It is summed across the
-- lines into po_orders.carriage_amount, which is where this module has always
-- carried delivery money - see lib/totals.ts and lib/ledger.ts.

ALTER TABLE "po_order_lines" ADD COLUMN IF NOT EXISTS "service_name" TEXT;
ALTER TABLE "po_order_lines" ADD COLUMN IF NOT EXISTS "service_cost" NUMERIC(12,4);
