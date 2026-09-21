'use client'

import { useRef, useEffect } from 'react'
import { simulateThrow, createRng, BOARD } from '@cornhole/engine'
import type { BoardState, ThrowInput, ThrowResult, BagOnBoard, Point, FlightType } from '@cornhole/engine'
import {
  makeLayout, worldPt, bagPos, bagHalfSize, holeRadius,
  canvasToBoard, pxPerCm, lerp,
} from '@/lib/projection'
import type { Layout } from '@/lib/projection'

// ---- Constants ----

const TEAM_COLOR    = ['#ef4444', '#3b82f6'] as const
const TEAM_DARK     = ['#7f1d1d', '#1e3a8a'] as const
const TEAM_LIGHT    = ['#fecaca', '#bfdbfe'] as const
const MAX_SWIPE_H   = 0.28
const FLY_SPEED     = 1.3
const SLIDE_MS      = 480
const SETTLED_MS    = 1400
const BAGS_PER_TEAM = 4

// ---- Game types ----

type Phase = 'idle' | 'charging' | 'flying' | 'sliding' | 'settled'

interface SlideAnim {
  id: string
  teamId: 0 | 1
  x0: number; y0: number
  x1: number; y1: number
  outcome: 'in' | 'on' | 'off'
}

interface PendingThrow {
  result: ThrowResult
  newBoardState: BoardState
  prevBoardBags: readonly BagOnBoard[]
  trajectory: Point[]
  thrownTeam: 0 | 1
}

interface GameData {
  layout: Layout
  boardState: BoardState
  seed: number
  team: 0 | 1
  throwsThisRound: number
  bagCount: [number, number]
  scores: [number, number]
  roundHoles: Array<{ teamId: 0 | 1 }>
  aim: { bx: number; by: number }
  phase: Phase
  chargeOrig: { sx: number; sy: number } | null
  chargeCurr: { sx: number; sy: number } | null
  chargePts: Array<{ sx: number; sy: number }>
  previewTraj: Point[] | null
  pending: PendingThrow | null
  flyStart: number
  flyDur: number
  slides: SlideAnim[]
  slideStart: number
  settledAt: number
  lastOutcome: 'in' | 'on' | 'off' | null
  debugMode: boolean
}

function makeGameData(): GameData {
  return {
    layout: makeLayout(390, 844),
    boardState: { bags: [] },
    seed: (Date.now() * 0x9e3779b9) >>> 0,
    team: 0,
    throwsThisRound: 0,
    bagCount: [0, 0],
    scores: [0, 0],
    roundHoles: [],
    aim: { bx: BOARD.holeX, by: BOARD.holeY },
    phase: 'idle',
    chargeOrig: null,
    chargeCurr: null,
    chargePts: [],
    previewTraj: null,
    pending: null,
    flyStart: 0,
    flyDur: 1200,
    slides: [],
    slideStart: 0,
    settledAt: 0,
    lastOutcome: null,
    debugMode: false,
  }
}

// ---- Gesture → ThrowInput ----

function computeThrowInput(g: GameData): ThrowInput | null {
  const { chargeOrig: o, chargeCurr: c, aim } = g
  if (!o || !c) return null
  const dx = c.sx - o.sx
  const dy = o.sy - c.sy   // positive = swiped up
  if (dy < 8) return null

  const dist   = Math.hypot(dx, dy)
  const maxLen = g.layout.cssH * MAX_SWIPE_H
  const power  = Math.min(dist / maxLen, 1)
  const angle  = Math.atan2(dx, dy)

  let spin = 0
  const pts = g.chargePts
  if (pts.length >= 12) {
    const tail = pts.slice(-10)
    const rdx  = tail[tail.length - 1].sx - tail[0].sx
    const rdy  = tail[0].sy - tail[tail.length - 1].sy
    const ra   = Math.atan2(rdx, rdy)
    let da = ra - angle
    if (da > Math.PI)  da -= 2 * Math.PI
    if (da < -Math.PI) da += 2 * Math.PI
    spin = Math.max(-1, Math.min(1, da * 1.8))
  }

  const flightType: FlightType =
    power > 0.70 ? 'airmail' : power < 0.36 ? 'roll' : 'flat'

  const aimX = Math.max(-BOARD.halfWidth,
    Math.min(BOARD.halfWidth, aim.bx + Math.sin(angle) * 14))

  return {
    teamId: g.team,
    targetX: aimX,
    targetY: aim.by,
    power,
    spin,
    flightType,
    skillLevel: 0.72,
    focus: Math.max(0.3, 0.85 - Math.min(1, Math.abs(angle) / (Math.PI / 4)) * 0.55),
  }
}

// ---- Trajectory interpolation ----

function sampleTraj(traj: Point[], tNorm: number): { x: number; y: number; z: number } {
  if (traj.length === 0) return { x: 0, y: 0, z: 0 }
  if (tNorm <= 0) return { ...traj[0] }
  if (tNorm >= 1) return { ...traj[traj.length - 1] }
  const total  = traj[traj.length - 1].t
  const target = tNorm * total
  let lo = 0, hi = traj.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (traj[mid].t <= target) lo = mid; else hi = mid
  }
  const a = traj[lo], b = traj[hi]
  const f = b.t > a.t ? (target - a.t) / (b.t - a.t) : 0
  return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), z: lerp(a.z, b.z, f) }
}

// ---- Game update ----

function update(g: GameData, ts: number) {
  if (g.phase === 'flying' && g.pending) {
    if (ts - g.flyStart >= g.flyDur) {
      const { result: r, prevBoardBags, trajectory, thrownTeam } = g.pending
      const land = trajectory[trajectory.length - 1]
      const slides: SlideAnim[] = [
        {
          id: r.thrownBag.id, teamId: thrownTeam,
          x0: land.x, y0: land.y,
          x1: r.thrownBag.finalX, y1: r.thrownBag.finalY,
          outcome: r.thrownBag.outcome,
        },
        ...r.pushedBags.map(pb => {
          const orig = prevBoardBags.find(b => b.id === pb.id)!
          return {
            id: pb.id, teamId: orig.teamId,
            x0: orig.x, y0: orig.y,
            x1: pb.finalX, y1: pb.finalY,
            outcome: pb.outcome,
          } as SlideAnim
        }),
      ]
      g.phase = 'sliding'
      g.slides = slides
      g.slideStart = ts
    }
    return
  }

  if (g.phase === 'sliding') {
    if (ts - g.slideStart >= SLIDE_MS) {
      const r = g.pending!.result
      if (r.thrownBag.outcome === 'in')
        g.roundHoles.push({ teamId: g.pending!.thrownTeam })
      for (const pb of r.pushedBags) {
        if (pb.outcome === 'in') {
          const orig = g.pending!.prevBoardBags.find(b => b.id === pb.id)
          if (orig) g.roundHoles.push({ teamId: orig.teamId })
        }
      }
      g.boardState  = g.pending!.newBoardState
      g.lastOutcome = r.thrownBag.outcome
      g.phase       = 'settled'
      g.settledAt   = ts
    }
    return
  }

  if (g.phase === 'settled') {
    if (ts - g.settledAt < SETTLED_MS) return
    g.throwsThisRound++
    g.bagCount[g.pending!.thrownTeam]++
    const TOTAL = BAGS_PER_TEAM * 2
    if (g.throwsThisRound < BAGS_PER_TEAM) {
      g.team = 0
    } else if (g.throwsThisRound < TOTAL) {
      g.team = 1
    } else {
      const on0  = g.boardState.bags.filter(b => b.teamId === 0).length
      const on1  = g.boardState.bags.filter(b => b.teamId === 1).length
      const h0   = g.roundHoles.filter(h => h.teamId === 0).length
      const h1   = g.roundHoles.filter(h => h.teamId === 1).length
      const pts0 = h0 * 3 + on0
      const pts1 = h1 * 3 + on1
      const diff = pts0 - pts1
      if (diff > 0) g.scores[0] += diff
      else if (diff < 0) g.scores[1] += -diff
      g.boardState      = { bags: [] }
      g.throwsThisRound = 0
      g.bagCount        = [0, 0]
      g.roundHoles      = []
      g.team            = 0
    }
    g.pending     = null
    g.lastOutcome = null
    g.phase       = 'idle'
    g.seed        = ((g.seed * 0x19660d + 0x3c6ef35f) >>> 0)
  }
}

// ---- Rendering ----

const GRASS_TOP  = '#1a3d12'
const GRASS_BOT  = '#2d5a1f'
const WOOD_NEAR  = '#c78b3a'
const WOOD_FAR   = '#a06520'
const WOOD_FRAME = '#5c300a'
const HOLE_COLOR = '#0d0600'
const HOLE_RIM   = '#3a1e08'

function drawBackground(ctx: CanvasRenderingContext2D, lt: Layout) {
  const { cssW: W, cssH: H } = lt
  const grad = ctx.createLinearGradient(0, lt.hudH, 0, H)
  grad.addColorStop(0, GRASS_TOP)
  grad.addColorStop(1, GRASS_BOT)
  ctx.fillStyle = grad
  ctx.fillRect(0, lt.hudH, W, H - lt.hudH)

  ctx.strokeStyle = 'rgba(0,0,0,0.1)'
  ctx.lineWidth = 1
  for (let i = 1; i <= 5; i++) {
    const ty = i / 6
    const lx = lerp(lt.frontLeft.x, lt.backLeft.x, ty)
    const rx = lerp(lt.frontRight.x, lt.backRight.x, ty)
    const y  = lerp(lt.frontLeft.y, lt.backLeft.y, ty)
    ctx.beginPath(); ctx.moveTo(lx, y); ctx.lineTo(rx, y); ctx.stroke()
  }
}

function drawBoard(ctx: CanvasRenderingContext2D, lt: Layout) {
  const { frontLeft: FL, frontRight: FR, backLeft: BL, backRight: BR } = lt

  // Drop shadow
  ctx.save()
  ctx.shadowBlur = 20
  ctx.shadowColor = 'rgba(0,0,0,0.5)'
  ctx.shadowOffsetY = 4
  ctx.beginPath()
  ctx.moveTo(FL.x, FL.y); ctx.lineTo(FR.x, FR.y)
  ctx.lineTo(BR.x, BR.y); ctx.lineTo(BL.x, BL.y)
  ctx.closePath()
  ctx.fillStyle = WOOD_NEAR
  ctx.fill()
  ctx.restore()

  // Wood surface
  ctx.beginPath()
  ctx.moveTo(FL.x, FL.y); ctx.lineTo(FR.x, FR.y)
  ctx.lineTo(BR.x, BR.y); ctx.lineTo(BL.x, BL.y)
  ctx.closePath()
  const woodGrad = ctx.createLinearGradient(lt.cssW / 2, FL.y, lt.cssW / 2, BL.y)
  woodGrad.addColorStop(0,   WOOD_NEAR)
  woodGrad.addColorStop(0.55, '#b87a2a')
  woodGrad.addColorStop(1,   WOOD_FAR)
  ctx.fillStyle = woodGrad
  ctx.fill()

  // Grain lines
  ctx.strokeStyle = 'rgba(255,255,255,0.055)'
  ctx.lineWidth = 1
  for (let i = 1; i <= 4; i++) {
    const tx = i / 5
    const t0 = worldPt(-30 + tx * 60, 0,   0, lt)
    const t1 = worldPt(-30 + tx * 60, 120, 0, lt)
    ctx.beginPath(); ctx.moveTo(t0.x, t0.y); ctx.lineTo(t1.x, t1.y); ctx.stroke()
  }

  // Frame border
  ctx.beginPath()
  ctx.moveTo(FL.x, FL.y); ctx.lineTo(FR.x, FR.y)
  ctx.lineTo(BR.x, BR.y); ctx.lineTo(BL.x, BL.y)
  ctx.closePath()
  ctx.strokeStyle = WOOD_FRAME
  ctx.lineWidth = 2.5
  ctx.stroke()

  // Hole rim + hole
  const hPos = bagPos(BOARD.holeX, BOARD.holeY, lt)
  const hTy  = BOARD.holeY / 120
  const hr   = holeRadius(hTy, lt)

  ctx.beginPath()
  ctx.arc(hPos.x, hPos.y, hr * 1.18, 0, Math.PI * 2)
  ctx.fillStyle = HOLE_RIM
  ctx.fill()

  ctx.beginPath()
  ctx.arc(hPos.x, hPos.y, hr, 0, Math.PI * 2)
  ctx.fillStyle = HOLE_COLOR
  ctx.fill()
}

// Flat rounded-square bag — lies on the board, no sphere shading
function drawBag(
  ctx: CanvasRenderingContext2D,
  bx: number, by: number,
  teamId: 0 | 1,
  lt: Layout,
  alpha = 1,
) {
  const { x, y } = bagPos(bx, by, lt)
  const ty  = by / 120
  const hs  = bagHalfSize(ty, lt)   // half of 15 cm side in px
  const hsY = hs * 0.70              // foreshortened in depth direction
  const r   = hs * 0.28             // corner radius

  ctx.globalAlpha = alpha

  // Soft shadow (offset slightly down)
  ctx.save()
  ctx.shadowBlur    = hs * 0.9
  ctx.shadowColor   = 'rgba(0,0,0,0.45)'
  ctx.shadowOffsetY = hs * 0.35
  ctx.beginPath()
  ctx.roundRect(x - hs, y - hsY, hs * 2, hsY * 2, r)
  ctx.fillStyle = TEAM_COLOR[teamId]
  ctx.fill()
  ctx.restore()

  // Bag face — flat fill with minimal top-light edge
  ctx.beginPath()
  ctx.roundRect(x - hs, y - hsY, hs * 2, hsY * 2, r)
  ctx.fillStyle = TEAM_COLOR[teamId]
  ctx.fill()

  // Subtle highlight stripe at top (flat light, not sphere)
  const hl = ctx.createLinearGradient(x, y - hsY, x, y - hsY + hsY * 0.5)
  hl.addColorStop(0, 'rgba(255,255,255,0.22)')
  hl.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.beginPath()
  ctx.roundRect(x - hs, y - hsY, hs * 2, hsY * 2, r)
  ctx.fillStyle = hl
  ctx.fill()

  // Border
  ctx.beginPath()
  ctx.roundRect(x - hs, y - hsY, hs * 2, hsY * 2, r)
  ctx.strokeStyle = TEAM_LIGHT[teamId] + '88'
  ctx.lineWidth = Math.max(0.8, hs * 0.1)
  ctx.stroke()

  ctx.globalAlpha = 1
}

// Flying bag — same flat style but round (no foreshortening while airborne)
function drawFlyingBag(
  ctx: CanvasRenderingContext2D,
  sx: number, sy: number,
  ty: number,
  teamId: 0 | 1,
  lt: Layout,
) {
  const hs = bagHalfSize(Math.max(0, Math.min(1, ty)), lt)
  const r  = hs * 0.28

  ctx.save()
  ctx.shadowBlur  = hs * 0.8
  ctx.shadowColor = 'rgba(0,0,0,0.4)'
  ctx.beginPath()
  ctx.roundRect(sx - hs, sy - hs, hs * 2, hs * 2, r)
  ctx.fillStyle = TEAM_COLOR[teamId]
  ctx.fill()
  ctx.restore()

  ctx.beginPath()
  ctx.roundRect(sx - hs, sy - hs, hs * 2, hs * 2, r)
  ctx.fillStyle = TEAM_COLOR[teamId]
  ctx.fill()

  const hl = ctx.createLinearGradient(sx, sy - hs, sx, sy)
  hl.addColorStop(0, 'rgba(255,255,255,0.25)')
  hl.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.beginPath()
  ctx.roundRect(sx - hs, sy - hs, hs * 2, hs * 2, r)
  ctx.fillStyle = hl
  ctx.fill()

  ctx.beginPath()
  ctx.roundRect(sx - hs, sy - hs, hs * 2, hs * 2, r)
  ctx.strokeStyle = TEAM_LIGHT[teamId] + '88'
  ctx.lineWidth = Math.max(0.8, hs * 0.1)
  ctx.stroke()
}

function drawCrosshair(ctx: CanvasRenderingContext2D, bx: number, by: number, lt: Layout) {
  const { x, y } = bagPos(bx, by, lt)
  const ty   = by / 120
  const size = Math.max(10, pxPerCm(ty, lt) * 14)

  ctx.strokeStyle = 'rgba(255,230,50,0.85)'
  ctx.lineWidth   = 1.5
  ctx.setLineDash([4, 3])

  ctx.beginPath()
  ctx.arc(x, y, size * 0.7, 0, Math.PI * 2)
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(x - size, y); ctx.lineTo(x - size * 0.38, y)
  ctx.moveTo(x + size * 0.38, y); ctx.lineTo(x + size, y)
  ctx.moveTo(x, y - size); ctx.lineTo(x, y - size * 0.38)
  ctx.moveTo(x, y + size * 0.38); ctx.lineTo(x, y + size)
  ctx.stroke()
  ctx.setLineDash([])
}

function drawTrajectoryLine(
  ctx: CanvasRenderingContext2D,
  traj: Point[],
  lt: Layout,
  upTo: number,
  color: string,
  dashed: boolean,
) {
  if (traj.length < 2 || upTo <= 0) return
  const n = Math.max(2, Math.floor(traj.length * upTo))
  ctx.beginPath()
  const p0 = worldPt(traj[0].x, traj[0].y, traj[0].z, lt)
  ctx.moveTo(p0.x, p0.y)
  for (let i = 1; i < n; i++) {
    const p = worldPt(traj[i].x, traj[i].y, traj[i].z, lt)
    ctx.lineTo(p.x, p.y)
  }
  ctx.strokeStyle = color
  ctx.lineWidth   = 2
  if (dashed) ctx.setLineDash([5, 5])
  ctx.stroke()
  if (dashed) ctx.setLineDash([])
}

// Debug overlay: 10 cm grid + exact hole circle
function drawDebugOverlay(ctx: CanvasRenderingContext2D, lt: Layout) {
  // 10 cm grid in x (width) direction
  ctx.strokeStyle = 'rgba(0,255,255,0.35)'
  ctx.lineWidth = 0.8
  ctx.setLineDash([3, 3])
  for (let cx_cm = -30; cx_cm <= 30; cx_cm += 10) {
    const p0 = worldPt(cx_cm, 0,   0, lt)
    const p1 = worldPt(cx_cm, 120, 0, lt)
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke()
  }
  // 10 cm grid in y (depth) direction
  for (let cy_cm = 0; cy_cm <= 120; cy_cm += 10) {
    const p0 = worldPt(-30, cy_cm, 0, lt)
    const p1 = worldPt( 30, cy_cm, 0, lt)
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke()
  }
  ctx.setLineDash([])

  // Exact hole circle (diameter 15.2 cm → radius 7.6 cm)
  const hPos = bagPos(BOARD.holeX, BOARD.holeY, lt)
  const hTy  = BOARD.holeY / 120
  const hr   = holeRadius(hTy, lt)
  ctx.beginPath()
  ctx.arc(hPos.x, hPos.y, hr, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(255,0,255,0.9)'
  ctx.lineWidth = 1.5
  ctx.stroke()

  // Label the grid centre lines
  ctx.fillStyle = 'rgba(0,255,255,0.7)'
  ctx.font = `${Math.max(8, pxPerCm(0, lt) * 4)}px monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (let cy_cm = 0; cy_cm <= 120; cy_cm += 10) {
    const p = worldPt(0, cy_cm, 0, lt)
    ctx.fillText(`${cy_cm}`, p.x, p.y + 2)
  }
}

function drawHUD(ctx: CanvasRenderingContext2D, g: GameData, lt: Layout) {
  const { cssW: W, hudH: H } = lt
  ctx.fillStyle = 'rgba(0,0,0,0.72)'
  ctx.fillRect(0, 0, W, H)

  ctx.font = `bold ${Math.round(H * 0.55)}px system-ui,sans-serif`
  ctx.textBaseline = 'middle'

  ctx.fillStyle = TEAM_COLOR[0]
  ctx.textAlign = 'right'
  ctx.fillText(String(g.scores[0]), W * 0.45, H * 0.5)

  ctx.fillStyle = 'rgba(255,255,255,0.4)'
  ctx.textAlign = 'center'
  ctx.font = `${Math.round(H * 0.38)}px system-ui,sans-serif`
  ctx.fillText(':', W * 0.5, H * 0.48)

  ctx.fillStyle = TEAM_COLOR[1]
  ctx.textAlign = 'left'
  ctx.font = `bold ${Math.round(H * 0.55)}px system-ui,sans-serif`
  ctx.fillText(String(g.scores[1]), W * 0.55, H * 0.5)

  const dotR    = Math.max(3, H * 0.09)
  const dotY    = H * 0.82
  const spacing = dotR * 2.8
  const base0   = W / 2 - BAGS_PER_TEAM * spacing - spacing * 0.5
  const base1   = W / 2 + spacing * 0.5
  for (let i = 0; i < BAGS_PER_TEAM; i++) {
    ctx.beginPath()
    ctx.arc(base0 + i * spacing, dotY, dotR, 0, Math.PI * 2)
    ctx.fillStyle = i < g.bagCount[0] ? TEAM_COLOR[0] : 'rgba(255,255,255,0.15)'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(base1 + i * spacing, dotY, dotR, 0, Math.PI * 2)
    ctx.fillStyle = i < g.bagCount[1] ? TEAM_COLOR[1] : 'rgba(255,255,255,0.15)'
    ctx.fill()
  }

  if (g.debugMode) {
    ctx.fillStyle = 'rgba(0,255,255,0.8)'
    ctx.font = `${Math.round(H * 0.28)}px monospace`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'
    ctx.fillText('DEBUG', W - 6, 4)
  }
}

function drawThrowZone(ctx: CanvasRenderingContext2D, g: GameData, lt: Layout) {
  const { cssW: W, cssH: H, throwZoneY: zy } = lt
  const zh    = H - zy
  const color = TEAM_COLOR[g.team]
  const dark  = TEAM_DARK[g.team]

  const bg = ctx.createLinearGradient(0, zy, 0, H)
  bg.addColorStop(0, 'rgba(0,0,0,0.55)')
  bg.addColorStop(1, 'rgba(0,0,0,0.75)')
  ctx.fillStyle = bg
  ctx.fillRect(0, zy, W, zh)

  ctx.strokeStyle = `${color}55`
  ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.moveTo(0, zy); ctx.lineTo(W, zy); ctx.stroke()

  const cx = W / 2
  const cy = zy + zh * 0.5
  const ir = Math.min(zh * 0.30, 28)

  ctx.beginPath()
  ctx.arc(cx, cy, ir + 4, 0, Math.PI * 2)
  ctx.fillStyle = `${dark}88`
  ctx.fill()

  ctx.beginPath()
  ctx.arc(cx, cy, ir, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()

  if (g.phase === 'idle' || g.phase === 'charging') {
    for (let i = 0; i < 3; i++) {
      const alpha = (i + 1) / 3
      const ay = zy + zh * 0.14 + i * zh * 0.07
      ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.45})`
      ctx.lineWidth = 2
      ctx.lineJoin = 'round'
      const s = 12
      ctx.beginPath()
      ctx.moveTo(cx - s, ay + s * 0.5)
      ctx.lineTo(cx, ay - s * 0.5)
      ctx.lineTo(cx + s, ay + s * 0.5)
      ctx.stroke()
    }
  }

  if (g.phase === 'charging' && g.chargeOrig && g.chargeCurr) {
    const dx    = g.chargeCurr.sx - g.chargeOrig.sx
    const dy    = g.chargeOrig.sy - g.chargeCurr.sy
    const dist  = Math.hypot(dx, dy)
    const power = Math.min(dist / (lt.cssH * MAX_SWIPE_H), 1)
    const arcR  = ir + 10

    ctx.strokeStyle = color
    ctx.lineWidth = 4
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.arc(cx, cy, arcR, -Math.PI / 2, -Math.PI / 2 + power * 2 * Math.PI)
    ctx.stroke()
    ctx.lineCap = 'butt'

    ctx.fillStyle = 'rgba(255,255,255,0.8)'
    ctx.font = `bold ${Math.round(ir * 0.62)}px system-ui,sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(`${Math.round(power * 100)}%`, cx, cy)
  }
}

function drawOutcomeLabel(ctx: CanvasRenderingContext2D, outcome: 'in' | 'on' | 'off', lt: Layout) {
  const label = outcome === 'in' ? 'HOLE!'
              : outcome === 'on' ? 'ON BOARD'
              : 'MISS'
  const color = outcome === 'in' ? '#fcd34d'
              : outcome === 'on' ? '#86efac'
              : '#fca5a5'
  const cx = lt.cssW / 2
  const cy = (lt.frontLeft.y + lt.backLeft.y) / 2

  ctx.save()
  ctx.font = `bold ${Math.round(lt.cssW * 0.065)}px system-ui,sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const m   = ctx.measureText(label)
  const pad = 14
  ctx.fillStyle = 'rgba(0,0,0,0.7)'
  ctx.roundRect(cx - m.width / 2 - pad, cy - 22, m.width + pad * 2, 44, 10)
  ctx.fill()
  ctx.fillStyle = color
  ctx.fillText(label, cx, cy)
  ctx.restore()
}

// ---- Main render ----

function render(ctx: CanvasRenderingContext2D, g: GameData, ts: number) {
  const lt = g.layout
  ctx.clearRect(0, 0, lt.cssW, lt.cssH)

  drawBackground(ctx, lt)
  drawBoard(ctx, lt)

  if (g.debugMode) drawDebugOverlay(ctx, lt)

  if (g.phase === 'idle' || g.phase === 'charging') {
    for (const b of g.boardState.bags) drawBag(ctx, b.x, b.y, b.teamId, lt)
    drawCrosshair(ctx, g.aim.bx, g.aim.by, lt)
  }

  if (g.phase === 'charging' && g.previewTraj) {
    drawTrajectoryLine(ctx, g.previewTraj, lt, 1, 'rgba(255,220,60,0.55)', true)
  }

  if (g.phase === 'flying' && g.pending) {
    const traj       = g.pending.trajectory
    const flyDurSec  = g.flyDur / 1000
    const elapsed    = (ts - g.flyStart) / 1000
    const tNorm      = Math.min(elapsed / flyDurSec, 1)

    for (const b of g.pending.prevBoardBags) drawBag(ctx, b.x, b.y, b.teamId, lt)
    drawTrajectoryLine(ctx, traj, lt, tNorm, 'rgba(255,240,100,0.7)', false)

    const p      = sampleTraj(traj, tNorm)
    const sPos   = worldPt(p.x, p.y, p.z, lt)
    const ty     = Math.max(0, Math.min(1, p.y / 120))
    drawFlyingBag(ctx, sPos.x, sPos.y, ty, g.pending.thrownTeam, lt)
  }

  if (g.phase === 'sliding' && g.slides.length > 0) {
    const tSlide = Math.min((ts - g.slideStart) / SLIDE_MS, 1)
    const ease   = 1 - Math.pow(1 - tSlide, 3)
    const slidingIds = new Set(g.slides.map(s => s.id))
    for (const b of g.pending!.prevBoardBags) {
      if (!slidingIds.has(b.id)) drawBag(ctx, b.x, b.y, b.teamId, lt)
    }
    for (const s of g.slides) {
      const bx    = lerp(s.x0, s.x1, ease)
      const by    = lerp(s.y0, s.y1, ease)
      const alpha = s.outcome === 'off' ? 1 - ease : 1
      if (alpha > 0.02) drawBag(ctx, bx, by, s.teamId, lt, alpha)
    }
  }

  if (g.phase === 'settled') {
    for (const b of g.boardState.bags) drawBag(ctx, b.x, b.y, b.teamId, lt)
    if (g.lastOutcome) drawOutcomeLabel(ctx, g.lastOutcome, lt)
  }

  drawThrowZone(ctx, g, lt)
  drawHUD(ctx, g, lt)
}

// ---- React component ----

export function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const g = makeGameData()
    let dpr   = 1
    let rafId = 0

    function resize() {
      dpr = window.devicePixelRatio || 1
      const w = canvas!.clientWidth  || 390
      const h = canvas!.clientHeight || 844
      canvas!.width  = Math.round(w * dpr)
      canvas!.height = Math.round(h * dpr)
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.layout = makeLayout(w, h)
    }

    let activePointerId = -1

    function canvasXY(e: PointerEvent): { sx: number; sy: number } {
      const rect = canvas!.getBoundingClientRect()
      return { sx: e.clientX - rect.left, sy: e.clientY - rect.top }
    }

    function onPointerDown(e: PointerEvent) {
      if (activePointerId !== -1) return
      if (g.phase === 'flying' || g.phase === 'sliding') return
      const { sx, sy } = canvasXY(e)
      const lt = g.layout

      if (sy >= lt.throwZoneY) {
        if (g.phase === 'idle' || g.phase === 'settled') {
          activePointerId = e.pointerId
          canvas!.setPointerCapture(e.pointerId)
          g.phase      = 'charging'
          g.chargeOrig = { sx, sy }
          g.chargeCurr = { sx, sy }
          g.chargePts  = [{ sx, sy }]
          g.previewTraj = null
        }
      } else {
        if (g.phase === 'idle' || g.phase === 'settled') {
          const bPos = canvasToBoard(sx, sy, lt)
          if (bPos) g.aim = { bx: bPos.bx, by: Math.max(10, Math.min(115, bPos.by)) }
        }
      }
    }

    function onPointerMove(e: PointerEvent) {
      if (e.pointerId !== activePointerId) return
      const { sx, sy } = canvasXY(e)
      g.chargeCurr = { sx, sy }
      g.chargePts.push({ sx, sy })
      if (g.chargePts.length > 60) g.chargePts.shift()

      const input = computeThrowInput(g)
      if (input) {
        const previewInput: ThrowInput = { ...input, skillLevel: 1, focus: 1 }
        try {
          const { trajectory } = simulateThrow(g.boardState, previewInput, createRng(0))
          g.previewTraj = trajectory
        } catch { g.previewTraj = null }
      }
    }

    function onPointerUp(e: PointerEvent) {
      if (e.pointerId !== activePointerId) return
      activePointerId = -1

      if (g.phase !== 'charging') return
      g.phase       = 'idle'
      g.previewTraj = null

      const input = computeThrowInput(g)
      if (!input) {
        g.chargeOrig = null; g.chargeCurr = null; g.chargePts = []
        return
      }

      const prevBags = [...g.boardState.bags]
      const { state: newBoardState, trajectory, result } = simulateThrow(
        g.boardState, input, createRng(g.seed),
      )
      g.pending = { result, newBoardState, prevBoardBags: prevBags, trajectory, thrownTeam: g.team }
      g.flyStart = performance.now()
      g.flyDur   = (trajectory[trajectory.length - 1].t / FLY_SPEED) * 1000
      g.phase    = 'flying'
      g.chargeOrig = null; g.chargeCurr = null; g.chargePts = []
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'd' || e.key === 'D') g.debugMode = !g.debugMode
    }

    function loop(ts: number) {
      update(g, ts)
      render(ctx!, g, ts)
      rafId = requestAnimationFrame(loop)
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    canvas.addEventListener('pointerdown',   onPointerDown,  { passive: true })
    canvas.addEventListener('pointermove',   onPointerMove,  { passive: true })
    canvas.addEventListener('pointerup',     onPointerUp,    { passive: true })
    canvas.addEventListener('pointercancel', onPointerUp,    { passive: true })
    canvas.addEventListener('contextmenu', e => e.preventDefault())
    window.addEventListener('keydown', onKeyDown)

    rafId = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(rafId)
      ro.disconnect()
      canvas.removeEventListener('pointerdown',   onPointerDown)
      canvas.removeEventListener('pointermove',   onPointerMove)
      canvas.removeEventListener('pointerup',     onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="block w-full h-full"
      style={{ touchAction: 'none', userSelect: 'none' }}
    />
  )
}
