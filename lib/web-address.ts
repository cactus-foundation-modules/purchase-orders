// One job: take a web address somebody typed into a box and hand back something
// safe to put in an href, or nothing at all.
//
// It lives on its own, with no zod and no imports, because the supplier's panel
// is a client component and pulling a validation library into their bundle to
// tidy one string would be daft.
//
// Two problems it exists to solve, and the second is the one that matters:
//
//  1. A supplier types dpd.co.uk/track/1. That is a web address to everybody
//     except a URL parser, and telling them their own tracking page "does not
//     look like a web address" is how they give up and email it instead.
//  2. `new URL()` is perfectly happy with javascript: and data:, and so is
//     zod's .url(). This string ends up as the href of a link somebody in the
//     office clicks, on a page behind their login, and the person who typed it
//     is outside the building. http and https, or nothing.

/**
 * @param raw What they typed, or nothing.
 * @returns A normalised http(s) address, or null if it is blank or is not one.
 */
export function webAddress(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return null

  // A bare host means https. Anything already carrying a scheme keeps it, and
  // then has to survive the check below.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  // A scheme bolted on can push a long paste past what the column takes.
  if (url.href.length > 500) return null
  return url.href
}

/** What to say when it is not one. Same words on both forms that take one. */
export const WEB_ADDRESS_MESSAGE =
  'That tracking link does not look like a web address. It wants to start with https://'
