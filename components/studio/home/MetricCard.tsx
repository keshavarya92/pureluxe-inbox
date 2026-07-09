interface Props {
  label: string
  value: number | string
  sub?: string
  alert?: boolean
  warning?: boolean
}

export function MetricCard({ label, value, sub, alert, warning }: Props) {
  const valueColor = alert ? 'text-[#E24B4A]' : warning ? 'text-[#BA7517]' : 'text-[#0F0F0D]'

  return (
    <div className="bg-[#F5F4F1] rounded-lg p-4">
      <p className="text-[11px] text-[#9B9A97] mb-2">{label}</p>
      <p className={`text-[22px] font-medium ${valueColor}`}>{value}</p>
      {sub && <p className="text-[11px] text-[#9B9A97] mt-1">{sub}</p>}
    </div>
  )
}
