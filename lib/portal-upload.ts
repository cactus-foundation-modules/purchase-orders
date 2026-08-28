import { getActiveMediaProvider, isMediaProviderConfigured } from '@/lib/config/env'
import { getOrCreateFolderByPath, resolveFolderPath } from '@/lib/media/organise'
import { saveMediaRecord, uploadMedia, validateNonImageUpload } from '@/lib/media/upload'
import {
  MAX_BILL_ATTACHMENT_BYTES,
  preflightFileError,
  sniffMimeType,
  typeForFilename,
  type AllowedMimeType,
} from './bill-file-kinds'

// A file arriving through the SUPPLIER's own link.
//
// This is the only place on the platform where somebody with no account at all
// can put bytes on the site, so it is worth being blunt about what stands
// between them and the media library:
//
//  - the link itself, which is 32 random bytes and scoped to one order;
//  - the portal rate limiter, per token and per address;
//  - the same two-stage file check the supplier-invoice upload uses - the name
//    has to be one of four kinds, and then the BYTES have to agree with the name
//    (lib/bill-file-kinds.ts, magic bytes, client-safe and run again here);
//  - a size cap;
//  - and the owner's own switch in settings, which turns the whole thing off.
//
// There is NO virus scanning anywhere in Cactus and this does not invent any.
// Files are stored, not executed, and type-sniffed. That is the extent of it and
// it is said plainly on the screen and in the wiki.
//
// The bytes come through the server rather than going straight to storage: the
// media Worker's direct upload path types a file from its object key and accepts
// only raster images and 3D models, so a PDF sent that way is refused outright -
// and a proforma is nearly always a PDF.

/** What a supplier may send us, and where it gets filed. */
export const PORTAL_FILE_KINDS = ['proforma', 'acknowledgement'] as const
export type PortalFileKind = (typeof PORTAL_FILE_KINDS)[number]

const FOLDERS: Record<PortalFileKind, string[]> = {
  proforma: ['Purchasing', 'Proforma invoices'],
  acknowledgement: ['Purchasing', 'Order acknowledgements'],
}

/** Smaller than the bill attachment's cap. A proforma is a page or two of PDF;
 *  fifteen megabytes of it is a scanner nobody has configured, and this is an
 *  unauthenticated door. */
export const MAX_PORTAL_UPLOAD_BYTES = Math.min(8 * 1024 * 1024, MAX_BILL_ATTACHMENT_BYTES)

export type PortalUploadRefusal = { ok: false; reason: string; status: number }
export type PortalUploadAccepted = {
  ok: true
  buffer: Buffer
  mimeType: AllowedMimeType
  filename: string
}

/** Never throws: every refusal is a sentence a supplier can act on, and the
 *  route turns it straight into a message on their screen. */
export async function readPortalUpload(
  file: unknown,
): Promise<PortalUploadRefusal | PortalUploadAccepted> {
  if (!(file instanceof File)) return { ok: false, reason: 'No file was sent.', status: 400 }

  const preflight = preflightFileError(file)
  if (preflight) return { ok: false, reason: preflight, status: 400 }
  if (file.size > MAX_PORTAL_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: `That file is bigger than the ${Math.round(MAX_PORTAL_UPLOAD_BYTES / 1024 / 1024)} MB we can take through this page. Email it to us instead.`,
      status: 400,
    }
  }

  const claimed = typeForFilename(file.name)!
  const buffer = Buffer.from(await file.arrayBuffer())

  // The bytes decide, not the name.
  if (sniffMimeType(buffer) !== claimed) {
    return {
      ok: false,
      reason: `“${file.name}” is not really a ${claimed.split('/')[1]?.toUpperCase()} file. Nothing has been saved.`,
      status: 400,
    }
  }

  const validation = await validateNonImageUpload(claimed, buffer.length, {
    allowedMimeTypes: [claimed],
    maxSizeBytes: MAX_PORTAL_UPLOAD_BYTES,
  })
  if (!validation.valid) {
    return { ok: false, reason: validation.reason ?? 'That file was refused.', status: 400 }
  }

  return { ok: true, buffer, mimeType: claimed, filename: file.name }
}

export type StoredPortalUpload = { ok: true; mediaId: string } | PortalUploadRefusal

/**
 * Put the bytes where the site keeps its media and record them in the library.
 *
 * Filed under Purchasing / Proforma invoices / <order number> (or Order
 * acknowledgements), so what a supplier sent is browsable in Media beside the
 * order it belongs to rather than being a heap of files only this module can
 * see. The order carries the library id and nothing else, and
 * lib/media-usage-provider.ts stops the library ever offering one of these up as
 * clutter.
 *
 * `uploadedById` is deliberately left off: a supplier is not a user of this
 * site, and putting somebody else's id against their file would be a lie in the
 * one column that says who to ask about it.
 */
export async function storePortalUpload(
  accepted: PortalUploadAccepted,
  kind: PortalFileKind,
  orderNumber: string,
): Promise<StoredPortalUpload> {
  const provider = await getActiveMediaProvider()
  if (!provider || !isMediaProviderConfigured(provider)) {
    return {
      ok: false,
      reason: 'We cannot take files on this page at the moment. Email it to us instead and we will file it.',
      status: 503,
    }
  }

  const folderId = await getOrCreateFolderByPath([...FOLDERS[kind], orderNumber])
  const folderPath = folderId ? await resolveFolderPath(folderId) : ''

  const result = await uploadMedia(
    accepted.buffer,
    accepted.mimeType,
    provider,
    accepted.filename,
    folderPath || undefined,
  )
  const record = await saveMediaRecord({
    key: result.key,
    url: result.url,
    provider,
    mimeType: result.mimeType,
    sizeBytes: result.sizeBytes,
    originalName: accepted.filename || undefined,
    folderId,
  })

  if (!record?.id) {
    return {
      ok: false,
      reason: 'The file went to storage but could not be filed. Try again, or email it to us.',
      status: 500,
    }
  }
  return { ok: true, mediaId: record.id }
}
