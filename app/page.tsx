'use client'

import { useState, useEffect, useCallback } from 'react'
import type { ClassifiedEmail, InboxStats } from '@/types'

const CATEGORY_CONFIG = {
  all:      { label: 'All',       color: '#8B7355' },
  booking:  { label: 'Bookings',  color: '#B89A5A' },
  client:   { label: 'Clients',   color: '#4A7C9E' },
  supplier: { label: 'Suppliers', color: '#2E7D52' },
  finance:  { label: 'Finance',   color: '#7B5EA7' },
  pre_stay: { label: 'Pre-stay',  color: '#C07B2E' },
  ops:      { label: 'Ops',       color: '#5A6B7A' },
  dispute:  { label: 'Disputes',  color: '#B84444' },
  noise:    { label: 'Noise',     color: '#4A4438' },
  action:   { label: 'Action',    color: '#C85A1A' },
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: '#C85A1A', high: '#B89A5A',
  normal: '#4A7C9E', low: '#4A4438', none: 'transparent',
}

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const diff = Math.floor((now.getTime() - d.getTime()) / 60000)
  if (diff < 1) return 'just now'
  if (diff < 60) return `${diff}m ago`
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`
  return `${Math.floor(diff / 1440)}d ago`
}

function initials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
}

function formatAmount(amount: number, currency: string): string {
  const symbols: Record<string, string> = {
    USD:'$', EUR:'€', GBP:'£', THB:'฿', JPY:'¥', INR:'₹', IDR:'IDR ',
  }
  return `${symbols[currency] || currency + ' '}${amount.toLocaleString()}`
}

export default function InboxPage() {
  const [emails, setEmails] = useState<ClassifiedEmail[]>([])
  const [stats, setStats] = useState<InboxStats | null>(null)
  const [activeCategory, setActiveCategory] = useState('all')
  const [selectedEmail, setSelectedEmail] = useState<ClassifiedEmail | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncStatus, setSyncStatus] = useState('Not synced yet')
  const [backfilling, setBackfilling] = useState(false)
  const [backfillStatus, setBackfillStatus] = useState<string | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [extractStatus, setExtractStatus] = useState<string | null>(null)
  // Fix 1+2: no tokens in state — auth is handled by session cookie server-side
  const [connected, setConnected] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const loadEmails = useCallback(async () => {
    const res = await fetch('/api/emails?category=all&limit=200')
    if (!res.ok) return
    const data = await res.json()
    setEmails(data.emails || [])
    setStats(data.stats || null)
  }, [])

  const handleSync = useCallback(async () => {
    setSyncing(true)
    setSyncStatus('Fetching emails...')
    try {
      // Fix 1+2: no tokens sent in body — server reads from session cookie
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxResults: 50 }),
      })
      if (res.status === 401) {
        setConnected(false)
        setSyncStatus('Session expired — reconnect Gmail')
        return
      }
      const result = await res.json()
      if (!res.ok) throw new Error(result.error)
      await loadEmails()
      setSyncStatus(`Last synced · ${result.classified} new · ${result.total} total`)
    } catch (err: any) {
      setSyncStatus(`Error: ${err.message}`)
    } finally {
      setSyncing(false)
    }
  }, [loadEmails])

  // Fix 13: proper effect-based auto-sync instead of arbitrary setTimeout
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const isConnected = params.get('connected') === '1'
    const hasError = params.get('error')

    if (hasError) {
      setSyncStatus(`Auth error: ${hasError}`)
    }

    if (isConnected) {
      setConnected(true)
      window.history.replaceState({}, '', window.location.pathname)
    } else {
      // Check if already connected (session cookie exists)
      fetch('/api/sync', { method: 'GET' })
        .then(r => { if (r.ok) setConnected(true) })
        .catch(() => {})
    }
  }, [])

  // Auto-sync when connected state becomes true
  useEffect(() => {
    if (connected && emails.length === 0) {
      handleSync()
    }
  }, [connected]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleBackfill = useCallback(async () => {
    setBackfilling(true)
    setBackfillStatus(null)
    try {
      const res = await fetch('/api/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxTotal: 200 }),
      })
      if (res.status === 401) {
        setConnected(false)
        setBackfillStatus('Session expired — reconnect Gmail')
        return
      }
      const result = await res.json()
      if (!res.ok) throw new Error(result.error)
      await loadEmails()
      setBackfillStatus(`Backfilled ${result.classified} emails`)
    } catch (err: any) {
      setBackfillStatus(`Error: ${err.message}`)
    } finally {
      setBackfilling(false)
    }
  }, [loadEmails])

  const handleExtract = useCallback(async () => {
    setExtracting(true)
    setExtractStatus(null)
    try {
      const res = await fetch('/api/admin/extract', { method: 'POST' })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error)
      if (result.processed === 0) {
        setExtractStatus('No bookings to extract')
      } else {
        setExtractStatus(`Extracted ${result.inserted + result.updated} bookings · ${result.skipped} skipped`)
      }
    } catch (err: any) {
      setExtractStatus(`Error: ${err.message}`)
    } finally {
      setExtracting(false)
    }
  }, [])

  const handleConnect = async () => {
    const res = await fetch('/api/auth')
    const { url } = await res.json()
    window.location.href = url
  }

  const filtered = emails.filter(e => {
    const matchCat = activeCategory === 'all' ? true
      : activeCategory === 'action' ? e.actionRequired
      : e.tags.includes(activeCategory as any)
    const matchSearch = searchQuery
      ? e.subject.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.fromName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.summary.toLowerCase().includes(searchQuery.toLowerCase())
      : true
    return matchCat && matchSearch
  })

  return (
    <div style={{ minHeight:'100vh', background:'#0F0F0D', color:'#E8E0D4', fontFamily:"var(--font-crimson, 'Georgia', serif)", display:'flex', flexDirection:'column' }}>
      <header style={{ borderBottom:'1px solid #2A2820', padding:'0 2rem', height:56, display:'flex', alignItems:'center', justifyContent:'space-between', background:'#0F0F0D', position:'sticky', top:0, zIndex:100 }}>
        <div style={{ display:'flex', alignItems:'center', gap:16 }}>
          <span style={{ fontFamily:"var(--font-playfair, serif)", fontSize:18, letterSpacing:'0.12em', color:'#B89A5A', fontWeight:400 }}>PURELUXE</span>
          <span style={{ color:'#2A2820', fontSize:20 }}>|</span>
          <span style={{ fontSize:13, color:'#6B6558', letterSpacing:'0.08em' }}>INBOX INTELLIGENCE</span>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color:'#6B6558' }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background: syncing ? '#B89A5A' : connected ? '#2E7D52' : '#6B6558' }} />
            {syncStatus}
          </div>
          {connected && (
            <>
              {extractStatus && (
                <span style={{ fontSize:11, color:'#4A4438' }}>{extractStatus}</span>
              )}
              {backfillStatus && (
                <span style={{ fontSize:11, color:'#4A4438' }}>{backfillStatus}</span>
              )}
              <button onClick={handleExtract} disabled={extracting || backfilling || syncing} style={{ padding:'6px 14px', fontSize:12, borderRadius:4, border:'1px solid #2A2820', background:'transparent', color: extracting ? '#4A4438' : '#6B6558', cursor: extracting || backfilling || syncing ? 'not-allowed':'pointer', letterSpacing:'0.06em', opacity: extracting || backfilling || syncing ? 0.5:1 }}>
                {extracting ? 'Extracting...' : 'Extract bookings'}
              </button>
              <button onClick={handleBackfill} disabled={backfilling || syncing || extracting} style={{ padding:'6px 14px', fontSize:12, borderRadius:4, border:'1px solid #2A2820', background:'transparent', color: backfilling ? '#4A4438' : '#6B6558', cursor: backfilling || syncing || extracting ? 'not-allowed':'pointer', letterSpacing:'0.06em', opacity: backfilling || syncing || extracting ? 0.5:1 }}>
                {backfilling ? 'Backfilling...' : 'Backfill inbox'}
              </button>
              <button onClick={handleSync} disabled={syncing || backfilling || extracting} style={{ padding:'6px 14px', fontSize:12, borderRadius:4, border:'1px solid #2A2820', background:'transparent', color:'#B89A5A', cursor: syncing || backfilling || extracting ? 'not-allowed':'pointer', letterSpacing:'0.06em', opacity: syncing || backfilling || extracting ? 0.5:1 }}>
                {syncing ? 'Syncing...' : 'Sync inbox'}
              </button>
            </>
          )}
          {!connected && (
            <button onClick={handleConnect} style={{ padding:'6px 16px', fontSize:12, borderRadius:4, border:'1px solid #B89A5A', background:'#B89A5A', color:'#0F0F0D', cursor:'pointer', letterSpacing:'0.06em', fontWeight:600 }}>
              Connect Gmail
            </button>
          )}
        </div>
      </header>

      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
        <aside style={{ width:220, borderRight:'1px solid #2A2820', padding:'1.5rem 0', display:'flex', flexDirection:'column', gap:4, overflowY:'auto' }}>
          {stats && (
            <div style={{ padding:'0 1rem 1rem', borderBottom:'1px solid #2A2820', marginBottom:8 }}>
              <div style={{ fontSize:11, color:'#4A4438', letterSpacing:'0.1em', marginBottom:8 }}>OVERVIEW</div>
              {[
                { label:'Total', value:stats.total },
                { label:'Unread', value:stats.unread },
                { label:'Action needed', value:stats.actionRequired, hi:true },
                { label:'Urgent', value:stats.urgent, hi: stats.urgent > 0 },
              ].map(s => (
                <div key={s.label} style={{ display:'flex', justifyContent:'space-between', fontSize:12, color: s.hi && s.value > 0 ? '#C85A1A':'#8B7355', marginBottom:3 }}>
                  <span>{s.label}</span>
                  <span style={{ fontFamily:'monospace' }}>{s.value}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ padding:'0 0.5rem' }}>
            <div style={{ fontSize:11, color:'#4A4438', letterSpacing:'0.1em', padding:'0 0.5rem', marginBottom:4 }}>CATEGORIES</div>
            {Object.entries(CATEGORY_CONFIG).map(([key, cfg]) => {
              const count = key==='all' ? emails.length : key==='action' ? (stats?.actionRequired||0) : ((stats?.byCategory as any)?.[key]||0)
              return (
                <button key={key} onClick={() => setActiveCategory(key)} style={{ width:'100%', textAlign:'left', padding:'6px 8px', borderRadius:4, border:'none', background: activeCategory===key ? '#1A1814':'transparent', color: activeCategory===key ? cfg.color:'#6B6558', cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:13 }}>
                  <span style={{ display:'flex', alignItems:'center', gap:6 }}>
                    <span style={{ width:6, height:6, borderRadius:'50%', background: activeCategory===key ? cfg.color:'#2A2820' }} />
                    {cfg.label}
                  </span>
                  {count > 0 && <span style={{ fontSize:11, fontFamily:'monospace', color: activeCategory===key ? cfg.color:'#4A4438' }}>{count}</span>}
                </button>
              )
            })}
          </div>
        </aside>

        <main style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', borderRight: selectedEmail ? '1px solid #2A2820':'none' }}>
          <div style={{ padding:'1rem 1.5rem', borderBottom:'1px solid #2A2820' }}>
            <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search emails..." style={{ width:'100%', padding:'8px 12px', background:'#1A1814', border:'1px solid #2A2820', borderRadius:4, color:'#E8E0D4', fontSize:13, outline:'none', fontFamily:'inherit' }} />
          </div>
          <div style={{ flex:1, overflowY:'auto' }}>
            {!connected && (
              <div style={{ padding:'4rem 2rem', textAlign:'center', color:'#4A4438' }}>
                <div style={{ fontSize:32, marginBottom:12, opacity:0.3 }}>✉</div>
                <div style={{ fontSize:14, marginBottom:4 }}>Connect your Gmail to get started</div>
                <div style={{ fontSize:12, color:'#2A2820' }}>Your inbox will be classified and analysed automatically</div>
              </div>
            )}
            {connected && emails.length===0 && !syncing && (
              <div style={{ padding:'4rem 2rem', textAlign:'center', color:'#4A4438' }}>
                <div style={{ fontSize:14 }}>Click &ldquo;Sync inbox&rdquo; to read your emails</div>
              </div>
            )}
            {syncing && emails.length===0 && (
              <div style={{ padding:'4rem 2rem', textAlign:'center', color:'#4A4438' }}>
                <div style={{ fontSize:14, marginBottom:8 }}>Reading and classifying your inbox...</div>
                <div style={{ fontSize:12 }}>~30–60 seconds for 50 emails</div>
              </div>
            )}
            {filtered.map(email => (
              <EmailRow key={email.id} email={email} selected={selectedEmail?.id===email.id}
                onClick={() => setSelectedEmail(selectedEmail?.id===email.id ? null : email)} />
            ))}
          </div>
        </main>

        {selectedEmail && <DetailPanel email={selectedEmail} onClose={() => setSelectedEmail(null)} />}
      </div>

      <style>{`
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2A2820; border-radius: 2px; }
      `}</style>
    </div>
  )
}

function EmailRow({ email, selected, onClick }: { email: ClassifiedEmail; selected: boolean; onClick: () => void }) {
  const cat = CATEGORY_CONFIG[email.category as keyof typeof CATEGORY_CONFIG]
  const pc = PRIORITY_COLORS[email.actionPriority] || 'transparent'
  return (
    <div onClick={onClick} style={{ padding:'12px 1.5rem', borderBottom:'1px solid #1A1814', cursor:'pointer', background: selected ? '#1A1814':'transparent', borderLeft:`2px solid ${email.actionRequired ? pc:'transparent'}`, transition:'background 0.1s' }}
      onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLElement).style.background='#141210' }}
      onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLElement).style.background='transparent' }}>
      <div style={{ display:'flex', alignItems:'flex-start', gap:10 }}>
        <div style={{ width:32, height:32, borderRadius:'50%', background:'#1A1814', border:`1px solid ${cat?.color||'#2A2820'}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, color:cat?.color||'#8B7355', flexShrink:0, fontFamily:'monospace' }}>
          {initials(email.fromName)}
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
            <span style={{ fontSize:13, fontWeight: email.unread ? 600:400, color: email.unread ? '#E8E0D4':'#8B7355', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:'70%' }}>{email.fromName}</span>
            <span style={{ fontSize:11, color:'#4A4438', flexShrink:0 }}>{timeAgo(email.date)}</span>
          </div>
          <div style={{ fontSize:13, color: email.unread ? '#C8B896':'#6B6558', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', marginBottom:4 }}>{email.subject}</div>
          <div style={{ fontSize:12, color:'#4A4438', fontStyle:'italic', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', marginBottom:6 }}>{email.summary}</div>
          <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
            {email.tags.slice(0,3).map(tag => {
              const c = CATEGORY_CONFIG[tag as keyof typeof CATEGORY_CONFIG]
              return <span key={tag} style={{ fontSize:10, padding:'1px 6px', borderRadius:20, background:`${c?.color||'#8B7355'}15`, color:c?.color||'#8B7355', border:`1px solid ${c?.color||'#8B7355'}30`, letterSpacing:'0.04em' }}>{c?.label||tag}</span>
            })}
            {email.actionRequired && <span style={{ fontSize:10, padding:'1px 6px', borderRadius:20, background:`${pc}15`, color:pc, border:`1px solid ${pc}30` }}>{email.actionPriority==='urgent' ? '⚡ urgent':'action needed'}</span>}
            {email.booking?.totalAmount && <span style={{ fontSize:10, padding:'1px 6px', borderRadius:20, background:'#B89A5A15', color:'#B89A5A', border:'1px solid #B89A5A30' }}>{formatAmount(email.booking.totalAmount, email.booking.currency||'USD')}</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

function DetailPanel({ email, onClose }: { email: ClassifiedEmail; onClose: () => void }) {
  const cat = CATEGORY_CONFIG[email.category as keyof typeof CATEGORY_CONFIG]
  const pc = PRIORITY_COLORS[email.actionPriority] || '#9A9A9A'
  return (
    <div style={{ width:380, overflowY:'auto', padding:'1.5rem', display:'flex', flexDirection:'column', gap:16 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
        <div style={{ fontSize:10, letterSpacing:'0.1em', color:cat?.color||'#8B7355', padding:'2px 8px', border:`1px solid ${cat?.color||'#8B7355'}40`, borderRadius:20 }}>{(cat?.label||email.category).toUpperCase()}</div>
        <button onClick={onClose} style={{ background:'none', border:'none', color:'#4A4438', cursor:'pointer', fontSize:18, lineHeight:1 }}>×</button>
      </div>
      <h2 style={{ fontSize:16, fontWeight:400, color:'#E8E0D4', lineHeight:1.4, fontFamily:"var(--font-playfair, serif)" }}>{email.subject}</h2>
      <div style={{ fontSize:12, color:'#6B6558', display:'flex', flexDirection:'column', gap:3 }}>
        <div><span style={{ color:'#4A4438' }}>From: </span>{email.fromName} &lt;{email.from}&gt;</div>
        <div><span style={{ color:'#4A4438' }}>Date: </span>{new Date(email.date).toLocaleString()}</div>
        {email.to.length>0 && <div><span style={{ color:'#4A4438' }}>To: </span>{email.to.join(', ')}</div>}
      </div>
      <div style={{ padding:'12px', background:'#1A1814', borderRadius:6, borderLeft:`2px solid ${cat?.color||'#B89A5A'}` }}>
        <div style={{ fontSize:10, color:'#4A4438', letterSpacing:'0.08em', marginBottom:4 }}>AI SUMMARY</div>
        <div style={{ fontSize:13, color:'#C8B896', fontStyle:'italic', lineHeight:1.5 }}>{email.summary}</div>
      </div>
      {email.actionRequired && email.actionDescription && (
        <div style={{ padding:'12px', background:`${pc}10`, border:`1px solid ${pc}30`, borderRadius:6 }}>
          <div style={{ fontSize:10, letterSpacing:'0.08em', color:pc, marginBottom:4 }}>{email.actionPriority.toUpperCase()} ACTION REQUIRED</div>
          <div style={{ fontSize:13, color:'#E8E0D4', lineHeight:1.5 }}>{email.actionDescription}</div>
        </div>
      )}
      {email.booking && (
        <Section title="Booking Details" color="#B89A5A">
          <DataGrid rows={[
            ['Client', email.booking.clientName],['Property', email.booking.property],
            ['Check-in', email.booking.checkIn],['Check-out', email.booking.checkOut],
            ['Nights', email.booking.nights],['Rooms', email.booking.rooms],
            ['Room type', email.booking.roomType],['Programme', email.booking.programme],
            ['Status', email.booking.status],['Conf. no.', email.booking.confirmationNumber],
            ['GDS ref', email.booking.gdsRef],
            ['Total', email.booking.totalAmount ? formatAmount(email.booking.totalAmount, email.booking.currency||'') : null],
            ['Net', email.booking.netAmount ? formatAmount(email.booking.netAmount, email.booking.currency||'') : null],
            ['Commission', email.booking.commissionRate ? `${email.booking.commissionRate}%` : null],
            ['Payment', email.booking.paymentStatus],['Cxl deadline', email.booking.cancellationDeadline],
          ]} />
        </Section>
      )}
      {email.finance?.amount && (
        <Section title="Financial" color="#7B5EA7">
          <DataGrid rows={[
            ['Type', email.finance.type],
            ['Amount', formatAmount(email.finance.amount, email.finance.currency||'')],
            ['Reference', email.finance.reference],['Due date', email.finance.dueDate],
          ]} />
        </Section>
      )}
      {email.supplierContact?.name && (
        <Section title="Supplier Contact" color="#2E7D52">
          <DataGrid rows={[
            ['Name', email.supplierContact.name],['Email', email.supplierContact.email],
            ['Property', email.supplierContact.property],['Consortium', email.supplierContact.consortium],
          ]} />
        </Section>
      )}
      <Section title="Preview" color="#4A4438">
        <div style={{ fontSize:12, color:'#6B6558', lineHeight:1.6 }}>{email.snippet}</div>
      </Section>
    </div>
  )
}

function Section({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return (
    <div style={{ border:'1px solid #2A2820', borderRadius:6, overflow:'hidden' }}>
      <div style={{ padding:'6px 12px', background:'#1A1814', fontSize:10, letterSpacing:'0.08em', color, borderBottom:'1px solid #2A2820' }}>{title.toUpperCase()}</div>
      <div style={{ padding:'10px 12px' }}>{children}</div>
    </div>
  )
}

function DataGrid({ rows }: { rows: [string, any][] }) {
  const visible = rows.filter(([, v]) => v !== null && v !== undefined && v !== '')
  if (!visible.length) return null
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
      {visible.map(([label, value]) => (
        <div key={label} style={{ display:'flex', gap:8, fontSize:12 }}>
          <span style={{ color:'#4A4438', minWidth:100, flexShrink:0 }}>{label}</span>
          <span style={{ color:'#C8B896' }}>{String(value)}</span>
        </div>
      ))}
    </div>
  )
}
