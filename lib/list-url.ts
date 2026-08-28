// The checks that decide whether a recorded address may be fetched at all, and
// the one rewrite that turns a Google Sheet you can look at into a file you can
// read.
//
// Kept apart from the fetching itself so it carries no database import and no
// network, and can be tested as the plain functions it is. Nothing in here is
// borrowed from another module: Purchase Orders may be installed on a site with
// neither a shop nor a stock feed, and a module that imports from a directory
// which does not exist at build time does not build.

export class ListFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ListFetchError'
  }
}

/**
 * Only http(s), and never a private address.
 *
 * The address is typed by an owner, or copied across from one the shop has on
 * file, and the request is made by the site's own server - which can reach
 * things the owner's browser cannot, including the metadata endpoints and
 * internal services of whatever it is deployed on. A typo is the likeliest
 * reason one of those would ever appear here. The check is not optional either
 * way.
 */
export function assertSafeListUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new ListFetchError('That does not look like a web address. It should start with https://')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ListFetchError('The address has to start with https:// or http://')
  }
  if (isPrivateHost(url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, ''))) {
    throw new ListFetchError('That address points back at this server rather than out at your supplier.')
  }
  return url
}

export function isPrivateHost(host: string): boolean {
  return (
    host === '' ||
    host === 'localhost' ||
    host === '::1' ||
    host === '::' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^0\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/i.test(host) ||
    /^fe80:/i.test(host)
  )
}

/**
 * The address of the FILE behind a link somebody would paste.
 *
 * A shop catalogue records where a list lives, and what gets recorded is the
 * address off the browser bar - a Google Sheet ending `/edit#gid=0`. Fetching
 * that returns the spreadsheet's HTML, which parses as a price list with one
 * column and no codes in it. Google publishes the same document as CSV at
 * `/export?format=csv`, on the same host and under the same sharing rules, so
 * the rewrite happens here and the fetch stays a plain fetch.
 *
 * The tab matters: `gid` names one sheet of a workbook, and dropping it silently
 * imports whichever tab happens to be first. It is carried across from the
 * fragment or the query, wherever the address it was copied from put it.
 *
 * Anything that is not a Google Sheet is returned untouched. A supplier serving
 * a CSV of their own is the simple case and needs no help.
 */
export function toDownloadUrl(raw: string): string {
  const url = new URL(raw.trim())
  if (url.hostname.toLowerCase() !== 'docs.google.com') return url.toString()

  const path = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(url.pathname)
  if (!path) return url.toString()

  // Already asking for a file rather than a page: an /export url, or one of the
  // "publish to the web" addresses, which serve CSV directly when told to.
  if (/\/export\b/.test(url.pathname)) return url.toString()
  if (/\/pub\b/.test(url.pathname) && url.searchParams.get('output') === 'csv') return url.toString()

  const gid = url.searchParams.get('gid') ?? gidFromFragment(url.hash)
  const download = new URL(`https://docs.google.com/spreadsheets/d/${path[1]}/export`)
  download.searchParams.set('format', 'csv')
  if (gid) download.searchParams.set('gid', gid)
  return download.toString()
}

/** `#gid=1234567`, which is where the browser bar puts the tab. */
function gidFromFragment(hash: string): string | null {
  const found = /(?:^#|&)gid=(\d+)/.exec(hash)
  return found ? found[1]! : null
}

/** True where the address is one this module knows how to turn into a file, as
 *  opposed to one it will simply fetch and hope. Used only for the wording on
 *  the screen - the import itself tries either way. */
export function isGoogleSheet(raw: string): boolean {
  try {
    const url = new URL(raw.trim())
    return url.hostname.toLowerCase() === 'docs.google.com' && /\/spreadsheets\/d\//.test(url.pathname)
  } catch {
    return false
  }
}

/** A login page dressed as a download is the single most common false success:
 *  a sheet nobody has shared answers 200 with Google's sign-in HTML. */
export function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 400).trim().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml')
}
