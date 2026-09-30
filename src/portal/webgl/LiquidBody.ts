export type LiquidBodySnapshot = {
  modes: Float32Array
  nodes: Float32Array
  restNodes: Float32Array
  nodeCount: number
  areaRatio: number
  pointerX: number
  pointerY: number
  pointerRadius: number
  pressure: number
  timestep: number
}

export type LiquidBodyPreset = 'button' | 'panel'
export type LiquidBodyOptions = { preset?: LiquidBodyPreset }

const TAU = Math.PI * 2
const FIXED_STEP = 1 / 120

/**
 * @deprecated The visible renderer uses its analytic deformation field. This
 * boundary model remains only for the developer contour/debug view until the
 * debug UI is migrated.
 */
export class LiquidBody {
  readonly nodeCount: number
  private readonly x: Float32Array
  private readonly y: Float32Array
  private readonly vx: Float32Array
  private readonly vy: Float32Array
  private readonly nextVx: Float32Array
  private readonly nextVy: Float32Array
  private readonly restX: Float32Array
  private readonly restY: Float32Array
  private readonly radialNodes: Float32Array
  private readonly restRadialNodes: Float32Array
  private readonly modes = new Float32Array(8)
  private readonly restArea: number
  private accumulator = 0
  private lastTime = 0
  private pointerX = 0
  private pointerY = 0
  private pointerVelocityX = 0
  private pointerVelocityY = 0
  private pressTarget = 0
  private pressure = 0
  private areaRatio = 1
  private reducedMotion = false
  private readonly forceScale: number
  private readonly tensionScale: number
  private readonly damping: number

  constructor(options: LiquidBodyOptions = {}) {
    const nodeCount = typeof window !== 'undefined' && window.matchMedia('(max-width: 700px)').matches ? 48 : 64
    const preset = options.preset ?? 'button'
    this.forceScale = preset === 'panel' ? .42 : 1
    this.tensionScale = preset === 'panel' ? 1.25 : 1
    this.damping = preset === 'panel' ? .978 : .965
    this.nodeCount = nodeCount
    this.x = new Float32Array(nodeCount)
    this.y = new Float32Array(nodeCount)
    this.vx = new Float32Array(nodeCount)
    this.vy = new Float32Array(nodeCount)
    this.nextVx = new Float32Array(nodeCount)
    this.nextVy = new Float32Array(nodeCount)
    this.restX = new Float32Array(nodeCount)
    this.restY = new Float32Array(nodeCount)
    this.radialNodes = new Float32Array(nodeCount)
    this.restRadialNodes = new Float32Array(nodeCount)
    for (let index = 0; index < nodeCount; index++) {
      const angle = index / nodeCount * TAU
      this.x[index] = this.restX[index] = Math.cos(angle)
      this.y[index] = this.restY[index] = Math.sin(angle)
      this.radialNodes[index] = this.restRadialNodes[index] = 1
    }
    this.restArea = this.polygonArea(this.x, this.y)
    this.reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  setPointer(x: number, y: number, pressed: number, velocityX: number, velocityY: number): void {
    this.pointerX = Math.max(-1.25, Math.min(1.25, x))
    this.pointerY = Math.max(-1.25, Math.min(1.25, y))
    this.pointerVelocityX = Math.max(-4, Math.min(4, velocityX))
    this.pointerVelocityY = Math.max(-4, Math.min(4, velocityY))
    this.pressTarget = pressed
  }

  step(now: number): void {
    if (!this.lastTime) { this.lastTime = now; return }
    const frameDelta = Math.min(.05, Math.max(0, (now - this.lastTime) / 1000))
    this.lastTime = now
    this.accumulator = Math.min(.08, this.accumulator + frameDelta)
    let steps = 0
    while (this.accumulator >= FIXED_STEP && steps < 6) {
      this.integrate(FIXED_STEP)
      this.accumulator -= FIXED_STEP
      steps++
    }
    this.projectModes()
  }

  snapshot(): LiquidBodySnapshot {
    for (let index = 0; index < this.nodeCount; index++) this.radialNodes[index] = Math.hypot(this.x[index], this.y[index])
    return {
      modes: this.modes,
      nodes: this.radialNodes,
      restNodes: this.restRadialNodes,
      nodeCount: this.nodeCount,
      areaRatio: this.areaRatio,
      pointerX: this.pointerX,
      pointerY: this.pointerY,
      pointerRadius: .72,
      pressure: this.pressure,
      timestep: FIXED_STEP,
    }
  }

  private integrate(dt: number): void {
    const n = this.nodeCount
    this.pressure += (this.pressTarget - this.pressure) * (this.reducedMotion ? .34 : .27)
    const damping = this.reducedMotion ? .84 : this.damping
    const pointerRadius = .56
    const area = this.polygonArea(this.x, this.y)
    this.areaRatio = area / this.restArea
    const areaForce = Math.max(-.2, Math.min(.2, (1 - this.areaRatio) * (this.reducedMotion ? .85 : 1.7)))
    this.nextVx.fill(0)
    this.nextVy.fill(0)

    for (let index = 0; index < n; index++) {
      const prev = (index + n - 1) % n
      const next = (index + 1) % n
      const px = this.x[index]
      const py = this.y[index]
      const tangentX = this.x[next] - this.x[prev]
      const tangentY = this.y[next] - this.y[prev]
      const tangentLength = Math.max(.001, Math.hypot(tangentX, tangentY))
      const normalX = -tangentY / tangentLength
      const normalY = tangentX / tangentLength
      const neighborAverageX = (this.x[prev] + this.x[next]) * .5
      const neighborAverageY = (this.y[prev] + this.y[next]) * .5
      let ax = (neighborAverageX - px) * (this.reducedMotion ? 7.5 : 11.5) * this.tensionScale
      let ay = (neighborAverageY - py) * (this.reducedMotion ? 7.5 : 11.5) * this.tensionScale
      ax += normalX * areaForce
      ay += normalY * areaForce

      const dx = px - this.pointerX
      const dy = py - this.pointerY
      const influence = Math.exp(-(dx * dx + dy * dy) / (pointerRadius * pointerRadius)) * this.pressure
      const distance = Math.max(.001, Math.hypot(dx, dy))
      // Pressure pushes fluid away from the contact point. The area term above
      // then redistributes the displaced volume across the whole boundary.
      ax += dx / distance * influence * 14.5 * this.forceScale
      ay += dy / distance * influence * 14.5 * this.forceScale
      ax += this.pointerVelocityX * influence * .3 * this.forceScale
      ay += this.pointerVelocityY * influence * .3 * this.forceScale

      this.nextVx[index] = (this.vx[index] + ax * dt) * damping
      this.nextVy[index] = (this.vy[index] + ay * dt) * damping
    }

    for (let index = 0; index < n; index++) {
      this.vx[index] = this.nextVx[index]
      this.vy[index] = this.nextVy[index]
      this.x[index] += this.vx[index] * dt
      this.y[index] += this.vy[index] * dt
      const radius = Math.hypot(this.x[index], this.y[index])
      if (radius > 1.22) { this.x[index] *= 1.22 / radius; this.y[index] *= 1.22 / radius }
      if (radius < .76) { this.x[index] *= .76 / Math.max(.001, radius); this.y[index] *= .76 / Math.max(.001, radius) }
    }
  }

  private projectModes(): void {
    this.modes.fill(0)
    const n = this.nodeCount
    for (let index = 0; index < n; index++) {
      const angle = index / n * TAU
      const restRadius = Math.hypot(this.restX[index], this.restY[index])
      const radius = Math.hypot(this.x[index], this.y[index])
      const displacement = Math.max(-.16, Math.min(.16, radius - restRadius))
      for (let harmonic = 1; harmonic <= 4; harmonic++) {
        this.modes[(harmonic - 1) * 2] += displacement * Math.cos(angle * harmonic) * 10 / n
        this.modes[(harmonic - 1) * 2 + 1] += displacement * Math.sin(angle * harmonic) * 10 / n
      }
    }
    this.modes.forEach((value, index) => { this.modes[index] = Math.max(-.11, Math.min(.11, value * (this.reducedMotion ? .35 : 1))) })
  }

  private polygonArea(xs: Float32Array, ys: Float32Array): number {
    let area = 0
    for (let index = 0; index < xs.length; index++) {
      const next = (index + 1) % xs.length
      area += xs[index] * ys[next] - xs[next] * ys[index]
    }
    return Math.abs(area) * .5
  }
}
