import { NextRequest, NextResponse } from 'next/server'
import { runExtraction } from '@/lib/extract'
import { supabase } from '@/lib/supabase'

async function handler(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Check backlog before processing so we know whether to chain immediately
    const { count: backlog } = await supabase
      .from('inbox_emails')
      .select('id', { count: 'exact', head: true })
      .eq('booking_extracted', false)
      .throwOnError()

    const result = await runExtraction()

    // If there is still a backlog, chain the next run immediately rather than
    // waiting for the next scheduled tick — 1 s delay, fire and forget
    if ((backlog ?? 0) > 0) {
      setTimeout(() => {
        fetch('https://pureluxe-inbox.vercel.app/api/cron/extract', {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + process.env.CRON_SECRET },
        }).catch(() => {})
      }, 1000)
    }

    return NextResponse.json({ ...result, backlog: backlog ?? 0 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export const GET  = handler
export const POST = handler
