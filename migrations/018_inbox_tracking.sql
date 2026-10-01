-- Purchase Orders - delivery tracking from email, recorded as a despatch
--
-- The unified inbox tells this module when an email arrives
-- (`unified-inbox.message-received`). Where that email carries delivery
-- tracking - the supplier replying on the order's thread, or the carrier they
-- booked writing to us - and it can be pinned to exactly one of our purchase
-- orders, it is recorded here as a despatch, and later mail about the same
-- parcel (a delivery day, a timeslot, a better link) updates that despatch
-- rather than adding a second. See lib/inbound-tracking.ts.
--
-- Four changes, all additive, all idempotent, and 001 carries the same for a
-- fresh install.
--
-- 1. A third source of despatch, INBOX. The CHECK is dropped and recreated
--    because Postgres has no ALTER CONSTRAINT for one; both halves are one
--    statement each, and the new list is a superset of the old, so no stored
--    row can fail it.
--
-- 2. What a despatch from email needs that one typed in never did:
--    - `tracking_key`: the one thing that says "this parcel" - the parcel or
--      consignment number with its spaces taken out, or failing that the code
--      out of a follow-my-parcel link. With the unique index below it is what
--      makes two offers of one email, or two carrier emails about one parcel
--      arriving together, one despatch rather than two.
--    - `tracking_code`: the code out of a follow-my-parcel link, kept beside
--      the number, so a later email that quotes only the link still finds it.
--    - the delivery day and timeslot, as the carrier gave them: a day as a
--      DATE, a slot as 'HH:MM' text, never an instant (an instant is a moment
--      in one timezone and prints as another day in the next).
--    - the email it came from, and when it last changed.
--    - `announced`: a fingerprint of what the rest of the site was last told
--      about this despatch, written once every listener has taken it.
--    - `announce_pending`: set when an email changes the despatch, cleared
--      once it has been announced (or there is nobody to tell). A listener
--      that failed for a moment - a busy order, a database blip - leaves it
--      set, and the half-hourly job announces it again - backing off, by
--      `announce_attempts` and `announce_tried_at`, and after ten failed tries
--      giving up and putting it on the Paperwork list for a person.
--
-- 3. The Paperwork list's tracking rows. A tracking email matched only by its
--    delivery postcode is never applied by itself - a wrong match emails one
--    customer another customer's delivery - so it waits on the list as a
--    proposal with a one-click "yes, that one". The rows live in the same
--    table as the paperwork, kind 'tracking', with what was read kept as JSON
--    and the despatch it became.
--
-- 4. Indexes for the questions asked of these on every email: is this parcel
--    already one of ours (by number or by code), and which tracking rows did
--    this email produce.
--
-- No DO blocks, no dollar quoting: every statement here is plain DDL that can
-- run any number of times.
ALTER TABLE "po_shipments" DROP CONSTRAINT IF EXISTS "po_shipments_source_check";
ALTER TABLE "po_shipments" ADD CONSTRAINT "po_shipments_source_check"
    CHECK ("source" IN ('PORTAL','ADMIN','INBOX'));

ALTER TABLE "po_shipments" ADD COLUMN IF NOT EXISTS "tracking_key" TEXT;
ALTER TABLE "po_shipments" ADD COLUMN IF NOT EXISTS "tracking_code" TEXT;
ALTER TABLE "po_shipments" ADD COLUMN IF NOT EXISTS "delivery_date" DATE;
ALTER TABLE "po_shipments" ADD COLUMN IF NOT EXISTS "delivery_slot_start" TEXT;
ALTER TABLE "po_shipments" ADD COLUMN IF NOT EXISTS "delivery_slot_end" TEXT;
ALTER TABLE "po_shipments" ADD COLUMN IF NOT EXISTS "source_message_id" TEXT;
ALTER TABLE "po_shipments" ADD COLUMN IF NOT EXISTS "announced" TEXT;
ALTER TABLE "po_shipments" ADD COLUMN IF NOT EXISTS "announce_pending" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "po_shipments" ADD COLUMN IF NOT EXISTS "announce_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "po_shipments" ADD COLUMN IF NOT EXISTS "announce_tried_at" TIMESTAMPTZ;
ALTER TABLE "po_shipments" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS "po_shipments_order_tracking_key_unique"
    ON "po_shipments" ("order_id", "tracking_key") WHERE "tracking_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "po_shipments_tracking_key_idx"
    ON "po_shipments" ("tracking_key") WHERE "tracking_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "po_shipments_tracking_code_idx"
    ON "po_shipments" ("tracking_code") WHERE "tracking_code" IS NOT NULL;
-- The job's first question, answered off this alone: is anything waiting to
-- be announced?
CREATE INDEX IF NOT EXISTS "po_shipments_announce_pending_idx"
    ON "po_shipments" ("announce_tried_at") WHERE "announce_pending";

ALTER TABLE "po_inbound_documents" ADD COLUMN IF NOT EXISTS "tracking" JSONB;
ALTER TABLE "po_inbound_documents" ADD COLUMN IF NOT EXISTS "shipment_id" TEXT;
ALTER TABLE "po_inbound_documents" DROP CONSTRAINT IF EXISTS "po_inbound_documents_shipment_fk";
ALTER TABLE "po_inbound_documents" ADD CONSTRAINT "po_inbound_documents_shipment_fk"
    FOREIGN KEY ("shipment_id") REFERENCES "po_shipments" ("id") ON DELETE SET NULL;
