import { Suspense } from 'react'
import { TripBuilderWorkspace } from '@/components/studio/trip-builder/TripBuilderWorkspace'

export default function TripBuilderPage() {
  return (
    <Suspense fallback={null}>
      <TripBuilderWorkspace />
    </Suspense>
  )
}
