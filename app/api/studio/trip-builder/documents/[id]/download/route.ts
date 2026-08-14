import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { getDocumentDownloadUrl } from '@/lib/trip-builder/document-generator'

// GET ?format=docx|pdf (default docx) — redirects to a short-lived signed
// URL for the stored file. Generated on demand rather than a stored public
// URL, since the storage bucket is private (these are confidential client
// rates/itineraries).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const format = req.nextUrl.searchParams.get('format')
  if (format !== null && format !== 'docx' && format !== 'pdf') {
    return NextResponse.json({ error: 'format must be "docx" or "pdf"' }, { status: 400 })
  }

  try {
    const { url } = await getDocumentDownloadUrl(id, format ?? 'docx')
    return NextResponse.redirect(url)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
