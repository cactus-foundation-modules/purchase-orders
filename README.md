<p align="center">
  <img src="module-art.webp" alt="Purchase Orders" width="640" />
</p>

# Purchase Orders

Buying, for [Cactus](https://github.com/usersaynoso/cactus-foundation) sites.

Keep a supplier list, raise a purchase order against it, send it out, and then
check what actually turned up against what you ordered before anybody pays for
it. Every change to an order is recorded, and once an order has gone to the
supplier the version they were sent is kept exactly as it was sent.

Stands on its own. It works with the Shop module (pick lines straight off your
catalogue, and optionally take goods into stock when they arrive) and with the
UK Bookkeeping module (approved bills go through to the books), but it needs
neither - a builder with no online shop and no books on the site still buys
things.

## What is in this release

- Suppliers, with the terms you buy on: payment terms, lead times, minimum
  order value, carriage-paid thresholds.
- Purchase orders: draft, line editor, approval where you want one, and the
  full order lifecycle through to closed or cancelled.
- The order as a document you design yourself, printed as a PDF and emailed to
  the supplier, with every revision kept exactly as it was sent.
- Receiving: tick off what turned up, flag what came in over, and optionally
  move a stock count.
- Returns and debit notes, with the credit tracked until it arrives.
- Supplier bills, with a three-way match against what was ordered and what was
  delivered, their own invoice attached, and a query-or-approve flow.
- Approved bills and supplier credits going through to the books by themselves,
  where UK Bookkeeping is installed.
- Reorder levels per product, and the draft orders that follow when a count
  drops below one - grouped by supplier and mindful of their minimum.
- A link for the supplier: their own view of their own order, which they can
  accept, offer a different date on, or report a shortage against, and change
  nothing at all. Scoped to one order, expiring, revocable, and stored only as
  a hash.
- Reports: what you have committed to and not yet received, what is late, goods
  in without an invoice, invoices in without the goods, and what you spend with
  whom, month by month and by category.
- Chasing: a note to a supplier whose order is late, on the schedule you set -
  or one you send yourself from the Reports tab.
- Four spreadsheets to take away: orders, order lines, deliveries and supplier
  invoices.
- A tile on the admin dashboard: what is out with suppliers, what it is worth,
  what is late, and how many invoices are waiting to be checked.

## Installation

Install the module from the Cactus admin panel under Modules.

## Configuration

Settings live under Settings, Purchase Orders. Grant `purchase-orders.access`
to whichever role(s) should see the section, `purchase-orders.create` to raise
and edit orders, `purchase-orders.approve` to approve them,
`purchase-orders.receive` to book deliveries in and send goods back,
`purchase-orders.bills` to enter and approve supplier invoices, and
`purchase-orders.settings` to change the settings.

## License

MIT
