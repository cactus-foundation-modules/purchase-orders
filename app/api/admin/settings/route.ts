import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getPoConfig, PoConfigSchema, updatePoConfig } from '@/modules/purchase-orders/lib/config'
import { getCapabilities } from '@/modules/purchase-orders/lib/capabilities'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'

// The settings screen is also where the module says what it can and cannot do on
// this install, so the capabilities ride along with the config rather than
// needing a second round trip.
export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canSettings) return errorResponse('Forbidden', 403)

  const [config, capabilities] = await Promise.all([getPoConfig(), getCapabilities()])
  return NextResponse.json({ config, capabilities })
}

export async function PATCH(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canSettings) return errorResponse('Forbidden', 403)

  const parsed = PoConfigSchema.partial().safeParse(await request.json())
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const config = await updatePoConfig(parsed.data)
  await recordAudit('settings', 'singleton', 'settings.updated', { keys: Object.keys(parsed.data) }, user.id)
  return NextResponse.json({ config })
}
