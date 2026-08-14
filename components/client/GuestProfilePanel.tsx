'use client'

import { DEMO_GUEST_PROFILE } from './placeholderData'

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-2.5 border-b border-[#F5F4F1] last:border-0">
      <p className="text-[11px] text-[#9B9A97] mb-0.5">{label}</p>
      <p className="text-[13px] text-[#0F0F0D]">{value}</p>
    </div>
  )
}

interface Props {
  onClose: () => void
}

// Slide-over panel, matching the convention used by Studio's
// BookingEditPanel/BookingDetailPanel — backdrop + fixed right-hand sheet.
export function GuestProfilePanel({ onClose }: Props) {
  const profile = DEMO_GUEST_PROFILE

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full w-[420px] bg-white border-l border-[#E5E4E0] z-50 flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#E5E4E0] shrink-0">
          <p className="text-[13px] font-medium text-[#0F0F0D]">Guest profile</p>
          <button onClick={onClose} className="text-[12px] text-[#6B6A67] hover:text-[#0F0F0D]">Close</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-full bg-[#0F0F0D] text-white text-[14px] font-medium flex items-center justify-center shrink-0">
              {profile.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <p className="text-[14px] font-medium text-[#0F0F0D]">{profile.name}</p>
              <p className="text-[11.5px] text-[#9B9A97]">Demo persona — placeholder data only</p>
            </div>
          </div>

          <FieldRow label="Email" value={profile.email} />
          <FieldRow label="Phone" value={profile.phone} />

          <div className="py-2.5 border-b border-[#F5F4F1]">
            <p className="text-[11px] text-[#9B9A97] mb-1">Travel preferences</p>
            <ul className="space-y-1">
              {profile.preferences.map((pref, i) => (
                <li key={i} className="text-[13px] text-[#0F0F0D]">{pref}</li>
              ))}
            </ul>
          </div>

          <FieldRow label="Passport / ID" value={profile.passport} />

          <div className="py-2.5">
            <p className="text-[11px] text-[#9B9A97] mb-1">Loyalty numbers</p>
            <ul className="space-y-1">
              {profile.loyaltyNumbers.map((l, i) => (
                <li key={i} className="text-[13px] text-[#0F0F0D] flex items-center justify-between">
                  <span>{l.program}</span>
                  <span className="text-[#6B6A67]">{l.number}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </>
  )
}
