import React, { useEffect, useRef, useState } from 'react';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { GLView, ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

// Keep the asset reference static so Metro includes it in the native bundle.
const LAIN_MODEL_ASSET = require('../lain.glb');

function removeMissingTextureReferences(source: ArrayBuffer): ArrayBuffer {
  const sourceBytes = new Uint8Array(source);
  const sourceView = new DataView(source);
  const jsonLength = sourceView.getUint32(12, true);
  const jsonText = new TextDecoder().decode(sourceBytes.subarray(20, 20 + jsonLength)).trim();
  const document = JSON.parse(jsonText);

  // This GLB points at separate texture files that were not included with it.
  for (const material of document.materials ?? []) {
    const pbr = material.pbrMetallicRoughness;
    if (pbr) {
      delete pbr.baseColorTexture;
      delete pbr.metallicRoughnessTexture;
    }
    delete material.normalTexture;
    delete material.occlusionTexture;
    delete material.emissiveTexture;
  }

  const encodedJson = new TextEncoder().encode(JSON.stringify(document));
  const paddedJsonLength = (encodedJson.length + 3) & ~3;
  const binHeaderOffset = 20 + jsonLength;
  const binLength = sourceView.getUint32(binHeaderOffset, true);
  const binOffset = binHeaderOffset + 8;
  const output = new Uint8Array(12 + 8 + paddedJsonLength + 8 + binLength);
  const outputView = new DataView(output.buffer);
  outputView.setUint32(0, 0x46546c67, true);
  outputView.setUint32(4, 2, true);
  outputView.setUint32(8, output.length, true);
  outputView.setUint32(12, paddedJsonLength, true);
  outputView.setUint32(16, 0x4e4f534a, true);
  output.set(encodedJson, 20);
  output.fill(0x20, 20 + encodedJson.length, 20 + paddedJsonLength);
  const outputBinHeader = 20 + paddedJsonLength;
  outputView.setUint32(outputBinHeader, binLength, true);
  outputView.setUint32(outputBinHeader + 4, 0x004e4942, true);
  output.set(sourceBytes.subarray(binOffset, binOffset + binLength), outputBinHeader + 8);
  return output.buffer;
}

function applyVaporwaveMaterials(root: THREE.Object3D) {
  let named = 0;
  root.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) {
      for (const m of ([] as THREE.Material[]).concat((object as THREE.Mesh).material)) if (m.name) named += 1;
    }
  });
  // Colours are keyed by material name; a re-export that drops names leaves the model grey.
  if (named === 0) console.warn('[Lain model] materials have no names; vaporwave colours cannot be applied.');
  root.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    const mesh = object as THREE.Mesh;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const name = material.name.toLowerCase();
      const colorMaterial = material as THREE.Material & { color?: THREE.Color };
      if (name.includes('肌')) colorMaterial.color?.set('#e9bfc6');
      else if (name.includes('頬染') || name.includes('頬')) colorMaterial.color?.set('#ee91be');
      else if (name.includes('目の光')) colorMaterial.color?.set('#59f3ff');
      else if (name.includes('瞳')) colorMaterial.color?.set('#7653aa');
      else if (name.includes('白目') || name.includes('歯')) colorMaterial.color?.set('#fbf3ff');
      else if (name.includes('眉毛') || name.includes('睫毛') || name.includes('瞼線')) colorMaterial.color?.set('#392344');
      else if (name.includes('口内') || name.includes('舌')) colorMaterial.color?.set('#b65e91');
      else if (name.includes('髪飾り')) colorMaterial.color?.set('#59f3ff');
      else if (name.includes('髪')) colorMaterial.color?.set('#423052');
      else if (name.includes('上着_ライン')) colorMaterial.color?.set('#59f3ff');
      else if (name.includes('上着_白')) colorMaterial.color?.set('#dcd5f1');
      else if (name.includes('上着')) colorMaterial.color?.set('#7380ad');
      else if (name.includes('ｴｲﾘｱﾝｳｪｱ')) colorMaterial.color?.set('#413255');
      else if (name.includes('skin')) colorMaterial.color?.set('#e9bfc6');
      else if (name.includes('cheek')) colorMaterial.color?.set('#ee91be');
      else if (name.includes('hair')) colorMaterial.color?.set('#423052');
      else if (name.includes('eye')) colorMaterial.color?.set('#7653aa');
      else if (name.includes('coat_line')) colorMaterial.color?.set('#59f3ff');
      else if (name.includes('coat')) colorMaterial.color?.set('#7380ad');
      else if (name.includes('mouth') || name.includes('tongue')) colorMaterial.color?.set('#b65e91');
      material.needsUpdate = true;
    }
  });
}

export default function AvatarScene() {
  const frameRef = useRef<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadErrorMessage, setLoadErrorMessage] = useState('');

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  const onContextCreate = async (gl: ExpoWebGLRenderingContext) => {
    // Expo GL supplies WebGL 1. Use Three.js r162, the last release line
    // that supports WebGL 1, with the small canvas shim used by Expo GL.
    const canvas = {
      width: gl.drawingBufferWidth,
      height: gl.drawingBufferHeight,
      clientWidth: gl.drawingBufferWidth,
      clientHeight: gl.drawingBufferHeight,
      style: {},
      addEventListener: () => {},
      removeEventListener: () => {},
      getContext: () => gl,
    } as any;
    const nativePixelStorei = gl.pixelStorei.bind(gl);
    gl.pixelStorei = ((parameter: number, value: number | boolean) => {
      if (parameter === gl.UNPACK_FLIP_Y_WEBGL || parameter === gl.UNPACK_ALIGNMENT) {
        nativePixelStorei(parameter, value);
      }
      // Expo GL logs a native warning for pixel-store parameters it does not implement.
    }) as typeof gl.pixelStorei;

    const renderer = new THREE.WebGLRenderer({ canvas, context: gl as any, antialias: true });
    renderer.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight);
    renderer.setClearColor(0x10091e, 1);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x10091e, 7, 14);
    const camera = new THREE.PerspectiveCamera(32, gl.drawingBufferWidth / gl.drawingBufferHeight, 0.01, 100);
    scene.add(new THREE.HemisphereLight(0xe9d5ff, 0x24143a, 2.1));
    const key = new THREE.DirectionalLight(0xff9fea, 3.2);
    key.position.set(-3, 5, 5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x59f3ff, 1.8);
    fill.position.set(3, 1, 4);
    scene.add(fill);
    const rim = new THREE.PointLight(0x59f3ff, 15, 12);
    rim.position.set(3, 2, -2);
    scene.add(rim);

    const avatar = new THREE.Group();
    scene.add(avatar);
    const grid = new THREE.GridHelper(12, 24, 0x913cbd, 0x30234f);
    scene.add(grid);

    try {
      const asset = Asset.fromModule(LAIN_MODEL_ASSET);
      await asset.downloadAsync();
      if (!asset.localUri) throw new Error('GLB asset did not resolve to a local file.');
      const fileBytes = await new File(asset.localUri).bytes();
      const arrayBuffer = removeMissingTextureReferences(Uint8Array.from(fileBytes).buffer);
      // Three.js r162 reads navigator.userAgent when constructing GLTFLoader.
      // React Native may expose navigator without that browser-only property.
      if (typeof navigator !== 'undefined' && typeof navigator.userAgent !== 'string') {
        Object.defineProperty(navigator, 'userAgent', {
          configurable: true,
          value: 'React Native',
        });
      }
      const gltf = await new Promise<any>((resolve, reject) => {
        new GLTFLoader().parse(arrayBuffer, '', resolve, reject);
      });
      const model = gltf.scene as THREE.Group;
      applyVaporwaveMaterials(model);
      model.updateWorldMatrix(true, true);
      const originalBounds = new THREE.Box3().setFromObject(model);
      if (originalBounds.isEmpty()) throw new Error('lain.glb loaded without visible geometry.');
      let meshCount = 0;
      model.traverse((object) => {
        if ((object as THREE.Mesh).isMesh) meshCount += 1;
      });
      if (meshCount === 0) throw new Error('lain.glb loaded but contains no renderable meshes.');

      const size = originalBounds.getSize(new THREE.Vector3());
      const center = originalBounds.getCenter(new THREE.Vector3());
      const largestSide = Math.max(size.x, size.y, size.z) || 1;
      const scale = 2.5 / largestSide;
      model.scale.setScalar(scale);
      model.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
      model.updateWorldMatrix(true, true);
      const fittedBounds = new THREE.Box3().setFromObject(model);
      const fittedSphere = fittedBounds.getBoundingSphere(new THREE.Sphere());
      const aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
      const verticalFov = THREE.MathUtils.degToRad(camera.fov);
      const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
      const limitingFov = Math.min(verticalFov, horizontalFov);
      const distance = (fittedSphere.radius / Math.sin(limitingFov / 2)) * 1.2;
      camera.position.set(
        fittedSphere.center.x,
        fittedSphere.center.y + fittedSphere.radius * 0.08,
        fittedSphere.center.z + distance
      );
      camera.lookAt(fittedSphere.center);
      camera.near = Math.max(distance - fittedSphere.radius * 2, 0.01);
      camera.far = distance + fittedSphere.radius * 4;
      camera.updateProjectionMatrix();
      grid.position.y = fittedBounds.min.y - 0.04;
      console.info(`[Lain model] ${meshCount} meshes; bounds ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`);
      avatar.add(model);

      const clock = new THREE.Clock();
      const mixer = gltf.animations?.length ? new THREE.AnimationMixer(model) : null;
      mixer?.clipAction(gltf.animations[0]).play();
      const render = () => {
        frameRef.current = requestAnimationFrame(render);
        avatar.rotation.y += 0.0025;
        mixer?.update(clock.getDelta());
        renderer.render(scene, camera);
        gl.endFrameEXP();
      };
      render();
      setIsLoading(false);
    } catch (error) {
      console.warn('Unable to load lain.glb', error);
      setIsLoading(false);
      setLoadError(true);
      setLoadErrorMessage(error instanceof Error ? error.message.slice(0, 100) : String(error).slice(0, 100));
      const render = () => {
        frameRef.current = requestAnimationFrame(render);
        renderer.render(scene, camera);
        gl.endFrameEXP();
      };
      render();
    }
  };

  return <View style={styles.stage}>
    <GLView style={styles.gl} onContextCreate={onContextCreate} />
    {isLoading && <View pointerEvents="none" style={styles.loading}><ActivityIndicator color="#59f3ff" /><Text style={styles.loadingText}>LOADING MODEL</Text></View>}
    {loadError && <View pointerEvents="none" style={styles.error}><Text style={styles.errorText}>Couldn’t load lain.glb</Text><Text style={styles.errorDetail}>{loadErrorMessage}</Text></View>}
  </View>;
}

const styles = StyleSheet.create({
  stage: { height: 300, overflow: 'hidden', borderRadius: 18 },
  gl: { flex: 1 },
  loading: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, alignItems: 'center', justifyContent: 'center', gap: 8 },
  loadingText: { fontSize: 8, letterSpacing: 1.6, color: '#59f3ff', fontWeight: '700' },
  error: { position: 'absolute', bottom: 42, left: 0, right: 0, alignItems: 'center' },
  errorText: { color: '#ff4fd8', fontSize: 11, fontWeight: '700' },
  errorDetail: { color: '#d1c1e2', fontSize: 8, marginTop: 4, paddingHorizontal: 16, textAlign: 'center' },
});
