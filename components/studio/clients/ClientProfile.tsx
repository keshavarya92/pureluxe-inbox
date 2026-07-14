'use client'

import { useState } from 'react'
import type { ClientProfile, FamilyMemberRole } from '@/lib/studio/types'
import { FamilyCard } from './FamilyCard'
import { ClientEditForm } from './ClientEditForm'
import { ClientMergePanel } from './ClientMergePanel'
import { AddToFamilyPanel } from './AddToFamilyPanel'

interface Props {
  profile: ClientProfile
  userEmail: string
  onNavigateToClient: (id: string) => void
  onRefresh: () => void
}

function formatDate(d: string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function formatCurrency(amount: number): string {
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`
  if (amount >= 1000)    return `$${(amount / 1000).toFixed(0)}K`
  return `$${amount.toFixed(0)}`
}

type PanelMode = 'view' | 'edit' | 'merge' | 'family'

export function ClientProfile({ profile, userEmail, onNavigateToClient, onRefresh }: Props) {
  const [mode, setMode] = useState<PanelMode>('view')

  const initials = profile.full_name
    .split(' ').filter(Boolean).slice(0, 2).map(n => n[0].toUpperCase()).join('')

  const lastBooking = profile.bookings[0]

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Header */}
      <div className="p-5 border-b border-[#E5E4E0]">
        <div className="flex items-start gap-4 mb-4">
          <div className="w-12 h-12 rounded-full bg-[#E5E4E0] flex items-center justify-center text-[15px] font-medium text-[#0F0F0D] shrink-0">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[15px] font-medium text-[#0F0F0D]">{profile.full_name}</h2>
              {profile.vip_level === 'vvip' && (
                <span className="text-[10px] bg-[#FBEAF0] text-[#72243E] px-2 py-0.5 rounded-full font-medium">VVIP</span>
              )}
              {profile.vip_level === 'vip' && (
                <span className="text-[10px] bg-[#FAEEDA] text-[#633806] px-2 py-0.5 rounded-full font-medium">VIP</span>
              )}
            </div>
            {profile.family && (
              <p className="text-[11px] text-[#9B9A97] mt-0.5">
                {profile.family.family_name} · {profile.family_role}
              </p>
            )}
            <p className="text-[11px] text-[#9B9A97] mt-0.5">
              Client since {formatDate(profile.created_at)}
            </p>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')}
            className={`text-[11px] px-3 py-1.5 rounded-md border transition-colors ${
              mode === 'edit'
                ? 'bg-[#0F0F0D] text-white border-[#0F0F0D]'
                : 'border-[#E5E4E0] text-[#6B6A67] hover:bg-[#F5F4F1]'
            }`}
          >
            Edit
          </button>
          <button
            onClick={() => setMode(mode === 'merge' ? 'view' : 'merge')}
            className={`text-[11px] px-3 py-1.5 rounded-md border transition-colors ${
              mode === 'merge'
                ? 'bg-[#0F0F0D] text-white border-[#0F0F0D]'
                : 'border-[#E5E4E0] text-[#6B6A67] hover:bg-[#F5F4F1]'
            }`}
          >
            Merge
          </button>
          <button
            onClick={() => setMode(mode === 'family' ? 'view' : 'family')}
            className={`text-[11px] px-3 py-1.5 rounded-md border transition-colors ${
              mode === 'family'
                ? 'bg-[#0F0F0D] text-white border-[#0F0F0D]'
                : 'border-[#E5E4E0] text-[#6B6A67] hover:bg-[#F5F4F1]'
            }`}
          >
            {profile.family ? 'Manage family' : 'Add to family'}
          </button>
        </div>
      </div>

      {/* Edit mode */}
      {mode === 'edit' && (
        <ClientEditForm
          profile={profile}
          onSaved={() => { setMode('view'); onRefresh() }}
          onCancel={() => setMode('view')}
        />
      )}

      {/* Merge mode */}
      {mode === 'merge' && (
        <ClientMergePanel
          client={profile}
          userEmail={userEmail}
          onMerged={() => { setMode('view'); onRefresh() }}
          onCancel={() => setMode('view')}
        />
      )}

      {/* Family mode */}
      {mode === 'family' && (
        <AddToFamilyPanel
          clientId={profile.id}
          currentFamily={profile.family}
          onSaved={() => { setMode('view'); onRefresh() }}
          onCancel={() => setMode('view')}
        />
      )}

      {/* View mode content */}
      {mode === 'view' && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-3 gap-px bg-[#E5E4E0] border-b border-[#E5E4E0]">
            {[
              { label: 'Bookings', value: profile.booking_count },
              { label: 'Spend (USD)', value: formatCurrency(profile.total_spend_usd) },
              { label: 'Family spend', value: profile.family ? formatCurrency(profile.family.total_spend_usd) : '—' },
            ].map(s => (
              <div key={s.label} className="bg-white px-4 py-3">
                <p className="text-[10px] text-[#9B9A97] mb-1">{s.label}</p>
                <p className="text-[14px] font-medium text-[#0F0F0D]">{s.value}</p>
              </div>
            ))}
          </div>

          {/* Contact */}
          <div className="p-5 border-b border-[#E5E4E0]">
            <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-3">Contact</p>
            <div className="space-y-2">
              {[
                { label: 'Email',     value: profile.email },
                { label: 'Phone',     value: profile.phone },
                { label: 'WhatsApp',  value: profile.whatsapp },
                { label: 'City',      value: profile.city_of_residence },
                { label: 'Nationality', value: profile.nationality },
                { label: 'Company',   value: profile.company },
              ].map(f => f.value && (
                <div key={f.label} className="flex items-center justify-between">
                  <span className="text-[11px] text-[#9B9A97] w-24">{f.label}</span>
                  <span className="text-[11px] text-[#0F0F0D]">{f.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Family */}
          {profile.family && (
            <div className="p-5 border-b border-[#E5E4E0]">
              <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-3">Family</p>
              <FamilyCard
                family={profile.family}
                currentClientId={profile.id}
                onNavigateToClient={onNavigateToClient}
              />
            </div>
          )}

          {/* Family suggestions */}
          {!profile.family && profile.family_suggestions.length > 0 && (
            <div className="p-5 border-b border-[#E5E4E0]">
              <div className="bg-[#F5F4F1] rounded-md p-3">
                <p className="text-[11px] font-medium text-[#0F0F0D] mb-2">Possible family members</p>
                {profile.family_suggestions.map(s => (
                  <div key={s.client_id} className="flex items-center justify-between py-1">
                    <p className="text-[11px] text-[#6B6A67]">{s.full_name}</p>
                    <button
                      onClick={() => setMode('family')}
                      className="text-[10px] text-[#185FA5] hover:underline"
                    >
                      Add to family
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          {profile.general_notes && (
            <div className="p-5 border-b border-[#E5E4E0]">
              <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-2">Notes</p>
              <p className="text-[11px] text-[#6B6A67] leading-relaxed">{profile.general_notes}</p>
            </div>
          )}

          {/* Booking history */}
          <div className="p-5">
            <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-3">
              Booking history ({profile.booking_count})
            </p>
            {profile.bookings.length === 0 ? (
              <p className="text-[12px] text-[#9B9A97]">No bookings yet.</p>
            ) : (
              <div className="space-y-0">
                {profile.bookings.map(b => (
                  <div key={b.id} className={`py-2.5 border-b border-[#F5F4F1] last:border-0 ${
                    b.status === 'superseded' || b.status === 'cancelled' ? 'opacity-40' : ''
                  }`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] font-medium text-[#0F0F0D] truncate">{b.hotel_name ?? '—'}</p>
                        <p className="text-[10px] text-[#9B9A97]">
                          {b.check_in} – {b.check_out}
                          {b.nights ? ` · ${b.nights}n` : ''}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        {b.total_cost && (
                          <p className="text-[11px] text-[#0F0F0D]">{b.currency} {b.total_cost.toLocaleString()}</p>
                        )}
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                          b.status === 'confirmed'     ? 'bg-[#EAF3DE] text-[#27500A]' :
                          b.status === 'checked_out'   ? 'bg-[#F5F4F1] text-[#6B6A67]' :
                          b.status === 'superseded'    ? 'bg-[#F5F4F1] text-[#9B9A97]' :
                          b.status === 'cancelled'     ? 'bg-[#FCEBEB] text-[#791F1F]' :
                          'bg-[#FAEEDA] text-[#633806]'
                        }`}>
                          {b.status}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Merge suggestions */}
          {profile.similar_clients.length > 0 && (
            <div className="px-5 pb-5">
              <div className="bg-[#FAEEDA] border border-[#FAC775] rounded-md p-3">
                <p className="text-[11px] font-medium text-[#633806] mb-1">Similar client records found</p>
                <p className="text-[10px] text-[#633806] mb-2">These may be duplicates of this client.</p>
                <button
                  onClick={() => setMode('merge')}
                  className="text-[10px] bg-[#633806] text-white px-2 py-1 rounded hover:opacity-90"
                >
                  Review and merge
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
