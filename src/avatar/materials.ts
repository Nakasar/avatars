import * as THREE from 'three';

/**
 * Améliore les matériaux d'un avatar glTF pour un rendu plus réaliste :
 *  - peau : MeshPhysicalMaterial + diffusion sous-cutanée approchée (« wrap lighting »
 *    teinté rouge) et voile de sheen pour le duvet ;
 *  - yeux : cornée brillante (clearcoat) ;
 *  - dents / langue : satinées, assombries (l'intérieur de la bouche reçoit peu de lumière).
 *
 * Les textures d'origine (albedo, normal, roughness, AO…) sont conservées.
 */
export function upgradeMaterials(root: THREE.Object3D) {
  const cache = new Map<string, THREE.Material>();

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const kind = classify(mesh);
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const upgraded = mats.map((m) => {
      const key = `${m.uuid}:${kind}`;
      if (!cache.has(key)) cache.set(key, upgrade(m as THREE.MeshStandardMaterial, kind));
      return cache.get(key)!;
    });
    mesh.material = Array.isArray(mesh.material) ? upgraded : upgraded[0];

    // Les yeux et les dents ne projettent pas d'ombre (évite l'acné d'ombre sous les paupières).
    if (kind === 'eye' || kind === 'teeth' || kind === 'tongue') mesh.castShadow = false;
  });
}

type Kind = 'skin' | 'eye' | 'teeth' | 'tongue' | 'hair' | 'cloth' | 'other';

function classify(mesh: THREE.Mesh): Kind {
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const n = `${mesh.name} ${mesh.parent?.name ?? ''} ${mat?.name ?? ''}`.toLowerCase();
  if (/eye(?!brow|lash)|cornea|iris|pupil|high-poly|low-poly/.test(n)) return 'eye';
  if (/tongue|mouth_?inner/.test(n)) return 'tongue';
  if (/teeth|tooth/.test(n)) return 'teeth';
  if (/hair|brow|lash|beard|ponytail|bob|braid/.test(n)) return 'hair';
  if (/shirt|outfit|cloth|suit|top|bottom|shoe|jacket|wear|pants|dress/.test(n)) return 'cloth';
  if (/head|face|skin|body|lambert/.test(n)) return 'skin';
  // Par défaut, une géométrie avec des blendshapes est très probablement la peau du visage.
  return mesh.morphTargetInfluences?.length ? 'skin' : 'other';
}

function upgrade(src: THREE.MeshStandardMaterial, kind: Kind): THREE.Material {
  if (kind === 'hair') {
    // Mèches en alpha-test : l'alpha-to-coverage (avec le MSAA) adoucit les bords.
    if (src.alphaTest > 0 || src.transparent) {
      src.alphaToCoverage = true;
      src.transparent = false;
      src.depthWrite = true;
    }
    src.roughness = Math.max(src.roughness, 0.55);
    return src;
  }
  if (kind === 'other') return src;

  const m = new THREE.MeshPhysicalMaterial();
  // Copie des propriétés standard partagées (textures comprises).
  THREE.MeshStandardMaterial.prototype.copy.call(m, src);
  m.name = `${src.name || kind}-${kind}`;

  switch (kind) {
    case 'skin':
      m.metalness = 0;
      m.roughness = src.roughnessMap ? Math.min(src.roughness, 1) : 0.52;
      m.specularIntensity = 0.5;
      m.ior = 1.4; // IOR de l'épiderme
      m.sheen = 0.25;
      m.sheenRoughness = 0.6;
      m.sheenColor = new THREE.Color(0xffd2c2);
      applySubsurface(m);
      break;
    case 'eye':
      m.metalness = 0;
      m.roughness = 0.35;
      m.clearcoat = 1;
      m.clearcoatRoughness = 0.02;
      m.ior = 1.376; // cornée
      m.envMapIntensity = 1.4;
      break;
    case 'teeth':
      m.metalness = 0;
      m.roughness = 0.3;
      m.clearcoat = 0.4;
      m.clearcoatRoughness = 0.2;
      m.color.multiplyScalar(0.82);
      break;
    case 'tongue':
      // Intérieur de la bouche : humide mais peu éclairé (pas d'occlusion sans GTAO).
      m.metalness = 0;
      m.roughness = 0.4;
      m.color.multiplyScalar(0.7);
      m.envMapIntensity = 0.4;
      break;
    case 'cloth':
      m.metalness = 0;
      m.sheen = 0.25;
      m.sheenRoughness = 0.9;
      m.roughness = Math.max(m.roughness, 0.85);
      m.sheenColor = m.color.clone().lerp(new THREE.Color(1, 1, 1), 0.3);
      break;
  }
  return m;
}

/**
 * Approximation temps réel de la diffusion sous-cutanée : la lumière « déborde » au-delà du
 * terminateur (wrap lighting) avec une teinte rouge, ce qui adoucit les ombres de la peau
 * comme le ferait le sang sous l'épiderme.
 */
export function applySubsurface(
  m: THREE.MeshPhysicalMaterial,
  scatterColor = new THREE.Color(0.85, 0.22, 0.12),
  wrap = 0.55,
) {
  const target = 'reflectedLight.directDiffuse += irradiance * diffuseBRDF * ( 1.0 - F );';
  m.onBeforeCompile = (shader) => {
    const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
    if (!chunk.includes(target)) {
      console.warn('[avatar] chunk de lumière inattendu : diffusion sous-cutanée désactivée');
      return;
    }
    shader.uniforms.skinScatterColor = { value: scatterColor };
    shader.uniforms.skinWrap = { value: wrap };
    const patched =
      'uniform vec3 skinScatterColor;\nuniform float skinWrap;\n' +
      chunk.replace(
        target,
        `${target}
  {
    float skinNL = dot( geometryNormal, directLight.direction );
    float wrapped = saturate( ( skinNL + skinWrap ) / ( 1.0 + skinWrap ) );
    vec3 scatter = ( wrapped - saturate( skinNL ) ) * skinScatterColor;
    reflectedLight.directDiffuse += directLight.color * scatter * diffuseBRDF;
  }`,
      );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_physical_pars_fragment>',
      patched,
    );
  };
  m.customProgramCacheKey = () => 'breign-skin-sss';
  m.needsUpdate = true;
}
