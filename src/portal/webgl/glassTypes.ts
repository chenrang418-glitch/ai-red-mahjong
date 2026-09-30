export type GlassShape = 'circle' | 'roundedRect' | 'capsule'
export type GlassInteractionMode = 'press' | 'anchored-elastic' | 'slider'

export type PointerSession = {
  id: number
  active: boolean
  startX: number
  startY: number
  x: number
  y: number
  prevX: number
  prevY: number
  velocityX: number
  velocityY: number
  dragX: number
  dragY: number
  pressAnchorX: number
  pressAnchorY: number
  dragged: boolean
}

export type GlassObjectDescriptor = {
  shape: GlassShape
  interaction: GlassInteractionMode
}

export function shapeForSurface(kind: 'button' | 'lens' | 'menu', width: number, height: number): GlassObjectDescriptor {
  if (kind === 'lens') return { shape: 'capsule', interaction: 'slider' }
  if (kind === 'menu' && Math.min(width, height) < 100) return { shape: 'circle', interaction: 'anchored-elastic' }
  if (kind === 'menu') return { shape: 'roundedRect', interaction: 'press' }
  return { shape: 'roundedRect', interaction: 'anchored-elastic' }
}
