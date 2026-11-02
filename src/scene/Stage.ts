import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

export interface StageOptions {
  /** URL d'une carte d'environnement HDR (.hdr). Sans elle, un studio procédural est utilisé. */
  hdrUrl?: string;
  quality?: 'high' | 'medium' | 'low';
}

/**
 * Plateau de tournage : moteur de rendu physiquement réaliste, éclairage studio trois points,
 * environnement pour les réflexions (IBL) et post-traitement photographique.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly keyLight: THREE.DirectionalLight;

  private composer: EffectComposer;
  private gtao?: GTAOPass;
  private bloom?: UnrealBloomPass;
  private backdrop: THREE.Texture;
  private finishPass: ShaderPass;
  private timer = new THREE.Timer();
  private updaters: Array<(dt: number, t: number) => void> = [];
  private rims: Array<{ light: THREE.SpotLight; base: THREE.Vector3 }> = [];

  constructor(private container: HTMLElement, options: StageOptions = {}) {
    const quality = options.quality ?? 'high';

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // l'anticrénelage est fait par le MSAA du composer
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 'low' ? 1 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    // Objectif « portrait » (~85 mm) : peu de déformation du visage.
    this.camera = new THREE.PerspectiveCamera(22, 1, 0.05, 100);
    this.camera.position.set(0, 0.1, 3.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minPolarAngle = Math.PI * 0.3;
    this.controls.maxPolarAngle = Math.PI * 0.62;
    this.controls.minAzimuthAngle = -Math.PI * 0.45;
    this.controls.maxAzimuthAngle = Math.PI * 0.45;

    this.backdrop = makeBackdrop();
    this.scene.background = this.backdrop;

    // --- Éclairage d'environnement (réflexions spéculaires et lumière ambiante réaliste)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    this.scene.environmentIntensity = 0.35;
    room.dispose();
    if (options.hdrUrl) {
      new RGBELoader().load(options.hdrUrl, (hdr) => {
        this.scene.environment = pmrem.fromEquirectangular(hdr).texture;
        hdr.dispose();
      });
    }

    // --- Éclairage studio trois points
    // Lumière principale : chaude, légèrement de côté et au-dessus (type « Rembrandt » doux).
    this.keyLight = new THREE.DirectionalLight(0xfff1e0, 2.8);
    this.keyLight.position.set(1.6, 1.8, 2.2);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 0.5;
    this.keyLight.shadow.camera.far = 8;
    const s = 0.6;
    Object.assign(this.keyLight.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
    this.keyLight.shadow.radius = 4;
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.01;
    this.scene.add(this.keyLight);

    // Débouchage : froid, faible, de l'autre côté.
    const fill = new THREE.DirectionalLight(0xc8d8ff, 0.3);
    fill.position.set(-2.2, 0.6, 1.6);
    this.scene.add(fill);

    // Contre-jours : détachent la silhouette du fond.
    const rimL = new THREE.SpotLight(0xffe2c8, 3, 10, Math.PI / 7, 0.6, 1.5);
    rimL.position.set(-1.6, 1.4, -2.2);
    const rimR = new THREE.SpotLight(0xd6e4ff, 2.2, 10, Math.PI / 7, 0.6, 1.5);
    rimR.position.set(1.8, 1.0, -2.0);
    this.scene.add(rimL, rimL.target, rimR, rimR.target);
    this.rims = [rimL, rimR].map((light) => ({ light, base: light.position.clone() }));

    // Rebond du sol / du buste, très léger.
    this.scene.add(new THREE.HemisphereLight(0xf4f1ee, 0x3a2f2a, 0.15));

    // --- Post-traitement
    const rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: quality === 'low' ? 0 : 4,
    });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (quality === 'high') {
      this.gtao = new GTAOPass(this.scene, this.camera, 1, 1);
      this.gtao.blendIntensity = 0.65;
      this.gtao.updateGtaoMaterial({ radius: 0.08, distanceExponent: 1, thickness: 1, scale: 1 });
      this.composer.addPass(this.gtao);
    }
    if (quality !== 'low') {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.05, 0.4, 0.98);
      this.composer.addPass(this.bloom);
    }
    this.composer.addPass(new OutputPass());
    this.finishPass = new ShaderPass(FinishShader);
    this.composer.addPass(this.finishPass);

    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
    this.renderer.setAnimationLoop(() => this.tick());
  }

  /** Centre la caméra sur un objet (typiquement la tête de l'avatar). */
  frame(target: THREE.Object3D, focus?: THREE.Vector3, subjectHeight?: number) {
    const box = new THREE.Box3().setFromObject(target);
    const size = box.getSize(new THREE.Vector3());
    const center = focus ?? box.getCenter(new THREE.Vector3());
    const height = (subjectHeight ?? Math.max(size.y, size.x)) * 1.35;
    const dist = height / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.camera.position.set(center.x + dist * 0.12, center.y + height * 0.04, center.z + dist);
    this.camera.near = dist / 50;
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.minDistance = dist * 0.45;
    this.controls.maxDistance = dist * 2.2;
    this.controls.update();

    // Ajuste les lumières et la caméra d'ombre à l'échelle du modèle.
    const r = subjectHeight ?? Math.max(size.x, size.y, size.z);
    this.keyLight.target.position.copy(center);
    this.keyLight.position.copy(center).add(new THREE.Vector3(1.6, 1.8, 2.2).multiplyScalar(r));
    const sc = this.keyLight.shadow.camera;
    Object.assign(sc, { left: -r, right: r, top: r, bottom: -r, near: r * 0.5, far: r * 8 });
    sc.updateProjectionMatrix();
    this.scene.add(this.keyLight.target);
    for (const { light, base } of this.rims) {
      light.position.copy(base).multiplyScalar(r).add(center);
      light.target.position.copy(center);
      light.distance = r * 10;
    }
    this.gtao?.updateGtaoMaterial({ radius: r * 0.12 });
  }

  /**
   * Ambiance du plateau : « studio » pour l'humain (lumière photo, halo discret),
   * « holo » pour l'orbe (fond sombre teinté de sa couleur, halo lumineux généreux).
   */
  setLook(look: 'studio' | 'holo', tint?: THREE.ColorRepresentation) {
    const holo = look === 'holo';
    if (this.bloom) {
      this.bloom.strength = holo ? 0.7 : 0.05;
      this.bloom.radius = holo ? 0.5 : 0.4;
      this.bloom.threshold = holo ? 0.2 : 0.98;
    }
    // Le rendu « neutre » garde la saturation des lumières vives, là où AgX les blanchit.
    this.renderer.toneMapping = holo ? THREE.NeutralToneMapping : THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = holo ? 1 : 0.9;
    if (this.gtao) this.gtao.enabled = !holo;
    this.backdrop.dispose();
    this.backdrop = holo ? makeHoloBackdrop(new THREE.Color(tint ?? 0x2f8cff)) : makeBackdrop();
    this.scene.background = this.backdrop;
  }

  onUpdate(fn: (dt: number, t: number) => void) {
    this.updaters.push(fn);
  }

  private resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.finishPass.uniforms.resolution.value.set(w, h);
  }

  private tick() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const t = this.timer.getElapsed();
    for (const fn of this.updaters) fn(dt, t);
    this.controls.update();
    this.finishPass.uniforms.time.value = t;
    this.composer.render(dt);
  }
}

/** Fond de studio : dégradé radial sombre et neutre, rendu dans une texture. */
function makeBackdrop(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(256, 210, 20, 256, 256, 380);
  grad.addColorStop(0, '#4a4642');
  grad.addColorStop(0.55, '#262422');
  grad.addColorStop(1, '#0e0d0c');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Fond de l'orbe : presque noir, avec une lueur de sa couleur derrière elle. */
function makeHoloBackdrop(tint: THREE.Color): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#05060a';
  g.fillRect(0, 0, 512, 512);
  const [r, gr, b] = tint.clone().convertLinearToSRGB().toArray().map((v) => Math.round(v * 255));
  const grad = g.createRadialGradient(256, 220, 10, 256, 256, 360);
  grad.addColorStop(0, `rgba(${r},${gr},${b},0.22)`);
  grad.addColorStop(0.5, `rgba(${r},${gr},${b},0.06)`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Finition « photo » : vignettage léger, aberration chromatique minime et grain de pellicule. */
const FinishShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    resolution: { value: new THREE.Vector2(1, 1) },
    vignette: { value: 0.28 },
    grain: { value: 0.022 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform vec2 resolution;
    uniform float vignette;
    uniform float grain;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      vec2 ca = d * r2 * 0.004;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + ca).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - ca).b;
      col *= mix(1.0, 1.0 - vignette, smoothstep(0.08, 0.55, r2 * 1.6));
      float n = hash(vUv * resolution + fract(time) * 100.0) - 0.5;
      col += n * grain * (1.0 - col * 0.6);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
