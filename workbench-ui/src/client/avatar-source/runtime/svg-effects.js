import { HEAD_C } from "../original-data.js";
import { ALERT_GLYPH, CIRCLE_PATH, PENCIL_GLYPH } from "./geometry.js";
import { backOut, clamp, cubicInOut, cubicOut, random, smoothstep } from "./math.js";
const REDUCE_MOTION = typeof globalThis.matchMedia === "function" ? globalThis.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

export function renderDots(amount, now) {
  const anchors = [HEAD_C - 62, HEAD_C + 62];
  for (let index = 0; index < 2; index += 1) {
    const element = this.morphHeads[index];
    const phase = clamp((amount - 0.12 * index) / (1 - 0.12 * index), 0, 1);
    if (phase <= 0.004) continue;
    const grow = cubicOut(phase);
    const enter = backOut(phase);
    const pulseDistance = Math.abs(((((now - this.morphStartedAt) / 1400 + 0.119) % 1 + 1) % 1) - index * 2 / 3);
    const distance = Math.min(pulseDistance, 1 - pulseDistance);
    const pulse = REDUCE_MOTION.matches ? 1 : Math.exp(-(distance ** 2) / 0.045);
    const lift = REDUCE_MOTION.matches ? 0 : 9 * pulse * amount;
    const pop = REDUCE_MOTION.matches ? 1 : 0.84 + 0.22 * pulse;
    const scale = 22 * grow * pop / HEAD_C * 1.02;
    element.hidden = false;
    element.setAttribute("d", CIRCLE_PATH);
    element.setAttribute("transform", `translate(${(HEAD_C + (anchors[index] - HEAD_C) * enter).toFixed(1)} ${(HEAD_C - lift).toFixed(1)}) scale(${scale.toFixed(4)}) translate(${-HEAD_C} ${-HEAD_C})`);
    element.setAttribute("opacity", (grow * (1 - 0.5 * (1 - pulse))).toFixed(3));
  }
}

export function renderOrbit(amount, now) {
  const radius = 52 * backOut(amount);
  for (let index = 0; index < 5; index += 1) {
    const element = this.parts[index];
    const phase = 0.0017 * now + index * Math.PI * 2 / 5;
    const cosine = Math.cos(phase);
    const depth = 0.5 + 0.5 * clamp(cosine, 0, 1);
    element.hidden = false;
    element.setAttribute("cx", (HEAD_C + radius * Math.sin(phase)).toFixed(1));
    element.setAttribute("cy", (HEAD_C - 0.42 * radius * Math.cos(phase)).toFixed(1));
    element.setAttribute("r", Math.max(12 * depth * cubicOut(amount), 0.3).toFixed(2));
    element.setAttribute("opacity", (clamp((cosine + 0.4) / 0.6, 0.18, 1) * cubicOut(amount)).toFixed(3));
  }
}

export function renderRadar(amount, now, baseRadius) {
  for (let index = 0; index < 3; index += 1) {
    const element = this.rings[index];
    const phase = ((now / 1300 + index / 3) % 1 + 1) % 1;
    element.hidden = false;
    element.setAttribute("fill", "none");
    element.setAttribute("stroke", "var(--fg)");
    element.setAttribute("r", (baseRadius + (104 - baseRadius) * phase).toFixed(1));
    element.setAttribute("stroke-width", (3.4 * (1 - 0.55 * phase)).toFixed(2));
    element.setAttribute("opacity", (cubicOut(amount) * (1 - phase) * 0.9).toFixed(3));
  }
}

export function renderProgress(amount, now) {
  const radius = 62 * backOut(amount);
  const track = this.rings[3];
  const value = this.rings[4];
  track.hidden = false;
  track.setAttribute("fill", "none"); track.setAttribute("stroke", "var(--fg)"); track.setAttribute("r", radius.toFixed(1)); track.setAttribute("stroke-width", "5"); track.setAttribute("opacity", (0.16 * cubicOut(amount)).toFixed(3));
  const progress = clamp((now - this.morphShotStartedAt) / 2500 / 0.85, 0, 1);
  const circumference = 2 * Math.PI * radius;
  value.hidden = false;
  value.setAttribute("fill", "none"); value.setAttribute("stroke", "var(--fg)"); value.setAttribute("r", radius.toFixed(1)); value.setAttribute("stroke-width", "5"); value.setAttribute("stroke-dasharray", circumference.toFixed(1)); value.setAttribute("stroke-dashoffset", (circumference * (1 - progress)).toFixed(1)); value.setAttribute("transform", `rotate(-90 ${HEAD_C} ${HEAD_C})`); value.setAttribute("opacity", cubicOut(amount).toFixed(3));
}

export function renderGather(amount, now) {
  for (let index = 0; index < 5; index += 1) {
    const element = this.parts[index];
    const phase = clamp(((now - this.morphShotStartedAt) / 2000 - 0.09 * index) / 0.62, 0, 1);
    if (phase >= 1) continue;
    const settle = 1 - (1 - phase) ** 3;
    const angle = 2.4 * index + 2.2 * phase;
    const radius = 96 * (1 - settle);
    element.hidden = false;
    element.setAttribute("cx", (HEAD_C + radius * Math.cos(angle)).toFixed(1));
    element.setAttribute("cy", (HEAD_C + radius * Math.sin(angle) * 0.8).toFixed(1));
    element.setAttribute("r", (9 * (0.5 + 0.5 * settle) * cubicOut(amount)).toFixed(2));
    element.setAttribute("opacity", (cubicOut(amount) * clamp(5 * phase, 0, 1) * (1 - 0.25 * settle)).toFixed(3));
  }
}

export function renderWave(amount, now) {
  const offsets = [-2, -1, 1, 2];
  for (let index = 0; index < 4; index += 1) {
    const element = index < 2 ? this.morphHeads[index] : this.parts[index - 2];
    const offset = offsets[index];
    const phase = clamp((amount - 0.1 * Math.abs(offset)) / (1 - 0.1 * Math.abs(offset)), 0, 1);
    if (phase <= 0.004) continue;
    const energy = (0.42 + 0.29 * Math.sin(0.0021 * now) * Math.sin(0.0034 * now) + 0.29 * Math.sin(0.0013 * now + 1.7)) * (0.55 + 0.45 * Math.sin(0.012 * now - 1.05 * Math.abs(offset)));
    const size = (7 + 9 * clamp(energy, 0.08, 1)) * cubicOut(phase);
    const lift = 6 * clamp(energy, 0, 1) * phase;
    element.hidden = false;
    if (index < 2) {
      const scale = size / HEAD_C * 1.02;
      element.setAttribute("d", CIRCLE_PATH);
      element.setAttribute("transform", `translate(${(HEAD_C + 44 * offset * backOut(phase)).toFixed(1)} ${(HEAD_C - lift).toFixed(1)}) scale(${scale.toFixed(4)}) translate(${-HEAD_C} ${-HEAD_C})`);
    } else {
      element.setAttribute("cx", (HEAD_C + 44 * offset * backOut(phase)).toFixed(1)); element.setAttribute("cy", (HEAD_C - lift).toFixed(1)); element.setAttribute("r", size.toFixed(2));
    }
    element.setAttribute("opacity", phase.toFixed(3));
  }
}

export function renderSend(amount, now) {
  const phase = ((((now - this.stateStartedAt) / 1500) % 1) + 1) % 1;
  const travel = clamp((phase - 0.18) / 0.55, 0, 1);
  const eased = travel ** 2 * (0.4 + 0.6 * travel);
  const distance = 108 * eased;
  const first = this.parts[0];
  if (travel > 0 && travel < 1) { first.hidden = false; first.setAttribute("cx", (HEAD_C + 0.74 * distance).toFixed(1)); first.setAttribute("cy", (HEAD_C - 0.62 * distance).toFixed(1)); first.setAttribute("r", (10 * (1 - 0.55 * eased) * cubicOut(amount)).toFixed(2)); first.setAttribute("opacity", (cubicOut(amount) * (1 - eased ** 2)).toFixed(3)); }
  const secondTravel = clamp((phase - 0.26) / 0.55, 0, 1);
  const secondEase = secondTravel ** 2 * (0.4 + 0.6 * secondTravel);
  const second = this.parts[1];
  if (travel > 0 && secondTravel > 0 && secondTravel < 1) { const secondDistance = 108 * secondEase; second.hidden = false; second.setAttribute("cx", (HEAD_C + 0.74 * secondDistance).toFixed(1)); second.setAttribute("cy", (HEAD_C - 0.62 * secondDistance).toFixed(1)); second.setAttribute("r", (5 * (1 - 0.6 * secondEase) * cubicOut(amount)).toFixed(2)); second.setAttribute("opacity", (0.3 * cubicOut(amount) * (1 - secondEase)).toFixed(3)); }
  const ringPhase = clamp((phase - 0.18) / 0.3, 0, 1);
  if (ringPhase > 0 && ringPhase < 1) { const ring = this.rings[0]; ring.hidden = false; ring.setAttribute("fill", "none"); ring.setAttribute("stroke", "var(--fg)"); ring.setAttribute("r", (20 + 34 * cubicOut(ringPhase)).toFixed(1)); ring.setAttribute("stroke-width", (2.8 * (1 - ringPhase)).toFixed(2)); ring.setAttribute("opacity", (cubicOut(amount) * (1 - ringPhase) * 0.8).toFixed(3)); }
}

export function renderReceive(amount, now) {
  const elapsed = now - this.stateStartedAt;
  const cycle = Math.floor(elapsed / 1700);
  if (cycle !== this.receiveCycle) { this.receiveCycle = cycle; this.receiveAngle = random(-1.25 * Math.PI, 0.25 * Math.PI); }
  const phase = (((elapsed / 1700) % 1) + 1) % 1;
  const travel = clamp(phase / 0.6, 0, 1);
  const eased = 1 - (1 - travel) ** 3;
  const radius = 108 * (1 - eased);
  const orbit = 18 * Math.sin(travel * Math.PI) * (1 - 0.7 * eased);
  const cosine = Math.cos(this.receiveAngle || 0);
  const sine = Math.sin(this.receiveAngle || 0);
  const part = this.parts[0];
  if (travel < 1) { part.hidden = false; part.setAttribute("cx", (HEAD_C + cosine * radius - sine * orbit).toFixed(1)); part.setAttribute("cy", (HEAD_C + sine * radius + cosine * orbit).toFixed(1)); part.setAttribute("r", (3.5 + 6.5 * eased).toFixed(2)); part.setAttribute("opacity", (cubicOut(amount) * clamp(3.5 * travel, 0, 1) * (0.3 + 0.7 * eased)).toFixed(3)); }
  const ringPhase = clamp((phase - 0.58) / 0.32, 0, 1);
  if (ringPhase > 0 && ringPhase < 1) { const ring = this.rings[1]; ring.hidden = false; ring.setAttribute("fill", "none"); ring.setAttribute("stroke", "var(--fg)"); ring.setAttribute("r", (20 + 26 * cubicOut(ringPhase)).toFixed(1)); ring.setAttribute("stroke-width", (2.8 * (1 - ringPhase)).toFixed(2)); ring.setAttribute("opacity", (cubicOut(amount) * (1 - ringPhase) * 0.8).toFixed(3)); }
}

export function renderDock(amount, now) {
  const elapsed = (now - this.stateStartedAt) / 1000;
  for (let index = 0; index < 2; index += 1) {
    const part = this.parts[index];
    const phase = clamp((elapsed - (0.2 + 1.3 * index)) / 0.9, 0, 1);
    if (phase <= 0) continue;
    const eased = 1 - (1 - phase) ** 3;
    const angle = 0.0011 * now + index * Math.PI;
    const targetX = HEAD_C + 42 * Math.sin(angle);
    const targetY = HEAD_C + 21 * Math.cos(angle) + 2 * Math.sin(0.003 * now + index);
    const startX = HEAD_C - 120 + 30 * index;
    const startY = HEAD_C + 95;
    part.hidden = false; part.setAttribute("cx", (startX + (targetX - startX) * eased).toFixed(1)); part.setAttribute("cy", (startY + (targetY - startY) * eased).toFixed(1)); part.setAttribute("r", ((7 + 3 * eased) * cubicOut(amount)).toFixed(2)); part.setAttribute("opacity", (cubicOut(amount) * clamp(4 * phase, 0, 1)).toFixed(3));
  }
}

export function pencilPose(now) {
  const elapsed = now - this.stateStartedAt;
  const cycle = (((elapsed / 2500) % 1) + 1) % 1;
  if (cycle < 0.68) { const phase = cycle / 0.68; const envelope = clamp(phase / 0.08, 0, 1) * clamp((1 - phase) / 0.08, 0, 1); return { x: -54 + smoothstep(phase) * 118, y: 26, wiggle: 3.2 * Math.sin(24 * phase) * envelope, rotation: 17 + Math.sin(0.0006 * elapsed), lift: false }; }
  const phase = cubicInOut((cycle - 0.68) / 0.32);
  return { x: 64 - 118 * phase, y: 26 - 20 * Math.sin(phase * Math.PI), wiggle: 0, rotation: 17 - 2 * Math.sin(phase * Math.PI) + Math.sin(0.0006 * elapsed), lift: true };
}

export function renderPencil(amount, now) {
  const pose = this.pencilPose(now);
  const glyph = this.glyphs[0];
  const angle = (pose.rotation - 90) * Math.PI / 180;
  const offsetX = 68 * Math.cos(angle);
  const offsetY = 68 * Math.sin(angle);
  glyph.hidden = false; glyph.setAttribute("d", PENCIL_GLYPH); glyph.setAttribute("fill", "var(--fg)"); glyph.setAttribute("transform", `translate(${(HEAD_C + (pose.x + offsetX) * amount).toFixed(1)} ${(HEAD_C + (pose.y + 0.15 * pose.wiggle + offsetY) * amount).toFixed(1)}) rotate(${(pose.rotation * amount).toFixed(1)}) scale(${cubicOut(amount).toFixed(3)}) translate(${-HEAD_C} ${-HEAD_C})`); glyph.setAttribute("opacity", clamp(1.6 * amount - 0.3, 0, 1).toFixed(3));
  if (amount > 0.6 && !pose.lift) {
    const point = [HEAD_C + pose.x, HEAD_C + pose.y + pose.wiggle + 19];
    const last = this.writingTrail.at(-1);
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) > 2.4) {
      this.writingTrail.push(point);
      if (this.writingTrail.length > 64) this.writingTrail.shift();
    } else {
      last[0] = point[0];
      last[1] = point[1];
    }
  }
  else if (this.writingTrail.length) this.writingTrail.splice(0, 2);
  const trail = this.glyphs[1];
  if (this.writingTrail.length >= 2) {
    const points = this.writingTrail;
    let path = `M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
    if (points.length === 2) path += `L${points[1][0].toFixed(1)} ${points[1][1].toFixed(1)}`;
    else {
      for (let index = 0; index < points.length - 1; index += 1) {
        const previous = points[Math.max(index - 1, 0)];
        const point = points[index];
        const next = points[index + 1];
        const after = points[Math.min(index + 2, points.length - 1)];
        const control1X = point[0] + (next[0] - previous[0]) / 6;
        const control1Y = point[1] + (next[1] - previous[1]) / 6;
        const control2X = next[0] - (after[0] - point[0]) / 6;
        const control2Y = next[1] - (after[1] - point[1]) / 6;
        path += `C${control1X.toFixed(1)} ${control1Y.toFixed(1)} ${control2X.toFixed(1)} ${control2Y.toFixed(1)} ${next[0].toFixed(1)} ${next[1].toFixed(1)}`;
      }
    }
    trail.hidden = false;
    trail.setAttribute("fill", "none");
    trail.setAttribute("stroke", "var(--fg)");
    trail.setAttribute("stroke-width", "6");
    trail.setAttribute("stroke-linecap", "round");
    trail.setAttribute("stroke-linejoin", "round");
    trail.setAttribute("d", path);
    trail.setAttribute("opacity", clamp(1.2 * amount, 0, 1).toFixed(3));
  }
  return { x: pose.x, y: pose.y + 0.5 * pose.wiggle, rotation: pose.rotation, scale: 1, opacityLoss: 0 };
}

export function renderBang(amount, now) {
  const glyph = this.glyphs[2];
  const elapsed = (now - this.stateStartedAt) / 1000;
  const enter = cubicOut(clamp(1.1 * amount, 0, 1));
  const shake = 2.2 * Math.sin(42 * elapsed) * Math.exp(-((elapsed % 2.2) * 5.5));
  glyph.hidden = false; glyph.setAttribute("d", ALERT_GLYPH); glyph.setAttribute("fill", "var(--fg)"); glyph.setAttribute("transform", `translate(0 ${(-26 - (1 - enter) * 70).toFixed(1)}) rotate(${shake.toFixed(2)} ${HEAD_C} ${(HEAD_C - 74).toFixed(1)}) translate(${HEAD_C} ${HEAD_C}) scale(${clamp(1.2 * amount, 0, 1).toFixed(3)}) translate(${-HEAD_C} ${-HEAD_C})`); glyph.setAttribute("opacity", clamp(1.5 * amount - 0.2, 0, 1).toFixed(3));
  return { x: 0, y: 58, rotation: 0, scale: 1, opacityLoss: 0 };
}

export function renderStandby(amount, now) {
  const glow = this.parts[4];
  const pulse = 0.5 + 0.5 * Math.sin(0.0016 * now);
  glow.hidden = false; glow.setAttribute("cx", HEAD_C); glow.setAttribute("cy", HEAD_C); glow.setAttribute("r", (26 + 7 * pulse).toFixed(1)); glow.setAttribute("opacity", (cubicOut(amount) * (0.06 + 0.1 * pulse)).toFixed(3));
  if (amount < 0.995) { const ring = this.rings[2]; ring.hidden = false; ring.setAttribute("fill", "none"); ring.setAttribute("stroke", "var(--fg)"); ring.setAttribute("r", (104 - 88 * cubicOut(amount)).toFixed(1)); ring.setAttribute("stroke-width", "2.4"); ring.setAttribute("opacity", ((1 - cubicOut(amount)) * 0.5).toFixed(3)); }
}
