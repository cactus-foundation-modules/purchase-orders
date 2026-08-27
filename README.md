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
- An audit trail of every change.

Receiving, returns, supplier bills, reordering and the supplier portal follow
in later releases, and their tabs are already in place saying so.

## Installation

Install the module from the Cactus admin panel under Modules.

## Configuration

Settings live under Settings, Purchase Orders. Grant `purchase-orders.access`
to whichever role(s) should see the section, `purchase-orders.create` to raise
and edit orders, `purchase-orders.approve` to approve them, and
`purchase-orders.settings` to change the settings.

## License

MIT
