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

// The supplier's own invoice, out of a browser and into the site's media.
//
// Core's upload sniff is sharp-based and therefore image-only, which does not
// cover a PDF - and a PDF is what nearly every supplier invoice is. So the
// magic-byte check lives in this module, in `lib/bill-file-kinds.ts`, which is
// the client-safe half of this pair.
//
// The bytes come through the server rather than going straight to storage: the
// media Worker's direct upload path types a file from its object key's
// extension and accepts only raster images and 3D models, so a PDF sent that
// way is refused outright.
//
// There is NO virus scanning anywhere in Cactus and this does not invent any.
// Files are stored, not executed, and type-sniffed. That is the extent of it,
// and it is said plainly on the screen and in the wiki.

export type AttachmentRefusal = { ok: false; reason: string; status: number }
export type AttachmentAccepted = {
  ok: true
  buffer: Buffer
  mimeType: AllowedMimeType
  filename: string
}

/** Never throws: every refusal is a sentence somebody can act on, and the route
 *  turns it straight into a message on the screen. */
export async function readBillUpload(
  form: FormData | null,
): Promise<AttachmentRefusal | AttachmentAccepted> {
  const file = form?.get('file')
  if (!(file instanceof File)) return { ok: false, reason: 'No file was sent.', status: 400 }

  const preflight = preflightFileError(file)
  if (preflight) return { ok: false, reason: preflight, status: 400 }

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
    maxSizeBytes: MAX_BILL_ATTACHMENT_BYTES,
  })
  if (!validation.valid) {
    return { ok: false, reason: validation.reason ?? 'That file was refused.', status: 400 }
  }

  return { ok: true, buffer, mimeType: claimed, filename: file.name }
}

export type StoredAttachment = { ok: true; mediaId: string } | AttachmentRefusal

/**
 * Put the bytes where the site keeps its media and record them in the library.
 *
 * Filed under Purchasing / Supplier invoices / <year of the invoice date>, so a
 * folder of supplier invoices is browsable in Media rather than being a heap of
 * files only this module can see. The bill stores the library id and nothing
 * else; `lib/media-usage-provider.ts` stops the library ever offering one of
 * these up as clutter.
 */
export async function storeBillAttachment(
  accepted: AttachmentAccepted,
  invoiceDate: string,
  uploadedById: string,
): Promise<StoredAttachment> {
  const provider = await getActiveMediaProvider()
  if (!provider || !isMediaProviderConfigured(provider)) {
    return {
      ok: false,
      reason: 'File storage is not set up on this site yet. Add a provider in Settings → Media first.',
      status: 503,
    }
  }

  const year = /^\d{4}/.test(invoiceDate) ? invoiceDate.slice(0, 4) : String(new Date().getUTCFullYear())
  const folderId = await getOrCreateFolderByPath(['Purchasing', 'Supplier invoices', year])
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
    uploadedById,
    originalName: accepted.filename || undefined,
    folderId,
  })

  if (!record?.id) {
    return {
      ok: false,
      reason: 'The file went to storage but could not be filed in your media library.',
      status: 500,
    }
  }
  return { ok: true, mediaId: record.id }
}
