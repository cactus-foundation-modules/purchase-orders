import { prisma } from '@/lib/db/prisma'
import { getPoConfigCached } from './config'

// Atomic - backed by Postgres sequences, so two people raising an order at the
// same moment can never land on the same number. The prefix is the owner's; the
// running number is not, which is rather the point of a purchase order number.
//
// The sequences are created in 001 and are picked up by the backup dump from
// pg_sequences. A restored site therefore carries on where it left off instead
// of starting again at 1 and colliding on the unique index.

function pad(value: bigint): string {
  return value.toString().padStart(5, '0')
}

export async function generateOrderNumber(): Promise<string> {
  const config = await getPoConfigCached()
  const rows = await prisma.$queryRaw<{ nextval: bigint }[]>`
    SELECT nextval('po_number_seq') AS nextval
  `
  return `${config.orderNumberPrefix}${pad(rows[0]!.nextval)}`
}

export async function generateReceiptNumber(): Promise<string> {
  const config = await getPoConfigCached()
  const rows = await prisma.$queryRaw<{ nextval: bigint }[]>`
    SELECT nextval('po_receipt_number_seq') AS nextval
  `
  return `${config.receiptNumberPrefix}${pad(rows[0]!.nextval)}`
}

export async function generateReturnNumber(): Promise<string> {
  const config = await getPoConfigCached()
  const rows = await prisma.$queryRaw<{ nextval: bigint }[]>`
    SELECT nextval('po_return_number_seq') AS nextval
  `
  return `${config.returnNumberPrefix}${pad(rows[0]!.nextval)}`
}
