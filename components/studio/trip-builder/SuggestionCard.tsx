'use client'

interface Props {
  destination:   string
  property_name: string | null
  source:        'kb' | 'llm_general'
  content:       string
}

// Provenance tags — brass for knowledge-base-grounded content, amber for
// unverified general knowledge. Advisor-facing only; never enters generated
// documents (see build brief's provenance-flagging section).
function ProvenanceTag({ source }: { source: 'kb' | 'llm_general' }) {
  if (source === 'kb') {
    return (
      <span className="inline-flex items-center gap-1 bg-[#EFE6D3] text-[#8A6D3B] border border-[#D8C9A6] text-[10px] leading-none px-[7px] py-[4px] rounded-[10px]">
        Grounded in knowledge base
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 bg-[#FEF3C7] text-[#92400E] border border-[#FDE68A] text-[10px] leading-none px-[7px] py-[4px] rounded-[10px]">
      General knowledge — unverified
    </span>
  )
}

export function SuggestionCard({ destination, property_name, source, content }: Props) {
  return (
    <div className="max-w-[85%] rounded-lg border border-[#E5E4E0] bg-white px-3 py-2.5 text-[12px]">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <p className="font-medium text-[#0F0F0D] truncate">
          {property_name ? `${property_name} — ${destination}` : destination}
        </p>
        <ProvenanceTag source={source} />
      </div>
      <p className="text-[#3A3A38] whitespace-pre-wrap">{content}</p>
    </div>
  )
}
