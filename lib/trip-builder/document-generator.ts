// Orchestrates the document generation service (build brief step 8, plus
// the preview/PDF UI addition): assemble input from the DB, build all
// three output formats from that one assembly, store them, and record the
// trip_documents row with the staleness baseline. Uses the same
// computeContentLastUpdatedAt as the sidebar's staleness display, so a
// freshly generated document is guaranteed not to read as stale until
// something on the trip actually changes after it.
//
// Word (.docx) and the HTML/PDF pair are two independent renderers reading
// the SAME assembled TripDocumentData — docx-builder.ts is the original,
// reviewed-format port; html-builder.ts is the newer branded-HTML source
// that both the sidebar preview and the PDF (printed from that HTML via
// headless Chromium) share. All three live at one shared storage basename,
// differing only by extension — trip_documents.file_path stores the .docx
// path (unchanged column/convention); the .html/.pdf siblings are derived
// by swapping the extension, not tracked in separate columns.

import { supabase } from '../supabase'
import { assembleDocumentData } from './document-assembler'
import { buildTripDocumentBuffer } from './docx-builder'
import { buildTripDocumentHtml } from './html-builder'
import { renderHtmlToPdf } from './pdf-renderer'
import { getTripState, computeContentLastUpdatedAt } from './queries'
import type { TripDocument } from './queries'

const STORAGE_BUCKET = 'trip-documents'

function siblingPath(docxPath: string, extension: 'html' | 'pdf'): string {
  return docxPath.replace(/\.docx$/, `.${extension}`)
}

export async function generateDocument(
  tripId: string,
  type:   'itinerary' | 'rate_sheet',
): Promise<{ document: TripDocument; warnings: string[] }> {
  const [{ data, warnings }, state] = await Promise.all([
    assembleDocumentData(tripId, type),
    getTripState(tripId),
  ])

  const html = buildTripDocumentHtml(data)
  const [docxBuffer, pdfBuffer] = await Promise.all([
    buildTripDocumentBuffer(data),
    renderHtmlToPdf(html),
  ])
  const sourceUpdatedAt = computeContentLastUpdatedAt(state.itinerary_days, state.line_items) ?? new Date().toISOString()

  const docxPath = `${tripId}/${type}-${Date.now()}.docx`
  const htmlPath = siblingPath(docxPath, 'html')
  const pdfPath  = siblingPath(docxPath, 'pdf')

  const uploads = await Promise.all([
    supabase.storage.from(STORAGE_BUCKET).upload(docxPath, docxBuffer, {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      upsert: true,
    }),
    supabase.storage.from(STORAGE_BUCKET).upload(htmlPath, html, {
      contentType: 'text/html',
      upsert: true,
    }),
    supabase.storage.from(STORAGE_BUCKET).upload(pdfPath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    }),
  ])
  const uploadErr = uploads.find(u => u.error)?.error
  if (uploadErr) throw new Error(`generateDocument upload: ${uploadErr.message}`)

  const { data: doc, error: insertErr } = await supabase
    .from('trip_documents')
    .insert({
      trip_id:           tripId,
      type,
      file_path:         docxPath,
      source_updated_at: sourceUpdatedAt,
    })
    .select()
    .single()
  if (insertErr) throw new Error(`generateDocument insert: ${insertErr.message}`)

  return { document: doc, warnings }
}

async function getDocxPath(documentId: string): Promise<string> {
  const { data: doc, error } = await supabase
    .from('trip_documents')
    .select('file_path')
    .eq('id', documentId)
    .maybeSingle()
  if (error) throw new Error(`getDocxPath: ${error.message}`)
  if (!doc) throw new Error(`document not found: ${documentId}`)
  return doc.file_path
}

export async function getDocumentDownloadUrl(
  documentId: string,
  format:     'docx' | 'pdf' = 'docx',
): Promise<{ url: string; filename: string }> {
  const docxPath = await getDocxPath(documentId)
  const path = format === 'pdf' ? siblingPath(docxPath, 'pdf') : docxPath

  const { data: signed, error: signErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(path, 300) // 5 minutes — generated on demand, not cached
  if (signErr) throw new Error(`getDocumentDownloadUrl sign: ${signErr.message}`)

  return { url: signed.signedUrl, filename: path.split('/').pop() ?? `document.${format}` }
}

// Fetches the stored HTML directly (not a signed-URL redirect) so the
// preview endpoint can serve it inline behind the normal session auth
// check, without handing out a separate signed storage URL just to render
// an iframe.
export async function getDocumentPreviewHtml(documentId: string): Promise<string> {
  const docxPath = await getDocxPath(documentId)
  const htmlPath = siblingPath(docxPath, 'html')

  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(htmlPath)
  if (error) throw new Error(`getDocumentPreviewHtml: ${error.message}`)
  return data.text()
}
