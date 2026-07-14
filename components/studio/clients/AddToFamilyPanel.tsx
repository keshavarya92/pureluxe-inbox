'use client'

import { useState, useEffect } from 'react'
import type { FamilyWithMembers, FamilyMemberRole } from '@/lib/studio/types'

interface Props {
  clientId: string
  currentFamily: FamilyWithMembers | null
  onSaved: () => void
  onCancel: () => void
}

const ROLES: FamilyMemberRole[] = [
  'primary', 'spouse', 'parent', 'child', 'sibling', 'business_partner', 'member'
]

const ROLE_LABEL: Record<FamilyMemberRole, string> = {
  primary:          'Primary',
  spouse:           'Spouse',
  parent:           'Parent',
  child:            'Child',
  sibling:          'Sibling',
  business_partner: 'Business partner',
  member:           'Member',
}

export function AddToFamilyPanel({ clientId, currentFamily, onSaved, onCancel }: Props) {
  const [mode, setMode]               = useState<'choose' | 'new' | 'existing' | 'manage'>(currentFamily ? 'manage' : 'choose')
  const [familyName, setFamilyName]   = useState('')
  const [role, setRole]               = useState<FamilyMemberRole>('member')
  const [isPrimary, setIsPrimary]     = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [families, setFamilies]       = useState<Array<{ id: string; family_name: string }>>([])
  const [selectedFamilyId, setSelectedFamilyId] = useState('')
  const [saving, setSaving]           = useState(false)

  useEffect(() => {
    if (mode !== 'existing') return
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/studio/families?q=${encodeURIComponent(searchQuery)}`)
      const { families: data } = await res.json()
      setFamilies(data)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, mode])

  async function handleSave(action: string, extra: Record<string, any> = {}) {
    setSaving(true)
    try {
      const res = await fetch(`/api/studio/clients/${clientId}/family`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, role, isPrimary, ...extra }),
      })
      if (!res.ok) throw new Error('Failed')
      onSaved()
    } catch (err: any) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (mode === 'manage' && currentFamily) {
    return (
      <div className="p-5">
        <p className="text-[12px] font-medium text-[#0F0F0D] mb-3">
          Managing: {currentFamily.family_name}
        </p>
        <button
          onClick={() => handleSave('remove', { familyId: currentFamily.id })}
          disabled={saving}
          className="text-[11px] text-[#E24B4A] border border-[#F4C0D1] px-3 py-1.5 rounded-md hover:bg-[#FBEAF0] disabled:opacity-50"
        >
          {saving ? 'Removing…' : 'Remove from family'}
        </button>
        <div className="flex gap-2 mt-4 pt-3 border-t border-[#E5E4E0]">
          <button onClick={onCancel} className="text-[11px] text-[#6B6A67] border border-[#E5E4E0] px-3 py-1.5 rounded-md hover:bg-[#F5F4F1]">
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-5">
      {mode === 'choose' && (
        <>
          <p className="text-[12px] font-medium text-[#0F0F0D] mb-4">Add to family</p>
          <div className="space-y-2">
            <button
              onClick={() => setMode('new')}
              className="w-full text-left text-[12px] border border-[#E5E4E0] rounded-lg px-4 py-3 hover:bg-[#F5F4F1]"
            >
              <p className="font-medium text-[#0F0F0D]">Create new family</p>
              <p className="text-[11px] text-[#9B9A97] mt-0.5">Start a new family group for this client</p>
            </button>
            <button
              onClick={() => setMode('existing')}
              className="w-full text-left text-[12px] border border-[#E5E4E0] rounded-lg px-4 py-3 hover:bg-[#F5F4F1]"
            >
              <p className="font-medium text-[#0F0F0D]">Add to existing family</p>
              <p className="text-[11px] text-[#9B9A97] mt-0.5">Link to a family that already exists</p>
            </button>
          </div>
          <div className="flex gap-2 mt-4 pt-3 border-t border-[#E5E4E0]">
            <button onClick={onCancel} className="text-[11px] text-[#6B6A67] border border-[#E5E4E0] px-3 py-1.5 rounded-md hover:bg-[#F5F4F1]">
              Cancel
            </button>
          </div>
        </>
      )}

      {mode === 'new' && (
        <>
          <p className="text-[12px] font-medium text-[#0F0F0D] mb-3">Create new family</p>
          <div className="space-y-3 mb-4">
            <div>
              <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-1">Family name</p>
              <input
                type="text"
                placeholder="e.g. Kapadia Family"
                value={familyName}
                onChange={e => setFamilyName(e.target.value)}
                className="w-full text-[12px] border border-[#E5E4E0] rounded px-2 py-1.5 focus:outline-none"
              />
            </div>
            <div>
              <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-1">This client&apos;s role</p>
              <select
                value={role}
                onChange={e => setRole(e.target.value as FamilyMemberRole)}
                className="w-full text-[12px] border border-[#E5E4E0] rounded px-2 py-1.5 focus:outline-none"
              >
                {ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-2 pt-3 border-t border-[#E5E4E0]">
            <button onClick={() => setMode('choose')} className="text-[11px] text-[#6B6A67] border border-[#E5E4E0] px-3 py-1.5 rounded-md hover:bg-[#F5F4F1] mr-auto">Back</button>
            <button
              onClick={() => handleSave('create_and_add', { familyName })}
              disabled={!familyName.trim() || saving}
              className="text-[11px] bg-[#0F0F0D] text-white px-3 py-1.5 rounded-md hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Creating…' : 'Create family'}
            </button>
          </div>
        </>
      )}

      {mode === 'existing' && (
        <>
          <p className="text-[12px] font-medium text-[#0F0F0D] mb-3">Add to existing family</p>
          <input
            type="text"
            placeholder="Search families…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full text-[12px] border border-[#E5E4E0] rounded px-2 py-1.5 mb-3 focus:outline-none"
          />
          {families.map(f => (
            <button
              key={f.id}
              onClick={() => setSelectedFamilyId(f.id)}
              className={`w-full text-left text-[12px] px-3 py-2 rounded mb-1 border ${
                selectedFamilyId === f.id ? 'border-[#0F0F0D] bg-[#F5F4F1]' : 'border-[#E5E4E0] hover:bg-[#F5F4F1]'
              }`}
            >
              {f.family_name}
            </button>
          ))}
          {selectedFamilyId && (
            <div className="mt-3">
              <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-1">This client&apos;s role</p>
              <select
                value={role}
                onChange={e => setRole(e.target.value as FamilyMemberRole)}
                className="w-full text-[12px] border border-[#E5E4E0] rounded px-2 py-1.5 focus:outline-none"
              >
                {ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </div>
          )}
          <div className="flex gap-2 mt-4 pt-3 border-t border-[#E5E4E0]">
            <button onClick={() => setMode('choose')} className="text-[11px] text-[#6B6A67] border border-[#E5E4E0] px-3 py-1.5 rounded-md hover:bg-[#F5F4F1] mr-auto">Back</button>
            <button
              onClick={() => handleSave('add_to_existing', { familyId: selectedFamilyId })}
              disabled={!selectedFamilyId || saving}
              className="text-[11px] bg-[#0F0F0D] text-white px-3 py-1.5 rounded-md hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Adding…' : 'Add to family'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
