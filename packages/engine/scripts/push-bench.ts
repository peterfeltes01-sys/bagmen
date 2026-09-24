/**
 * push-bench.ts — Parameter-Sweep fuer den Push-Wurf
 * Ausfuehren: pnpm --filter @cornhole/engine bench:push
 *
 * Nur messen — Engine-Code und config.ts bleiben unveraendert.
 *
 * Sweep: pushedFriction × collisionTransfer (6×6 = 36 Kombos)
 * Szenarien je Kombo:
 *   slide-scat   : flat, kein Blocker, Streuung guter Spieler
 *   push25-no    : roll (weich), Blocker 25 cm vor Loch, sigma=0 (deterministisch)
 *   push25-scat  : roll, Blocker 25 cm, Streuung
 *   push35-no    : flat (fest), Blocker 35 cm vor Loch, sigma=0
 *   push35-scat  : flat, Blocker 35 cm, Streuung
 */

import { createRng }                               from '../src/rng.js'
import { BOARD, PHYSICS_DEFAULTS, SCATTER, SLIDE } from '../src/config.js'
import type { BagOnBoard, SackOutcome }             from '../src/types.js'

// ── Sweep-Gitter ──────────────────────────────────────────────────────────────
const PUSHED_FRIC_GRID  = [50, 100, 150, 200, 250, 300] as const  // pushedFriction cm/s²
const COL_TRANSFER_GRID = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0] as const // collisionTransfer ≤ 1.0

const N_THROWS  = 200   // Würfe pro Scatter-Szenario
const THROW_PWR = 0.8   // Standard-Wurfstärke

// ── Typen ─────────────────────────────────────────────────────────────────────

interface Po {
  slideVFlat:        number
  slideVRoll:        number
  pushFriction:      number
  pushedFriction:    number
  collisionTransfer: number
}
interface Mv { id: string; x: number; y: number; vx: number; vy: number; friction: number }
interface Gp { tx: number; ty: number; pw: number }

interface SimResult {
  thrownOutcome: SackOutcome
  pushedOutcome: SackOutcome | null
  contacted:     boolean
  pushedDy:      number   // Δy des geschobenen Sacks (cm)
}

interface RunStats {
  inRate:          number
  offRate:         number
  onRate:          number
  contactRate:     number
  medianPushDy:    number
  p90PushDy:       number
  finalYMax:       number
  inGivenContact:  number
  offGivenContact: number
}

interface ComboResult {
  pushedFric:  number
  colTransfer: number
  slideFlat:   number      // analytische Rutschweite, flat, power=0.8 (cm)
  slideScat:   RunStats
  push25Gp:    Gp
  push25No:    SimResult   // deterministisch (sigma=0)
  push25Scat:  RunStats
  push35Gp:    Gp
  push35No:    SimResult
  push35Scat:  RunStats
  score:       number      // max 11
}

// ── Slide-Simulation ──────────────────────────────────────────────────────────
// Vereinfachte Version der Engine-Logik (keine CCD), fuer Messzwecke.

function runSlide(
  thrown:  Mv,
  statics: readonly BagOnBoard[],
  po:      Po,
): Map<string, { x: number; y: number }> {
  const movers: Mv[] = [{ ...thrown }]
  const stat   = new Map(statics.map(b => [b.id, { x: b.x, y: b.y }]))
  const R2     = BOARD.bagDiameter * BOARD.bagDiameter
  const pf     = po.pushedFriction
  const ct     = po.collisionTransfer

  for (let step = 0; step < SLIDE.maxSteps; step++) {
    // Reibung + Bewegung
    for (const m of movers) {
      const spd = Math.hypot(m.vx, m.vy)
      if (spd < 0.01) continue
      const fac = Math.max(0, spd - m.friction * SLIDE.dt) / spd
      m.vx *= fac; m.vy *= fac
      m.x  += m.vx * SLIDE.dt
      m.y  += m.vy * SLIDE.dt
    }

    // Kollisionserkennung
    const spawned: Mv[] = []
    for (const m of movers) {
      const spd = Math.hypot(m.vx, m.vy)
      if (spd < 0.01) continue
      for (const [sid, sp] of stat) {
        const dx = sp.x - m.x, dy = sp.y - m.y
        if (dx * dx + dy * dy >= R2) continue
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d < 0.001) { stat.delete(sid); break }
        // AABB SAT: spiegelt simulate.ts
        const oX = BOARD.bagDiameter - Math.abs(dx)
        const oY = BOARD.bagDiameter - Math.abs(dy)
        let nx: number, ny: number
        if (oX <= 0 || oY <= 0) { nx = dx / d; ny = dy / d }
        else if (oY <= oX)       { nx = 0; ny = Math.sign(dy) }
        else                     { nx = dx / d; ny = dy / d }
        const dot = m.vx * nx + m.vy * ny
        if (dot > 0) {
          spawned.push({ id: sid, x: sp.x, y: sp.y, vx: dot*nx*ct, vy: dot*ny*ct, friction: pf })
          m.vx -= dot * nx; m.vy -= dot * ny
        } else if (m.y > sp.y && m.vy > 0) {
          const dr = -dot
          spawned.push({ id: sid, x: sp.x, y: sp.y, vx: -dr*nx*ct, vy: -dr*ny*ct, friction: pf })
          m.vx += dr * nx; m.vy += dr * ny
        } else continue
        stat.delete(sid); break
      }
    }
    movers.push(...spawned)
    if (movers.every(m => Math.hypot(m.vx, m.vy) < 0.01)) break
  }
  return new Map(movers.map(m => [m.id, { x: m.x, y: m.y }]))
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

const ih = (x: number, y: number) =>
  (x - BOARD.holeX) ** 2 + (y - BOARD.holeY) ** 2 < BOARD.holeRadius ** 2
const ob = (x: number, y: number) =>
  x >= -BOARD.halfWidth && x <= BOARD.halfWidth && y >= 0 && y <= BOARD.length
const oc = (x: number, y: number): SackOutcome =>
  ih(x, y) ? 'in' : ob(x, y) ? 'on' : 'off'

function throwSigma(): number {
  // skill=0.9, focus=1.0
  return SCATTER.min + SCATTER.spread * (1 - 0.9) * (1 - 1.0 * 0.5)
}

function boxMuller(rng: () => number, sig: number): [number, number] {
  const u1 = Math.max(rng(), 1e-10), u2 = rng()
  const r   = Math.sqrt(-2 * Math.log(u1))
  return [r * Math.cos(2 * Math.PI * u2) * sig, r * Math.sin(2 * Math.PI * u2) * sig]
}

function numRange(from: number, to: number, step: number): number[] {
  const a: number[] = []
  for (let v = from; v <= to + 1e-9; v += step) a.push(+(v.toFixed(4)))
  return a
}

function avgArr(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0
}

function pct(arr: number[], q: number): number {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const i = (q / 100) * (s.length - 1)
  const lo = Math.floor(i)
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo)
}

// ── Einzelwurf ───────────────────────────────────────────────────────────────

function sim(
  statics: BagOnBoard[],
  lx: number, ly: number,
  pw: number,
  fl: 'flat' | 'roll',
  po: Po,
): SimResult {
  if (ih(lx, ly))  return { thrownOutcome: 'in',  pushedOutcome: null, contacted: false, pushedDy: 0 }
  if (!ob(lx, ly)) return { thrownOutcome: 'off', pushedOutcome: null, contacted: false, pushedDy: 0 }

  const v0    = pw * (fl === 'roll' ? po.slideVRoll : po.slideVFlat)
  const mover: Mv = { id: 'T', x: lx, y: ly, vx: 0, vy: v0, friction: po.pushFriction }
  const fin   = runSlide(mover, statics, po)
  const tf    = fin.get('T') ?? { x: lx, y: ly }

  if (statics.length === 0) {
    return { thrownOutcome: oc(tf.x, tf.y), pushedOutcome: null, contacted: false, pushedDy: tf.y - ly }
  }

  const b   = statics[0]
  const bf  = fin.get(b.id)
  return {
    thrownOutcome: oc(tf.x, tf.y),
    pushedOutcome: oc((bf ?? b).x, (bf ?? b).y),
    contacted:     bf !== undefined,
    pushedDy:      bf ? bf.y - b.y : 0,
  }
}

// ── Grid-Suche ────────────────────────────────────────────────────────────────

function gridSearch(blocker: BagOnBoard, fl: 'flat' | 'roll', po: Po): Gp {
  const bY = blocker.y, bX = blocker.x
  // roll/weich: Landung 40-60cm vor Blocker; flat/fest: 5-15cm vor Blocker
  const tyRange = fl === 'roll'
    ? numRange(bY - 60, bY - 40, 5)
    : numRange(bY - 15, bY - 5,  2)
  const txRange = [bX]   // Zielpunkt immer auf Blocker-Mitte
  const pwRange = numRange(0.3, 1.0, 0.1)

  let best: Gp = { tx: bX, ty: bY - 20, pw: 0.6 }
  let bestIn = -1, bestDy = -1

  for (const ty of tyRange) for (const tx of txRange) for (const pw of pwRange) {
    const r   = sim([blocker], tx, ty, pw, fl, po)
    const inR = r.pushedOutcome === 'in' ? 1 : 0
    if (inR > bestIn || (inR === bestIn && r.pushedDy > bestDy)) {
      best = { tx, ty, pw }; bestIn = inR; bestDy = r.pushedDy
    }
  }
  return best
}

// ── Scatter-Lauf ─────────────────────────────────────────────────────────────

function scatterRun(
  statics: BagOnBoard[],
  gp:     Gp,
  fl:     'flat' | 'roll',
  sig:    number,
  po:     Po,
): RunStats {
  let inn = 0, off = 0, on = 0, contact = 0
  let innC = 0, offC = 0
  const dyArr:     number[] = []
  const finalYArr: number[] = []

  for (let seed = 0; seed < N_THROWS; seed++) {
    const rng       = createRng(seed)
    rng()           // bag-ID draw (spiegelt simulateThrow)
    const [ox, oy]  = boxMuller(rng, sig)
    const r         = sim(statics, gp.tx + ox, gp.ty + oy, gp.pw, fl, po)

    // slide-Szenario: thrownOutcome messen; push-Szenario: pushedOutcome
    const out = statics.length === 0 ? r.thrownOutcome : r.pushedOutcome
    if      (out === 'in')  inn++
    else if (out === 'on')  on++
    else if (out === 'off') off++

    if (r.contacted) {
      contact++
      dyArr.push(r.pushedDy)
      finalYArr.push(statics[0].y + r.pushedDy)
      if (r.pushedOutcome === 'in')  innC++
      if (r.pushedOutcome === 'off') offC++
    }
  }
  return {
    inRate:          inn     / N_THROWS,
    offRate:         off     / N_THROWS,
    onRate:          on      / N_THROWS,
    contactRate:     contact / N_THROWS,
    medianPushDy:    pct(dyArr, 50),
    p90PushDy:       pct(dyArr, 90),
    finalYMax:       finalYArr.length ? Math.max(...finalYArr) : (statics[0]?.y ?? 0),
    inGivenContact:  contact > 0 ? innC / contact : 0,
    offGivenContact: contact > 0 ? offC / contact : 0,
  }
}

// ── Kombo-Berechnung ──────────────────────────────────────────────────────────

const BLOCKER25: BagOnBoard = { id: 'B25', teamId: 1, x: 0, y: BOARD.holeY - 25, side: 'slow' }
const BLOCKER35: BagOnBoard = { id: 'B35', teamId: 1, x: 0, y: BOARD.holeY - 35, side: 'slow' }

function runCombo(pushedFric: number, colTransfer: number): ComboResult {
  const po: Po = {
    slideVFlat:        PHYSICS_DEFAULTS.slideVFlat,
    slideVRoll:        PHYSICS_DEFAULTS.slideVRoll,
    pushFriction:      PHYSICS_DEFAULTS.pushFriction,
    pushedFriction:    pushedFric,
    collisionTransfer: colTransfer,
  }
  const sig = throwSigma()

  // Analytische Rutschweite flat, power=0.8 (kein Blocker, keine Streuung)
  const slideFlat = (THROW_PWR * po.slideVFlat) ** 2 / (2 * po.pushFriction)

  // slide-scat: Ziel = Loch, flat, Streuung
  const slideGp: Gp = { tx: BOARD.holeX, ty: BOARD.holeY, pw: THROW_PWR }
  const slideScat   = scatterRun([], slideGp, 'flat', sig, po)

  // push25: roll (weich), Blocker 25 cm vor Loch
  const push25Gp   = gridSearch(BLOCKER25, 'roll', po)
  const push25No   = sim([BLOCKER25], push25Gp.tx, push25Gp.ty, push25Gp.pw, 'roll', po)
  const push25Scat = scatterRun([BLOCKER25], push25Gp, 'roll', sig, po)

  // push35: flat (fest), Blocker 35 cm vor Loch
  const push35Gp   = gridSearch(BLOCKER35, 'flat', po)
  const push35No   = sim([BLOCKER35], push35Gp.tx, push35Gp.ty, push35Gp.pw, 'flat', po)
  const push35Scat = scatterRun([BLOCKER35], push35Gp, 'flat', sig, po)

  const base = {
    pushedFric, colTransfer,
    slideFlat, slideScat,
    push25Gp, push25No, push25Scat,
    push35Gp, push35No, push35Scat,
  }
  return { ...base, score: calcScore(base as ComboResult) }
}

// ── Scoring ───────────────────────────────────────────────────────────────────
// Max 11 Punkte

function calcScore(r: ComboResult): number {
  let s = 0
  // Median Schubweg 20–50 cm (Mittel push25 + push35)
  const medMid = (r.push25Scat.medianPushDy + r.push35Scat.medianPushDy) / 2
  if (medMid >= 20 && medMid <= 50) s += 2
  // Off@Kontakt <= 10% für beide Szenarien
  if (r.push25Scat.offGivenContact <= 0.10 && r.push35Scat.offGivenContact <= 0.10) s += 2
  // In@Kontakt push25 20–40 %
  if (r.push25Scat.inGivenContact >= 0.20 && r.push25Scat.inGivenContact <= 0.40) s += 2
  // In@Kontakt push35 20–40 %
  if (r.push35Scat.inGivenContact >= 0.20 && r.push35Scat.inGivenContact <= 0.40) s += 2
  // p90 Schubweg < 80 cm (Blocker bleibt auf Brett)
  if (Math.max(r.push25Scat.p90PushDy, r.push35Scat.p90PushDy) < 80) s += 1
  // deterministisch: Blocker ins Loch
  if (r.push25No.pushedOutcome === 'in') s += 1
  if (r.push35No.pushedOutcome === 'in') s += 1
  return s
}

// ── Ausgabe ───────────────────────────────────────────────────────────────────

const p  = (r: number)        => (r * 100).toFixed(1) + '%'
const f  = (n: number, d = 1) => n.toFixed(d)
const yn = (b: boolean)       => b ? '✓' : '✗'

function printTable(results: ComboResult[]): void {
  const top = [...results].sort((a, b) => b.score - a.score).slice(0, 5)

  const W   = 150
  const SEP = '─'.repeat(W)
  console.log('\n' + '='.repeat(W))
  console.log('TOP 5 KOMBINATIONEN  (Ziele: Median-Schubweg 20–50 cm · off@Kontakt ≤10% · in@Kontakt push25/35 20–40% · p90 <80 cm)')
  console.log('='.repeat(W))
  console.log(
    'Rk | pFric | cT  |' +
    ' push25: med    p90  fYmax in@C  off@C no |' +
    ' push35: med    p90  fYmax in@C  off@C no |' +
    ' Pkt | Kriterien'
  )
  console.log(SEP)

  for (let i = 0; i < top.length; i++) {
    const r   = top[i]
    const p25 = r.push25Scat
    const p35 = r.push35Scat
    const medMid = (p25.medianPushDy + p35.medianPushDy) / 2
    const critMed  = yn(medMid >= 20 && medMid <= 50)
    const critOff  = yn(p25.offGivenContact <= 0.10 && p35.offGivenContact <= 0.10)
    const critIn25 = yn(p25.inGivenContact >= 0.20 && p25.inGivenContact <= 0.40)
    const critIn35 = yn(p35.inGivenContact >= 0.20 && p35.inGivenContact <= 0.40)
    const critP90  = yn(Math.max(p25.p90PushDy, p35.p90PushDy) < 80)
    console.log(
      ` ${i + 1} |` +
      `   ${String(r.pushedFric).padStart(3)} |` +
      ` ${r.colTransfer.toFixed(1)} |` +
      ` push25:` +
      ` ${f(p25.medianPushDy).padStart(4)}cm` +
      ` ${f(p25.p90PushDy).padStart(4)}cm` +
      ` ${f(p25.finalYMax).padStart(5)}cm` +
      ` ${p(p25.inGivenContact).padStart(6)}` +
      ` ${p(p25.offGivenContact).padStart(5)}` +
      ` ${yn(r.push25No.pushedOutcome === 'in')} |` +
      ` push35:` +
      ` ${f(p35.medianPushDy).padStart(4)}cm` +
      ` ${f(p35.p90PushDy).padStart(4)}cm` +
      ` ${f(p35.finalYMax).padStart(5)}cm` +
      ` ${p(p35.inGivenContact).padStart(6)}` +
      ` ${p(p35.offGivenContact).padStart(5)}` +
      ` ${yn(r.push35No.pushedOutcome === 'in')} |` +
      `  ${String(r.score).padStart(2)}/11 |` +
      ` med${critMed} off${critOff} in25${critIn25} in35${critIn35} p90${critP90}`
    )
    console.log(
      `   |       |     |` +
      `  push25 Gp: tX=${f(r.push25Gp.tx)} tY=${f(r.push25Gp.ty)} pw=${f(r.push25Gp.pw, 2)}` +
      `  |  push35 Gp: tX=${f(r.push35Gp.tx)} tY=${f(r.push35Gp.ty)} pw=${f(r.push35Gp.pw, 2)}`
    )
  }
  console.log('='.repeat(W))
}

function printJson(results: ComboResult[]): void {
  const top = [...results].sort((a, b) => b.score - a.score).slice(0, 5)
  console.log('\n── JSON (Debug-Panel-Export) ──────────────────────────────────────────')
  const out = top.map((r, i) => ({
    _rank:             i + 1,
    _score:            r.score,
    _p25medDy:         +f(r.push25Scat.medianPushDy),
    _p25p90Dy:         +f(r.push25Scat.p90PushDy),
    _p25inC:           p(r.push25Scat.inGivenContact),
    _p25offC:          p(r.push25Scat.offGivenContact),
    _p35medDy:         +f(r.push35Scat.medianPushDy),
    _p35p90Dy:         +f(r.push35Scat.p90PushDy),
    _p35inC:           p(r.push35Scat.inGivenContact),
    _p35offC:          p(r.push35Scat.offGivenContact),
    ...PHYSICS_DEFAULTS,
    pushedFriction:    r.pushedFric,
    collisionTransfer: r.colTransfer,
  }))
  console.log(JSON.stringify(out, null, 2))
}

// ── Instrumentierte Slide-Simulation für Detailanalyse ───────────────────────

interface ContactCapture {
  seed:           number
  landX:          number
  landY:          number
  lateralOff:     number   // m.x − blocker.x am Kontaktpunkt
  thrownYContact: number   // y der geworfenen Tasche am Kontaktmoment
  dot:            number   // Geschwindigkeit in Normalrichtung (Schubkomponente)
  pushAngleDeg:   number   // Winkel Schubrichtung von "geradeaus" in °  (0=vorwärts, 90=seitlich)
  initPushSpd:    number   // Anfangsschubgeschwindigkeit des Blockers (cm/s)
  finalPushedX:   number
  finalPushedY:   number
  pushedDy:       number   // Δy des Blockers (cm)
  outcome:        SackOutcome
  overlapX:       number   // bagDiameter − |lateralOff| beim Erkennen
  overlapY:       number   // bagDiameter − |dy| beim Erkennen
  chosenAxis:     'Y' | 'CC'  // Y = Flächennormale, CC = Zentrum-zu-Zentrum
}

function runSlideCapture(
  thrown:  Mv,
  blocker: BagOnBoard,
  po:      Po,
): ContactCapture | null {
  const movers: Mv[] = [{ ...thrown }]
  const stat   = new Map([[blocker.id, { x: blocker.x, y: blocker.y }]])
  const R2     = BOARD.bagDiameter * BOARD.bagDiameter
  const pf     = po.pushedFriction
  const ct     = po.collisionTransfer
  let cap: ContactCapture | null = null

  for (let step = 0; step < SLIDE.maxSteps; step++) {
    for (const m of movers) {
      const spd = Math.hypot(m.vx, m.vy)
      if (spd < 0.01) continue
      const fac = Math.max(0, spd - m.friction * SLIDE.dt) / spd
      m.vx *= fac; m.vy *= fac
      m.x  += m.vx * SLIDE.dt; m.y += m.vy * SLIDE.dt
    }

    const spawned: Mv[] = []
    for (const m of movers) {
      const spd = Math.hypot(m.vx, m.vy)
      if (spd < 0.01) continue
      for (const [sid, sp] of stat) {
        const dx = sp.x - m.x, dy = sp.y - m.y
        if (dx * dx + dy * dy >= R2) continue
        const d  = Math.sqrt(dx * dx + dy * dy)
        if (d < 0.001) { stat.delete(sid); break }

        // AABB SAT: spiegelt simulate.ts
        const oX = BOARD.bagDiameter - Math.abs(dx)
        const oY = BOARD.bagDiameter - Math.abs(dy)
        let nx: number, ny: number, axis: 'Y' | 'CC'
        if (oX <= 0 || oY <= 0) {
          nx = dx / d; ny = dy / d; axis = 'CC'
        } else if (oY <= oX) {
          nx = 0; ny = Math.sign(dy); axis = 'Y'
        } else {
          nx = dx / d; ny = dy / d; axis = 'CC'
        }
        const dot = m.vx * nx + m.vy * ny

        // Erstkontakt festhalten
        if (cap === null) {
          const angleDeg = Math.atan2(Math.abs(nx), Math.abs(ny) || 1e-9) * 180 / Math.PI
          cap = {
            seed:           -1,
            landX:          thrown.x, landY: thrown.y,
            lateralOff:     m.x - blocker.x,
            thrownYContact: m.y,
            dot:            Math.max(dot, -dot),
            pushAngleDeg:   angleDeg,
            initPushSpd:    0,
            finalPushedX:   blocker.x,
            finalPushedY:   blocker.y,
            pushedDy:       0,
            outcome:        'on',
            overlapX:       oX,
            overlapY:       oY,
            chosenAxis:     axis,
          }
        }

        if (dot > 0) {
          if (cap.initPushSpd === 0) cap.initPushSpd = dot * ct
          spawned.push({ id: sid, x: sp.x, y: sp.y, vx: dot*nx*ct, vy: dot*ny*ct, friction: pf })
          m.vx -= dot * nx; m.vy -= dot * ny
        } else if (m.y > sp.y && m.vy > 0) {
          const dr = -dot
          if (cap.initPushSpd === 0) cap.initPushSpd = dr * ct
          spawned.push({ id: sid, x: sp.x, y: sp.y, vx: -dr*nx*ct, vy: -dr*ny*ct, friction: pf })
          m.vx += dr * nx; m.vy += dr * ny
        } else continue
        stat.delete(sid); break
      }
    }
    movers.push(...spawned)
    if (movers.every(m => Math.hypot(m.vx, m.vy) < 0.01)) break
  }

  if (cap === null) return null

  const finalPos = new Map(movers.map(m => [m.id, { x: m.x, y: m.y }]))
  const bf = finalPos.get(blocker.id) ?? { x: blocker.x, y: blocker.y }
  cap.finalPushedX = bf.x
  cap.finalPushedY = bf.y
  cap.pushedDy     = bf.y - blocker.y
  cap.outcome      = oc(bf.x, bf.y)
  return cap
}

// ── Detailanalyse ─────────────────────────────────────────────────────────────

function bar(n: number, total: number, width = 30): string {
  const filled = total > 0 ? Math.round((n / total) * width) : 0
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function detailedAnalysis(po: Po): void {
  const sig = throwSigma()
  console.log('\n' + '='.repeat(80))
  console.log('DETAILANALYSE  —  Beste Kombo')
  console.log(`pushedFriction=${po.pushedFriction}  collisionTransfer=${po.collisionTransfer}`)
  console.log(`slideVFlat=${po.slideVFlat}  slideVRoll=${po.slideVRoll}  pushFriction=${po.pushFriction}  sigma=${f(sig)} cm`)
  console.log(`Board: Loch y=${BOARD.holeY} cm  Hinterkante y=${BOARD.length} cm  bagDiameter=${BOARD.bagDiameter} cm`)
  console.log('='.repeat(80))

  const scenarios: Array<{ label: string; blocker: BagOnBoard; fl: 'flat' | 'roll' }> = [
    { label: 'push25-scat  (roll / weich, Blocker 25 cm vor Loch)', blocker: BLOCKER25, fl: 'roll' },
    { label: 'push35-scat  (flat / fest, Blocker 35 cm vor Loch)',  blocker: BLOCKER35, fl: 'flat' },
  ]

  for (const { label, blocker, fl } of scenarios) {
    const gp = gridSearch(blocker, fl, po)

    const captures: ContactCapture[] = []
    let total = 0, directIn = 0, directOff = 0

    for (let seed = 0; seed < N_THROWS; seed++) {
      total++
      const rng       = createRng(seed)
      rng()
      const [ox, oy]  = boxMuller(rng, sig)
      const landX     = gp.tx + ox
      const landY     = gp.ty + oy

      if (ih(landX, landY))  { directIn++;  continue }
      if (!ob(landX, landY)) { directOff++; continue }

      const v0    = gp.pw * (fl === 'roll' ? po.slideVRoll : po.slideVFlat)
      const mover: Mv = { id: 'T', x: landX, y: landY, vx: 0, vy: v0, friction: po.pushFriction }
      const cap   = runSlideCapture(mover, blocker, po)
      if (cap !== null) { cap.seed = seed; captures.push(cap) }
    }

    const nContact  = captures.length
    const noContact = total - nContact - directIn - directOff
    const inC  = captures.filter(c => c.outcome === 'in').length
    const onC  = captures.filter(c => c.outcome === 'on').length
    const offC = captures.filter(c => c.outcome === 'off').length

    console.log(`\n╔══ ${label}`)
    console.log(`║   Bester Zielpunkt: tX=${f(gp.tx)} tY=${f(gp.ty)} pw=${f(gp.pw, 2)}`)
    console.log(`║   Blocker: y=${blocker.y} cm  Loch: y=${BOARD.holeY} cm`)
    console.log('╠══')

    console.log('║ 1) KONTAKT')
    console.log(`║    Gesamt Würfe    : ${total}`)
    console.log(`║    Direkt ins Loch : ${directIn}  (landen auf Loch, kein Rutsch nötig)`)
    console.log(`║    Direkt off-Board: ${directOff}`)
    console.log(`║    Kein Kontakt    : ${noContact}  (Tasche kommt nicht bis zum Blocker)`)
    console.log(`║    Mit Kontakt     : ${nContact} / ${total} = ${p(nContact / total)}`)

    if (nContact === 0) { console.log('╚══ kein Kontakt in allen Würfen'); continue }

    console.log('╠══')
    console.log('║ 2) OUTCOME  (bedingt auf Kontakt)')
    console.log(`║    in : ${String(inC).padStart(3)} / ${nContact} = ${p(inC / nContact)}`)
    console.log(`║    on : ${String(onC).padStart(3)} / ${nContact} = ${p(onC / nContact)}`)
    console.log(`║    off: ${String(offC).padStart(3)} / ${nContact} = ${p(offC / nContact)}`)
    console.log('║')
    console.log('║   Sweep-Tabelle vs. Detailanalyse:')
    console.log(`║     ${p(inC / total).padStart(6)} = ${inC}/${total}  — alle Würfe  (Sweep-Tabelle)`)
    console.log(`║     ${p(inC / nContact).padStart(6)} = ${inC}/${nContact}  — nur Kontaktwürfe  (Detailanalyse oben)`)
    console.log(`║     Kontaktrate ${p(nContact / total)} × ${p(inC / nContact)} ≈ ${p(inC / total)}`)

    // 3. Schubweg & Kontaktpunkt
    const pushDys   = captures.map(c => c.pushedDy)
    const medDy     = pct(pushDys, 50)
    const p90Dy     = pct(pushDys, 90)
    const maxFinalY = Math.max(...captures.map(c => c.finalPushedY))
    const offsets   = captures.map(c => c.lateralOff)
    const angles    = captures.map(c => c.pushAngleDeg)
    const initVs    = captures.map(c => c.initPushSpd)

    const meanOff   = avgArr(offsets)
    const stdOff    = Math.sqrt(avgArr(offsets.map(o => (o - meanOff) ** 2)))
    const meanAngle = avgArr(angles)
    const meanInitV = avgArr(initVs)

    console.log('╠══')
    console.log('║ 3) SCHUBWEG & KONTAKTPUNKT')
    console.log(`║    pushedDy    Median=${f(medDy)} cm  p90=${f(p90Dy)} cm  Max-finalY=${f(maxFinalY)} cm`)
    console.log(`║    lateralOff  MW=${f(meanOff, 1)} cm  σ=${f(stdOff, 1)} cm  (+ = Wurf rechts vom Blocker)`)
    console.log(`║    pushAngle   MW=${f(meanAngle, 1)}°  (0°=geradeaus → Loch, 90°=seitlich)`)
    console.log(`║    initPushSpd MW=${f(meanInitV, 1)} cm/s  →  theor. max Schubweg ${f(meanInitV**2/(2*po.pushedFriction), 1)} cm`)
    console.log('║')
    console.log('║    |lateralOff| Verteilung                       In-Quote bei Kontakt')

    const offBuckets: Array<[number, number]> = [[0,3],[3,6],[6,9],[9,12],[12,Infinity]]
    for (const [lo, hi] of offBuckets) {
      const bucket = captures.filter(c => Math.abs(c.lateralOff) >= lo && Math.abs(c.lateralOff) < hi)
      const inB    = bucket.filter(c => c.outcome === 'in').length
      const tag    = hi === Infinity ? `≥${lo} cm  ` : `${lo}–${hi} cm `
      const bStr   = bar(bucket.length, nContact)
      const inStr  = bucket.length > 0 ? `${inB}/${bucket.length} = ${p(inB/bucket.length)}` : '—'
      console.log(`║    ${tag}  ${bStr}  ${String(bucket.length).padStart(3)}  |  ${inStr}`)
    }

    console.log('║')
    console.log('║    Schubwinkel-Verteilung  (0° = geradeaus)')
    const angBuckets: Array<[number, number]> = [[0,10],[10,20],[20,30],[30,45],[45,90]]
    for (const [lo, hi] of angBuckets) {
      const bucket = captures.filter(c => c.pushAngleDeg >= lo && c.pushAngleDeg < hi)
      const inB    = bucket.filter(c => c.outcome === 'in').length
      const tag    = `${lo}–${hi < 90 ? hi : 90}° `
      const bStr   = bar(bucket.length, nContact)
      const inStr  = bucket.length > 0 ? `in ${inB}/${bucket.length} = ${p(inB/bucket.length)}` : '—'
      console.log(`║    ${tag.padEnd(8)}  ${bStr}  ${String(bucket.length).padStart(3)}  |  ${inStr}`)
    }

    // 4. AABB-Achsenanalyse
    console.log('╠══')
    console.log('║ 4) AABB-ACHSENANALYSE  nach |lateralOff|')
    console.log('║')
    console.log('║    Bucket     | Treffer | MW-Winkel | Y-Achse% | In-Rate')
    console.log('║    ──────────────────────────────────────────────────────')
    const axisBuckets: Array<[number, number, string]> = [
      [0, 3, ' 0– 3'], [3, 6, ' 3– 6'], [6, 9, ' 6– 9'], [9, 12, ' 9–12'], [12, 15, '12–15'],
    ]
    for (const [lo, hi, lbl] of axisBuckets) {
      const bucket  = captures.filter(c => Math.abs(c.lateralOff) >= lo && Math.abs(c.lateralOff) < hi)
      if (bucket.length === 0) continue
      const inB     = bucket.filter(c => c.outcome === 'in').length
      const yAxis   = bucket.filter(c => c.chosenAxis === 'Y').length
      const meanAng = avgArr(bucket.map(c => c.pushAngleDeg))
      const yPct    = String(Math.round(yAxis / bucket.length * 100)).padStart(3)
      const inPct   = (inB / bucket.length * 100).toFixed(1).padStart(5)
      console.log(
        `║    ${lbl} cm  |` +
        `     ${String(bucket.length).padStart(3)} |` +
        `    ${f(meanAng, 1).padStart(6)}° |` +
        `     ${yPct}%  |` +
        `  ${inPct}%`
      )
    }
    console.log('║')
    {
      const meanOX = avgArr(captures.map(c => c.overlapX))
      const meanOY = avgArr(captures.map(c => c.overlapY))
      const yCount = captures.filter(c => c.chosenAxis === 'Y').length
      console.log(`║    overlapX MW=${f(meanOX, 1)} cm  overlapY MW=${f(meanOY, 1)} cm  (bei Erkennung)`)
      console.log(`║    Y-Achse: ${yCount}/${nContact} = ${p(yCount / nContact)}  CC-Achse: ${nContact - yCount}/${nContact} = ${p((nContact - yCount) / nContact)}`)
    }

    // 5. Off-Analyse
    console.log('╠══')
    console.log('║ 5) OFF-ANALYSE')
    const backEdge      = BOARD.length
    const minDistToBack = backEdge - maxFinalY
    const holeNearMiss  = captures
      .filter(c => c.outcome === 'on')
      .map(c => Math.hypot(c.finalPushedX - BOARD.holeX, c.finalPushedY - BOARD.holeY))
    const closestMiss = holeNearMiss.length > 0 ? Math.min(...holeNearMiss) : Infinity

    if (offC === 0) {
      console.log(`║    off=0 — Blocker verlässt das Brett in keinem der ${nContact} Kontaktwürfe.`)
      console.log(`║    Max. Blocker-Endposition : y=${f(maxFinalY)} cm`)
      console.log(`║    Abstand zur Hinterkante  : ${f(minDistToBack)} cm  (Brett endet bei y=${backEdge} cm)`)
      console.log(`║    Knappster Fehlwurf (on)  : ${f(closestMiss)} cm vom Lochzentrum  (Lochradius=${BOARD.holeRadius} cm)`)
    } else {
      console.log(`║    off=${offC} / ${nContact} Kontaktwürfe`)
      const offCaptures = captures.filter(c => c.outcome === 'off')
      for (const cap of offCaptures.slice(0, 8)) {
        console.log(
          `║      Seed ${String(cap.seed).padStart(3)}: lateralOff=${f(cap.lateralOff, 1)} cm` +
          `  pushAngle=${f(cap.pushAngleDeg, 1)}°  initV=${f(cap.initPushSpd, 1)} cm/s` +
          `  Dy=${f(cap.pushedDy, 1)} cm  finalY=${f(cap.finalPushedY, 1)} cm`
        )
      }
      console.log(`║    Max. finalY: ${f(maxFinalY)} cm  |  Min. Abstand Hinterkante: ${f(minDistToBack)} cm`)
    }
    console.log('╚══')
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const sig = throwSigma()
  console.log('='.repeat(80))
  console.log('PUSH-BENCH  —  Sweep pushedFriction × collisionTransfer')
  console.log(`Loch: y=${BOARD.holeY} cm, r=${BOARD.holeRadius} cm  |  sigma=${f(sig)} cm  |  N=${N_THROWS}`)
  console.log(`pushedFriction  = [${PUSHED_FRIC_GRID.join(', ')}] cm/s²`)
  console.log(`collisionTransfer = [${COL_TRANSFER_GRID.join(', ')}]`)
  console.log(`Fixe Defaults: slideVFlat=${PHYSICS_DEFAULTS.slideVFlat}  slideVRoll=${PHYSICS_DEFAULTS.slideVRoll}  pushFriction=${PHYSICS_DEFAULTS.pushFriction}`)
  console.log(`→ ${PUSHED_FRIC_GRID.length * COL_TRANSFER_GRID.length} Kombos`)
  console.log('='.repeat(80))

  const allPo: Array<{ pf: number; ct: number }> = []
  for (const pf of PUSHED_FRIC_GRID)
    for (const ct of COL_TRANSFER_GRID)
      allPo.push({ pf, ct })

  // ── Zeitschätzung ──────────────────────────────────────────────────────────
  const PROBE = 5
  console.log(`\nZeitschätzung (${PROBE} Probe-Kombos) …`)
  const t0    = Date.now()
  for (let i = 0; i < PROBE; i++) runCombo(allPo[i].pf, allPo[i].ct)
  const probeMs  = Date.now() - t0
  const totalMs  = (probeMs / PROBE) * allPo.length
  const totalMin = totalMs / 60_000
  console.log(`  ${PROBE} Kombos in ${probeMs} ms  →  ${allPo.length} Kombos geschätzt: ~${totalMin.toFixed(1)} min`)

  if (totalMs > 10 * 60_000) {
    console.log('\nWARNUNG: Schätzung > 10 Minuten!')
    console.log('Bitte PUSHED_FRIC_GRID oder COL_TRANSFER_GRID verkleinern.')
    process.exit(1)
  }
  console.log()

  // ── Sweep ──────────────────────────────────────────────────────────────────
  const results: ComboResult[] = []

  for (let i = 0; i < allPo.length; i++) {
    const { pf, ct } = allPo[i]
    const r = runCombo(pf, ct)
    results.push(r)

    const p25ok = yn(r.push25No.pushedOutcome === 'in')
    const p35ok = yn(r.push35No.pushedOutcome === 'in')
    console.log(
      `[${String(i + 1).padStart(2)}/${allPo.length}]` +
      ` pFric=${String(pf).padStart(3)} cT=${ct.toFixed(1)}` +
      `  p25 med=${f(r.push25Scat.medianPushDy).padStart(4)}cm off@C=${p(r.push25Scat.offGivenContact)} ${p25ok}` +
      `  p35 med=${f(r.push35Scat.medianPushDy).padStart(4)}cm off@C=${p(r.push35Scat.offGivenContact)} ${p35ok}` +
      `  score=${r.score}/11`
    )
  }

  printTable(results)
  printJson(results)

  // Detailanalyse für die beste Kombination
  const best = [...results].sort((a, b) => b.score - a.score)[0]
  detailedAnalysis({
    slideVFlat:        PHYSICS_DEFAULTS.slideVFlat,
    slideVRoll:        PHYSICS_DEFAULTS.slideVRoll,
    pushFriction:      PHYSICS_DEFAULTS.pushFriction,
    pushedFriction:    best.pushedFric,
    collisionTransfer: best.colTransfer,
  })

  console.log('\nFERTIG')
}

main()
