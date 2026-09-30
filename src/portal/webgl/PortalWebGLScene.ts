import type { GameId } from '../gameManifest'
import { LiquidBody, type LiquidBodySnapshot } from './LiquidBody'
import { shapeForSurface, type GlassShape, type GlassInteractionMode } from './glassTypes'

const TAU = Math.PI * 2

type SurfaceKind = 'button' | 'lens' | 'menu'
type SurfaceRect = { left: number; top: number; width: number; height: number }
type SurfaceState = { element: HTMLElement; kind: SurfaceKind; shape: GlassShape; interaction: GlassInteractionMode; textNode?: HTMLElement; textTilt: number; textSkewX: number; textSkewY: number; textSpacing: number; textScaleX: number; textScaleY: number; pressed: number; pressTarget: number; pointerX: number; pointerY: number; pressAnchorX: number; pressAnchorY: number; velocityX: number; velocityY: number; dragX: number; dragY: number; dragTargetX: number; dragTargetY: number; dragCurrentX: number; dragCurrentY: number; dragVelocityX: number; dragVelocityY: number; releaseDistance: number; layoutRect: SurfaceRect; rect: SurfaceRect; rectObserver?: ResizeObserver; body: LiquidBody; snapshot?: LiquidBodySnapshot }

const vertexSource = `#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * .5 + .5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`

const fragmentSource = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uMahjong;
uniform sampler2D uSanguo;
uniform sampler2D uPortalText;
uniform vec2 uViewport;
uniform vec2 uMahjongSize;
uniform vec2 uSanguoSize;
uniform float uDpr;
uniform float uProgress;
uniform float uDirection;
uniform float uTime;
uniform float uMobile;
uniform int uSurfaceCount;
uniform int uDebugMode;
uniform int uMaterialMode;
uniform vec4 uRects[4];
uniform vec4 uStyles[4];
uniform vec2 uVelocities[4];
  uniform vec4 uLiquidModesA[4];
  uniform vec4 uLiquidModesB[4];
  uniform vec4 uShapes[4];
  uniform vec4 uPointerState[4];
  uniform vec4 uPressAnchor[4];
  uniform vec4 uDragState[4];

vec2 coverUv(vec2 uv, vec2 imageSize, float position) {
  float viewportRatio = uViewport.x / uViewport.y;
  float imageRatio = imageSize.x / imageSize.y;
  vec2 scale = imageRatio > viewportRatio
    ? vec2(imageSize.y * viewportRatio / imageSize.x, 1.0)
    : vec2(1.0, imageSize.x / viewportRatio / imageSize.y);
  vec2 offset = vec2((1.0 - scale.x) * position, (1.0 - scale.y) * .5);
  return offset + uv * scale;
}

vec4 sampleBackground(vec2 uv) {
  float movement = (uProgress * (1.0 - uProgress)) * .018 * uDirection;
  vec2 oldUv = coverUv(uv + vec2(0.0, movement), uMahjongSize, uMobile > .5 ? .5 : .68);
  vec2 nextUv = coverUv(uv - vec2(0.0, movement), uSanguoSize, uMobile > .5 ? .63 : .7);
  vec4 oldColor = texture(uMahjong, clamp(oldUv, 0.0, 1.0));
  vec4 nextColor = texture(uSanguo, clamp(nextUv, 0.0, 1.0));
  float amount = smoothstep(0.0, 1.0, uProgress);
  vec4 color = mix(oldColor, nextColor, amount);
  float dim = sin(3.1415926 * uProgress) * .075;
  return vec4(color.rgb * (1.0 - dim), 1.0);
}

vec4 samplePortalScene(vec2 uv) {
  vec4 background = sampleBackground(uv);
  vec4 portalText = texture(uPortalText, clamp(uv, 0.0, 1.0));
  return vec4(mix(background.rgb, portalText.rgb, portalText.a), 1.0);
}

  float roundedBox(vec2 point, vec2 halfSize, float radius) {
    vec2 q = abs(point) - halfSize + radius;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  }

  float circle(vec2 point, float radius) {
    return length(point) - radius;
  }

  float capsule(vec2 point, vec2 halfSize) {
    if (halfSize.x >= halfSize.y) {
      float segment = max(0.0, halfSize.x - halfSize.y);
      return length(vec2(max(abs(point.x) - segment, 0.0), point.y)) - halfSize.y;
    }
    float segment = max(0.0, halfSize.y - halfSize.x);
    return length(vec2(point.x, max(abs(point.y) - segment, 0.0))) - halfSize.x;
  }

  float shapeDistance(vec2 point, vec2 halfSize, float radius, float shapeType) {
    if (shapeType > 1.5) return capsule(point, halfSize);
    if (shapeType > .5) return circle(point, min(halfSize.x, halfSize.y));
    return roundedBox(point, halfSize, min(radius, min(halfSize.x, halfSize.y)));
  }

  float glassHeight(float distance, float bevelWidth) {
    float normalizedInside = clamp(-distance / bevelWidth, 0.0, 1.0);
    return smoothstep(0.0, 1.0, normalizedInside);
  }

float boundaryWave(vec2 point, vec4 modesA, vec4 modesB) {
  float angle = atan(point.y, point.x);
  return modesA.x * cos(angle) + modesA.y * sin(angle)
    + modesA.z * cos(angle * 2.0) + modesA.w * sin(angle * 2.0)
    + modesB.x * cos(angle * 3.0) + modesB.y * sin(angle * 3.0)
    + modesB.z * cos(angle * 4.0) + modesB.w * sin(angle * 4.0);
}

vec2 roundedRectSupport(vec2 direction, vec2 halfSize, float radius) {
  vec2 straight = max(halfSize - vec2(radius), vec2(0.001));
  vec2 corner = vec2(sign(direction.x) * straight.x, sign(direction.y) * straight.y);
  return corner + normalize(direction + vec2(0.0001)) * radius;
}

vec3 applyGlass(vec3 base, vec2 pixel, vec4 rect, vec4 style, vec2 velocity, vec4 modesA, vec4 modesB, vec4 shapeInfo, vec4 pointerState, vec4 pressAnchor, vec4 dragState) {
  vec2 center = rect.xy + rect.zw * .5;
  vec2 local = pixel - center;
  vec2 halfSize = rect.zw * .5;
  float aggressive = float(uMaterialMode);
  float press = clamp(pointerState.z, 0.0, 1.0);
  vec2 baseNormalized = local / max(halfSize, vec2(1.0));
  vec2 pointer = clamp(pointerState.xy, vec2(-1.25), vec2(1.25));
  vec2 drag = dragState.xy * halfSize.y;
  float dragLength = length(drag);
  vec2 dragDirection = dragLength > .001 ? drag / dragLength : vec2(1.0, 0.0);
  // The primary button's press field is locked to pointer-down. Using the
  // live pointer here would create a visible ellipse outside the button as
  // soon as a drag leaves its original bounds.
  vec2 pressCenter = shapeInfo.y > .5 ? pressAnchor.xy : pointer;
  vec2 fromPress = baseNormalized - pressCenter;
  float pressureField = exp(-dot(fromPress * vec2(.95, 1.18), fromPress * vec2(.95, 1.18)) * 3.8) * press * aggressive;
  float broadPressure = exp(-dot(fromPress * vec2(.68, .86), fromPress * vec2(.68, .86)) * 1.75) * press * aggressive;
  vec2 radial = normalize(fromPress + vec2(.0001, -.0001));
  // Local outward bulge around the contact point, with a broad inward
  // compensation field to keep the capsule volume approximately constant.
  vec2 pressDeformation = (radial * pressureField * (.16 + broadPressure * .08) - baseNormalized * broadPressure * .035) * halfSize;
  // Press feedback remains optical for the primary button. Letting the
  // pressure warp alter its boundary creates an edge notch when the anchor is
  // near a corner; the silhouette is owned exclusively by the elastic field.
  vec2 shapedLocal = local - (shapeInfo.y > .5 ? vec2(0.0) : pressDeformation);
  float radius = min(rect.w, style.w);
  float baseDistance = shapeDistance(shapedLocal, halfSize, radius, shapeInfo.x);
  float distance = baseDistance;
  vec2 debugDeformation = vec2(0.0);
  float debugAnchor = 0.0;
  if (shapeInfo.y > .5 || shapeInfo.z > .5) {
    // The primary button is one continuous SDF. Dragging applies a monotonic,
    // center-preserving elastic field anchored at pointer-down; it never
    // creates a second component, connector, hole, or metaball.
    vec2 anchor = pressAnchor.xy * halfSize;
    float maxDrag = max(halfSize.y * .48, 18.0);
    float visualDrag = maxDrag * (1.0 - exp(-dragLength / max(maxDrag, 1.0)));
    vec2 surfaceAnchor = roundedRectSupport(dragDirection, halfSize, min(radius, halfSize.y));
    float anchorBlend = smoothstep(4.0, max(10.0, halfSize.y * .28), dragLength);
    vec2 forceAnchor = mix(anchor, surfaceAnchor, anchorBlend);
    float anchorBias = clamp(dot(forceAnchor - anchor, dragDirection) / max(halfSize.y, 1.0), -1.0, 1.0);
    vec2 tangent = vec2(-dragDirection.y, dragDirection.x);
    float along = dot(local, dragDirection);
    float across = dot(local, tangent);
    float dragRatio = clamp(visualDrag / max(maxDrag, 1.0), 0.0, 1.0);
    // This is deliberately an invertible warp: the center stays at (0, 0),
    // both ends share the pull, and the field cannot fold into a detached lobe.
    float longitudinalScale = 1.0 + dragRatio * (.16 + anchorBias * .025);
    float transverseScale = 1.0 - dragRatio * .035;
    vec2 elasticLocal = dragDirection * (along / longitudinalScale)
      + tangent * (across / max(transverseScale, .9));
    // Feed the spring velocity into the optical shape. The bounded shear and
    // trailing wave add liquid follow-through without changing the center or
    // allowing the field to fold into a detached lobe.
    vec2 springVelocity = dragState.zw * halfSize.y;
    float velocityAlong = dot(springVelocity, dragDirection);
    float velocityTangent = dot(springVelocity, tangent);
    float flowEnergy = clamp(length(springVelocity) / max(halfSize.y * 1.65, 1.0), 0.0, 1.0);
    float normalizedAlong = along / max(halfSize.x, 1.0);
    float waveEnvelope = exp(-abs(normalizedAlong) * 1.35) * smoothstep(.06, .22, abs(normalizedAlong));
    float wavePhase = normalizedAlong * 3.2 - uTime * (5.0 + flowEnergy * 3.0);
    float flowWave = sin(wavePhase) * waveEnvelope * flowEnergy * 1.8;
    float flowShear = clamp(velocityAlong * .055 + velocityTangent * .035, -2.6, 2.6)
      * normalizedAlong * smoothstep(0.0, .35, abs(normalizedAlong));
    elasticLocal += tangent * (flowWave + flowShear);
    vec2 deformation = local - elasticLocal;
    debugDeformation = deformation;
    debugAnchor = exp(-dot((local - anchor) / max(halfSize.y * .14, 4.0), (local - anchor) / max(halfSize.y * .14, 4.0)));
    distance = shapeDistance(elasticLocal, halfSize, radius, shapeInfo.x);
  }
  float inside = 1.0 - smoothstep(0.0, 1.4, distance);
  // Keep the optical rim close to the SDF boundary. A wide band reads as a soft
  // plastic wall instead of a thin glass edge.
  float edge = 1.0 - smoothstep(0.0, 3.4, abs(distance));
  vec2 gradient = normalize(vec2(dFdx(distance), dFdy(distance)) + vec2(.0001));
  vec2 lightDirection = normalize(vec2(-.65, -.8));
  // Adapt the material to the color already behind this surface. This uses
  // the existing background sample, so the adaptive pass adds no texture IO.
  float backgroundLuma = dot(base, vec3(.2126, .7152, .0722));
  // A cheap local contrast proxy keeps the material adaptive without adding
  // neighborhood texture reads (important because this runs per surface).
  float backgroundContrast = max(max(base.r, base.g), base.b) - min(min(base.r, base.g), base.b);
  float brightBackground = smoothstep(.45, .82, backgroundLuma);
  float darkBackground = 1.0 - smoothstep(.12, .4, backgroundLuma);
  float contrastBackground = smoothstep(.08, .36, backgroundContrast);
  float fillAdapt = mix(.86, .64, brightBackground) * mix(1.0, .94, darkBackground);
  float transmissionAdapt = mix(1.04, .88, brightBackground);
  float rimAdapt = mix(1.08, .76, brightBackground);
  float specularAdapt = mix(1.10, .76, brightBackground);
  float bottomAdapt = mix(1.0, .68, brightBackground);
  fillAdapt *= mix(1.02, .90, contrastBackground);
  transmissionAdapt *= mix(1.0, .94, contrastBackground);
  rimAdapt *= mix(1.04, .84, contrastBackground);
  specularAdapt *= mix(1.04, .88, contrastBackground);
  bottomAdapt *= mix(1.0, .82, contrastBackground);
  float fresnel = pow(edge, mix(3.8, 3.25, aggressive));
  // Lift only the specular response into a shallow 3D surface model. The
  // center remains transmission-first, while the rim gains a restrained
  // curved-glass response instead of a flat CSS-like highlight.
  vec2 normalizedLocal = shapedLocal / max(halfSize, vec2(1.0));
  float primaryGlass = step(.5, shapeInfo.y) * (1.0 - step(.5, shapeInfo.x));
  float curvature = clamp(1.0 - dot(normalizedLocal, normalizedLocal) * .5, 0.0, 1.0);
  float bevelWidth = mix(2.4, 3.8, aggressive) + primaryGlass * .75;
  float height = glassHeight(distance, bevelWidth);
  vec2 heightGradient = vec2(dFdx(height), dFdy(height));
  vec3 glassNormal = normalize(vec3(-heightGradient * (2.2 + edge * 1.4), 1.0 - press * aggressive * .05));
  vec3 lightVector = normalize(vec3(lightDirection, .82));
  float planarLight = max(0.0, dot(gradient, lightDirection));
  float volumetricLight = max(0.0, dot(glassNormal, lightVector));
  float light = mix(planarLight, volumetricLight, mix(.46, .68, aggressive));
  vec2 topHighlightDelta = normalizedLocal - vec2(-.38, -.72);
  float topLeftLobe = exp(-dot(topHighlightDelta, topHighlightDelta) * mix(20.0, 24.0, aggressive)) * edge;
  vec2 cornerHighlightDelta = normalizedLocal - vec2(-.78, -.58);
  float cornerLobe = exp(-dot(cornerHighlightDelta, cornerHighlightDelta) * mix(26.0, 32.0, aggressive)) * edge;
  float contactLobe = exp(-dot(pressCenter, pressCenter) * 3.8) * inside * press * aggressive;
  float specular = (pow(light, 28.0 + press * (7.0 + aggressive * 8.0)) * (.22 + max(0.0, pointer.x) * .035) * (1.0 + press * (.08 + aggressive * .12)) + topLeftLobe * (.11 + aggressive * .035 + press * .012) + cornerLobe * (.075 + aggressive * .035 + press * .008) + contactLobe * .07) * specularAdapt;
  float interactiveGlass = step(.5, shapeInfo.y);
  float staticGlass = interactiveGlass * (1.0 - smoothstep(.5, 4.0, dragLength));
  float strength = style.z * (1.0 + press * mix(.18, .28, aggressive));
  float edgeRefraction = smoothstep(.18, .88, edge);
  float cornerRefraction = smoothstep(.78, 1.38, length(normalizedLocal));
  float refractionProfile = mix(.08 + edgeRefraction * .95, .11 + edgeRefraction * 1.42 + cornerRefraction * .35, aggressive);
  float primaryEdgeRefraction = primaryGlass * edgeRefraction * (1.0 + cornerRefraction * .7);
  vec2 refractOffset = glassNormal.xy * strength * refractionProfile * mix(1.0, 1.85, interactiveGlass) * (1.0 + primaryEdgeRefraction * 1.45) * (1.0 + press * aggressive * .24) / uViewport;
  refractOffset += pointer * .001 * edge;
  float dispersion = smoothstep(.35, .9, edge) * mix(1.0, .7, aggressive);
  float prismDispersion = dispersion * mix(1.0, 2.15, primaryGlass);
  vec3 refracted;
  refracted.r = samplePortalScene(vUv + refractOffset * (1.0 + prismDispersion * .16)).r;
  refracted.g = samplePortalScene(vUv + refractOffset).g;
  refracted.b = samplePortalScene(vUv + refractOffset * (1.0 - prismDispersion * .11)).b;
  // Keep the center optically quiet: the glass should transmit the scene,
  // while the rim carries the thickness and refraction cues.
  // The milky body is part of the same dynamic SDF as refraction and rim.
  // Keeping this fill here prevents a static CSS rectangle from covering the
  // live boundary while retaining the existing clear-center glass character.
  float milkyFill = inside * (.075 + style.z * .025) * fillAdapt;
  milkyFill += edge * (.014 + aggressive * .006) * fillAdapt;
  vec3 material = mix(refracted, vec3(.93, .965, .945), milkyFill);
  // A restrained spectral fringe makes the refraction read as real glass.
  // It is confined to the bevel and rotates with the local edge, so the body
  // remains transparent instead of becoming a rainbow overlay.
  float prismBand = primaryGlass * smoothstep(.16, .92, edge) * (.45 + .55 * cornerRefraction);
  float prismPhase = atan(normalizedLocal.y, normalizedLocal.x) * 1.35 + normalizedLocal.x * .8;
  vec3 prismTint = .5 + .5 * cos(vec3(0.0, 2.094, 4.188) + prismPhase);
  material += (prismTint - vec3(.5)) * (.072 * prismBand);
  // Reference-button material: make the interactive button read as a small
  // glass object instead of a flat translucent sticker. The top-left lift,
  // middle transition, and lower-right shade stay coupled to the SDF so the
  // treatment follows both the capsule and the round menu trigger.
  float topLeftHighlight = staticGlass * edge
    * (1.0 - smoothstep(-.92, .18, normalizedLocal.y))
    * (1.0 - smoothstep(-.98, .18, normalizedLocal.x));
  float upperBodyLift = staticGlass * inside
    * (1.0 - smoothstep(-.86, .34, normalizedLocal.y));
  float lowerBodyShade = staticGlass * inside
    * smoothstep(-.08, .94, normalizedLocal.y);
  float lowerEdgeShade = staticGlass * edge
    * smoothstep(-.12, .92, normalizedLocal.y);
  // Keep the dark treatment on two local corner arcs only. Requiring both
  // axes to be away from zero makes the shade follow a quarter-circle arc;
  // the soft thresholds provide only a short extension onto the straight
  // sections instead of darkening an entire side.
  float upperRightQuarter = staticGlass * edge
    * smoothstep(.24, .58, abs(normalizedLocal.x) * abs(normalizedLocal.y))
    * smoothstep(.16, .72, normalizedLocal.x)
    * (1.0 - smoothstep(-.86, -.08, normalizedLocal.y));
  float lowerLeftQuarter = staticGlass * edge
    * smoothstep(.24, .58, abs(normalizedLocal.x) * abs(normalizedLocal.y))
    * (1.0 - smoothstep(-.72, -.16, normalizedLocal.x))
    * smoothstep(.08, .86, normalizedLocal.y);
  float darkQuarter = clamp(upperRightQuarter + lowerLeftQuarter, 0.0, 1.0);
  float whiteBoundary = staticGlass * edge * (1.0 - darkQuarter * .92);
  material += vec3(.095, .11, .115) * topLeftHighlight;
  material += vec3(.018, .022, .024) * upperBodyLift;
  material -= vec3(.052, .061, .066) * lowerBodyShade;
  material -= vec3(.045, .052, .058) * lowerEdgeShade;
  material += vec3(.105, .125, .14) * whiteBoundary;
  material -= vec3(.12, .14, .16) * darkQuarter;
  float raisedTopEdge = interactiveGlass * edge
    * (1.0 - smoothstep(-.76, .08, normalizedLocal.y));
  float recessedBottomEdge = interactiveGlass * edge
    * smoothstep(-.02, .88, normalizedLocal.y);
  material += vec3(.16, .19, .20) * raisedTopEdge;
  material -= vec3(.10, .12, .14) * recessedBottomEdge;
  float rimDirection = .34 + .66 * max(0.0, dot(gradient, lightDirection));
  float rim = edge * (.026 + fresnel * mix(.055, .068, aggressive)) * rimDirection * rimAdapt * mix(1.0, 2.05, interactiveGlass);
  float innerEdge = (1.0 - smoothstep(0.0, 1.8, max(-distance, 0.0))) * inside;
  float innerRim = innerEdge * mix(.009, .014, aggressive) * rimDirection * rimAdapt * mix(1.0, 1.42, interactiveGlass) * (1.0 + press * aggressive * .16);
  float sheen = specular * (mix(.26, .31, aggressive) + edge * mix(.24, .3, aggressive)) * mix(1.0, 1.28, interactiveGlass);
  float bottomReflection = max(0.0, dot(gradient, vec2(0.0, .92))) * edge * mix(.012, .018, aggressive) * bottomAdapt;
  float innerReflection = pow(max(0.0, dot(gradient, normalize(vec2(-.85, -.95)))), 4.0) * inside * mix(.04, .055, aggressive);
  float lowerShade = max(0.0, dot(gradient, vec2(.18, .92))) * inside * .028;
  float bodyLayer = (1.0 - edge) * inside * aggressive * (.008 + .012 * curvature);
  float opticalMix = inside * (mix(.46, .51, aggressive) + style.z * mix(.25, .3, aggressive)) * transmissionAdapt;
  if (uDebugMode == 1) return refracted;
  if (uDebugMode == 2) return vec3(inside);
  if (uDebugMode == 3) return vec3(edge);
  if (uDebugMode == 4) return glassNormal * .5 + .5;
  if (uDebugMode == 5) return vec3(clamp(length(refractOffset) * uViewport.x * 10.0, 0.0, 1.0));
  if (uDebugMode == 6) return vec3(clamp(rim * 10.0, 0.0, 1.0));
  if (uDebugMode == 7) return vec3(clamp(innerRim * 24.0, 0.0, 1.0));
  if (uDebugMode == 8) return vec3(fresnel);
  if (uDebugMode == 9) return vec3(clamp(sheen * 8.0, 0.0, 1.0));
  if (uDebugMode == 10) return vec3(dispersion);
  if (uDebugMode == 11) return base;
  if (uDebugMode == 12) return vec3(inside);
  if (uDebugMode == 13) return vec3(clamp(length(debugDeformation) / max(halfSize.y * .48, 18.0), 0.0, 1.0));
  if (uDebugMode == 14) return vec3(debugAnchor, inside * .35, 1.0 - debugAnchor);
  return mix(base, material + vec3(rim + innerRim + sheen + innerReflection + bottomReflection + bodyLayer) - vec3(lowerShade), opticalMix);
}

void main() {
  vec2 pixel = vec2(gl_FragCoord.x / uDpr, (uViewport.y * uDpr - gl_FragCoord.y) / uDpr);
  vec3 color = samplePortalScene(vUv).rgb;
  float motionBlur = sin(3.1415926 * uProgress) * .00085;
  if (motionBlur > .0001) {
    color = color * .84;
    color += samplePortalScene(vUv + vec2(motionBlur * uDirection, 0.0)).rgb * .08;
    color += samplePortalScene(vUv - vec2(motionBlur * uDirection, 0.0)).rgb * .08;
  }
  for (int index = 0; index < 4; index++) {
    if (index >= uSurfaceCount) break;
    color = applyGlass(color, pixel, uRects[index], uStyles[index], uVelocities[index], uLiquidModesA[index], uLiquidModesB[index], uShapes[index], uPointerState[index], uPressAnchor[index], uDragState[index]);
  }
  outColor = vec4(color, 1.0);
}`

function numberedShaderSource(source: string): string {
  return source.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n')
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Unable to create WebGL shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const shaderKind = type === gl.VERTEX_SHADER ? 'VERTEX' : type === gl.FRAGMENT_SHADER ? 'FRAGMENT' : `TYPE_${type}`
    const infoLog = gl.getShaderInfoLog(shader) || 'WebGL shader compile failed'
    throw new Error(`[CRPlay] WebGL ${shaderKind} shader compile failed\n${infoLog}\n--- numbered source ---\n${numberedShaderSource(source)}`)
  }
  return shader
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const program = gl.createProgram()
  if (!program) throw new Error('Unable to create WebGL program')
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource))
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`[CRPlay] WebGL program link failed\n${gl.getProgramInfoLog(program) || 'No link info log available'}`)
  }
  return program
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => void image.decode().catch(() => undefined).finally(() => resolve(image))
    image.onerror = () => reject(new Error(`Unable to load portal texture: ${source}`))
    image.src = source
  })
}

export class PortalWebGLScene {
  private readonly surfaces = new Map<string, SurfaceState>()
  private canvas: HTMLCanvasElement | null = null
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private buffer: WebGLBuffer | null = null
  private textures: [WebGLTexture | null, WebGLTexture | null] = [null, null]
  private portalTextCanvas: HTMLCanvasElement | null = null
  private portalTextContext: CanvasRenderingContext2D | null = null
  private portalTextTexture: WebGLTexture | null = null
  private portalTextDirty = true
  private images: [HTMLImageElement | null, HTMLImageElement | null] = [null, null]
  private animationFrame = 0
  private resizeObserver: ResizeObserver | null = null
  private visibilityHandler = () => { if (document.hidden) this.stopLoop(); else this.startLoop() }
  private dpr = 1
  private width = 1
  private height = 1
  private progress = 0
  private startProgress = 0
  private targetProgress = 0
  private direction = 1
  private transitionStartedAt = 0
  private transitionDuration = 340
  private failed = false
  private fps = 0
  private frames = 0
  private fpsAt = 0
  private lastRenderAt = 0
  private debugMode = 0
  private materialMode = 1
  private liquidDebug = false
  // LiquidBody is retained for the developer contour view only. The visible
  // silhouette is produced by the analytic deformation field in the shader.
  private liquidView: 'final' | 'shape' | 'material' = 'material'
  private readonly zeroModes = new Float32Array(8)
  private debugCanvas: HTMLCanvasElement | null = null
  private debugContext: CanvasRenderingContext2D | null = null
  private readonly uniform = new Map<string, WebGLUniformLocation | null>()
  private availabilityListeners = new Set<(available: boolean) => void>()

  mount(canvas: HTMLCanvasElement, stage: HTMLElement): void {
    if (this.canvas === canvas && this.gl) return
    this.canvas = canvas
    this.debugMode = this.readDebugMode()
    this.materialMode = this.readMaterialMode()
    this.liquidDebug = this.readLiquidDebug()
    this.liquidView = this.readLiquidView()
    this.debugCanvas = stage.querySelector<HTMLCanvasElement>('#portal-liquid-debug')
    this.debugContext = this.debugCanvas?.getContext('2d') ?? null
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(stage)
    document.addEventListener('visibilitychange', this.visibilityHandler)
    try {
      const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false })
      if (!gl) throw new Error('WebGL2 unavailable')
      this.gl = gl
      this.program = createProgram(gl)
      this.portalTextCanvas = document.createElement('canvas')
      this.portalTextContext = this.portalTextCanvas.getContext('2d')
      this.ensurePortalTextTexture()
      this.buffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
      this.cacheUniforms()
      // The canvas is recreated when returning from a game. Keep the decoded
      // images, but upload them again into the new WebGL context.
      if (this.images[0] && this.images[1]) this.uploadTextures()
      canvas.addEventListener('webglcontextlost', this.onContextLost, false)
      canvas.addEventListener('webglcontextrestored', this.onContextRestored, false)
      this.resize()
      this.startLoop()
    } catch (error) {
      console.warn('[CRPlay] shared WebGL2 unavailable; using image fallback', error)
      this.failed = true
      this.availabilityListeners.forEach((listener) => listener(false))
    }
  }

  async preload(sources: [string, string]): Promise<void> {
    if (this.failed || (this.images[0] && this.images[1])) return
    try {
      this.images = await Promise.all(sources.map((source) => loadImage(source))) as [HTMLImageElement, HTMLImageElement]
      if (this.gl) this.uploadTextures()
    } catch (error) {
      console.warn('[CRPlay] portal texture preload failed; using image fallback', error)
      this.failed = true
      this.availabilityListeners.forEach((listener) => listener(false))
    }
  }

  setGame(game: GameId, immediate = false): void {
    this.direction = game === 'sanguosha' ? -1 : 1
    const target = game === 'sanguosha' ? 1 : 0
    if (immediate) {
      this.startProgress = target
      this.progress = target
      this.targetProgress = target
      this.transitionStartedAt = 0
      this.portalTextDirty = true
      this.startLoop()
      return
    }
    if (Math.abs(this.targetProgress - target) < .001 && Math.abs(this.progress - target) < .001) return
    this.startProgress = this.progress
    this.targetProgress = target
    this.transitionStartedAt = performance.now()
    this.portalTextDirty = true
    this.startLoop()
  }

  registerSurface(id: string, element: HTMLElement, kind: SurfaceKind): () => void {
    const initialRect = element.getBoundingClientRect()
    const descriptor = shapeForSurface(kind, initialRect.width, initialRect.height)
    const surface: SurfaceState = { element, kind, shape: descriptor.shape, interaction: descriptor.interaction, textNode: (kind === 'button' ? element.querySelector<HTMLElement>(':scope > span') : kind === 'menu' ? element.querySelector<HTMLElement>('.portal-menu-trigger') : null) ?? undefined, textTilt: 0, textSkewX: 0, textSkewY: 0, textSpacing: .08, textScaleX: 1, textScaleY: 1, pressed: 0, pressTarget: 0, pointerX: 0, pointerY: 0, pressAnchorX: 0, pressAnchorY: 0, velocityX: 0, velocityY: 0, dragX: 0, dragY: 0, dragTargetX: 0, dragTargetY: 0, dragCurrentX: 0, dragCurrentY: 0, dragVelocityX: 0, dragVelocityY: 0, releaseDistance: 0, layoutRect: { left: initialRect.left, top: initialRect.top, width: initialRect.width, height: initialRect.height }, rect: { left: initialRect.left, top: initialRect.top, width: initialRect.width, height: initialRect.height }, body: new LiquidBody({ preset: kind === 'menu' ? 'panel' : 'button' }) }
    const updateRect = () => {
      const rect = element.getBoundingClientRect()
      surface.layoutRect = { left: rect.left - surface.dragCurrentX, top: rect.top - surface.dragCurrentY, width: rect.width, height: rect.height }
      surface.rect = { ...surface.layoutRect, left: surface.layoutRect.left + surface.dragCurrentX, top: surface.layoutRect.top + surface.dragCurrentY }
      const nextDescriptor = shapeForSurface(kind, rect.width, rect.height)
      surface.shape = nextDescriptor.shape
      surface.interaction = nextDescriptor.interaction
    }
    updateRect()
    if (typeof ResizeObserver !== 'undefined') {
      surface.rectObserver = new ResizeObserver(updateRect)
      surface.rectObserver.observe(element)
    }
    this.surfaces.set(id, surface)
    return () => { surface.rectObserver?.disconnect(); this.surfaces.delete(id) }
  }

  setSurfacePointer(id: string, pointerX: number, pointerY: number, pressed = false, velocityX = 0, velocityY = 0, dragX = 0, dragY = 0, pressAnchorX = 0, pressAnchorY = 0): void {
    const surface = this.surfaces.get(id)
    if (!surface) return
    surface.pointerX = pointerX
    surface.pointerY = pointerY
    surface.velocityX = Math.max(-4, Math.min(4, velocityX))
    surface.velocityY = Math.max(-4, Math.min(4, velocityY))
    surface.dragX = dragX
    surface.dragY = dragY
    if (pressed) {
      surface.pressAnchorX = Math.max(-1.25, Math.min(1.25, pressAnchorX))
      surface.pressAnchorY = Math.max(-1.25, Math.min(1.25, pressAnchorY))
    } else {
      surface.releaseDistance = Math.hypot(dragX, dragY)
    }
    const limit = Math.max(1, surface.rect.height * .82)
    const rubberBand = (value: number): number => Math.sign(value) * limit * (1 - Math.exp(-Math.abs(value) / limit))
    const usesElasticDrag = surface.interaction === 'anchored-elastic' || surface.kind === 'lens'
    surface.dragTargetX = pressed && usesElasticDrag ? rubberBand(dragX) : 0
    surface.dragTargetY = pressed && usesElasticDrag ? rubberBand(dragY) : 0
    surface.pressTarget = pressed ? 1 : 0
  }

  /** 供外层轨道驱动内层玻璃，保证 CSS 滑块和 WebGL 形变使用同一份手势状态。 */
  setSurfacePointerForElement(element: HTMLElement, pointerX: number, pointerY: number, pressed = false, velocityX = 0, velocityY = 0, dragX = 0, dragY = 0): void {
    const entry = [...this.surfaces.entries()].find(([, surface]) => surface.element === element)
    if (entry) this.setSurfacePointer(entry[0], pointerX, pointerY, pressed, velocityX, velocityY, dragX, dragY)
  }

  onAvailabilityChange(listener: (available: boolean) => void): () => void { this.availabilityListeners.add(listener); return () => this.availabilityListeners.delete(listener) }
  isAvailable(): boolean { return !this.failed && Boolean(this.gl) }
  refreshSurfaceBounds(): void {
    this.surfaces.forEach((surface) => {
      const rect = surface.element.getBoundingClientRect()
      surface.layoutRect = { left: rect.left - surface.dragCurrentX, top: rect.top - surface.dragCurrentY, width: rect.width, height: rect.height }
      surface.rect = { ...surface.layoutRect, left: surface.layoutRect.left + surface.dragCurrentX, top: surface.layoutRect.top + surface.dragCurrentY }
      const nextDescriptor = shapeForSurface(surface.kind, rect.width, rect.height)
      surface.shape = nextDescriptor.shape
      surface.interaction = nextDescriptor.interaction
    })
    this.startLoop()
  }
  debugInfo(): { renderer: string; fps: number; dpr: number; textures: number; surfaces: number; draws: number; progress: number; glassDebug: string; glassMaterial: string; liquidNodes: number; liquidArea: number; liquidPressure: number; liquidTimestep: number } {
    const body = [...this.surfaces.values()].find((surface) => surface.snapshot)?.snapshot
    return { renderer: this.isAvailable() ? 'WebGL2 shared' : 'CSS/image fallback', fps: this.fps, dpr: this.dpr, textures: this.images.filter(Boolean).length, surfaces: this.surfaces.size, draws: 1, progress: this.progress, glassDebug: this.debugModeName(), glassMaterial: this.materialModeName(), liquidNodes: body?.nodeCount ?? 0, liquidArea: body?.areaRatio ?? 1, liquidPressure: body?.pressure ?? 0, liquidTimestep: body?.timestep ?? 0 }
  }

  dispose(): void {
    this.stopLoop()
    document.removeEventListener('visibilitychange', this.visibilityHandler)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    if (this.gl) this.textures.forEach((texture) => texture && this.gl?.deleteTexture(texture))
    if (this.gl && this.portalTextTexture) this.gl.deleteTexture(this.portalTextTexture)
    if (this.gl && this.program) this.gl.deleteProgram(this.program)
    if (this.gl && this.buffer) this.gl.deleteBuffer(this.buffer)
    this.gl = null; this.program = null; this.buffer = null; this.canvas = null; this.portalTextTexture = null; this.portalTextCanvas = null; this.portalTextContext = null
  }

  private cacheUniforms(): void {
    if (!this.gl || !this.program) return
    for (const name of ['uViewport', 'uMahjongSize', 'uSanguoSize', 'uDpr', 'uProgress', 'uDirection', 'uTime', 'uMobile', 'uSurfaceCount', 'uDebugMode', 'uMaterialMode', 'uMahjong', 'uSanguo', 'uPortalText']) this.uniform.set(name, this.gl.getUniformLocation(this.program, name))
    for (let index = 0; index < 4; index++) { this.uniform.set(`uRects[${index}]`, this.gl.getUniformLocation(this.program, `uRects[${index}]`)); this.uniform.set(`uStyles[${index}]`, this.gl.getUniformLocation(this.program, `uStyles[${index}]`)); this.uniform.set(`uVelocities[${index}]`, this.gl.getUniformLocation(this.program, `uVelocities[${index}]`)); this.uniform.set(`uLiquidModesA[${index}]`, this.gl.getUniformLocation(this.program, `uLiquidModesA[${index}]`)); this.uniform.set(`uLiquidModesB[${index}]`, this.gl.getUniformLocation(this.program, `uLiquidModesB[${index}]`)); this.uniform.set(`uShapes[${index}]`, this.gl.getUniformLocation(this.program, `uShapes[${index}]`)); this.uniform.set(`uPointerState[${index}]`, this.gl.getUniformLocation(this.program, `uPointerState[${index}]`)); this.uniform.set(`uPressAnchor[${index}]`, this.gl.getUniformLocation(this.program, `uPressAnchor[${index}]`)); this.uniform.set(`uDragState[${index}]`, this.gl.getUniformLocation(this.program, `uDragState[${index}]`)) }
  }

  private ensurePortalTextTexture(): void {
    if (!this.gl || this.portalTextTexture) return
    const texture = this.gl.createTexture()
    if (!texture) return
    this.portalTextTexture = texture
    this.gl.activeTexture(this.gl.TEXTURE2)
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture)
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR)
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR)
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE)
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE)
    this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, 1)
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, 1, 1, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
    this.portalTextDirty = true
  }

  private syncPortalTextTexture(): void {
    const gl = this.gl
    const canvas = this.portalTextCanvas
    const context = this.portalTextContext
    if (!gl || !canvas || !context || !this.portalTextTexture || this.width < 1 || this.height < 1) return
    const pixelWidth = Math.max(1, Math.round(this.width * this.dpr))
    const pixelHeight = Math.max(1, Math.round(this.height * this.dpr))
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    context.clearRect(0, 0, this.width, this.height)
    context.textAlign = 'left'
    context.textBaseline = 'top'
    const textNodes = [...document.querySelectorAll<HTMLElement>('.portal-title-slot h1, .portal-subtitle-slot p')]
    textNodes.forEach((node) => {
      const style = getComputedStyle(node)
      const opacity = Number.parseFloat(style.opacity)
      if (style.visibility === 'hidden' || opacity <= 0 || !node.textContent?.trim()) return
      const rect = node.getBoundingClientRect()
      const fontSize = Number.parseFloat(style.fontSize) || 16
      const lineHeight = style.lineHeight === 'normal' ? fontSize * 1.15 : Number.parseFloat(style.lineHeight) || fontSize
      context.font = `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`
      context.globalAlpha = opacity
      context.fillStyle = node.tagName === 'H1' ? 'rgba(255,255,255,.96)' : 'rgba(255,255,255,.82)'
      context.fillText(node.textContent.trim(), rect.left, rect.top + Math.max(0, (lineHeight - fontSize) * .5))
    })
    context.globalAlpha = 1
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.portalTextTexture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
    this.portalTextDirty = false
  }

  private uploadTextures(): void {
    const gl = this.gl
    if (!gl || !this.images[0] || !this.images[1]) return
    this.textures = this.images.map((image) => {
      const texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image!)
      return texture
    }) as [WebGLTexture | null, WebGLTexture | null]
  }

  private resize(): void {
    if (!this.canvas) return
    const rect = this.canvas.parentElement?.getBoundingClientRect()
    if (!rect) return
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    this.width = Math.max(1, Math.round(rect.width))
    this.height = Math.max(1, Math.round(rect.height))
    this.canvas.width = Math.round(this.width * this.dpr)
    this.canvas.height = Math.round(this.height * this.dpr)
    this.canvas.style.width = `${this.width}px`
    this.canvas.style.height = `${this.height}px`
    this.portalTextDirty = true
    this.gl?.viewport(0, 0, this.canvas.width, this.canvas.height)
    this.surfaces.forEach((surface) => {
      const rect = surface.element.getBoundingClientRect()
      surface.layoutRect = { left: rect.left - surface.dragCurrentX, top: rect.top - surface.dragCurrentY, width: rect.width, height: rect.height }
      surface.rect = { ...surface.layoutRect, left: surface.layoutRect.left + surface.dragCurrentX, top: surface.layoutRect.top + surface.dragCurrentY }
      const nextDescriptor = shapeForSurface(surface.kind, rect.width, rect.height)
      surface.shape = nextDescriptor.shape
      surface.interaction = nextDescriptor.interaction
    })
  }

  private startLoop(): void { if (!this.animationFrame && !document.hidden) this.animationFrame = requestAnimationFrame(this.render) }
  private stopLoop(): void { if (this.animationFrame) cancelAnimationFrame(this.animationFrame); this.animationFrame = 0 }

  private render = (now: number): void => {
    this.animationFrame = 0
    const gl = this.gl
    const program = this.program
    const image0 = this.images[0]
    const image1 = this.images[1]
    if (!gl || !program || !image0 || !image1) { this.startLoop(); return }
    const elapsed = now - this.transitionStartedAt
    const dt = this.lastRenderAt ? Math.min(.05, Math.max(.001, (now - this.lastRenderAt) / 1000)) : 1 / 60
    this.lastRenderAt = now
    if (this.transitionStartedAt && elapsed < this.transitionDuration) {
      const linear = Math.max(0, Math.min(1, elapsed / this.transitionDuration))
      const eased = linear * linear * (3 - 2 * linear)
      this.progress = this.startProgress + (this.targetProgress - this.startProgress) * eased
    } else this.progress = this.targetProgress
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    const position = gl.getAttribLocation(program, 'aPosition')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.textures[0]); gl.uniform1i(this.uniform.get('uMahjong') ?? null, 0)
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.textures[1]); gl.uniform1i(this.uniform.get('uSanguo') ?? null, 1)
    this.ensurePortalTextTexture()
    if (this.portalTextDirty || elapsed < this.transitionDuration + 120) this.syncPortalTextTexture()
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.portalTextTexture); gl.uniform1i(this.uniform.get('uPortalText') ?? null, 2)
    gl.uniform2f(this.uniform.get('uViewport') ?? null, this.width, this.height)
    gl.uniform2f(this.uniform.get('uMahjongSize') ?? null, image0.naturalWidth, image0.naturalHeight)
    gl.uniform2f(this.uniform.get('uSanguoSize') ?? null, image1.naturalWidth, image1.naturalHeight)
    gl.uniform1f(this.uniform.get('uDpr') ?? null, this.dpr)
    gl.uniform1f(this.uniform.get('uProgress') ?? null, this.progress)
    gl.uniform1f(this.uniform.get('uDirection') ?? null, this.direction)
    gl.uniform1f(this.uniform.get('uTime') ?? null, now / 1000)
    gl.uniform1f(this.uniform.get('uMobile') ?? null, this.width < 700 ? 1 : 0)
    const surfaces = [...this.surfaces.values()].filter(({ element }) => element.offsetWidth > 0 && element.offsetHeight > 0).slice(0, 4)
    gl.uniform1i(this.uniform.get('uSurfaceCount') ?? null, surfaces.length)
    gl.uniform1i(this.uniform.get('uDebugMode') ?? null, this.liquidView === 'shape' ? 12 : this.liquidDebug ? 11 : this.debugMode)
    gl.uniform1i(this.uniform.get('uMaterialMode') ?? null, this.materialMode)
    surfaces.forEach((surface, index) => {
      surface.pressed += (surface.pressTarget - surface.pressed) * .24
      if (Math.abs(surface.pressTarget - surface.pressed) < .002) surface.pressed = surface.pressTarget
      const springStiffness = surface.pressTarget > .5 ? 230 : 230
      const releaseRatio = Math.min(1, surface.releaseDistance / Math.max(1, surface.rect.height * 1.35))
      const springDamping = surface.pressTarget > .5 ? 30 : 24 - releaseRatio * 7
      surface.dragVelocityX += ((surface.dragTargetX - surface.dragCurrentX) * springStiffness - surface.dragVelocityX * springDamping) * dt
      surface.dragVelocityY += ((surface.dragTargetY - surface.dragCurrentY) * springStiffness - surface.dragVelocityY * springDamping) * dt
      surface.dragCurrentX += surface.dragVelocityX * dt
      surface.dragCurrentY += surface.dragVelocityY * dt
      const isMovableSurface = surface.interaction === 'anchored-elastic' && (surface.kind === 'button' || surface.kind === 'menu')
      surface.element.style.translate = isMovableSurface ? `${surface.dragCurrentX}px ${surface.dragCurrentY}px` : '0px 0px'
      const textNode = surface.textNode
      if (textNode) {
        const textMotionActive = isMovableSurface && surface.pressTarget < .5 && surface.releaseDistance > 1
        let targetTilt = 0
        let targetSkewX = 0
        let targetSkewY = 0
        let targetSpacing = .08
        let targetScaleX = 1
        let targetScaleY = 1
        if (textMotionActive) {
          const movementRatio = Math.min(1, Math.hypot(surface.dragCurrentX, surface.dragCurrentY) / Math.max(1, surface.rect.height * .82))
          const height = Math.max(1, surface.rect.height)
          // 只把速度作为轻微的滞后量，避免松手首帧把文字突然甩到新角度。
          const motionX = surface.dragCurrentX + surface.dragVelocityX * .018
          const motionY = surface.dragCurrentY + surface.dragVelocityY * .018
          // Treat the glass edge as an undirected line: preserve the full
          // 360-degree drag direction while avoiding an upside-down label.
          let edgeAngle = Math.atan2(motionY, motionX)
          if (edgeAngle > Math.PI / 2) edgeAngle -= Math.PI
          if (edgeAngle < -Math.PI / 2) edgeAngle += Math.PI
          const directionWeight = Math.min(1, Math.hypot(motionX, motionY) / Math.max(1, height * .22))
          targetTilt = Math.max(-11, Math.min(11, edgeAngle * 180 / Math.PI * .34 * directionWeight))
          targetSkewX = Math.max(-3.5, Math.min(3.5, motionX / height * 2.2))
          targetSkewY = Math.max(-2.5, Math.min(2.5, motionY / height * .95))
          const horizontalPull = Math.max(-1, Math.min(1, motionX / height))
          targetSpacing = Math.max(.045, Math.min(.15, .08 + movementRatio * .07 + horizontalPull * .018))
          targetScaleX = 1 + movementRatio * .025
          targetScaleY = 1 - movementRatio * .008
        }
        // 一阶平滑让文字跟随回弹的速度连续变化，而不是每帧跳变。
        const textSmoothing = 1 - Math.exp(-dt * 16)
        surface.textTilt += (targetTilt - surface.textTilt) * textSmoothing
        surface.textSkewX += (targetSkewX - surface.textSkewX) * textSmoothing
        surface.textSkewY += (targetSkewY - surface.textSkewY) * textSmoothing
        surface.textSpacing += (targetSpacing - surface.textSpacing) * textSmoothing
        surface.textScaleX += (targetScaleX - surface.textScaleX) * textSmoothing
        surface.textScaleY += (targetScaleY - surface.textScaleY) * textSmoothing
        const showTextMotion = textMotionActive || Math.max(Math.abs(surface.textTilt), Math.abs(surface.textSkewX), Math.abs(surface.textSkewY)) > .04
        if (showTextMotion) {
          textNode.style.transformOrigin = 'center'
          textNode.style.transform = `rotate(${surface.textTilt}deg) skew(${surface.textSkewX}deg, ${surface.textSkewY}deg) scale(${surface.textScaleX}, ${surface.textScaleY})`
          textNode.style.letterSpacing = `${surface.textSpacing}em`
          textNode.style.willChange = 'transform'
        } else {
          // 拖动时文字保持稳定；松手后的微小余振自然淡出。
          textNode.style.transform = ''
          textNode.style.letterSpacing = ''
          textNode.style.willChange = ''
        }
      }
      surface.rect = { ...surface.layoutRect, left: surface.layoutRect.left + surface.dragCurrentX, top: surface.layoutRect.top + surface.dragCurrentY }
      if (!surface.pressTarget && Math.hypot(surface.dragCurrentX, surface.dragCurrentY) < .05 && Math.hypot(surface.dragVelocityX, surface.dragVelocityY) < .05) { surface.dragCurrentX = 0; surface.dragCurrentY = 0; surface.dragVelocityX = 0; surface.dragVelocityY = 0; surface.releaseDistance = 0; surface.element.style.translate = '0px 0px' }
      surface.velocityX *= .88
      surface.velocityY *= .88
      const rect = surface.rect
      const pointerLocalX = ((surface.pointerX || rect.left + rect.width * .5) - (rect.left + rect.width * .5)) / Math.max(1, rect.width * .5)
      const pointerLocalY = ((surface.pointerY || rect.top + rect.height * .5) - (rect.top + rect.height * .5)) / Math.max(1, rect.height * .5)
      const physicsPressed = surface.pressed
      const physicsVelocityX = surface.velocityX
      const physicsVelocityY = surface.velocityY
      surface.body.setPointer(pointerLocalX, pointerLocalY, physicsPressed, physicsVelocityX, physicsVelocityY)
      surface.body.step(now)
      surface.snapshot = surface.body.snapshot()
      const radius = surface.kind === 'menu'
        ? Math.min(rect.width, rect.height) < 100 ? Math.min(rect.width, rect.height) * .5 : 26
        : rect.height * .5
      const style = surface.kind === 'lens' ? [surface.pressed, surface.pointerX || rect.left + rect.width * .5, surface.pointerY || rect.top + rect.height * .2, radius] : [surface.pressed, surface.pointerX || rect.left + rect.width * .5, surface.pointerY || rect.top + rect.height * .2, radius]
      gl.uniform4f(this.uniform.get(`uRects[${index}]`) ?? null, rect.left, rect.top, rect.width, rect.height)
      // A full menu sheet needs less optical fill than a small trigger button:
      // keep the sheet readable and frosted without washing out the scene.
      const materialStrength = surface.kind === 'menu'
        ? (rect.width > 100 ? .58 : 1.3)
        : surface.kind === 'lens' ? 1.5 : 1.42
      gl.uniform4f(this.uniform.get(`uStyles[${index}]`) ?? null, style[0], style[1], materialStrength, style[3])
      gl.uniform2f(this.uniform.get(`uVelocities[${index}]`) ?? null, physicsVelocityX, physicsVelocityY)
      const modes = this.liquidView === 'material' ? this.zeroModes : surface.snapshot.modes
      gl.uniform4f(this.uniform.get(`uLiquidModesA[${index}]`) ?? null, modes[0], modes[1], modes[2], modes[3])
      gl.uniform4f(this.uniform.get(`uLiquidModesB[${index}]`) ?? null, modes[4], modes[5], modes[6], modes[7])
      const shapeType = surface.shape === 'circle' ? 1 : surface.shape === 'capsule' ? 2 : 0
      gl.uniform4f(this.uniform.get(`uShapes[${index}]`) ?? null, shapeType, surface.interaction === 'anchored-elastic' ? 1 : 0, surface.kind === 'lens' ? 1 : 0, 0)
      gl.uniform4f(this.uniform.get(`uPointerState[${index}]`) ?? null, pointerLocalX, pointerLocalY, surface.pressed, surface.interaction === 'anchored-elastic' ? 1 : 0)
      gl.uniform4f(this.uniform.get(`uPressAnchor[${index}]`) ?? null, surface.pressAnchorX, surface.pressAnchorY, 0, 0)
      gl.uniform4f(this.uniform.get(`uDragState[${index}]`) ?? null, surface.dragCurrentX / Math.max(1, rect.height * .5), surface.dragCurrentY / Math.max(1, rect.height * .5), surface.dragVelocityX / Math.max(1, rect.height * .5), surface.dragVelocityY / Math.max(1, rect.height * .5))
    })
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    this.renderLiquidDebug(surfaces)
    this.frames++
    if (now - this.fpsAt > 500) { this.fps = Math.round(this.frames * 1000 / Math.max(1, now - this.fpsAt)); this.frames = 0; this.fpsAt = now }
    this.startLoop()
  }

  private onContextLost = (event: Event): void => { event.preventDefault(); this.stopLoop(); this.failed = true; this.availabilityListeners.forEach((listener) => listener(false)) }
  private onContextRestored = (): void => {
    try {
      if (!this.gl) throw new Error('WebGL2 context was not restored')
      this.program = createProgram(this.gl)
      this.buffer = this.gl.createBuffer()
      this.portalTextTexture = null
      this.ensurePortalTextTexture()
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer)
      this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), this.gl.STATIC_DRAW)
      this.cacheUniforms()
      this.uploadTextures()
      this.failed = false
      this.availabilityListeners.forEach((listener) => listener(true))
      this.startLoop()
    } catch (error) {
      console.warn('[CRPlay] shared WebGL2 restore failed; keeping fallback', error)
      this.failed = true
      this.availabilityListeners.forEach((listener) => listener(false))
    }
  }

  private readDebugMode(): number {
    if (typeof window === 'undefined') return 0
    const params = new URLSearchParams(window.location.search)
    if (params.get('webglDebug') !== '1' && !params.has('glassDebug')) return 0
    const modes: Record<string, number> = { base: 1, transmission: 1, sdf: 2, edge: 3, normal: 4, refraction: 5, 'outer-rim': 6, 'inner-rim': 7, fresnel: 8, specular: 9, dispersion: 10, deformation: 13, anchor: 14, final: 0 }
    return modes[params.get('glassDebug') ?? 'final'] ?? 0
  }

  private debugModeName(): string {
    const names = ['final', 'transmission', 'sdf', 'edge', 'normal', 'refraction', 'outer-rim', 'inner-rim', 'fresnel', 'specular', 'dispersion', 'reserved', 'reserved', 'deformation', 'anchor']
    return names[this.debugMode] ?? 'final'
  }

  private readMaterialMode(): number {
    if (typeof window === 'undefined') return 1
    const params = new URLSearchParams(window.location.search)
    return params.get('glassMaterial') === 'baseline' ? 0 : 1
  }

  private materialModeName(): string { return this.materialMode === 0 ? 'baseline' : 'aggressive_refined' }

  private readLiquidDebug(): boolean {
    return typeof window !== 'undefined' && import.meta.env.DEV && new URLSearchParams(window.location.search).get('liquidDebug') === '1'
  }

  private readLiquidView(): 'final' | 'shape' | 'material' {
    if (typeof window === 'undefined') return 'final'
    const view = new URLSearchParams(window.location.search).get('liquidView')
    return view === 'shape' || view === 'material' ? view : 'final'
  }

  private renderLiquidDebug(surfaces: SurfaceState[]): void {
    const context = this.debugContext
    const canvas = this.debugCanvas
    if (!this.liquidDebug || !context || !canvas) return
    canvas.width = Math.max(1, Math.round(this.width * this.dpr))
    canvas.height = Math.max(1, Math.round(this.height * this.dpr))
    canvas.style.width = `${this.width}px`
    canvas.style.height = `${this.height}px`
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    context.clearRect(0, 0, this.width, this.height)
    context.lineWidth = 1
    for (const surface of surfaces) {
      const snapshot = surface.snapshot
      if (!snapshot) continue
      const rect = surface.element.getBoundingClientRect()
      const drawContour = (nodes: Float32Array, color: string): void => {
        context.strokeStyle = color
        context.beginPath()
        for (let index = 0; index < snapshot.nodeCount; index++) {
          const angle = index / snapshot.nodeCount * TAU
          const nodeX = rect.left + rect.width * (.5 + nodes[index] * .5 * Math.cos(angle))
          const nodeY = rect.top + rect.height * (.5 + nodes[index] * .5 * Math.sin(angle))
          const next = (index + 1) % snapshot.nodeCount
          const nextAngle = next / snapshot.nodeCount * TAU
          const nextX = rect.left + rect.width * (.5 + nodes[next] * .5 * Math.cos(nextAngle))
          const nextY = rect.top + rect.height * (.5 + nodes[next] * .5 * Math.sin(nextAngle))
          const midX = (nodeX + nextX) * .5
          const midY = (nodeY + nextY) * .5
          if (index === 0) context.moveTo(midX, midY)
          context.quadraticCurveTo(nodeX, nodeY, midX, midY)
        }
        context.closePath()
        context.stroke()
      }
      drawContour(snapshot.restNodes, 'rgba(120, 255, 150, .72)')
      drawContour(snapshot.nodes, 'rgba(255, 100, 100, .95)')
      context.fillStyle = 'rgba(100, 185, 255, .98)'
      for (let index = 0; index < snapshot.nodeCount; index++) {
        const angle = index / snapshot.nodeCount * TAU
        const nodeX = rect.left + rect.width * (.5 + snapshot.nodes[index] * .5 * Math.cos(angle))
        const nodeY = rect.top + rect.height * (.5 + snapshot.nodes[index] * .5 * Math.sin(angle))
        context.fillRect(nodeX - 1.5, nodeY - 1.5, 3, 3)
      }
      const pointerX = rect.left + rect.width * (.5 + snapshot.pointerX * .5)
      const pointerY = rect.top + rect.height * (.5 + snapshot.pointerY * .5)
      context.strokeStyle = 'rgba(255, 224, 92, .9)'
      context.beginPath(); context.arc(pointerX, pointerY, snapshot.pointerRadius * rect.height * .5, 0, TAU); context.stroke()
      context.fillStyle = 'rgba(255, 224, 92, .98)'
      context.beginPath(); context.arc(pointerX, pointerY, 4, 0, TAU); context.fill()
    }
  }
}

export const portalWebGLScene = new PortalWebGLScene()
