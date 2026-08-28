import { createHash } from 'node:crypto'
import { assertSafeListUrl, ListFetchError, looksLikeHtml, toDownloadUrl } from './list-url'

// Downloading a supplier's price list from the address that is already on file.
//
// The address checks live in list-url.ts. This half exists because the shop
// already records where each supplier's catalogue lives, and asking somebody to
// open that link, download it and upload it again is asking them to do by hand
// the one thing a computer is good at.
//
// It is still never automatic. Nothing here runs on a schedule and nothing here
// runs without somebody pressing Import: a module that goes and reads a URL of
// its own accord is a module that can be pointed at an address inside the
// network it is running in, which is what assertSafeListUrl is for.

/** Refuse a file bigger than this.
 *
 *  Sixty megabytes, because a supplier's list is not always a list: the same
 *  spreadsheet that prices a range routinely carries the photography captions,
 *  the body copy and eighty columns of specification alongside, and thirty
 *  megabytes of that is an ordinary export rather than a mistake. The import
 *  reads it a row at a time and keeps only the columns it needs, so the size
 *  that matters is what will come down the wire inside the route's own minute,
 *  not what will fit in memory. Past this it is not a price list. */
const MAX_BYTES = 60 * 1024 * 1024

/** Give up on a supplier that has gone quiet, inside the route's own ceiling.
 *  Covers the whole download rather than just the answer: a big list is a slow
 *  one, and the minute the route gets has an import to do at the end of it. */
const TIMEOUT_MS = 40_000

/**
 * Fetch a price list as text.
 *
 * Returns the address it actually read as well as the text, because a Google
 * Sheet link is rewritten to its CSV form on the way out and the screen should
 * say what was fetched rather than what was clicked.
 */
export async function fetchPriceList(rawUrl: string): Promise<{ text: string; url: string }> {
  const safe = assertSafeListUrl(rawUrl)
  const target = assertSafeListUrl(toDownloadUrl(safe.toString()))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(target.toString(), {
      headers: {
        // Some supplier portals serve an HTML "please log in" page to anything
        // that does not look like a browser, which then parses as a CSV with one
        // column in it.
        Accept: 'text/csv, text/plain, */*',
        'User-Agent': 'Cactus Purchase Orders',
      },
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ListFetchError('Whoever hosts that list did not answer within forty seconds.')
    }
    throw new ListFetchError(`Could not reach that address (${error instanceof Error ? error.message : 'unknown error'}).`)
  }

  try {
    if (response.status === 401 || response.status === 403) {
      throw new ListFetchError(
        'That list would not let us in. If it is a Google Sheet, share it so that anyone with the link can view it, then try again - or download it and upload the file.',
      )
    }
    if (response.status === 404) {
      throw new ListFetchError('There is nothing at that address any more. Check the link on the list.')
    }
    if (!response.ok) {
      throw new ListFetchError(`That address answered with an error (HTTP ${response.status}).`)
    }

    const body = response.body
    if (!body) throw new ListFetchError('That address sent an empty response.')

    // Read with a hard ceiling rather than response.text(), so a mis-typed
    // address pointing at something enormous cannot take the whole function
    // down with it.
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        chunks.push(value)
        bytes += value.byteLength
        if (bytes > MAX_BYTES) {
          await reader.cancel().catch(() => {})
          throw new ListFetchError('That file is far bigger than any price list (over 60MB).')
        }
      }
    } catch (error) {
      if (error instanceof ListFetchError) throw error
      // The clock can run out halfway down a large file as easily as it can
      // waiting for the first byte, and it arrives here as an abort rather than
      // at the fetch above. There is the same thing to say about it either way.
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ListFetchError(
          'That list was still coming down after forty seconds. If it is a whole product dataset rather than a price list, a sheet carrying just the codes and the prices will import in moments.',
        )
      }
      throw new ListFetchError(
        `That address stopped sending partway through (${error instanceof Error ? error.message : 'unknown error'}).`,
      )
    }

    const text = new TextDecoder('utf-8').decode(concat(chunks, bytes))
    if (!text.trim()) throw new ListFetchError('There is nothing in that file.')
    if (looksLikeHtml(text)) {
      throw new ListFetchError(
        'That address gave us a web page rather than a price list. A Google Sheet has to be shared so that anyone with the link can view it; otherwise download it and upload the file.',
      )
    }
    return { text, url: target.toString() }
  } finally {
    clearTimeout(timer)
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * A short, stable name for one particular version of a price list.
 *
 * A list is read twice: once to show somebody what importing it would do, and
 * again when they say go ahead. Sending twelve megabytes of spreadsheet down to
 * the browser and back up again to avoid that second read is not an option -
 * the platform refuses a request body that size - so the second read happens,
 * and this is what proves it read the same thing. A supplier who edits the sheet
 * in between gets a fresh comparison rather than a silent swap.
 */
export function fingerprintList(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}
