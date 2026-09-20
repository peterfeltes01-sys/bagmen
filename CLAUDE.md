# Cornhole Spiel — CLAUDE.md

## Workspace-Struktur

| Paket | Zweck |
|---|---|
| `packages/engine` | Reine TypeScript-Spiellogik, keine DOM-Abhängigkeit |
| `apps/web` | Next.js 15 PWA, importiert `@cornhole/engine` |

## Regeln

### 1. Engine ist rein und deterministisch
`packages/engine` hat **keine** DOM-, Canvas- oder React-Abhängigkeit.
Öffentliche Signatur: `applyThrow(state, params, seed) → { state, trajectory }`
- Eingabe: aktueller `GameState` + `ThrowParams` + numerischer Seed
- Ausgabe: neuer `GameState` + `Trajectory` (Array aus `Point`-Objekten `{x,y,z,t}`)

### 2. Zufall nur über den seeded RNG
Kein `Math.random()` in der gesamten Engine.
Alle Zufallswerte kommen aus `createRng(seed)` in `packages/engine/src/rng.ts` (mulberry32).

### 3. Rendering liest den Engine-Zustand, schreibt ihn nie
- Partikel, Animationen und visuelle Effekte liegen außerhalb der Simulation.
- Komponenten in `apps/web` dürfen den `GameState` nur lesen und als Prop weitergeben.
- Kein `setState`/`dispatch` auf Basis von Rendering-Callbacks.

### 4. Physikwerte in config.ts, versioniert über engineHash
Alle Physik-Konstanten leben ausschließlich in `packages/engine/src/config.ts`.
Bei jeder Änderung an `PHYSICS`: `ENGINE_HASH` erhöhen, damit gespeicherte
Replays (Seed + ThrowParams) weiterhin reproduzierbar bleiben.
