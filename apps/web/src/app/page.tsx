import { createInitialState } from '@cornhole/engine'

export default function Home() {
  const state = createInitialState()

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-4xl font-bold tracking-tight">Cornhole Spiel</h1>
      <p className="text-sm text-gray-500">Engine {state.engineHash}</p>
    </main>
  )
}
