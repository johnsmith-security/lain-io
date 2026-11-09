import React, { useEffect, useRef, useState } from 'react';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { GLView, ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ActivityIndicator, LayoutChangeEvent, PanResponder, PixelRatio, StyleSheet, Text, View } from 'react-native';

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

type AvatarActivity = 'missing' | 'downloaded' | 'downloading' | 'loading' | 'ready' | 'thinking' | 'listening' | 'processing' | 'speaking' | 'error';

export default function AvatarScene({ animationState = 'ready', stageHeight = 300, fill = false, visualStyle = 'vaporwave' }: { animationState?: AvatarActivity; stageHeight?: number; fill?: boolean; visualStyle?: 'vaporwave' | 'wired' }) {
  const frameRef = useRef<number | null>(null);
  const pixelSizeRef = useRef<{ width: number; height: number } | null>(null);
  const animationStateRef = useRef(animationState);
  const visualStyleRef = useRef(visualStyle);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadErrorMessage, setLoadErrorMessage] = useState('');
  // Lain stays still on her own; a horizontal finger drag turns her, then she eases to a stop.
  const spinRef = useRef({ yaw: 0, velocity: 0, dragging: false });
  const dragStartYaw = useRef(0);
  const panResponder = useRef(PanResponder.create({
    // Claim horizontal drags only, so vertical swipes still scroll the page.
    onMoveShouldSetPanResponderCapture: (_, g) => Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
    onPanResponderGrant: () => {
      spinRef.current.dragging = true;
      spinRef.current.velocity = 0;
      dragStartYaw.current = spinRef.current.yaw;
    },
    onPanResponderMove: (_, g) => { spinRef.current.yaw = dragStartYaw.current + g.dx * 0.012; },
    onPanResponderRelease: (_, g) => {
      spinRef.current.dragging = false;
      spinRef.current.velocity = g.vx * 0.2;
    },
    onPanResponderTerminate: () => { spinRef.current.dragging = false; },
    onPanResponderTerminationRequest: () => false,
  })).current;

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  useEffect(() => { animationStateRef.current = animationState; }, [animationState]);
  useEffect(() => { visualStyleRef.current = visualStyle; }, [visualStyle]);

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
    const viewport = { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
    let fitCamera: ((width: number, height: number) => void) | null = null;
    // Expo GL's surface follows the view's layout, but three.js keeps the size it
    // was created with. Track the layout (in physical pixels) and refit on change.
    const syncViewport = () => {
      const target = pixelSizeRef.current;
      if (!target || (target.width === viewport.width && target.height === viewport.height)) return;
      viewport.width = target.width;
      viewport.height = target.height;
      canvas.width = canvas.clientWidth = target.width;
      canvas.height = canvas.clientHeight = target.height;
      if (fitCamera) fitCamera(target.width, target.height);
      else renderer.setViewport(0, 0, target.width, target.height);
    };
    const wiredLook = visualStyle === 'wired';
    let lastVisualStyle = visualStyle;
    const clearColor = wiredLook ? 0x07121c : 0x10091e;
    renderer.setClearColor(clearColor, 1);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(clearColor, 7, 14);
    const camera = new THREE.PerspectiveCamera(32, gl.drawingBufferWidth / gl.drawingBufferHeight, 0.01, 100);
    scene.add(new THREE.HemisphereLight(0xe9d5ff, 0x24143a, 2.1));
    const key = new THREE.DirectionalLight(wiredLook ? 0x8bb8c7 : 0xff9fea, 3.2);
    key.position.set(-3, 5, 5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(wiredLook ? 0x63a6b8 : 0x59f3ff, 1.8);
    fill.position.set(3, 1, 4);
    scene.add(fill);
    const rim = new THREE.PointLight(wiredLook ? 0x498395 : 0x59f3ff, 15, 12);
    rim.position.set(3, 2, -2);
    scene.add(rim);

    const avatar = new THREE.Group();
    scene.add(avatar);
    const grid = wiredLook
      ? new THREE.GridHelper(12, 24, 0x34788a, 0x1b3544)
      : new THREE.GridHelper(12, 24, 0x913cbd, 0x30234f);
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
      const fittedSize = fittedBounds.getSize(new THREE.Vector3());
      const fittedCenter = fittedBounds.getCenter(new THREE.Vector3());
      // The avatar spins around Y, so its on-screen width is bounded by the XZ radius.
      const spinRadius = Math.hypot(fittedSize.x / 2, fittedSize.z / 2);
      // Frame the model for the current viewport; re-run whenever the stage is resized
      // (e.g. it grows to fill the screen while the keyboard is open).
      fitCamera = (width: number, height: number) => {
        renderer.setViewport(0, 0, width, height);
        camera.aspect = width / height;
        const verticalFov = THREE.MathUtils.degToRad(camera.fov);
        const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
        const distance = Math.max(
          (fittedSize.y / 2) / Math.tan(verticalFov / 2),
          spinRadius / Math.tan(horizontalFov / 2)
        ) * 1.08 + spinRadius;
        camera.position.set(fittedCenter.x, fittedCenter.y, fittedCenter.z + distance);
        camera.lookAt(fittedCenter);
        camera.near = Math.max(distance - spinRadius * 3, 0.01);
        camera.far = distance + spinRadius * 8;
        camera.updateProjectionMatrix();
      };
      fitCamera(viewport.width, viewport.height);
      grid.position.y = fittedBounds.min.y - 0.04;
      console.info(`[Lain model] ${meshCount} meshes; bounds ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`);
      avatar.add(model);

      const clock = new THREE.Clock();
      const head = model.getObjectByName('頭');
      const neck = model.getObjectByName('首');
      const leftArm = model.getObjectByName('腕.L');
      const rightArm = model.getObjectByName('腕.R');
      const baseRotations = [head, neck, leftArm, rightArm].map((bone) => bone?.rotation.clone());
      const render = () => {
        frameRef.current = requestAnimationFrame(render);
        if (visualStyleRef.current !== lastVisualStyle) {
          lastVisualStyle = visualStyleRef.current;
          const useWiredLook = lastVisualStyle === 'wired';
          const nextClear = useWiredLook ? 0x07121c : 0x10091e;
          renderer.setClearColor(nextClear, 1);
          (scene.fog as THREE.Fog).color.setHex(nextClear);
          key.color.setHex(useWiredLook ? 0x8bb8c7 : 0xff9fea);
          fill.color.setHex(useWiredLook ? 0x63a6b8 : 0x59f3ff);
          rim.color.setHex(useWiredLook ? 0x498395 : 0x59f3ff);
          const gridColors = useWiredLook ? [0x34788a, 0x1b3544] : [0x913cbd, 0x30234f];
          const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
          gridMaterials.forEach((material, index) => material.color?.setHex(gridColors[index % 2]));
        }
        const t = clock.getElapsedTime();
        const currentState = animationStateRef.current;
        const listening = currentState === 'listening' || currentState === 'processing';
        const thinking = currentState === 'thinking';
        const speaking = currentState === 'speaking';
        if (head && baseRotations[0]) {
          // Only a speaking nod and a listening/thinking head tilt; no idle sway.
          head.rotation.x = baseRotations[0].x + (speaking ? Math.sin(t * 5) * 0.08 : 0);
          head.rotation.z = baseRotations[0].z + (listening ? -0.12 : thinking ? 0.09 : 0);
        }
        if (neck && baseRotations[1]) neck.rotation.z = baseRotations[1].z + (listening ? -0.08 : thinking ? 0.06 : 0);
        if (leftArm && baseRotations[2]) leftArm.rotation.x = baseRotations[2].x + (speaking ? Math.sin(t * 4) * 0.06 : 0);
        if (rightArm && baseRotations[3]) rightArm.rotation.x = baseRotations[3].x + (speaking ? Math.sin(t * 4 + 1.2) * 0.06 : 0);
        const spin = spinRef.current;
        if (!spin.dragging && spin.velocity !== 0) {
          spin.yaw += spin.velocity;
          spin.velocity *= 0.92;
          if (Math.abs(spin.velocity) < 0.0005) spin.velocity = 0;
        }
        avatar.rotation.y = spin.yaw;
        syncViewport();
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
        syncViewport();
        renderer.render(scene, camera);
        gl.endFrameEXP();
      };
      render();
    }
  };

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    const ratio = PixelRatio.get();
    if (width > 0 && height > 0) pixelSizeRef.current = { width: Math.round(width * ratio), height: Math.round(height * ratio) };
  };

  return <View onLayout={onLayout} {...panResponder.panHandlers} style={[styles.stage, fill ? styles.fillStage : { height: stageHeight }]}>
    <GLView style={styles.gl} onContextCreate={onContextCreate} />
    {isLoading && <View pointerEvents="none" style={styles.loading}><ActivityIndicator color="#59f3ff" /><Text style={styles.loadingText}>LOADING MODEL</Text></View>}
    {loadError && <View pointerEvents="none" style={styles.error}><Text style={styles.errorText}>Couldn’t load lain.glb</Text><Text style={styles.errorDetail}>{loadErrorMessage}</Text></View>}
  </View>;
}

const styles = StyleSheet.create({
  stage: { overflow: 'hidden', borderRadius: 18 },
  fillStage: { flex: 1, borderRadius: 0 },
  gl: { flex: 1 },
  loading: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, alignItems: 'center', justifyContent: 'center', gap: 8 },
  loadingText: { fontSize: 8, letterSpacing: 1.6, color: '#59f3ff', fontWeight: '700' },
  error: { position: 'absolute', bottom: 42, left: 0, right: 0, alignItems: 'center' },
  errorText: { color: '#ff4fd8', fontSize: 11, fontWeight: '700' },
  errorDetail: { color: '#d1c1e2', fontSize: 8, marginTop: 4, paddingHorizontal: 16, textAlign: 'center' },
});
