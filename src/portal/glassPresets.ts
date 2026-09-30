export type PortalGlassVariant = 'menuButton' | 'primaryButton' | 'navLens' | 'sheet'

export interface PortalGlassPreset {
  renderer: 'webgl'
  effectMode: 'auto' | 'blur'
  lensProfile: 'player' | 'track' | 'material'
  strength: number
  dispersion: number
  radius: number
  frost: number
  blur: number
  saturation: number
  scale: number
  lens: 'convex' | 'shift' | 'rim'
  lensStrength: number
  liquid?: 'flow' | 'ripple' | 'wobble'
  liquidSpeed?: number
  liquidScale?: number
  glassColor: string
  lightness: number
  alpha: number
}

export const portalGlassPresets: Record<PortalGlassVariant, PortalGlassPreset> = {
  menuButton: { renderer: 'webgl', effectMode: 'auto', lensProfile: 'material', strength: .08, dispersion: 1, radius: 22, frost: .025, blur: .5, saturation: 118, scale: 132, lens: 'rim', lensStrength: .35, glassColor: 'rgba(255,255,255,.035)', lightness: 1.03, alpha: .9 },
  primaryButton: { renderer: 'webgl', effectMode: 'auto', lensProfile: 'player', strength: .14, dispersion: 2.5, radius: 32, frost: .018, blur: 1, saturation: 122, scale: 155, lens: 'convex', lensStrength: .8, liquid: 'flow', liquidSpeed: .55, liquidScale: 1.6, glassColor: 'rgba(255,255,255,.028)', lightness: 1.05, alpha: .94 },
  navLens: { renderer: 'webgl', effectMode: 'auto', lensProfile: 'track', strength: .17, dispersion: 1.5, radius: 28, frost: .012, blur: .5, saturation: 124, scale: 170, lens: 'shift', lensStrength: .6, liquid: 'flow', liquidSpeed: .45, liquidScale: 1.2, glassColor: 'rgba(255,255,255,.025)', lightness: 1.04, alpha: .92 },
  sheet: { renderer: 'webgl', effectMode: 'blur', lensProfile: 'material', strength: .04, dispersion: .5, radius: 28, frost: .07, blur: 7, saturation: 112, scale: 120, lens: 'rim', lensStrength: .2, glassColor: 'rgba(255,255,255,.045)', lightness: 1.02, alpha: .9 },
}
