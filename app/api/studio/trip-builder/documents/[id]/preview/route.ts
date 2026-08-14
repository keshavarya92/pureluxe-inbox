import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { getDocumentPreviewHtml } from '@/lib/trip-builder/document-generator'

// GET — serves the stored HTML inline (not a signed-URL redirect), so it
// stays behind the normal session check and can be embedded directly in an
// iframe for the sidebar preview.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getStudioUser()
  if (!user) return new NextResponse('Unauthorized', { status: 401 })

  const { id } = await params

  try {
    const html = await getDocumentPreviewHtml(id)
    return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
