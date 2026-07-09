import { QueueSubTabsClient } from '@/components/studio/queue/QueueSubTabs'

export default function QueueLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col h-full">
      <QueueSubTabsClient />
      <div className="flex-1 overflow-y-auto">
        {children}
      </div>
    </div>
  )
}
