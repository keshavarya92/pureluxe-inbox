import type { Booking } from '@/lib/studio/types'

interface Props {
  payments: Booking[]
}

function formatDate(d: string | null): string {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

function extractPaymentNote(notes: string | null, misc: string | null): string {
  const combined = [notes, misc].filter(Boolean).join(' ')
  if (/payit\.cc|kasikorn|payment link/i.test(combined)) return 'Payment link'
  if (/deposit/i.test(combined)) return 'Deposit due'
  if (/bank transfer|swift/i.test(combined)) return 'Bank transfer'
  return 'Payment due'
}

export function PaymentDueList({ payments }: Props) {
  if (payments.length === 0) {
    return (
      <p className="text-[12px] text-[#9B9A97] py-4 text-center">
        No payments due this week.
      </p>
    )
  }

  return (
    <div>
      {payments.map(b => (
        <div key={b.id} className="flex items-center gap-3 py-2.5 border-b border-[#F5F4F1] last:border-0">
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-medium text-[#0F0F0D] truncate">{b.client_name}</p>
            <p className="text-[11px] text-[#9B9A97] truncate">{b.hotel_name}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-[11px] text-[#0F0F0D]">
              {b.currency} {b.total_cost?.toLocaleString()}
            </p>
            <p className="text-[10px] text-[#9B9A97]">
              {extractPaymentNote(b.notes, b.misc)} · Check-in {formatDate(b.check_in)}
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}
