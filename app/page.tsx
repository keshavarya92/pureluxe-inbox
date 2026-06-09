'use client'

import { useState, useEffect, useCallback } from 'react'
import type { ClassifiedEmail } from '@/types'

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const diff = Math.floor((now.getTime() - d.getTime()) / 60000)
  if (diff < 1)    return 'just now'
  if (diff < 60)   return `${diff}m ago`
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`
  return `${Math.floor(diff / 1440)}d ago`
}

function initials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
}

export default function InboxPage() {
  const [emails, setEmails]               = useState<ClassifiedEmail[]>([])
  const [total, setTotal]                 = useState(0)
  const [unread, setUnread]               = useState(0)
  const [selectedEmail, setSelectedEmail] = useState<ClassifiedEmail | null>(null)
  const [syncing, setSyncing]             = useState(false)
  const [syncStatus, setSyncStatus]       = useState('Not synced yet')
  const [backfilling, setBackfilling]     = useState(false)
  const [backfillStatus, setBackfillStatus] = useState<string | null>(null)
  const [extracting, setExtracting]       = useState(false)
  const [extractStatus, setExtractStatus] = useState<string | null>(null)
  const [connected, setConnected]         = useState(false)
  const [searchQuery, setSearchQuery]     = useState('')

  const loadEmails = useCallback(async () => {
    const res = await fetch('/api/emails?category=all&limit=200')
    if (!res.ok) return
    const data = await res.json()
    setEmails(data.emails || [])
    setTotal(data.stats?.total || 0)
    setUnread(data.stats?.unread || 0)
  }, [])

  const handleSync = useCallback(async () => {
    setSyncing(true)
    setSyncStatus('Fetching emails...')
    try {
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
      setSyncStatus(`Synced · ${result.stored} new`)
    } catch (err: any) {
      setSyncStatus(`Error: ${err.message}`)
    } finally {
      setSyncing(false)
    }
  }, [loadEmails])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('error')) setSyncStatus(`Auth error: ${params.get('error')}`)
    if (params.get('connected') === '1') {
      setConnected(true)
      window.history.replaceState({}, '', window.location.pathname)
    } else {
      fetch('/api/sync', { method: 'GET' })
        .then(r => { if (r.ok) setConnected(true) })
        .catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (connected && emails.length === 0) handleSync()
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
      if (res.status === 401) { setConnected(false); setBackfillStatus('Session expired'); return }
      const result = await res.json()
      if (!res.ok) throw new Error(result.error)
      await loadEmails()
      setBackfillStatus(`Backfilled ${result.stored} emails`)
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
      setExtractStatus(
        result.processed === 0
          ? 'Nothing to extract'
          : `Extracted from ${result.processed} emails`,
      )
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

  const q = searchQuery.toLowerCase()
  const filtered = q
    ? emails.filter(e =>
        e.subject.toLowerCase().includes(q) ||
        e.fromName.toLowerCase().includes(q) ||
        e.snippet.toLowerCase().includes(q),
      )
    : emails

  const busy = syncing || backfilling || extracting

  return (
    <div style={{ minHeight:'100vh', background:'#0F0F0D', color:'#E8E0D4', fontFamily:"var(--font-crimson, 'Georgia', serif)", display:'flex', flexDirection:'column' }}>

      {/* Header */}
      <header style={{ borderBottom:'1px solid #2A2820', padding:'0 2rem', height:56, display:'flex', alignItems:'center', justifyContent:'space-between', background:'#0F0F0D', position:'sticky', top:0, zIndex:100 }}>
        <div style={{ display:'flex', alignItems:'center', gap:16 }}>
          <span style={{ fontFamily:"var(--font-playfair, serif)", fontSize:18, letterSpacing:'0.12em', color:'#B89A5A', fontWeight:400 }}>PURELUXE</span>
          <span style={{ color:'#2A2820', fontSize:20 }}>|</span>
          <span style={{ fontSize:13, color:'#6B6558', letterSpacing:'0.08em' }}>INBOX</span>
          {connected && (
            <span style={{ fontSize:11, color:'#4A4438', fontFamily:'monospace' }}>
              {total} total · {unread} unread
            </span>
          )}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color:'#6B6558' }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background: syncing ? '#B89A5A' : connected ? '#2E7D52' : '#6B6558' }} />
            {syncStatus}
          </div>
          {connected && (
            <>
              {(extractStatus || backfillStatus) && (
                <span style={{ fontSize:11, color:'#4A4438' }}>{extractStatus || backfillStatus}</span>
              )}
              <button onClick={handleExtract} disabled={busy} style={btnStyle(busy, '#6B6558')}>
                {extracting ? 'Extracting…' : 'Extract'}
              </button>
              <button onClick={handleBackfill} disabled={busy} style={btnStyle(busy, '#6B6558')}>
                {backfilling ? 'Backfilling…' : 'Backfill'}
              </button>
              <button onClick={handleSync} disabled={busy} style={btnStyle(busy, '#B89A5A')}>
                {syncing ? 'Syncing…' : 'Sync'}
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

      {/* Body */}
      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>

        {/* Email list */}
        <main style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', borderRight: selectedEmail ? '1px solid #2A2820' : 'none' }}>
          <div style={{ padding:'1rem 1.5rem', borderBottom:'1px solid #2A2820' }}>
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search emails…"
              style={{ width:'100%', padding:'8px 12px', background:'#1A1814', border:'1px solid #2A2820', borderRadius:4, color:'#E8E0D4', fontSize:13, outline:'none', fontFamily:'inherit' }}
            />
          </div>
          <div style={{ flex:1, overflowY:'auto' }}>
            {!connected && (
              <div style={{ padding:'4rem 2rem', textAlign:'center', color:'#4A4438' }}>
                <div style={{ fontSize:32, marginBottom:12, opacity:0.3 }}>✉</div>
                <div style={{ fontSize:14, marginBottom:4 }}>Connect your Gmail to get started</div>
              </div>
            )}
            {connected && emails.length === 0 && !syncing && (
              <div style={{ padding:'4rem 2rem', textAlign:'center', color:'#4A4438' }}>
                <div style={{ fontSize:14 }}>Click &ldquo;Sync&rdquo; to load your inbox</div>
              </div>
            )}
            {syncing && emails.length === 0 && (
              <div style={{ padding:'4rem 2rem', textAlign:'center', color:'#4A4438' }}>
                <div style={{ fontSize:14 }}>Fetching emails…</div>
              </div>
            )}
            {filtered.map(email => (
              <EmailRow
                key={email.id}
                email={email}
                selected={selectedEmail?.id === email.id}
                onClick={() => setSelectedEmail(selectedEmail?.id === email.id ? null : email)}
              />
            ))}
          </div>
        </main>

        {selectedEmail && (
          <DetailPanel email={selectedEmail} onClose={() => setSelectedEmail(null)} />
        )}
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

function btnStyle(disabled: boolean, color: string): React.CSSProperties {
  return {
    padding: '6px 14px', fontSize: 12, borderRadius: 4,
    border: `1px solid #2A2820`, background: 'transparent',
    color: disabled ? '#4A4438' : color,
    cursor: disabled ? 'not-allowed' : 'pointer',
    letterSpacing: '0.06em', opacity: disabled ? 0.5 : 1,
  }
}

function EmailRow({ email, selected, onClick }: { email: ClassifiedEmail; selected: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{ padding:'12px 1.5rem', borderBottom:'1px solid #1A1814', cursor:'pointer', background: selected ? '#1A1814' : 'transparent', transition:'background 0.1s' }}
      onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = '#141210' }}
      onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <div style={{ display:'flex', alignItems:'flex-start', gap:10 }}>
        <div style={{ width:32, height:32, borderRadius:'50%', background:'#1A1814', border:'1px solid #2A2820', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, color:'#8B7355', flexShrink:0, fontFamily:'monospace' }}>
          {initials(email.fromName)}
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
            <span style={{ fontSize:13, fontWeight: email.unread ? 600 : 400, color: email.unread ? '#E8E0D4' : '#8B7355', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:'70%' }}>
              {email.fromName}
            </span>
            <span style={{ fontSize:11, color:'#4A4438', flexShrink:0 }}>{timeAgo(email.date)}</span>
          </div>
          <div style={{ fontSize:13, color: email.unread ? '#C8B896' : '#6B6558', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', marginBottom:3 }}>
            {email.subject}
          </div>
          <div style={{ fontSize:12, color:'#4A4438', fontStyle:'italic', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
            {email.snippet}
          </div>
        </div>
      </div>
    </div>
  )
}

function DetailPanel({ email, onClose }: { email: ClassifiedEmail; onClose: () => void }) {
  return (
    <div style={{ width:380, overflowY:'auto', padding:'1.5rem', display:'flex', flexDirection:'column', gap:16 }}>
      <div style={{ display:'flex', justifyContent:'flex-end' }}>
        <button onClick={onClose} style={{ background:'none', border:'none', color:'#4A4438', cursor:'pointer', fontSize:18, lineHeight:1 }}>×</button>
      </div>
      <h2 style={{ fontSize:16, fontWeight:400, color:'#E8E0D4', lineHeight:1.4, fontFamily:"var(--font-playfair, serif)", margin:0 }}>
        {email.subject}
      </h2>
      <div style={{ fontSize:12, color:'#6B6558', display:'flex', flexDirection:'column', gap:3 }}>
        <div><span style={{ color:'#4A4438' }}>From: </span>{email.fromName} &lt;{email.from}&gt;</div>
        <div><span style={{ color:'#4A4438' }}>Date: </span>{new Date(email.date).toLocaleString()}</div>
        {email.to.length > 0 && <div><span style={{ color:'#4A4438' }}>To: </span>{email.to.join(', ')}</div>}
      </div>
      <div style={{ border:'1px solid #2A2820', borderRadius:6, overflow:'hidden' }}>
        <div style={{ padding:'6px 12px', background:'#1A1814', fontSize:10, letterSpacing:'0.08em', color:'#4A4438', borderBottom:'1px solid #2A2820' }}>PREVIEW</div>
        <div style={{ padding:'10px 12px', fontSize:12, color:'#6B6558', lineHeight:1.6, whiteSpace:'pre-wrap', wordBreak:'break-word' }}>
          {email.body || email.snippet}
        </div>
      </div>
    </div>
  )
}
