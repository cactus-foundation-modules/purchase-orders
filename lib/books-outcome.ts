// What the books said, as a bill screen and a return screen read it back.
//
// A file of its own, and NOT part of lib/book-sinks.ts, for one reason: the two
// admin screens are client components and book-sinks.ts imports the database.
// A client component importing that file drags the whole server graph into the
// browser bundle - the exact trap the prebuild guard and lib/bill-file-kinds.ts
// both exist for. Nothing here touches anything but the shape of an object.

/** One registered module's answer, kept on the bill or the return. */
export type PoBookSinkResult = { id: string; ok: boolean; message: string; at: string }

/** What gets stored in `books_outcome`, and what the screen reads back. */
export type PoBooksOutcome = {
  ok: boolean
  message: string
  at: string
  results: PoBookSinkResult[]
}

/**
 * Reads a stored `books_outcome` column back, whatever is actually in it.
 *
 * Defensive on purpose: the column is JSON, it defaults to `{}`, and every bill
 * raised before this release has nothing useful in it at all. A screen that
 * threw on an empty column would be a screen nobody could open.
 */
export function readBooksOutcome(raw: unknown): PoBooksOutcome | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (typeof value.message !== 'string') return null
  return {
    ok: value.ok === true,
    message: value.message,
    at: typeof value.at === 'string' ? value.at : '',
    results: Array.isArray(value.results) ? (value.results as PoBookSinkResult[]) : [],
  }
}
