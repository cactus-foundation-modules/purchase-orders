-- Purchase Orders - notes that went on saying "nothing has been sent"
--
-- An order drafted off a customer order, or off the reorder levels, was given an
-- internal note that said where it came from AND where it had got to: "Nobody
-- has read it and nothing has been sent to the supplier." The first half is true
-- for ever. The second half is true until the moment somebody presses Send, and
-- a note is written once - so an order that had been emailed, acknowledged and
-- delivered went on telling whoever opened it that nothing had been sent.
--
-- The order screen now works that out from the order itself, and the drafting
-- code no longer writes the sentence. This takes it off the orders that already
-- carry it, sent or not: on a draft the screen says the same thing, from the
-- status, and will stop saying it when it stops being true.
--
-- Exact sentences only, each with the space in front of it. They are the two
-- this module ever wrote; anything a person typed is left exactly as it was,
-- including a note somebody added after one of these.
--
-- No schema change, nothing for 001 to carry, and idempotent: a second run finds
-- nothing to replace.
UPDATE "po_orders"
   SET "notes_internal" = replace(replace("notes_internal",
         ' Nobody has read it and nothing has been sent to the supplier.', ''),
         ' Nothing has been sent to the supplier.', '')
 WHERE "notes_internal" LIKE '%othing has been sent to the supplier.%';
