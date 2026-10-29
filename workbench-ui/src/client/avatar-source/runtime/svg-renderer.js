import { CIRCLE_RING, EYE_HALF, HEAD_C } from "../original-data.js";
import {
  ALERT_GLYPH,
  CIRCLE_PATH,
  PENCIL_GLYPH,
  PENCIL_RING,
  centroid,
  lerpRing,
  ringOutline,
  ringPath,
  shapeSpanAt,
  spanAt,
  turnedShapeRing,
} from "./geometry.js";
import { backOut, clamp, cubicInOut, cubicOut, random, smoothstep } from "./math.js";

export const MORPH_SIZES = Object.freeze({
  dots: 22,
  orbit: 19,
  radar: 19,
  progress: 19,
  gather: 19,
  wave: 16,
  send: 20,
  receive: 20,
  dock: 20,
  ball: 18,
  whirl: 15,
  pencil: 17,
  bang: 13,
  standby: 13,
});

const MORPH_EFFECTS = Object.keys(MORPH_SIZES);
const MORPH_VIEWBOX = {
  dots: 1.5,
  orbit: 1.14,
  radar: 1.14,
  progress: 1.32,
  gather: 1.15,
  wave: 1.42,
  send: 1.12,
  receive: 1.12,
  dock: 1.3,
  ball: 1.22,
  whirl: 1.45,
  pencil: 1.18,
  bang: 1.28,
  standby: 1.75,
};
const SVG_NS = "http://www.w3.org/2000/svg";
const REDUCE_MOTION = typeof globalThis.matchMedia === "function"
  ? globalThis.matchMedia("(prefers-reduced-motion: reduce)")
  : { matches: false };

export function render(now, config) {
  const geometry = this.resolveShape(config.shape);
  const shape = geometry.shape;
  const effectiveShape = {
    ...shape,
    face: geometry.face,
    tiltScale: geometry.tiltScale,
    beltRadius: geometry.beltRadius,
    top: geometry.transitioning ? Math.min(...geometry.ring.map((point) => point[1])) : shape.top,
    bottom: geometry.transitioning ? Math.max(...geometry.ring.map((point) => point[1])) : shape.bottom,
    spanSamples: geometry.transitioning ? null : shape.spanSamples,
  };
  const morphAmount = clamp(this.morph.x, 0, 1);
  this.currentBeltRadius = geometry.beltRadius + (this.state === "loading" ? (52 - geometry.beltRadius) * morphAmount : 0);
  const morphBlend = clamp(this.morphBlend.x, 0, 1);
  const previousMorphEffect = morphBlend < 0.999 ? this.previousMorphEffect : null;
  const morphIsTurning = this.morph.x > 0.001 || Math.abs(this.turn.target - this.turn.x) > 0.01;
  const morphTurn = morphIsTurning ? this.turn.x : 0;
  const turnAngle = morphTurn + (this.spinSpring?.x ?? 0) + this.directTurn;
  const baseShapeRing = geometry.ring;
  const shapeRing = Math.abs(turnAngle) > 0.001 && !geometry.transitioning ? turnedShapeRing(shape, turnAngle) : baseShapeRing;
  const activeMorphRing = this.morphEffect === "pencil" ? PENCIL_RING : CIRCLE_RING;
  const previousMorphRing = previousMorphEffect === "pencil" ? PENCIL_RING : CIRCLE_RING;
  const morphRing = previousMorphEffect
    ? lerpRing(previousMorphRing, activeMorphRing, cubicInOut(morphBlend))
    : activeMorphRing;
  const morphPathAmount = clamp(morphAmount / 0.62, 0, 1);
  const headRing = morphPathAmount <= 0 ? shapeRing : lerpRing(shapeRing, morphRing, cubicInOut(morphPathAmount));
  const headPath = morphPathAmount <= 0
    ? geometry.transitioning || (Math.abs(turnAngle) > 0.001 && (shape.solid || shape.sides)) ? ringOutline(shapeRing) : shape.path
    : ringOutline(headRing);
  this.head.setAttribute("d", headPath);
  this.clipHead.setAttribute("d", headPath);

  this.renderEyes(now, config, effectiveShape, shapeRing, turnAngle, morphAmount);
  const effect = this.morphEffect;
  const activeMorphSize = effect ? MORPH_SIZES[effect] : 19;
  const previousMorphSize = previousMorphEffect ? MORPH_SIZES[previousMorphEffect] : activeMorphSize;
  const morphSize = activeMorphSize * morphBlend + previousMorphSize * (1 - morphBlend);
  const morphScale = morphSize / HEAD_C;
  const effectPose = this.renderMorphEffects(morphAmount, morphBlend, previousMorphEffect, morphSize, now);
  this.renderHummingMarkers(effectiveShape);
  const normal = 1 - morphAmount;
  const translateX = this.headX.x * normal + this.directX * normal + effectPose.x;
  const translateY = this.headY.x * normal + this.directY * normal + effectPose.y;
  const rotation = this.rotation.x * 180 / Math.PI * geometry.tiltScale * normal + this.directRotation * normal + effectPose.rotation;
  const scaleX = config.scaleX * normal + morphScale * effectPose.scale * morphAmount;
  const scaleY = this.scaleY.x * normal + morphScale * effectPose.scale * morphAmount;
  this.transformGroup.setAttribute("transform", `translate(${(HEAD_C + translateX).toFixed(2)} ${(HEAD_C + translateY).toFixed(2)}) rotate(${rotation.toFixed(2)}) scale(${scaleX.toFixed(4)} ${scaleY.toFixed(4)}) translate(${-HEAD_C} ${-HEAD_C})`);
  this.transformGroup.style.opacity = effectPose.opacity.toFixed(3);

  const badgeAmount = clamp(this.notify.x, 0, 1.4);
  if (badgeAmount <= 0.01) this.badge.hidden = true;
  else {
    const badgeAnchor = shapeRing[Math.round(7 * shapeRing.length / 8) % shapeRing.length];
    this.badge.hidden = false;
    this.badge.setAttribute("fill", config.badgeColor);
    this.badge.setAttribute("stroke", config.eyeColor);
    this.badge.setAttribute("stroke-width", "10");
    this.badge.setAttribute("cx", badgeAnchor[0].toFixed(1));
    this.badge.setAttribute("cy", badgeAnchor[1].toFixed(1));
    this.badge.setAttribute("r", (20 * config.badgeScale * badgeAmount).toFixed(2));
  }

  const width = this.svg.getBoundingClientRect().width || 380;
  const responsive = 1 - smoothstep(clamp((width - 44) / 90, 0, 1));
  const activeExpansion = effect ? MORPH_VIEWBOX[effect] : 1;
  const previousExpansion = previousMorphEffect ? MORPH_VIEWBOX[previousMorphEffect] : activeExpansion;
  const expansion = activeExpansion * morphBlend + previousExpansion * (1 - morphBlend);
  const radius = 129.5 / (1 + (expansion - 1) * morphAmount * responsive);
  this.svg.setAttribute("viewBox", `${(114.5 - radius).toFixed(2)} ${(114.5 - radius).toFixed(2)} ${(2 * radius).toFixed(2)} ${(2 * radius).toFixed(2)}`);
  return { headPath, rotation };
}

export function renderEyes(now, config, shape, shapeRing, turnAngle, morphAmount) {
  const amount = clamp(this.expressionSpring.x, 0, 1);
  const eyeRings = [
    lerpRing(this.expressionFrom[0], this.expressionTo[0], amount),
    lerpRing(this.expressionFrom[1], this.expressionTo[1], amount),
  ];
  const centers = eyeRings.map(centroid);
  const face = shape.face;
  let top = shape.top;
  let bottom = shape.bottom;
  if (Math.abs(turnAngle) > 0.001) {
    top = Math.min(...shapeRing.map((point) => point[1]));
    bottom = Math.max(...shapeRing.map((point) => point[1]));
  }
  let leftHalf = 0;
  let rightHalf = 0;
  for (const point of eyeRings[0]) leftHalf = Math.max(leftHalf, Math.abs(point[0] - centers[0][0]));
  for (const point of eyeRings[1]) rightHalf = Math.max(rightHalf, Math.abs(point[0] - centers[1][0]));
  const distance = Math.abs(centers[1][0] - centers[0][0]) * face.sx;
  const fit = leftHalf + rightHalf > 0.5 ? clamp((distance - 5) / (leftHalf + rightHalf), 0.35, 4) : 4;

  if (config.pointer && this.pointer.active) {
    const bounds = this.svg.getBoundingClientRect();
    const flip = config.flipX ? -1 : 1;
    this.pointer.targetX = 22 * clamp((this.pointer.clientX - (bounds.left + bounds.width / 2)) / bounds.width, -0.6, 0.6) * flip;
    this.pointer.targetY = 14 * clamp((this.pointer.clientY - (bounds.top + bounds.height / 2)) / bounds.height, -0.6, 0.6);
  } else { this.pointer.targetX = 0; this.pointer.targetY = 0; }
  const smoothing = 1 - Math.exp(60 * Math.log(0.91) * (this.delta || 1 / 60));

  for (let index = 0; index < 2; index += 1) {
    this.pointer.x += (this.pointer.targetX - this.pointer.x) * smoothing;
    this.pointer.y += (this.pointer.targetY - this.pointer.y) * smoothing;
    const element = this.eyes[index];
    const ring = eyeRings[index];
    const [centerX, centerY] = centers[index];
    element.setAttribute("d", ringPath(ring));
    let localCenter = HEAD_C + face.x;
    let offsetX = (centerX - HEAD_C) * face.sx;
    let perspectiveX = 1;
    let visible = true;
    let perspectiveFade = 1;
    if (Math.abs(turnAngle) > 0.001) {
      const [left, right] = spanAt(shapeRing, clamp(HEAD_C + face.y + (centerY - HEAD_C) * face.sy, top + 2, bottom - 2));
      const radius = Math.max((right - left) / 2, 12);
      localCenter = (left + right) / 2;
      const initial = Math.asin(clamp(offsetX / radius, -1, 1));
      const turned = initial + turnAngle;
      const cosine = Math.cos(turned);
      const baseCosine = Math.max(Math.cos(initial), 0.02);
      visible = cosine > 0.02;
      perspectiveX = Math.max(cosine, 0.02) / baseCosine;
      offsetX = radius * Math.sin(turned);
      perspectiveFade = smoothstep(clamp(cosine / 0.5, 0, 1));
    }
    const pulse = 1 + 0.07 * Math.sin(amount * Math.PI);
    let driftX = 1.4 * Math.sin(0.00042 * now + index) + 0.5 * Math.sin(0.001 * now + 2 * index);
    let driftY = 0.9 * Math.sin(0.00058 * now + index);
    const autonomousGazeWeight = config.pointer && this.pointer.active ? 0.2 : 1;
    driftX += this.pointer.x * (config.pointerGain ?? 1) + this.aimX.x * autonomousGazeWeight + this.directGazeX;
    driftY += this.pointer.y * (config.pointerGain ?? 1) + this.aimY.x * autonomousGazeWeight + this.directGazeY;
    const notification = clamp(this.notify.x, 0, 1);
    driftX -= 10 * notification;
    driftY += 7 * notification;
    const eyeScale = Math.min(clamp(this.eyeScale.x, 0.2, 2) * face.eye, fit / pulse);
    const scaleX = clamp(perspectiveX * eyeScale * pulse, 0.02, 2.4);
    let winkScale = 1;
    if (index === this.winkEye && now < this.winkAt + 320) {
      const phase = (now - this.winkAt) / 320;
      winkScale = Math.max(phase < 0.42 ? 1 - phase / 0.42 : (phase - 0.42) / 0.58, 0.04);
    }
    const scaleY = clamp(Math.max(this.eyeOpen.x * winkScale, 0.04) * eyeScale * pulse, 0.02, 2.4);
    element.style.display = visible && morphAmount < 0.5 ? "" : "none";
    const halfHeight = EYE_HALF * scaleY + 2;
    const y = clamp(HEAD_C + face.y + (centerY + driftY - HEAD_C) * face.sy, top + halfHeight, bottom - halfHeight);
    let maxLeft = -Infinity;
    let minRight = Infinity;
    for (let point = 0; point < ring.length; point += 2) {
      const scaledX = (ring[point][0] - centerX) * scaleX;
      const sampleY = y + (ring[point][1] - centerY) * scaleY;
      const [left, right] = Math.abs(turnAngle) > 0.001 ? spanAt(shapeRing, sampleY) : shapeSpanAt(shape, sampleY);
      maxLeft = Math.max(maxLeft, left - scaledX);
      minRight = Math.min(minRight, right - scaledX);
    }
    const desired = localCenter + offsetX + driftX * face.sx;
    const bounded = maxLeft <= minRight ? clamp(desired, maxLeft, minRight) : (maxLeft + minRight) / 2;
    let finalX = bounded + (desired - bounded) * (1 - perspectiveFade);
    let finalY = y;
    if (notification > 0.01) {
      const badgeAnchor = shapeRing[Math.round(7 * shapeRing.length / 8) % shapeRing.length];
      const dx = finalX - badgeAnchor[0];
      const dy = finalY - badgeAnchor[1];
      const distance = Math.hypot(dx, dy) || 1;
      const directionX = dx / distance;
      const directionY = dy / distance;
      const eyeHalf = index === 0 ? leftHalf : rightHalf;
      const needed = 20 * clamp(this.notify.x, 0, 1.4) + Math.hypot(eyeHalf * scaleX * directionX, EYE_HALF * scaleY * directionY) + 5;
      if (distance < needed) {
        finalX += directionX * (needed - distance);
        finalY += directionY * (needed - distance);
      }
    }
    element.setAttribute("transform", `translate(${finalX.toFixed(2)} ${finalY.toFixed(2)}) scale(${scaleX.toFixed(4)} ${scaleY.toFixed(4)}) translate(${(-centerX).toFixed(2)} ${(-centerY).toFixed(2)})`);
  }
}

export function createMorphLayer(effect) {
  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("class", "morph-effect-layer");
  group.setAttribute("data-morph-effect", effect);
  const create = (tag, className, count) => Array.from({ length: count }, () => {
    const element = document.createElementNS(SVG_NS, tag);
    element.setAttribute("class", className);
    if (tag === "circle") {
      element.setAttribute("cx", HEAD_C);
      element.setAttribute("cy", HEAD_C);
      element.setAttribute("r", 0);
    }
    element.hidden = true;
    group.appendChild(element);
    return element;
  });
  const layer = {
    group,
    heads: create("path", "grok-bot-mark__head morph-head", 2),
    rings: create("circle", "morph-ring", 5),
    parts: create("circle", "grok-bot-mark__head morph-part", 5),
    glyphs: create("path", "morph-glyph", 3),
  };
  this.svg.insertBefore(group, this.transformGroup);
  this.morphLayers.set(effect, layer);
  return layer;
}

export function useMorphLayer(layer) {
  this.morphHeads = layer.heads;
  this.rings = layer.rings;
  this.parts = layer.parts;
  this.glyphs = layer.glyphs;
}

export function hideMorphElements() {
  for (const element of [...this.morphHeads, ...this.rings, ...this.parts, ...this.glyphs]) element.hidden = true;
}

export function renderHummingMarkers(shape) {
  const amount = clamp(this.humming.x, 0, 1);
  if (amount <= 0.01) return;
  for (let index = 0; index < 2; index += 1) {
    const element = this.parts[3 + index];
    const angle = 0.85 * this.spinAngle + index * Math.PI;
    const radius = 1.3 * shape.radius;
    const depth = 0.55 + 0.45 * clamp((Math.cos(angle) + 1) / 2, 0, 1);
    element.hidden = false;
    element.setAttribute("cx", (HEAD_C + radius * Math.sin(angle)).toFixed(1));
    element.setAttribute("cy", (HEAD_C - 0.38 * radius * Math.cos(angle) - 8).toFixed(1));
    element.setAttribute("r", (7.5 * depth * amount).toFixed(2));
    element.setAttribute("opacity", ((0.3 + 0.7 * depth) * amount).toFixed(3));
  }
}

export function renderMorphEffects(morphAmount, morphBlend, previousMorphEffect, morphSize, now) {
  this.useMorphLayer(this.baseMorphLayer);
  this.hideMorphElements();
  for (const layer of this.morphLayers.values()) layer.group.hidden = true;
  const pose = { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 };
  if (!this.morphEffect || morphAmount <= 0.004) return pose;

  const effectAmount = (effect) => {
    if (effect === this.morphEffect) return morphAmount * morphBlend;
    if (effect === previousMorphEffect) return morphAmount * (1 - morphBlend);
    return 0;
  };
  const elapsed = now - this.stateStartedAt;

  for (const effect of MORPH_EFFECTS) {
    const amount = effectAmount(effect);
    if (amount <= 0.004) continue;
    const layer = this.morphLayers.get(effect) || this.createMorphLayer(effect);
    layer.group.hidden = false;
    this.useMorphLayer(layer);
    this.hideMorphElements();
    switch (effect) {
      case "dots": {
        this.renderDots(amount, now);
        const distance = Math.abs(((((now - this.morphStartedAt) / 1400 + 0.119) % 1 + 1) % 1) - 1 / 3);
        const pulseDistance = Math.min(distance, 1 - distance);
        const pulse = REDUCE_MOTION.matches ? 1 : Math.exp(-(pulseDistance ** 2) / 0.045);
        const pop = REDUCE_MOTION.matches ? 1 : 0.84 + 0.22 * pulse;
        pose.scale *= 1 + (pop - 1) * (amount / Math.max(morphAmount, 0.001));
        pose.y -= REDUCE_MOTION.matches ? 0 : 9 * pulse * amount * morphAmount;
        pose.opacity *= 1 - (REDUCE_MOTION.matches ? 0 : 0.5 * (1 - pulse)) * amount;
        break;
      }
      case "orbit": this.renderOrbit(amount, now); break;
      case "radar": this.renderRadar(amount, now, morphSize); break;
      case "progress": this.renderProgress(amount, now); break;
      case "gather": this.renderGather(amount, now); break;
      case "wave": this.renderWave(amount, now); break;
      case "send": {
        this.renderSend(amount, now);
        const phase = ((((elapsed / 1500) % 1) + 1) % 1);
        pose.scale *= 1 + (phase < 0.18 ? -0.06 * Math.sin(phase / 0.18 * Math.PI) : phase < 0.42 ? 0.05 * Math.sin((phase - 0.18) / 0.24 * Math.PI) : 0) * amount;
        break;
      }
      case "receive": {
        this.renderReceive(amount, now);
        const phase = clamp((((((elapsed / 1700) % 1) + 1) % 1) - 0.58) / 0.34, 0, 1);
        pose.scale *= 1 + 0.11 * Math.sin(phase * Math.PI) * amount;
        break;
      }
      case "dock": this.renderDock(amount, now); break;
      case "pencil": {
        const pencil = this.renderPencil(amount, now);
        pose.x += pencil.x * amount * morphAmount;
        pose.y += pencil.y * amount * morphAmount;
        pose.rotation += pencil.rotation * amount * morphAmount;
        break;
      }
      case "bang":
        this.renderBang(amount, now);
        pose.y += 58 * amount * morphAmount;
        pose.scale *= 1 + 0.04 * Math.exp(-((elapsed / 1000 % 2.2) * 5.5)) * amount;
        break;
      case "standby":
        this.renderStandby(amount, now);
        pose.opacity *= 1 - (0.28 + 0.2 * Math.sin(0.0016 * now)) * amount;
        break;
      case "whirl":
        pose.x += (2 * Math.sin(0.0009 * now) + 0.8 * Math.sin(0.0017 * now)) * amount * morphAmount;
        pose.y += (2.4 * Math.sin(0.0013 * now) + 1.2 * Math.sin(0.0006 * now)) * amount * morphAmount;
        break;
      case "ball": {
        const seconds = elapsed / 1000;
        const gravity = 416 / 0.3844;
        const fall = Math.sqrt(80 / gravity);
        const cycle = ((((seconds - fall) / 0.62) % 1 + 1) % 1);
        const height = seconds < fall ? 40 - 0.5 * gravity * seconds ** 2 : 208 * cycle * (1 - cycle);
        pose.y += (40 - height) * amount * morphAmount;
        break;
      }
      default: break;
    }
  }
  this.useMorphLayer(this.baseMorphLayer);
  return pose;
}

export { renderDots, renderOrbit, renderRadar, renderProgress, renderGather, renderWave, renderSend, renderReceive, renderDock, pencilPose, renderPencil, renderBang, renderStandby } from "./svg-effects.js";
