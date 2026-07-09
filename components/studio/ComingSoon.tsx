const ClockIcon = () => (
  <svg
    width="36"
    height="36"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
)

interface Props {
  title: string
}

export default function ComingSoon({ title }: Props) {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[480px] text-[#9B9A97]">
      <ClockIcon />
      <h2 className="mt-5 text-base font-medium text-[#6B6A67]">{title}</h2>
      <p className="mt-1 text-sm">Coming in the next release</p>
    </div>
  )
}
