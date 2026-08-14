// Reserved for the client-session auth check (Session 6) — kept as its own
// route group now, mirroring /app/studio/(shell), so auth wiring later is an
// addition here rather than a restructure of the routes.
export default function ClientShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-screen overflow-hidden bg-white [font-family:system-ui,sans-serif]">
      {children}
    </div>
  )
}
