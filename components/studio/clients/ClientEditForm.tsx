'use client'

import { useState } from 'react'
import type { ClientProfile } from '@/lib/studio/types'

interface Props {
  profile: ClientProfile
  onSaved: () => void
  onCancel: () => void
}

export function ClientEditForm({ profile, onSaved, onCancel }: Props) {
  const [fields, setFields] = useState({
    full_name:         profile.full_name,
    title:             profile.title ?? '',
    first_name:        profile.first_name ?? '',
    last_name:         profile.last_name ?? '',
    email:             profile.email ?? '',
    phone:             profile.phone ?? '',
    whatsapp:          profile.whatsapp ?? '',
    nationality:       profile.nationality ?? '',
    city_of_residence: profile.city_of_residence ?? '',
    company:           profile.company ?? '',
    vip_level:         profile.vip_level ?? 'standard',
    general_notes:     profile.general_notes ?? '',
    internal_notes:    profile.internal_notes ?? '',
  })
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch(`/api/studio/clients/${profile.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
      if (!res.ok) throw new Error('Save failed')
      onSaved()
    } catch (err: any) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  const fieldDefs = [
    { key: 'full_name',         label: 'Full name',    span: 2 },
    { key: 'title',             label: 'Title',        span: 1 },
    { key: 'first_name',        label: 'First name',   span: 1 },
    { key: 'last_name',         label: 'Last name',    span: 1 },
    { key: 'email',             label: 'Email',        span: 2 },
    { key: 'phone',             label: 'Phone',        span: 1 },
    { key: 'whatsapp',          label: 'WhatsApp',     span: 1 },
    { key: 'nationality',       label: 'Nationality',  span: 1 },
    { key: 'city_of_residence', label: 'City',         span: 1 },
    { key: 'company',           label: 'Company',      span: 2 },
  ]

  return (
    <div className="p-5">
      <div className="grid grid-cols-2 gap-3 mb-4">
        {fieldDefs.map(f => (
          <div key={f.key} className={f.span === 2 ? 'col-span-2' : ''}>
            <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-1">{f.label}</p>
            <input
              type="text"
              value={fields[f.key as keyof typeof fields]}
              onChange={e => setFields(prev => ({ ...prev, [f.key]: e.target.value }))}
              className="w-full text-[12px] border border-[#E5E4E0] rounded px-2 py-1.5 focus:outline-none focus:border-[#9B9A97]"
            />
          </div>
        ))}

        <div>
          <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-1">VIP level</p>
          <select
            value={fields.vip_level}
            onChange={e => setFields(prev => ({ ...prev, vip_level: e.target.value }))}
            className="w-full text-[12px] border border-[#E5E4E0] rounded px-2 py-1.5 focus:outline-none"
          >
            <option value="standard">Standard</option>
            <option value="vip">VIP</option>
            <option value="vvip">VVIP</option>
          </select>
        </div>

        <div className="col-span-2">
          <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-1">Notes</p>
          <textarea
            value={fields.general_notes}
            onChange={e => setFields(prev => ({ ...prev, general_notes: e.target.value }))}
            rows={3}
            className="w-full text-[12px] border border-[#E5E4E0] rounded px-2 py-1.5 focus:outline-none resize-none"
          />
        </div>

        <div className="col-span-2">
          <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-1">Internal notes</p>
          <textarea
            value={fields.internal_notes}
            onChange={e => setFields(prev => ({ ...prev, internal_notes: e.target.value }))}
            rows={2}
            className="w-full text-[12px] border border-[#E5E4E0] rounded px-2 py-1.5 focus:outline-none resize-none"
          />
        </div>
      </div>

      <div className="flex gap-2 pt-3 border-t border-[#E5E4E0]">
        <button
          onClick={onCancel}
          className="text-[11px] text-[#6B6A67] border border-[#E5E4E0] px-3 py-1.5 rounded-md hover:bg-[#F5F4F1] mr-auto"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="text-[11px] bg-[#0F0F0D] text-white px-3 py-1.5 rounded-md hover:opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}
