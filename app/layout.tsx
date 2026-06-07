import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'PureLuxe Inbox Intelligence',
  description: 'AI-powered email reader and classifier for PureLuxe',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Fix 12: preconnect + preload for Google Fonts — faster than @import in CSS */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,300;0,400;0,500;1,300&family=Playfair+Display:wght@400;500&display=swap"
        />
      </head>
      <body style={{ margin: 0, padding: 0, background: '#0F0F0D', fontFamily: "'Crimson Pro', Georgia, serif" }}>
        {children}
      </body>
    </html>
  )
}
