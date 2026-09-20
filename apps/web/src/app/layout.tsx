import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Cornhole Spiel',
  description: 'Cornhole PWA',
  manifest: '/manifest.json',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body className="min-h-screen bg-gray-900 text-white">{children}</body>
    </html>
  )
}
