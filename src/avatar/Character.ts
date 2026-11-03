import type * as THREE from 'three';
import type { Expression, Mode } from './Avatar';
import type { VisemeFrame } from './lipsync';
import type { ActionCode } from '../actions/vocabulary';

/** Apparences proposées pour le bot. */
export type Appearance = 'human' | 'orb';

/**
 * Ce que la conversation attend d'une apparence : un humain 3D ou l'orbe IA.
 * Chaque apparence traduit à sa façon les mêmes signaux (écoute, réflexion, parole).
 */
export interface Character {
  readonly root: THREE.Object3D;
  /** Point de mise au point pour la caméra. */
  readonly focus: THREE.Vector3;
  /** Hauteur à cadrer. */
  framingHeight: number;

  setExpression(name: Expression, intensity?: number): void;
  /** Poids de visèmes courants et énergie de la voix (0–1). */
  setVisemes(frame: VisemeFrame, energy: number): void;
  setMode(mode: Mode): void;
  readonly currentMode: Mode;
  /** Petit signe d'acquiescement (écoute active). */
  nod(): void;
  /** Niveau de la voix de l'utilisateur (0–1). */
  setUserLevel(level: number): void;
  lookAt(world: THREE.Vector3): void;
  update(dt: number, t: number): void;
  /**
   * Applique un code d'action envoyé par l'agent (`[[ACTION.EMOTION.AGGRESSIVE]]`…).
   * Renvoie `false` si l'apparence ne sait pas le jouer.
   */
  applyAction?(code: ActionCode): boolean;
  /** Annule les effets des codes d'action en cours (début d'une nouvelle réponse). */
  resetActions?(): void;
  dispose?(): void;
}
