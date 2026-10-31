import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { upgradeMaterials } from './materials';
import { VISEMES, VISEME_TO_ARKIT, type Weights } from './visemes';
import type { VisemeFrame } from './lipsync';

export type Expression = 'neutral' | 'happy' | 'thinking' | 'surprised' | 'sad' | 'listening';

const EXPRESSIONS: Record<Expression, Weights> = {
  neutral: {},
  happy: {
    mouthSmile_L: 0.55, mouthSmile_R: 0.55, cheekSquint_L: 0.35, cheekSquint_R: 0.35,
    eyeSquint_L: 0.2, eyeSquint_R: 0.2, browInnerUp: 0.1, mouthDimple_L: 0.2, mouthDimple_R: 0.2,
  },
  thinking: {
    browDown_L: 0.25, browInnerUp: 0.2, mouthPress_L: 0.2, mouthPress_R: 0.2, mouthLeft: 0.15,
    eyeSquint_L: 0.15, eyeSquint_R: 0.1,
  },
  surprised: {
    browInnerUp: 0.6, browOuterUp_L: 0.55, browOuterUp_R: 0.55, eyeWide_L: 0.4, eyeWide_R: 0.4,
    jawOpen: 0.12,
  },
  sad: {
    browInnerUp: 0.55, browDown_L: 0.1, browDown_R: 0.1, mouthFrown_L: 0.4, mouthFrown_R: 0.4,
    mouthShrugLower: 0.2,
  },
  listening: { browInnerUp: 0.12, mouthSmile_L: 0.12, mouthSmile_R: 0.12, eyeWide_L: 0.05, eyeWide_R: 0.05 },
};

/** Normalise un nom de blendshape : `eyeBlink_L`, `eyeBlinkLeft`, `Eye_Blink_L` → `eyeblinkl`. */
const norm = (s: string) =>
  s
    .split('.')
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/left$/, 'l')
    .replace(/right$/, 'r');

let ktx2: KTX2Loader | undefined;

/**
 * Avatar 3D : charge un modèle glTF/GLB, améliore ses matériaux et anime son visage
 * (clignements, micro-saccades, respiration, mouvements de tête, expressions, lipsync).
 *
 * Compatible avec les modèles exposant les 52 blendshapes ARKit (Face Cap, Avaturn,
 * Ready Player Me, Character Creator 4, exports MetaHuman…) et/ou les visèmes Oculus
 * (`viseme_aa`, `viseme_PP`…).
 */
export class Avatar {
  readonly root = new THREE.Group();
  /** Point de mise au point pour la caméra (entre les yeux). */
  readonly focus = new THREE.Vector3();
  /** Hauteur à cadrer : la tête et les épaules pour un corps entier. */
  framingHeight = 0.3;

  private morphs = new Map<string, Array<{ mesh: THREE.Mesh; index: number }>>();
  private hasVisemeShapes = false;
  private head?: THREE.Object3D;
  private headRest = new THREE.Quaternion();
  private eyes: Array<{ node: THREE.Object3D; rest: THREE.Quaternion }> = [];
  private model!: THREE.Object3D;
  private modelRestY = 0;

  private expression: Weights = {};
  private expressionTarget: Weights = {};
  private visemes: VisemeFrame = {};
  private speechEnergy = 0;

  private blink = { next: 2, t: -1 };
  private gaze = { target: new THREE.Vector2(), current: new THREE.Vector2(), next: 0.5 };
  private lookAtWorld?: THREE.Vector3;

  static async load(url: string, renderer: THREE.WebGLRenderer): Promise<Avatar> {
    const loader = new GLTFLoader();
    ktx2 ??= new KTX2Loader().setTranscoderPath('/basis/').detectSupport(renderer);
    loader.setKTX2Loader(ktx2);
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.setDRACOLoader(
      new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/'),
    );
    const gltf = await loader.loadAsync(url);
    const avatar = new Avatar();
    avatar.init(gltf.scene);
    return avatar;
  }

  private init(model: THREE.Object3D) {
    this.model = model;
    this.root.add(model);
    upgradeMaterials(model);

    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.morphTargetDictionary) {
        for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
          const key = norm(name);
          if (!this.morphs.has(key)) this.morphs.set(key, []);
          this.morphs.get(key)!.push({ mesh, index });
          if (key.startsWith('viseme')) this.hasVisemeShapes = true;
        }
      }
    });

    this.relaxPose(model);

    // Tête : un os « Head » si le modèle est riggé, sinon le modèle entier.
    this.head = findNode(model, /^(mixamorig:?)?head$|^cc_base_head$|^head_?jnt$/i);
    if (!this.head) {
      this.head = model;
    }
    this.headRest.copy(this.head.quaternion);
    this.modelRestY = model.position.y;

    // Yeux : os ou groupes pivots des globes oculaires.
    const left = findNode(model, /^grp_eyeleft$|^(mixamorig:?)?lefteye$|^cc_base_l_eye$|^eye_?l(eft)?$/i)
      ?? findNode(model, /^eyeleft$/i);
    const right = findNode(model, /^grp_eyeright$|^(mixamorig:?)?righteye$|^cc_base_r_eye$|^eye_?r(ight)?$/i)
      ?? findNode(model, /^eyeright$/i);
    for (const node of [left, right]) {
      if (node) this.eyes.push({ node, rest: node.quaternion.clone() });
    }

    // Point focal : milieu des yeux, ou haut de la boîte englobante.
    model.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(model);
    const height = bbox.max.y - bbox.min.y;
    const isBust = !!findNode(model, /^(mixamorig:?)?(spine2?|neck)$/i) && height > 1;
    this.framingHeight = isBust ? height * 0.21 : height;
    if (left && right) {
      const a = left.getWorldPosition(new THREE.Vector3());
      const b = right.getWorldPosition(new THREE.Vector3());
      this.focus.copy(a).add(b).multiplyScalar(0.5);
    } else {
      const c = bbox.getCenter(new THREE.Vector3());
      this.focus.set(c.x, isBust ? bbox.max.y - height * 0.07 : c.y, c.z);
    }
    if (isBust) this.focus.y -= this.framingHeight * 0.17; // inclut le haut des épaules
  }

  /**
   * Les modèles riggés arrivent souvent en T-pose ou A-pose : on baisse les bras le long du
   * corps, en alignant chaque os sur une direction cible exprimée dans l'espace monde.
   */
  private relaxPose(model: THREE.Object3D) {
    model.updateMatrixWorld(true);
    const align = (bone: THREE.Object3D | undefined, child: THREE.Object3D | undefined, dir: THREE.Vector3) => {
      if (!bone || !child || !bone.parent) return;
      const a = bone.getWorldPosition(new THREE.Vector3());
      const b = child.getWorldPosition(new THREE.Vector3());
      const current = b.sub(a).normalize();
      const delta = new THREE.Quaternion().setFromUnitVectors(current, dir.clone().normalize());
      const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion());
      const boneQ = bone.getWorldQuaternion(new THREE.Quaternion());
      bone.quaternion.copy(parentQ.invert().multiply(delta).multiply(boneQ));
      bone.updateMatrixWorld(true);
    };
    for (const [side, sx] of [['Left', 1], ['Right', -1]] as const) {
      const arm = findNode(model, new RegExp(`^(mixamorig:?)?${side}Arm$`, 'i'));
      const fore = findNode(model, new RegExp(`^(mixamorig:?)?${side}ForeArm$`, 'i'));
      const hand = findNode(model, new RegExp(`^(mixamorig:?)?${side}Hand$`, 'i'));
      if (!arm || !fore) continue;
      // Le côté « gauche » du personnage est en +X quand il nous fait face (+Z).
      const sign = Math.sign(fore.getWorldPosition(new THREE.Vector3()).x - arm.getWorldPosition(new THREE.Vector3()).x) || sx;
      align(arm, fore, new THREE.Vector3(0.16 * sign, -1, 0.02));
      align(fore, hand, new THREE.Vector3(0.08 * sign, -1, 0.22));
    }
  }

  get morphTargetNames(): string[] {
    return [...this.morphs.keys()];
  }

  setExpression(name: Expression, intensity = 1) {
    const w = EXPRESSIONS[name];
    this.expressionTarget = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v * intensity]));
  }

  /** Poids de visèmes courants, fournis par un lipsync audio ou textuel. */
  setVisemes(frame: VisemeFrame, energy: number) {
    this.visemes = frame;
    this.speechEnergy = energy;
  }

  /** Point que l'avatar regarde (typiquement la caméra). */
  lookAt(world: THREE.Vector3) {
    this.lookAtWorld = world;
  }

  update(dt: number, t: number) {
    const w: Weights = {};
    const add = (k: string, v: number) => (w[k] = (w[k] ?? 0) + v);

    // Expression : transition douce vers la cible.
    const keys = new Set([...Object.keys(this.expression), ...Object.keys(this.expressionTarget)]);
    for (const k of keys) {
      const cur = this.expression[k] ?? 0;
      const tgt = this.expressionTarget[k] ?? 0;
      this.expression[k] = cur + (tgt - cur) * Math.min(1, dt * 4);
      add(k, this.expression[k]);
    }

    // Lipsync : visèmes natifs si présents, sinon composition ARKit.
    for (const v of VISEMES) {
      const amount = this.visemes[v] ?? 0;
      if (amount < 0.001) continue;
      if (this.hasVisemeShapes) add(`viseme_${v}`, amount);
      else for (const [k, x] of Object.entries(VISEME_TO_ARKIT[v])) add(k, x * amount);
    }
    // Pendant la parole, on atténue le sourire pour que la bouche reste lisible.
    if (this.speechEnergy > 0.05) {
      for (const k of ['mouthSmile_L', 'mouthSmile_R', 'mouthPress_L', 'mouthPress_R']) {
        if (w[k]) w[k] *= 0.6;
      }
    }

    // Clignements naturels (toutes les 2 à 6 s, parfois doubles).
    const b = this.blink;
    b.next -= dt;
    if (b.next <= 0 && b.t < 0) {
      b.t = 0;
      b.next = 2 + Math.random() * 4;
      if (Math.random() < 0.15) b.next = 0.25;
    }
    if (b.t >= 0) {
      b.t += dt;
      const d = 0.16;
      const x = b.t / d;
      const closed = x < 0.4 ? x / 0.4 : Math.max(0, 1 - (x - 0.4) / 0.6);
      add('eyeBlink_L', closed);
      add('eyeBlink_R', closed);
      if (b.t > d) b.t = -1;
    }

    // Micro-expressions de repos.
    add('browInnerUp', 0.04 + 0.03 * noise(t * 0.3));
    add('mouthSmile_L', 0.03);
    add('mouthSmile_R', 0.03);
    // Sourcils plus mobiles en parlant (emphase).
    add('browOuterUp_L', this.speechEnergy * 0.12);
    add('browOuterUp_R', this.speechEnergy * 0.12);

    // Regard : fixe la caméra avec de petites saccades.
    const g = this.gaze;
    g.next -= dt;
    if (g.next <= 0) {
      g.next = 0.4 + Math.random() * 2.2;
      const r = Math.random() < 0.7 ? 0.04 : 0.14;
      g.target.set((Math.random() * 2 - 1) * r, (Math.random() * 2 - 1) * r * 0.6);
    }
    g.current.lerp(g.target, Math.min(1, dt * 25));
    this.applyGaze(g.current, add);

    this.applyWeights(w);

    // Tête : léger balancement + hochements liés à l'énergie de la voix.
    const yaw = 0.035 * noise(t * 0.21 + 3) + 0.02 * this.speechEnergy * noise(t * 1.7);
    const pitch = 0.025 * noise(t * 0.17) - 0.03 * this.speechEnergy * Math.max(0, noise(t * 2.3 + 1));
    const roll = 0.015 * noise(t * 0.13 + 7);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
    this.head!.quaternion.copy(this.headRest).multiply(q);

    // Respiration : légère montée du buste.
    this.model.position.y = this.modelRestY + Math.sin(t * 1.6) * 0.0015;
  }

  private applyGaze(offset: THREE.Vector2, add: (k: string, v: number) => void) {
    // Direction du regard dans l'espace monde (le modèle regarde vers +Z).
    const dir = new THREE.Vector3(0, 0, 1);
    if (this.lookAtWorld) {
      dir.copy(this.lookAtWorld).sub(this.root.localToWorld(this.focus.clone())).normalize();
    }
    dir.x += offset.x;
    dir.y += offset.y;
    dir.normalize();
    const yaw = THREE.MathUtils.clamp(Math.atan2(dir.x, dir.z), -0.5, 0.5);
    const pitch = THREE.MathUtils.clamp(Math.asin(dir.y), -0.35, 0.35);

    // Blendshapes de paupières (suivent le globe oculaire).
    add('eyeLookUp_L', Math.max(0, pitch) * 1.5);
    add('eyeLookUp_R', Math.max(0, pitch) * 1.5);
    add('eyeLookDown_L', Math.max(0, -pitch) * 1.5);
    add('eyeLookDown_R', Math.max(0, -pitch) * 1.5);
    add('eyeLookOut_L', Math.max(0, yaw) * 1.2);
    add('eyeLookIn_R', Math.max(0, yaw) * 1.2);
    add('eyeLookIn_L', Math.max(0, -yaw) * 1.2);
    add('eyeLookOut_R', Math.max(0, -yaw) * 1.2);

    // Rotation des globes oculaires (rotation monde convertie dans l'espace du parent).
    const qWorld = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, yaw, 0, 'YXZ'));
    for (const { node, rest } of this.eyes) {
      const parentQ = node.parent!.getWorldQuaternion(new THREE.Quaternion());
      const qLocal = parentQ.clone().invert().multiply(qWorld).multiply(parentQ);
      node.quaternion.copy(qLocal).multiply(rest);
    }
  }

  private applyWeights(w: Weights) {
    // Remise à zéro puis application (les poids absents retombent à 0).
    for (const list of this.morphs.values()) {
      for (const { mesh, index } of list) mesh.morphTargetInfluences![index] = 0;
    }
    for (const [k, v] of Object.entries(w)) {
      const list = this.morphs.get(norm(k));
      if (!list) continue;
      const value = THREE.MathUtils.clamp(v, 0, 1);
      for (const { mesh, index } of list) mesh.morphTargetInfluences![index] = value;
    }
  }
}

function findNode(root: THREE.Object3D, re: RegExp): THREE.Object3D | undefined {
  let found: THREE.Object3D | undefined;
  root.traverse((o) => {
    if (!found && re.test(o.name)) found = o;
  });
  return found;
}

/** Bruit lisse 1D dans [-1, 1] (somme de sinus incommensurables). */
function noise(x: number) {
  return (Math.sin(x * 1.0) * 0.5 + Math.sin(x * 2.137 + 1.3) * 0.3 + Math.sin(x * 4.71 + 2.1) * 0.2);
}
