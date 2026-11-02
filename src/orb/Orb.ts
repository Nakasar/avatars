import * as THREE from 'three';
import type { Character } from '../avatar/Character';
import type { Expression, Mode } from '../avatar/Avatar';
import type { VisemeFrame } from '../avatar/lipsync';

export type OrbColor = 'blue' | 'orange' | 'green' | 'violet';

/** Teintes de l'orbe : couleur principale, étincelles et cœur. */
export const ORB_PALETTES: Record<OrbColor, { main: number; accent: number; core: number }> = {
  blue: { main: 0x2f8cff, accent: 0xffa24a, core: 0xd2e9ff },
  orange: { main: 0xff9a1f, accent: 0xffe08a, core: 0xfff0d2 },
  green: { main: 0x1fe08a, accent: 0xd4ff5a, core: 0xe0fff0 },
  violet: { main: 0x9b5cff, accent: 0xff6ad5, core: 0xf0e2ff },
};

export function isOrbColor(v: unknown): v is OrbColor {
  return typeof v === 'string' && v in ORB_PALETTES;
}

/** Rayon de la sphère, en mètres de scène. */
const R = 0.5;
/** Formes que prend l'orbe en se reconfigurant : 0 sphère, 1 gyroscope, 2 cube, 3 nœud. */
const SHAPES = 4;

/**
 * Orbe IA « mascotte » : une sphère holographique de données faite de particules,
 * d'un réseau de circuits, d'anneaux, d'éclats et d'étincelles autour d'un cœur lumineux.
 *
 * Elle exprime les états de la conversation :
 *  - au repos, elle respire, flotte et se reconfigure de temps en temps ;
 *  - quand on lui parle, elle se resserre et vibre au rythme de la voix de l'utilisateur ;
 *  - quand elle réfléchit, ses anneaux et ses données s'allument, elle tourbillonne et
 *    change de forme en boucle (gyroscope, cube, nœud) ;
 *  - quand elle parle, son cœur et sa surface pulsent avec l'énergie de sa voix.
 */
export class Orb implements Character {
  readonly root = new THREE.Group();
  readonly focus = new THREE.Vector3(0, -0.1, 0);
  framingHeight = R * 2.7;

  private shell = new THREE.Group();
  private rings: Array<{ group: THREE.Group; spin: number; mat: THREE.ShaderMaterial }> = [];
  private shards!: THREE.InstancedMesh;
  private shardData: Array<{
    axis: THREE.Vector3; radius: number; angle: number; speed: number;
    tumbleAxis: THREE.Vector3; tumble: number; tumbleSpeed: number; scale: THREE.Vector3; base: THREE.Vector3;
  }> = [];
  private core: THREE.Sprite;
  private hot: THREE.Sprite;
  private halo: THREE.Sprite;
  private glyphs: Array<{ sprite: THREE.Sprite; seed: number }> = [];
  private disposables: Array<{ dispose(): void }> = [];

  private u = {
    uTime: { value: 0 },
    uFlow: { value: 0 },
    uRadius: { value: R },
    uEnergy: { value: 0 },
    uUser: { value: 0 },
    uThink: { value: 0 },
    uListen: { value: 0 },
    uPulse: { value: 0 },
    uBreath: { value: 0 },
    uIntensity: { value: 1 },
    uMorph: { value: new THREE.Vector3() },
    uLattice: { value: 1 },
    uShards: { value: 1 },
    uSparks: { value: 1 },
    uScale: { value: 800 },
    uColor: { value: new THREE.Color() },
    uAccent: { value: new THREE.Color() },
    uCore: { value: new THREE.Color() },
  };
  private target = { main: new THREE.Color(), accent: new THREE.Color(), core: new THREE.Color() };

  private mode: Mode = 'idle';
  private modeTime = 0;
  private f = { listen: 0, think: 0, speak: 0, energy: 0, user: 0, bright: 1, spin: 1, rings: 0.25, glyphs: 0.2 };
  private expr = { bright: 1, spin: 1 };
  private pulse = { x: 0, v: 0 };
  private userLevel = 0;
  private speechEnergy = 0;
  private openness = 0;
  private shape = { current: 0, next: 4 + Math.random() * 4, hold: 0 };
  private morph = new THREE.Vector3();

  constructor(color: OrbColor = 'blue') {
    this.setColor(color, true);
    this.root.add(this.shell);
    this.buildShell();
    this.buildLattice();
    this.buildRings();
    this.buildShards();
    this.buildSparks();
    this.buildGlyphs();

    const glow = glowTexture();
    this.disposables.push(glow);
    const sprite = (opacity: number) => {
      const m = new THREE.SpriteMaterial({
        map: glow, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity,
      });
      this.disposables.push(m);
      return new THREE.Sprite(m);
    };
    this.halo = sprite(0.1);
    this.core = sprite(1);
    this.hot = sprite(1);
    this.halo.renderOrder = -1;
    this.root.add(this.halo, this.core, this.hot);

    // Taille des points : dépend de la hauteur de l'image et du champ de la caméra.
    const size = new THREE.Vector2();
    this.core.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getDrawingBufferSize(size);
      const fov = (camera as THREE.PerspectiveCamera).fov ?? 22;
      this.u.uScale.value = size.y * 0.5 / Math.tan(THREE.MathUtils.degToRad(fov / 2));
    };
  }

  // ------------------------------------------------------------------ API Character
  setColor(name: OrbColor, immediate = false) {
    const p = ORB_PALETTES[name] ?? ORB_PALETTES.blue;
    this.target.main.setHex(p.main);
    this.target.accent.setHex(p.accent);
    this.target.core.setHex(p.core);
    if (immediate) {
      this.u.uColor.value.copy(this.target.main);
      this.u.uAccent.value.copy(this.target.accent);
      this.u.uCore.value.copy(this.target.core);
    }
  }

  setExpression(name: Expression, intensity = 1) {
    const k = THREE.MathUtils.clamp(intensity, 0, 1);
    const table: Record<Expression, { bright: number; spin: number; kick: number }> = {
      neutral: { bright: 1, spin: 1, kick: 0 },
      listening: { bright: 1.05, spin: 0.8, kick: 0 },
      happy: { bright: 1.3, spin: 1.5, kick: 0.04 },
      thinking: { bright: 0.95, spin: 1.2, kick: 0 },
      surprised: { bright: 1.25, spin: 1.8, kick: 0.12 },
      sad: { bright: 0.65, spin: 0.5, kick: -0.03 },
    };
    const e = table[name];
    this.expr.bright = 1 + (e.bright - 1) * k;
    this.expr.spin = 1 + (e.spin - 1) * k;
    this.pulse.v += e.kick * k * 6;
  }

  setVisemes(frame: VisemeFrame, energy: number) {
    this.speechEnergy = THREE.MathUtils.clamp(energy, 0, 1);
    this.openness = (frame.aa ?? 0) + (frame.O ?? 0) * 0.8 + (frame.E ?? 0) * 0.5 + (frame.U ?? 0) * 0.4;
  }

  setMode(mode: Mode) {
    if (mode === this.mode) return;
    if (mode === 'thinking') this.shape.next = 0.4; // se reconfigure aussitôt
    if (mode === 'speaking' || mode === 'listening') {
      this.shape.current = 0; // reprend sa forme de sphère pour parler ou écouter
      this.shape.next = 6 + Math.random() * 6;
    }
    if (mode === 'speaking') this.pulse.v += 0.5;
    this.mode = mode;
    this.modeTime = 0;
  }

  get currentMode() {
    return this.mode;
  }

  nod() {
    this.pulse.v += 0.35;
  }

  setUserLevel(level: number) {
    this.userLevel = THREE.MathUtils.clamp(level, 0, 1);
  }

  lookAt(_world: THREE.Vector3) {
    // L'orbe est symétrique : elle n'a pas besoin de regarder la caméra.
  }

  update(dt: number, t: number) {
    this.modeTime += dt;
    const damp = (cur: number, to: number, rate: number) => THREE.MathUtils.damp(cur, to, rate, dt);
    const f = this.f;
    const m = this.mode;

    f.listen = damp(f.listen, m === 'listening' ? 1 : 0, 4);
    f.think = damp(f.think, m === 'thinking' ? 1 : 0, 3);
    f.speak = damp(f.speak, m === 'speaking' ? 1 : 0, 4);
    const voice = Math.min(1, this.speechEnergy * 1.2 + this.openness * 0.3) * (m === 'speaking' ? 1 : 0.3);
    f.energy = damp(f.energy, voice, voice > f.energy ? 22 : 9);
    f.user = damp(f.user, this.userLevel, this.userLevel > f.user ? 18 : 6);
    f.bright = damp(f.bright, this.expr.bright, 2);
    f.spin = damp(f.spin, this.expr.spin, 1.5);
    f.rings = damp(f.rings, 0.22 + f.think * 0.75 + f.speak * 0.15 + f.user * 0.3, 3);
    f.glyphs = damp(f.glyphs, 0.12 + f.think * 0.7 + f.energy * 0.25, 3);

    // Ressort : pulsations (acquiescement, surprise, début de parole).
    const k = 120, c = 9;
    this.pulse.v += (-k * this.pulse.x - c * this.pulse.v) * dt;
    this.pulse.x += this.pulse.v * dt;

    // Respiration : lente au repos, plus vive à l'écoute.
    const breath = Math.sin(t * (1.1 + f.listen * 0.9)) * (0.018 + f.listen * 0.01);

    // Couleur (transition douce quand on la change).
    const ct = 1 - Math.exp(-dt * 4);
    this.u.uColor.value.lerp(this.target.main, ct);
    this.u.uAccent.value.lerp(this.target.accent, ct);
    this.u.uCore.value.lerp(this.target.core, ct);

    // Reconfiguration : change de forme en réfléchissant, et parfois au repos.
    this.updateShape(dt);
    const mx = Math.max(this.morph.x, this.morph.y, this.morph.z);

    const u = this.u;
    u.uTime.value = t;
    u.uFlow.value += dt * (0.25 + f.energy * 1.4 + f.think * 0.5 + f.user * 0.4);
    u.uEnergy.value = f.energy;
    u.uUser.value = f.user * f.listen;
    u.uThink.value = f.think;
    u.uListen.value = f.listen;
    u.uPulse.value = this.pulse.x;
    u.uBreath.value = breath;
    u.uIntensity.value = f.bright * (0.95 + f.energy * 0.6 + f.user * 0.3);
    u.uMorph.value.copy(this.morph);
    u.uLattice.value = 1 - mx;
    u.uShards.value = 0.8 + f.think * 0.4 + f.energy * 0.5;
    u.uSparks.value = 0.5 + f.energy * 1.2 + f.think * 0.6;

    // Mouvements d'ensemble : flottement, dérive et rotation.
    this.root.position.set(Math.sin(t * 0.37) * 0.025, Math.sin(t * 0.8) * 0.03 - (f.bright < 0.9 ? 0.03 : 0), 0);
    const spin = (0.14 + f.think * 0.9 + f.energy * 0.35) * f.spin;
    this.shell.rotation.y += dt * spin;
    this.shell.rotation.x = Math.sin(t * 0.21) * 0.25 + f.think * Math.sin(t * 0.9) * 0.2;
    this.shell.rotation.z = Math.cos(t * 0.17) * 0.12;

    for (const r of this.rings) {
      r.group.rotation.z += dt * r.spin * (0.4 + f.think * 2.2 + f.energy) * f.spin;
      r.mat.uniforms.uRings.value = f.rings;
    }

    this.updateShards(dt);
    for (const g of this.glyphs) {
      const flick = 0.5 + 0.5 * Math.sin(t * (2 + g.seed * 5) + g.seed * 40);
      g.sprite.material.opacity = f.glyphs * flick * flick;
      g.sprite.material.color.copy(u.uColor.value).multiplyScalar(1.6 * u.uIntensity.value);
    }

    // Cœur : bat avec la voix, scintille en réfléchissant, s'avive quand on lui parle.
    const flicker = 1 + f.think * 0.25 * Math.sin(t * 23) * Math.sin(t * 7.3);
    const coreGain = u.uIntensity.value * flicker * (1 + f.energy * 1.6 + f.user * 0.8);
    const s = 1 + this.pulse.x + breath;
    this.core.scale.setScalar(R * (0.95 + f.energy * 0.55 + f.user * 0.3) * s);
    this.core.material.color.copy(u.uColor.value).lerp(u.uCore.value, 0.2).multiplyScalar(1.1 * coreGain);
    this.hot.scale.setScalar(R * (0.32 + f.energy * 0.35) * s);
    this.hot.material.color.copy(u.uCore.value).multiplyScalar(2.2 * coreGain);
    this.halo.scale.setScalar(R * 5.5 * (1 + f.energy * 0.15));
    this.halo.material.color.copy(u.uColor.value).multiplyScalar(0.5 * f.bright);
  }

  dispose() {
    this.root.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (g) g.dispose();
      const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      for (const x of [mat ?? []].flat()) {
        (x as THREE.SpriteMaterial).map?.dispose();
        x.dispose();
      }
    });
    for (const d of this.disposables) d.dispose();
  }

  // ------------------------------------------------------------------ Animation
  private updateShape(dt: number) {
    const s = this.shape;
    s.next -= dt;
    if (s.next <= 0) {
      if (this.mode === 'thinking') {
        // En réfléchissant : enchaîne les formes, en repassant parfois par la sphère.
        const options = [1, 2, 3, 0].filter((x) => x !== s.current);
        s.current = options[Math.floor(Math.random() * (s.current === 0 ? 3 : 4))];
        s.next = 1.6 + Math.random() * 0.8;
      } else if (this.mode === 'idle' && s.current === 0) {
        s.current = 1 + Math.floor(Math.random() * (SHAPES - 1));
        s.next = 2.5 + Math.random() * 1.5;
      } else {
        s.current = 0;
        s.next = 10 + Math.random() * 8;
      }
    }
    const step = dt / 1.1;
    const goal = [s.current === 1 ? 1 : 0, s.current === 2 ? 1 : 0, s.current === 3 ? 1 : 0];
    const towards = (v: number, g: number) => (v < g ? Math.min(g, v + step) : Math.max(g, v - step));
    this.morph.set(towards(this.morph.x, goal[0]), towards(this.morph.y, goal[1]), towards(this.morph.z, goal[2]));
  }

  private updateShards(dt: number) {
    const f = this.f;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const tq = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const reach = 1 + f.energy * 0.28 + f.think * 0.08 - f.listen * 0.06 + this.pulse.x * 1.5;
    this.shardData.forEach((d, i) => {
      d.angle += dt * d.speed * (1 + f.think * 2.2 + f.energy * 1.2) * f.spin;
      d.tumble += dt * d.tumbleSpeed * (1 + f.think * 2);
      p.copy(d.base).applyAxisAngle(d.axis, d.angle).multiplyScalar(d.radius * reach);
      q.setFromAxisAngle(d.tumbleAxis, d.tumble);
      tq.setFromUnitVectors(new THREE.Vector3(0, 0, 1), p.clone().normalize());
      q.premultiply(tq);
      m.compose(p, q, d.scale);
      this.shards.setMatrixAt(i, m);
    });
    this.shards.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------ Construction
  private material(vertex: string, fragment: string, extra: Record<string, THREE.IUniform> = {}) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.u, ...extra },
      vertexShader: NOISE + DISPLACE + vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return mat;
  }

  /** Nuée de particules qui forme la surface, avec ses formes de reconfiguration. */
  private buildShell() {
    const n = 7000;
    const sphere = new Float32Array(n * 3);
    const gyro = new Float32Array(n * 3);
    const cube = new Float32Array(n * 3);
    const knot = new Float32Array(n * 3);
    const rand = new Float32Array(n * 4);
    const v = new THREE.Vector3();
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      // Sphère : répartition de Fibonacci, avec une fine épaisseur.
      const y = 1 - (i / (n - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = golden * i;
      v.set(Math.cos(th) * r, y, Math.sin(th) * r).multiplyScalar(R * (0.97 + Math.random() * 0.06));
      v.toArray(sphere, i * 3);

      // Gyroscope : trois grands cercles orthogonaux et un noyau de données.
      const a = Math.random() * Math.PI * 2;
      const j = () => (Math.random() - 0.5) * R * 0.05;
      const k = i % 4;
      if (k === 3) v.randomDirection().multiplyScalar(R * 0.32 * Math.cbrt(Math.random()));
      else {
        const cr = R * (1.02 + (i % 3) * 0.03);
        const c = Math.cos(a) * cr, s = Math.sin(a) * cr;
        v.set(k === 0 ? c : k === 1 ? 0 : c, k === 0 ? s : k === 1 ? c : 0, k === 0 ? 0 : s);
        v.x += j(); v.y += j(); v.z += j();
      }
      v.toArray(gyro, i * 3);

      // Cube holographique : arêtes et grille des faces.
      const h = R * 0.68;
      const grid = (x: number) => (Math.round(x * 2) / 2);
      const u1 = Math.random() * 2 - 1, u2 = Math.random() * 2 - 1;
      const face = Math.floor(Math.random() * 6);
      const onLine = Math.random() < 0.5;
      const pa = onLine ? grid(u1) : u1, pb = onLine ? u2 : grid(u2);
      const sign = face % 2 ? 1 : -1;
      const axis = Math.floor(face / 2);
      const coords = axis === 0 ? [sign, pa, pb] : axis === 1 ? [pa, sign, pb] : [pa, pb, sign];
      v.set(coords[0], coords[1], coords[2]).multiplyScalar(h);
      v.toArray(cube, i * 3);

      // Nœud torique (2,3) : un ruban de données entrelacé.
      const tt = (i / n) * Math.PI * 2;
      const rr = 2 + Math.cos(3 * tt);
      v.set(rr * Math.cos(2 * tt), rr * Math.sin(2 * tt), -Math.sin(3 * tt)).multiplyScalar(R * 0.3);
      v.add(new THREE.Vector3().randomDirection().multiplyScalar(R * 0.07 * Math.random()));
      v.toArray(knot, i * 3);

      rand.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(sphere, 3));
    g.setAttribute('aShape1', new THREE.BufferAttribute(gyro, 3));
    g.setAttribute('aShape2', new THREE.BufferAttribute(cube, 3));
    g.setAttribute('aShape3', new THREE.BufferAttribute(knot, 3));
    g.setAttribute('aRand', new THREE.BufferAttribute(rand, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R * 2);
    const mat = this.material(
      /* glsl */ `
      attribute vec3 aShape1; attribute vec3 aShape2; attribute vec3 aShape3; attribute vec4 aRand;
      uniform vec3 uMorph;
      varying float vAlpha; varying float vHot;
      void main() {
        // Reconfiguration en vague, du haut vers le bas, chaque particule avec son retard.
        float st = clamp(position.y / uRadius * 0.5 + 0.5, 0.0, 1.0) * 0.35 + aRand.x * 0.25;
        vec3 w = smoothstep(vec3(st), vec3(st + 0.4), uMorph);
        vec3 p = mix(mix(mix(position, aShape1, w.x), aShape2, w.y), aShape3, w.z);
        // Pendant la transition, les particules s'éparpillent puis se réassemblent.
        float burst = dot(w * (1.0 - w), vec3(4.0));
        vec3 dir = normalize(p + vec3(1e-4));
        p += dir * burst * uRadius * 0.35 * aRand.y;
        // Tourbillon pendant la réflexion.
        float a = uThink * (aRand.y - 0.5) * 0.9 * sin(uTime * 0.7 + aRand.z * 6.28);
        p.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * p.xz;
        p = orbDisplace(p);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float tw = pow(0.5 + 0.5 * sin(uTime * (1.0 + aRand.z * 3.0) + aRand.x * 40.0), 3.0);
        vAlpha = 0.3 + 0.7 * tw;
        vHot = step(0.97, aRand.w);
        gl_PointSize = 0.0065 * uRadius * 2.0 * (0.6 + aRand.w * 1.3 + vHot * 1.5) * uScale / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
      /* glsl */ `
      uniform vec3 uColor; uniform vec3 uCore; uniform float uIntensity;
      varying float vAlpha; varying float vHot;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        vec3 c = mix(uColor, uCore, vHot * 0.7);
        gl_FragColor = vec4(c * uIntensity * (1.1 + vHot * 1.5), a * vAlpha * 0.6);
      }`,
    );
    this.shell.add(new THREE.Points(g, mat));
  }

  /** Réseau de circuits sur la sphère, qui scintille comme un flux de données. */
  private buildLattice() {
    const nodes: THREE.Vector3[] = [];
    for (let i = 0; i < 360; i++) nodes.push(new THREE.Vector3().randomDirection());
    const pos: number[] = [];
    const seed: number[] = [];
    const seen = new Set<string>();
    const sub = 5;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    nodes.forEach((n, i) => {
      const near = nodes
        .map((m, j) => ({ j, d: m.distanceToSquared(n) }))
        .filter((x) => x.j !== i)
        .sort((x, y) => x.d - y.d)
        .slice(0, 2 + (i % 2));
      for (const { j } of near) {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const s = Math.random();
        // Arc découpé en segments, posé sur la sphère.
        for (let k = 0; k < sub; k++) {
          a.lerpVectors(n, nodes[j], k / sub).normalize().multiplyScalar(R);
          b.lerpVectors(n, nodes[j], (k + 1) / sub).normalize().multiplyScalar(R);
          pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
          seed.push(s, s);
        }
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
    const mat = this.material(
      /* glsl */ `
      attribute float aSeed; varying float vSeed;
      void main() {
        vSeed = aSeed;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(orbDisplace(position), 1.0);
      }`,
      /* glsl */ `
      uniform vec3 uColor; uniform float uIntensity; uniform float uTime; uniform float uLattice; uniform float uThink;
      varying float vSeed;
      void main() {
        float flick = pow(0.5 + 0.5 * sin(uTime * (0.8 + vSeed * 2.5 + uThink * 3.0) + vSeed * 50.0), 6.0);
        float a = (0.25 + 0.75 * flick) * uLattice * 0.8;
        gl_FragColor = vec4(uColor * uIntensity * 1.8, a);
      }`,
    );
    this.shell.add(new THREE.LineSegments(g, mat));
  }

  /** Anneaux de données en pointillés, qui tournent sur des axes inclinés. */
  private buildRings() {
    const defs = [
      { tilt: new THREE.Euler(1.2, 0.2, 0), radius: 1.18, spin: 0.6, seg: 18 },
      { tilt: new THREE.Euler(-0.5, 0.9, 0.3), radius: 1.3, spin: -0.4, seg: 30 },
      { tilt: new THREE.Euler(0.3, -0.7, 1.4), radius: 0.85, spin: 0.9, seg: 12 },
    ];
    for (const d of defs) {
      const group = new THREE.Group();
      const outer = new THREE.Group();
      outer.rotation.copy(d.tilt);
      outer.add(group);
      const mat = this.material(
        /* glsl */ `
        attribute float aU; varying float vU;
        void main() { vU = aU; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        /* glsl */ `
        uniform vec3 uColor; uniform vec3 uCore; uniform float uIntensity; uniform float uTime;
        uniform float uRings; uniform float uSeg; uniform float uSpeed;
        varying float vU;
        void main() {
          float u = fract(vU * uSeg + uTime * uSpeed);
          float dash = step(0.3, u) * step(u, 0.85);
          float cell = floor(vU * uSeg);
          float flick = 0.4 + 0.6 * step(0.35, fract(sin(cell * 91.7 + floor(uTime * 3.0)) * 43758.5));
          gl_FragColor = vec4(mix(uColor, uCore, 0.2) * uIntensity * 1.6, dash * flick * uRings * 0.8);
        }`,
        { uRings: { value: 0.25 }, uSeg: { value: d.seg }, uSpeed: { value: d.spin * 0.3 } },
      );
      for (let k = 0; k < 3; k++) {
        const n = 256;
        const pos = new Float32Array((n + 1) * 3);
        const us = new Float32Array(n + 1);
        const rr = R * (d.radius + k * 0.035);
        for (let i = 0; i <= n; i++) {
          const a = (i / n) * Math.PI * 2;
          pos.set([Math.cos(a) * rr, Math.sin(a) * rr, 0], i * 3);
          us[i] = i / n + k * 0.13;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('aU', new THREE.BufferAttribute(us, 1));
        group.add(new THREE.Line(g, mat));
      }
      this.root.add(outer);
      this.rings.push({ group, spin: d.spin, mat });
    }
  }

  /** Éclats de verre holographique en orbite. */
  private buildShards() {
    const count = 46;
    const g = new THREE.TetrahedronGeometry(1);
    const n = g.getAttribute('position').count;
    const bary = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) bary[i * 3 + (i % 3)] = 1;
    g.setAttribute('aBary', new THREE.BufferAttribute(bary, 3));
    const seeds = new Float32Array(count).map(() => Math.random());
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    const mat = this.material(
      /* glsl */ `
      attribute vec3 aBary; attribute float aSeed; varying vec3 vBary; varying float vSeed;
      void main() {
        vBary = aBary; vSeed = aSeed;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
      /* glsl */ `
      uniform vec3 uColor; uniform vec3 uCore; uniform float uIntensity; uniform float uTime; uniform float uShards;
      varying vec3 vBary; varying float vSeed;
      void main() {
        float e = min(min(vBary.x, vBary.y), vBary.z);
        float edge = 1.0 - smoothstep(0.0, 0.07, e);
        float flick = 0.65 + 0.35 * sin(uTime * 3.0 + vSeed * 40.0);
        vec3 c = mix(uColor, uCore, edge * 0.35);
        gl_FragColor = vec4(c * uIntensity * 1.5, (0.08 + edge * 0.85) * flick * uShards);
      }`,
    );
    mat.side = THREE.DoubleSide;
    this.shards = new THREE.InstancedMesh(g, mat, count);
    this.shards.frustumCulled = false;
    for (let i = 0; i < count; i++) {
      const base = new THREE.Vector3().randomDirection();
      const axis = new THREE.Vector3().randomDirection().cross(base).normalize();
      const s = R * (0.025 + Math.random() ** 2 * 0.07);
      this.shardData.push({
        base, axis,
        radius: R * (1.05 + Math.random() * 0.55),
        angle: Math.random() * Math.PI * 2,
        speed: (0.08 + Math.random() * 0.25) * (Math.random() < 0.5 ? -1 : 1),
        tumbleAxis: new THREE.Vector3().randomDirection(),
        tumble: Math.random() * 6,
        tumbleSpeed: 0.3 + Math.random() * 1.2,
        scale: new THREE.Vector3(s * (1 + Math.random()), s * (0.6 + Math.random()), s * 0.25),
      });
    }
    this.root.add(this.shards);
  }

  /** Étincelles qui jaillissent du cœur, plus nombreuses et rapides quand l'orbe parle. */
  private buildSparks() {
    const n = 650;
    const dir = new Float32Array(n * 3);
    const seed = new Float32Array(n * 4);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.randomDirection().toArray(dir, i * 3);
      seed.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(dir, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R * 3);
    const mat = this.material(
      /* glsl */ `
      attribute vec4 aSeed; varying float vLife; varying float vMix;
      void main() {
        float life = fract(uFlow * (0.35 + aSeed.x * 0.8) + aSeed.y);
        float dist = uRadius * (0.2 + life * (1.5 + uEnergy * 0.9) * (0.6 + aSeed.z * 0.6));
        vec3 p = position * dist;
        float a = life * (aSeed.w - 0.5) * 2.5 + uThink * life * 2.5;
        p.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * p.xz;
        vLife = life; vMix = aSeed.z;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = 0.01 * uRadius * 2.0 * (0.4 + aSeed.z) * uScale / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
      /* glsl */ `
      uniform vec3 uColor; uniform vec3 uAccent; uniform float uIntensity; uniform float uSparks;
      varying float vLife; varying float vMix;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * pow(1.0 - vLife, 1.5) * smoothstep(0.0, 0.1, vLife);
        vec3 c = mix(uAccent, uColor, step(0.55, vMix));
        gl_FragColor = vec4(c * uIntensity * 2.0, a * uSparks * 0.9);
      }`,
    );
    this.root.add(new THREE.Points(g, mat));
  }

  /** Bribes de code binaire qui flottent à l'intérieur. */
  private buildGlyphs() {
    for (let i = 0; i < 14; i++) {
      const tex = binaryTexture();
      const mat = new THREE.SpriteMaterial({
        map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.position.randomDirection().multiplyScalar(R * (0.25 + Math.random() * 0.55));
      const w = R * (0.35 + Math.random() * 0.3);
      sprite.scale.set(w, w / 4, 1);
      this.shell.add(sprite);
      this.glyphs.push({ sprite, seed: Math.random() });
    }
  }
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.15, 'rgba(255,255,255,0.75)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function binaryTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.font = '600 26px ui-monospace, Menlo, Consolas, monospace';
  g.textBaseline = 'middle';
  let s = '';
  for (let i = 0; i < 12; i++) s += Math.random() < 0.5 ? '0' : '1';
  g.fillText(`${s.slice(0, 4)} ${s.slice(4, 8)} ${s.slice(8)}`, 8, 32);
  return new THREE.CanvasTexture(c);
}

/** Bruit simplex 3D (Ashima Arts, licence MIT). */
const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
`;

/** Déformation commune à la surface : ondulations lentes, vibration de la voix, pulsations. */
const DISPLACE = /* glsl */ `
uniform float uTime; uniform float uFlow; uniform float uRadius; uniform float uEnergy; uniform float uUser;
uniform float uThink; uniform float uListen; uniform float uPulse; uniform float uBreath; uniform float uScale;
vec3 orbDisplace(vec3 p) {
  float r = length(p);
  vec3 n = r > 1e-4 ? p / r : vec3(0.0, 1.0, 0.0);
  float slow = snoise(n * 1.6 + vec3(0.0, uTime * 0.18, uTime * 0.05));
  float fast = snoise(n * 4.0 + vec3(uFlow * 1.5));
  float d = slow * (0.035 + uThink * 0.04) + fast * (uEnergy * 0.11 + uUser * 0.07);
  float wave = sin(n.y * 9.0 - uFlow * 9.0) * uEnergy * 0.035;
  float scale = 1.0 + uPulse - uListen * 0.05 + uBreath + uEnergy * 0.05;
  return p * scale + n * (d + wave) * uRadius;
}
`;
