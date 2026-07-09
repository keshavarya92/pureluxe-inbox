// Displays a single field in the queue card grid.
// Green if value present, red if required and missing, amber if optional and missing.

interface Props {
  label: string
  value: string | number | null | undefined
  required?: boolean
  missingLabel?: string
}

export function FieldStatus({ label, value, required, missingLabel }: Props) {
  const hasValue = value !== null && value !== undefined && value !== ''

  return (
    <div>
      <p className="text-[10px] text-[#9B9A97] uppercase tracking-[0.04em] mb-[3px]">
        {label}
      </p>
      {hasValue ? (
        <p className="text-[12px] text-[#0F0F0D]">{String(value)}</p>
      ) : required ? (
        <p className="text-[12px] text-[#E24B4A] italic">
          {missingLabel ?? 'Required'}
        </p>
      ) : (
        <p className="text-[12px] text-[#BA7517] italic">
          {missingLabel ?? 'Not captured'}
        </p>
      )}
    </div>
  )
}
