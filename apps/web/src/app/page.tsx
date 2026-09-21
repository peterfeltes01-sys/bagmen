import { GameCanvas } from '@/components/GameCanvas'

export default function Home() {
  return (
    <main className="fixed inset-0 flex justify-center items-stretch bg-black overflow-hidden">
      <div className="relative w-full max-w-sm h-full">
        <GameCanvas />
      </div>
    </main>
  )
}
