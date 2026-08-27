// What counts as a supplier's invoice, and how we decide.
//
// Client-safe on purpose. The screen runs these checks before it uploads
// anything, and the route runs them again on the bytes - so this file must not
// reach for the media library, the environment or anything else that only
// exists on the server. `lib/bill-attachment.ts` is the half that does, and it
// imports this rather than the other way about: a client component pulling in a
// module that touches server code drags the whole graph into the browser bundle.
//
// It is a structural twin of the check the books keep for their receipts, and
// deliberately a copy: this module never imports from
// '@/modules/uk-bookkeeping/...', a directory that does not exist at build time
// on a site without it.

export const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const
export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number]

const BY_EXTENSION: Record<string, AllowedMimeType> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

export const MAX_BILL_ATTACHMENT_BYTES = 15 * 1024 * 1024

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
}

export function typeForFilename(filename: string): AllowedMimeType | null {
  return BY_EXTENSION[extensionOf(filename)] ?? null
}

/** iPhone photos arrive as HEIC and are worth their own sentence, because the
 *  answer is a camera setting rather than anything to do with this screen. */
export function isHeic(filename: string, mimeType: string): boolean {
  const extension = extensionOf(filename)
  return extension === 'heic' || extension === 'heif' || /image\/hei[cf]/i.test(mimeType)
}

export const HEIC_MESSAGE =
  'iPhone photos in HEIC format are not accepted. Share the photo as a JPEG, or change Camera settings to Most Compatible, then try again.'

/** What the browser can decide before uploading anything. The same rules run
 *  again at the route, because a check only the browser does is not a check. */
export function preflightFileError(file: {
  name: string
  type: string
  size: number
}): string | null {
  if (isHeic(file.name, file.type)) return HEIC_MESSAGE
  if (!typeForFilename(file.name)) {
    return `“${file.name}” is not a kind of file we can keep. Use a PDF, JPEG, PNG or WebP.`
  }
  if (file.size > MAX_BILL_ATTACHMENT_BYTES) {
    return `“${file.name}” is ${formatSize(file.size)}. The most one invoice can be is ${formatSize(MAX_BILL_ATTACHMENT_BYTES)}.`
  }
  if (file.size === 0) return `“${file.name}” is empty.`
  return null
}

/**
 * The bytes, checked against what the name claims.
 *
 * A .pdf that is really something else passes every name-based check ever
 * written. WebP is the fiddly one: it is a RIFF container, so "RIFF" at 0 and
 * "WEBP" at 8 both have to be there.
 *
 * Takes a Uint8Array rather than a Buffer so this file stays runnable anywhere:
 * a Buffer IS a Uint8Array, so the route passes one straight in.
 */
export function sniffMimeType(bytes: Uint8Array): AllowedMimeType | null {
  if (bytes.length < 12) return null
  const text = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))

  if (text(0, 5) === '%PDF-') return 'application/pdf'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x89 && text(1, 4) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a) {
    return 'image/png'
  }
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp'
  return null
}
