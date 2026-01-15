import { useCallback, useEffect, useRef, useState } from 'react';

import GIF from 'gif.js.optimized';
import {
  Activity,
  Box,
  Download,
  FileCode,
  Languages,
  Layers,
  Loader2,
  Palette,
  Play,
  Square,
  Sun,
  Upload,
  Video,
  Zap,
} from 'lucide-react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { Locale, translations } from './locales';
import { ModelMetadata, RenderingConfig, SceneConfig } from './types';

const needsPreciseBounds = (model: THREE.Object3D) => {
  let precise = false;
  model.traverse((child) => {
    if ((child as THREE.SkinnedMesh).isSkinnedMesh) precise = true;
  });
  return precise;
};

const getBoneBounds = (root: THREE.Object3D) => {
  const box = new THREE.Box3();
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  let hasBone = false;
  const worldPos = new THREE.Vector3();

  root.updateMatrixWorld(true);
  root.traverse((child) => {
    if ((child as THREE.Bone).isBone) {
      hasBone = true;
      child.getWorldPosition(worldPos);
      min.min(worldPos);
      max.max(worldPos);
    }
  });

  if (!hasBone) return box;
  box.min.copy(min);
  box.max.copy(max);
  return box;
};

const getNodeBounds = (root: THREE.Object3D) => {
  const box = new THREE.Box3();
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  let hasNode = false;
  const worldPos = new THREE.Vector3();

  root.updateMatrixWorld(true);
  root.traverse((child) => {
    hasNode = true;
    child.getWorldPosition(worldPos);
    min.min(worldPos);
    max.max(worldPos);
  });

  if (!hasNode) return box;
  box.min.copy(min);
  box.max.copy(max);
  return box;
};

const getObjectBounds = (root: THREE.Object3D, precise = false) => {
  const box = new THREE.Box3().setFromObject(root, precise);
  if (!box.isEmpty()) return box;
  const boneBox = getBoneBounds(root);
  if (!boneBox.isEmpty()) return boneBox;
  return getNodeBounds(root);
};

type RigHelper = {
  helper: THREE.LineSegments;
  pairs: Array<{ child: THREE.Object3D; parent: THREE.Object3D }>;
};

const createRigHelper = (root: THREE.Object3D): RigHelper | null => {
  const pairs: Array<{ child: THREE.Object3D; parent: THREE.Object3D }> = [];
  root.updateMatrixWorld(true);
  root.traverse((child) => {
    if (child === root) return;
    if (!child.parent) return;
    pairs.push({ child, parent: child.parent });
  });
  if (pairs.length === 0) return null;
  const positions = new Float32Array(pairs.length * 2 * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: 0xff7a18,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.9,
  });
  const helper = new THREE.LineSegments(geometry, material);
  helper.frustumCulled = false;
  return { helper, pairs };
};

const updateRigHelper = (rig: RigHelper) => {
  const position = rig.helper.geometry.getAttribute('position') as THREE.BufferAttribute;
  const worldPos = new THREE.Vector3();
  let idx = 0;
  for (const { child, parent } of rig.pairs) {
    child.getWorldPosition(worldPos);
    position.setXYZ(idx++, worldPos.x, worldPos.y, worldPos.z);
    parent.getWorldPosition(worldPos);
    position.setXYZ(idx++, worldPos.x, worldPos.y, worldPos.z);
  }
  position.needsUpdate = true;
};

const alignRootToGround = (root: THREE.Object3D, targetSize = 250, precise = false) => {
  root.updateMatrixWorld(true);
  const box = getObjectBounds(root, precise);
  if (box.isEmpty()) return;

  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = Number.isFinite(maxDim) && maxDim > 0 ? targetSize / maxDim : 1;
  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);

  const scaledBox = getObjectBounds(root, precise);
  if (scaledBox.isEmpty()) return;
  const center = scaledBox.getCenter(new THREE.Vector3());
  root.position.set(-center.x, -scaledBox.min.y, -center.z);
  root.updateMatrixWorld(true);
};

const getSupportedMimeType = (candidates: string[]) => {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
};

const getRecordingOptions = (format: 'webm' | 'mp4') => {
  const mp4Candidates = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=h264', 'video/mp4'];
  const webmCandidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  if (format === 'mp4') {
    const mimeType = getSupportedMimeType(mp4Candidates);
    if (mimeType) {
      return { mimeType, format: 'mp4' as const, notice: false };
    }
    const fallbackMime = getSupportedMimeType(webmCandidates);
    return {
      mimeType: fallbackMime,
      format: 'webm' as const,
      notice: true,
    };
  }
  return { mimeType: getSupportedMimeType(webmCandidates), format: 'webm' as const, notice: false };
};

const gifWorkerUrl = new URL('gif.js.optimized/dist/gif.worker.js', import.meta.url).toString();

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const getCropRectForAspect = (
  _rect: { x: number; y: number; width: number; height: number },
  aspect: number,
  viewWidth: number,
  viewHeight: number,
) => {
  const defaultRect = { x: 0, y: 0, width: 1, height: 1 };
  if (!Number.isFinite(aspect) || aspect <= 0) return defaultRect;
  if (!Number.isFinite(viewWidth) || !Number.isFinite(viewHeight)) return defaultRect;
  if (viewWidth <= 0 || viewHeight <= 0) return defaultRect;
  const viewAspect = viewWidth / viewHeight;
  let width = 1;
  let height = 1;
  if (aspect > viewAspect) {
    height = viewAspect / aspect;
  } else {
    width = aspect / viewAspect;
  }
  // Always center the crop rectangle to ensure the model stays in the center
  const nextX = (1 - width) / 2;
  const nextY = (1 - height) / 2;
  return { x: nextX, y: nextY, width, height };
};

const getClipFrameCount = (clip: THREE.AnimationClip | null) => {
  if (!clip) return 0;
  let maxFrames = 0;
  for (const track of clip.tracks) {
    const count = track.times.length;
    if (count > maxFrames) maxFrames = count;
  }
  if (maxFrames > 0) return maxFrames;
  if (Number.isFinite(clip.duration) && clip.duration > 0)
    return Math.max(1, Math.round(clip.duration * 60));
  return 0;
};

const resolutionPresets = [
  { label: '720p (HD)', width: 1280, height: 720 },
  { label: '1080p (FHD)', width: 1920, height: 1080 },
  { label: '1440p (QHD)', width: 2560, height: 1440 },
  { label: '2160p (4K)', width: 3840, height: 2160 },
];

const aspectPresets = [
  { label: '1:1', width: 1, height: 1 },
  { label: '4:3', width: 4, height: 3 },
  { label: '9:16', width: 9, height: 16 },
];

const viewPreset = {
  cameraPosition: new THREE.Vector3(-533.2114976476801, 130.61937589294004, 629.7917070129056),
  controlsTarget: new THREE.Vector3(61.36949013775254, 124.18544261444927, 63.603582359940226),
};

const applyViewPreset = (
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls | null,
  preset: { cameraPosition: THREE.Vector3; controlsTarget: THREE.Vector3 },
) => {
  camera.position.copy(preset.cameraPosition);
  if (controls) {
    controls.target.copy(preset.controlsTarget);
  }
  const distance = camera.position.distanceTo(preset.controlsTarget);
  camera.near = Math.max(distance / 100, 0.1);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  if (controls) controls.update();
};

const frameCameraToObject = (
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls | null,
  object: THREE.Object3D,
  margin = 2,
) => {
  object.updateMatrixWorld(true);
  const box = getObjectBounds(object, true);
  if (box.isEmpty()) return;

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxSize = Math.max(size.x, size.y, size.z);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const fitHeightDistance = maxSize / (2 * Math.tan(fov / 2));
  const fitWidthDistance = fitHeightDistance / camera.aspect;
  const distance = margin * Math.max(fitHeightDistance, fitWidthDistance);

  const currentTarget = controls ? controls.target : center;
  const direction = new THREE.Vector3().subVectors(camera.position, currentTarget);
  if (direction.lengthSq() === 0) direction.set(1, 1, 1);
  direction.normalize();

  camera.position.copy(center).add(direction.multiplyScalar(distance));
  camera.near = Math.max(distance / 100, 0.1);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();

  if (controls) {
    controls.target.copy(center);
    controls.update();
  } else {
    camera.lookAt(center);
  }
};

const applyViewForModel = (
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls | null,
  model: THREE.Object3D,
) => {
  if (viewPreset) {
    applyViewPreset(camera, controls, viewPreset);
  } else {
    frameCameraToObject(camera, controls, model);
  }
};

const Converter: React.FC = () => {
  const [lang, setLang] = useState<Locale>('zh');
  const t = translations[lang];

  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [metadata, setMetadata] = useState<ModelMetadata | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoFormat, setVideoFormat] = useState<'webm' | 'mp4' | 'gif'>('webm');
  const [renderNotice, setRenderNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [frameProgress, setFrameProgress] = useState({ current: 0, total: 0 });
  const [activeTab, setActiveTab] = useState<'info' | 'settings' | 'export'>('info');

  const [sceneParams, setSceneParams] = useState<SceneConfig>({
    cameraPosition: { x: 300, y: 200, z: 300 },
    lookAt: { x: 0, y: 0, z: 0 },
    mainLightColor: '#ffffff',
    mainLightIntensity: 5.0,
    mainLightPosition: { x: 200, y: 400, z: 200 },
    ambientIntensity: 3.0,
    ambientColor: '#ffffff',
    environmentVibe: 'studio',
    backgroundColor: '#020617',
    exposure: 1.5,
    shadowsEnabled: true,
    animationSpeed: 1.0,
    fov: 45,
  });

  const [renderConfig, setRenderConfig] = useState<RenderingConfig>({
    fps: 60,
    width: 1920,
    height: 1080,
    bitrate: 20000000,
    format: 'mp4',
    duration: 5,
    gifQuality: 10,
    viewMode: 'fit',
  });

  const [resolutionMode, setResolutionMode] = useState<'preset' | 'custom'>('preset');
  const [cropRect, setCropRect] = useState({ x: 0, y: 0, width: 1, height: 1 });
  const renderConfigRef = useRef(renderConfig);
  const viewportSizeRef = useRef({ width: 1, height: 1 });

  const presetMatch = resolutionPresets.find(
    (preset) => preset.width === renderConfig.width && preset.height === renderConfig.height,
  );
  const resolutionValue =
    resolutionMode === 'custom' || !presetMatch
      ? 'custom'
      : `${renderConfig.width}x${renderConfig.height}`;

  const toDimension = (value: string | number, fallback: number) => {
    const parsed = typeof value === 'string' ? Number(value) : value;
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(16, Math.round(parsed));
  };

  const applyAspectPreset = (preset: { width: number; height: number }) => {
    const base = Math.max(renderConfig.width, renderConfig.height);
    const isLandscape = preset.width >= preset.height;
    const targetWidth = isLandscape ? base : Math.round((base * preset.width) / preset.height);
    const targetHeight = isLandscape ? Math.round((base * preset.height) / preset.width) : base;
    const nextWidth = toDimension(targetWidth, renderConfig.width);
    const nextHeight = toDimension(targetHeight, renderConfig.height);
    setResolutionMode('custom');
    setRenderConfig((prev) => ({
      ...prev,
      width: nextWidth,
      height: nextHeight,
    }));
    syncCropRectForConfig(nextWidth, nextHeight);
  };

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const sceneParamsRef = useRef(sceneParams);
  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    mixer: THREE.AnimationMixer | null;
    model: THREE.Group | THREE.Object3D | null;
    skeletonHelper: THREE.SkeletonHelper | null;
    rigHelper: RigHelper | null;
    clock: THREE.Clock;
    controls: OrbitControls;
    mainLight: THREE.DirectionalLight;
    ambientLight: THREE.AmbientLight;
    floor: THREE.Mesh;
  } | null>(null);
  const renderStateRef = useRef<{
    isRendering: boolean;
    recorder: MediaRecorder | null;
    gif: GIF | null;
    restore: (() => void) | null;
  }>({
    isRendering: false,
    recorder: null,
    gif: null,
    restore: null,
  });

  const recordCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const recordedChunks = useRef<Blob[]>([]);
  const cropRectRef = useRef(cropRect);
  const cropDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: { x: number; y: number; width: number; height: number };
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    renderConfigRef.current = renderConfig;
  }, [renderConfig]);

  useEffect(() => {
    cropRectRef.current = cropRect;
  }, [cropRect]);

  const syncCropRectForConfig = useCallback(
    (nextWidth: number, nextHeight: number, viewWidth?: number, viewHeight?: number) => {
      const width = viewWidth ?? viewportSizeRef.current.width;
      const height = viewHeight ?? viewportSizeRef.current.height;
      setCropRect((prev) => getCropRectForAspect(prev, nextWidth / nextHeight, width, height));
    },
    [],
  );

  const handleViewportResize = useCallback(() => {
    if (!canvasRef.current || !sceneRef.current) return;
    if (renderStateRef.current.isRendering) return;
    const parent = canvasRef.current.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    const view = viewportSizeRef.current;
    if (view.width !== width || view.height !== height) {
      viewportSizeRef.current = { width, height };
      const currentConfig = renderConfigRef.current;
      syncCropRectForConfig(currentConfig.width, currentConfig.height, width, height);
    }
    const { camera, renderer } = sceneRef.current;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  }, [syncCropRectForConfig]);

  const handleViewportRef = useCallback(
    (node: HTMLDivElement | null) => {
      viewportRef.current = node;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      viewportSizeRef.current = { width: rect.width, height: rect.height };
      const currentConfig = renderConfigRef.current;
      syncCropRectForConfig(currentConfig.width, currentConfig.height, rect.width, rect.height);
    },
    [syncCropRectForConfig],
  );

  const handleCropPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!viewportRef.current) return;
    const bounds = viewportRef.current.getBoundingClientRect();
    cropDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: cropRectRef.current,
      width: bounds.width,
      height: bounds.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleCropPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = cropDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = (event.clientX - drag.startX) / drag.width;
    const dy = (event.clientY - drag.startY) / drag.height;
    const nextX = clamp(drag.origin.x + dx, 0, 1 - drag.origin.width);
    const nextY = clamp(drag.origin.y + dy, 0, 1 - drag.origin.height);
    setCropRect({ ...drag.origin, x: nextX, y: nextY });
  };

  const handleCropPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = cropDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    cropDragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    // Always reset to center to ensure the model stays in the center of the exported video
    const currentConfig = renderConfigRef.current;
    syncCropRectForConfig(currentConfig.width, currentConfig.height);
  };

  // Sync scene state to Three.js objects
  useEffect(() => {
    if (!sceneRef.current) return;
    sceneParamsRef.current = sceneParams;
    const { scene, camera, renderer, mainLight, ambientLight, floor } = sceneRef.current;

    scene.background = new THREE.Color(sceneParams.backgroundColor);
    scene.fog = new THREE.Fog(sceneParams.backgroundColor, 500, 2000);

    camera.fov = sceneParams.fov;
    camera.updateProjectionMatrix();

    mainLight.intensity = sceneParams.mainLightIntensity;
    mainLight.color.set(sceneParams.mainLightColor);
    mainLight.position.set(
      sceneParams.mainLightPosition.x,
      sceneParams.mainLightPosition.y,
      sceneParams.mainLightPosition.z,
    );
    mainLight.castShadow = sceneParams.shadowsEnabled;

    ambientLight.intensity = sceneParams.ambientIntensity;
    ambientLight.color.set(sceneParams.ambientColor);

    renderer.toneMappingExposure = sceneParams.exposure;
    floor.visible = sceneParams.shadowsEnabled;
  }, [sceneParams]);

  // Initialize Scene (only runs once on mount, sceneParams changes handled by sync effect above)
  useEffect(() => {
    if (!canvasRef.current) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(sceneParams.backgroundColor);

    const camera = new THREE.PerspectiveCamera(sceneParams.fov, 1, 0.1, 5000);
    camera.position.set(
      sceneParams.cameraPosition.x,
      sceneParams.cameraPosition.y,
      sceneParams.cameraPosition.z,
    );

    const renderer = new THREE.WebGLRenderer({
      canvas: canvasRef.current,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(800, 600);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ReinhardToneMapping;
    renderer.toneMappingExposure = sceneParams.exposure;

    const ambientLight = new THREE.AmbientLight(
      sceneParams.ambientColor,
      sceneParams.ambientIntensity,
    );
    scene.add(ambientLight);

    const mainLight = new THREE.DirectionalLight(
      sceneParams.mainLightColor,
      sceneParams.mainLightIntensity,
    );
    mainLight.position.set(
      sceneParams.mainLightPosition.x,
      sceneParams.mainLightPosition.y,
      sceneParams.mainLightPosition.z,
    );
    mainLight.castShadow = sceneParams.shadowsEnabled;
    mainLight.shadow.mapSize.width = 2048;
    mainLight.shadow.mapSize.height = 2048;
    scene.add(mainLight);

    const grid = new THREE.GridHelper(2000, 50, 0x1e293b, 0x0f172a);
    scene.add(grid);

    const planeGeometry = new THREE.PlaneGeometry(2000, 2000);
    const planeMaterial = new THREE.MeshStandardMaterial({ color: 0x020617, roughness: 0.8 });
    const floor = new THREE.Mesh(planeGeometry, planeMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    const clock = new THREE.Clock();

    sceneRef.current = {
      scene,
      camera,
      renderer,
      mixer: null,
      model: null,
      skeletonHelper: null,
      rigHelper: null,
      clock,
      controls,
      mainLight,
      ambientLight,
      floor,
    };

    const animate = () => {
      requestAnimationFrame(animate);
      if (renderStateRef.current.isRendering) return;
      const delta = clock.getDelta() * sceneParamsRef.current.animationSpeed;
      if (sceneRef.current?.mixer) sceneRef.current.mixer.update(delta);
      if (sceneRef.current?.controls) sceneRef.current.controls.update();
      if (sceneRef.current?.skeletonHelper) {
        sceneRef.current.skeletonHelper.updateMatrixWorld(true);
      }
      if (sceneRef.current?.rigHelper) {
        updateRigHelper(sceneRef.current.rigHelper);
      }
      renderer.render(scene, camera);
    };
    animate();

    const parent = canvasRef.current?.parentElement;
    if (parent && !renderStateRef.current.isRendering) {
      const width = parent.clientWidth;
      const height = parent.clientHeight;
      viewportSizeRef.current = { width, height };
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    }
    window.addEventListener('resize', handleViewportResize);

    return () => {
      window.removeEventListener('resize', handleViewportResize);
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = event.target.files?.[0];
    if (!uploadedFile || !sceneRef.current) return;

    setLoading(true);
    setFile(uploadedFile);
    setVideoUrl(null);

    const extension = uploadedFile.name.split('.').pop()?.toLowerCase();
    const reader = new FileReader();

    reader.onload = async (e) => {
      const contents = e.target?.result as ArrayBuffer;
      let object: THREE.Object3D | null = null;
      let animations: THREE.AnimationClip[] = [];

      try {
        if (extension === 'fbx') {
          const loader = new FBXLoader();
          object = loader.parse(contents, '');
          animations = object.animations;
        } else if (extension === 'glb' || extension === 'gltf') {
          const loader = new GLTFLoader();
          const gltf = await new Promise<any>((resolve, reject) => {
            loader.parse(contents, '', resolve, reject);
          });
          let sceneRoot = gltf.scene ?? gltf.scenes?.[0] ?? null;
          if (!sceneRoot || sceneRoot.children.length === 0) {
            const nodes = await gltf.parser.getDependencies('node');
            const rootNodes = nodes.filter((node: THREE.Object3D) => !node.parent);
            if (rootNodes.length > 0) {
              const group = new THREE.Group();
              rootNodes.forEach((node: THREE.Object3D) => group.add(node));
              sceneRoot = group;
            }
          }
          object = sceneRoot;
          animations = gltf.animations;
        }

        if (!object) throw new Error('Unsupported format');

        if (sceneRef.current?.model) sceneRef.current.scene.remove(sceneRef.current.model);
        if (sceneRef.current?.skeletonHelper) {
          sceneRef.current.scene.remove(sceneRef.current.skeletonHelper);
          sceneRef.current.skeletonHelper.geometry.dispose();
          if (Array.isArray(sceneRef.current.skeletonHelper.material)) {
            sceneRef.current.skeletonHelper.material.forEach((material) => material.dispose());
          } else {
            sceneRef.current.skeletonHelper.material.dispose();
          }
          sceneRef.current.skeletonHelper = null;
        }
        if (sceneRef.current?.rigHelper) {
          sceneRef.current.scene.remove(sceneRef.current.rigHelper.helper);
          sceneRef.current.rigHelper.helper.geometry.dispose();
          if (Array.isArray(sceneRef.current.rigHelper.helper.material)) {
            sceneRef.current.rigHelper.helper.material.forEach((material) => material.dispose());
          } else {
            sceneRef.current.rigHelper.helper.material.dispose();
          }
          sceneRef.current.rigHelper = null;
        }

        const root = new THREE.Group();
        root.add(object);
        const preciseBounds = needsPreciseBounds(object);

        let hasMesh = false;
        let hasBone = false;
        object.traverse((child) => {
          if ((child as THREE.Bone).isBone) hasBone = true;
          if ((child as THREE.Mesh).isMesh) {
            hasMesh = true;
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });

        root.userData.animations = animations;

        let mixer: THREE.AnimationMixer | null = null;
        if (animations.length > 0) {
          mixer = new THREE.AnimationMixer(root);
          mixer.clipAction(animations[0]).play();
          mixer.setTime(0);
        }

        alignRootToGround(root, 250, preciseBounds);

        sceneRef.current!.scene.add(root);
        if (!hasMesh && hasBone) {
          const helper = new THREE.SkeletonHelper(root);
          helper.material = new THREE.LineBasicMaterial({ color: 0xff7a18 });
          helper.frustumCulled = false;
          sceneRef.current!.scene.add(helper);
          sceneRef.current!.skeletonHelper = helper;
        } else if (!hasMesh) {
          const rigHelper = createRigHelper(root);
          if (rigHelper) {
            sceneRef.current!.scene.add(rigHelper.helper);
            sceneRef.current!.rigHelper = rigHelper;
            updateRigHelper(rigHelper);
          }
        }
        sceneRef.current!.model = root;
        sceneRef.current!.mixer = mixer;
        if (!hasMesh) {
          frameCameraToObject(sceneRef.current!.camera, sceneRef.current!.controls, root);
        } else {
          applyViewForModel(sceneRef.current!.camera, sceneRef.current!.controls, root);
        }

        const meta: ModelMetadata = {
          name: uploadedFile.name,
          boneCount: 0,
          animations: animations.map((a) => ({ name: a.name, duration: a.duration })),
        };
        object.traverse((child) => {
          if ((child as THREE.Bone).isBone) meta.boneCount++;
        });

        const primaryClip = animations[0] ?? null;
        setFrameProgress({ current: 0, total: getClipFrameCount(primaryClip) });
        setMetadata(meta);
        setActiveTab('info');
      } catch (err) {
        console.error('Error parsing model:', err);
      } finally {
        setLoading(false);
      }
    };
    reader.readAsArrayBuffer(uploadedFile);
  };

  const startRendering = async () => {
    if (!canvasRef.current || !sceneRef.current?.mixer) return;
    if (renderStateRef.current.isRendering) return;

    renderStateRef.current.isRendering = true;
    setIsRendering(true);
    setRenderNotice(null);
    recordedChunks.current = [];
    setProgress(0);
    renderStateRef.current.recorder = null;
    renderStateRef.current.gif = null;

    const { renderer, scene, camera, mixer, controls, model } = sceneRef.current;

    const originalSize = new THREE.Vector2();
    renderer.getSize(originalSize);
    const originalPixelRatio = renderer.getPixelRatio();
    const originalCamera = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      near: camera.near,
      far: camera.far,
      aspect: camera.aspect,
    };
    const originalControls = {
      target: controls.target.clone(),
      enabled: controls.enabled,
    };

    const restoreAfterRecording = () => {
      renderer.setPixelRatio(originalPixelRatio);
      renderer.setSize(originalSize.x, originalSize.y, false);
      camera.position.copy(originalCamera.position);
      camera.quaternion.copy(originalCamera.quaternion);
      camera.near = originalCamera.near;
      camera.far = originalCamera.far;
      camera.aspect = originalCamera.aspect;
      camera.updateProjectionMatrix();
      controls.target.copy(originalControls.target);
      controls.enabled = originalControls.enabled;
      controls.update();
    };
    renderStateRef.current.restore = restoreAfterRecording;

    controls.enabled = false;
    if (renderConfig.viewMode === 'fit' && model) {
      frameCameraToObject(camera, controls, model);
    }

    const recordCanvas = document.createElement('canvas');
    recordCanvas.width = renderConfig.width;
    recordCanvas.height = renderConfig.height;
    recordCanvasRef.current = recordCanvas;
    const recordContext = recordCanvas.getContext('2d');
    if (!recordContext) {
      setIsRendering(false);
      renderStateRef.current.isRendering = false;
      renderStateRef.current.recorder = null;
      restoreAfterRecording();
      renderStateRef.current.restore = null;
      return;
    }

    const drawCroppedFrame = () => {
      const source = renderer.domElement;
      const crop = getCropRectForAspect(
        cropRectRef.current,
        renderConfig.width / renderConfig.height,
        source.width,
        source.height,
      );
      const sw = Math.max(1, crop.width * source.width);
      const sh = Math.max(1, crop.height * source.height);
      const sx = clamp(crop.x * source.width, 0, source.width - sw);
      const sy = clamp(crop.y * source.height, 0, source.height - sh);
      recordContext.clearRect(0, 0, recordCanvas.width, recordCanvas.height);
      recordContext.drawImage(
        source,
        sx,
        sy,
        sw,
        sh,
        0,
        0,
        recordCanvas.width,
        recordCanvas.height,
      );
    };

    const root = mixer.getRoot() as THREE.Object3D & { animations: THREE.AnimationClip[] };
    const animationList = (root.userData?.animations ||
      (root as any).animations ||
      []) as THREE.AnimationClip[];
    const animation = animationList.length > 0 ? animationList[0] : null;

    const clipFrameTotal = getClipFrameCount(animation);
    setFrameProgress({ current: 0, total: clipFrameTotal });

    const clipDuration = animation ? mixer.existingAction(animation)?.getClip().duration || 0 : 0;
    const targetDuration = renderConfig.duration > 0 ? renderConfig.duration : clipDuration || 5;
    const totalFrames = Math.max(1, Math.ceil(targetDuration * renderConfig.fps));
    const frameTime = 1 / renderConfig.fps;
    const frameDelayMs = 1000 / renderConfig.fps;

    const updateFrameProgress = (time: number) => {
      if (clipFrameTotal <= 0 || clipDuration <= 0) return;
      const normalized = clamp(time / clipDuration, 0, 1);
      const nextFrame = Math.min(
        clipFrameTotal,
        Math.max(1, Math.floor(normalized * clipFrameTotal) + 1),
      );
      setFrameProgress({ current: nextFrame, total: clipFrameTotal });
    };

    mixer.stopAllAction();
    const action = animation ? mixer.clipAction(animation) : null;
    if (action) action.reset().play();

    if (renderConfig.format === 'gif') {
      const gif = new GIF({
        workers: Math.min(4, navigator.hardwareConcurrency || 4),
        quality: renderConfig.gifQuality,
        workerScript: gifWorkerUrl,
        width: renderConfig.width,
        height: renderConfig.height,
      });
      renderStateRef.current.gif = gif;

      gif.on('finished', (blob: Blob) => {
        setVideoUrl(URL.createObjectURL(blob));
        setVideoFormat('gif');
        setIsRendering(false);
        setProgress(100);
        setFrameProgress((prev) => ({ ...prev, current: prev.total }));
        renderStateRef.current.isRendering = false;
        renderStateRef.current.gif = null;
        restoreAfterRecording();
        renderStateRef.current.restore = null;
      });

      for (let i = 0; i < totalFrames && renderStateRef.current.isRendering; i++) {
        const elapsed = i * frameTime * sceneParams.animationSpeed;
        const time = clipDuration > 0 ? elapsed % clipDuration : 0;
        mixer.setTime(time);
        if (sceneRef.current?.skeletonHelper) {
          sceneRef.current.skeletonHelper.updateMatrixWorld(true);
        }
        if (sceneRef.current?.rigHelper) {
          updateRigHelper(sceneRef.current.rigHelper);
        }
        renderer.render(scene, camera);
        drawCroppedFrame();
        updateFrameProgress(time);
        gif.addFrame(recordCanvas, { copy: true, delay: frameDelayMs });
        await new Promise((r) => setTimeout(r, frameDelayMs));
        setProgress(Math.round(((i + 1) / totalFrames) * 100));
      }

      if (!renderStateRef.current.isRendering) {
        gif.abort();
        renderStateRef.current.gif = null;
        restoreAfterRecording();
        renderStateRef.current.restore = null;
        return;
      }

      gif.render();
      return;
    }

    drawCroppedFrame();
    const stream = recordCanvas.captureStream(renderConfig.fps);
    const { mimeType, format: formatUsedRaw, notice } = getRecordingOptions(renderConfig.format);
    let formatUsed = formatUsedRaw;
    if (notice) setRenderNotice(t.formatFallback);

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(
        stream,
        mimeType
          ? { mimeType, videoBitsPerSecond: renderConfig.bitrate }
          : { videoBitsPerSecond: renderConfig.bitrate },
      );
      if (recorder.mimeType) {
        formatUsed = recorder.mimeType.includes('mp4') ? 'mp4' : 'webm';
      }
    } catch (_err) {
      const fallback = getRecordingOptions('webm');
      formatUsed = fallback.format;
      setRenderNotice(t.formatFallback);
      recorder = new MediaRecorder(
        stream,
        fallback.mimeType
          ? { mimeType: fallback.mimeType, videoBitsPerSecond: renderConfig.bitrate }
          : { videoBitsPerSecond: renderConfig.bitrate },
      );
      if (recorder.mimeType) {
        formatUsed = recorder.mimeType.includes('mp4') ? 'mp4' : 'webm';
      }
    }
    renderStateRef.current.recorder = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.current.push(e.data);
    };
    recorder.onstop = () => {
      const blobType = formatUsed === 'mp4' ? 'video/mp4' : 'video/webm';
      const blob = new Blob(recordedChunks.current, { type: blobType });
      setVideoUrl(URL.createObjectURL(blob));
      setVideoFormat(formatUsed);
      setIsRendering(false);
      setProgress(100);
      setFrameProgress((prev) => ({ ...prev, current: prev.total }));
      renderStateRef.current.isRendering = false;
      renderStateRef.current.recorder = null;
      restoreAfterRecording();
      renderStateRef.current.restore = null;
    };
    recorder.onerror = () => {
      setIsRendering(false);
      renderStateRef.current.isRendering = false;
      renderStateRef.current.recorder = null;
      restoreAfterRecording();
      renderStateRef.current.restore = null;
    };

    recorder.start();

    for (let i = 0; i < totalFrames && renderStateRef.current.isRendering; i++) {
      const elapsed = i * frameTime * sceneParams.animationSpeed;
      const time = clipDuration > 0 ? elapsed % clipDuration : 0;
      mixer.setTime(time);
      if (sceneRef.current?.skeletonHelper) {
        sceneRef.current.skeletonHelper.updateMatrixWorld(true);
      }
      if (sceneRef.current?.rigHelper) {
        updateRigHelper(sceneRef.current.rigHelper);
      }
      renderer.render(scene, camera);
      drawCroppedFrame();
      updateFrameProgress(time);
      await new Promise((r) => setTimeout(r, frameDelayMs));
      setProgress(Math.round(((i + 1) / totalFrames) * 100));
    }

    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
  };

  const logViewParams = () => {
    if (!sceneRef.current) return;
    const { camera, controls, renderer } = sceneRef.current;
    console.warn('View params', {
      camera: {
        position: camera.position.toArray(),
        quaternion: camera.quaternion.toArray(),
        fov: camera.fov,
        near: camera.near,
        far: camera.far,
        aspect: camera.aspect,
      },
      controls: {
        target: controls.target.toArray(),
      },
      viewport: {
        width: renderer.domElement.width,
        height: renderer.domElement.height,
        pixelRatio: renderer.getPixelRatio(),
      },
    });
  };

  const cancelRendering = () => {
    renderStateRef.current.isRendering = false;
    if (renderStateRef.current.recorder && renderStateRef.current.recorder.state !== 'inactive') {
      renderStateRef.current.recorder.stop();
    }
    if (renderStateRef.current.gif) {
      renderStateRef.current.gif.abort();
      renderStateRef.current.gif = null;
    }
    if (renderStateRef.current.restore) {
      renderStateRef.current.restore();
      renderStateRef.current.restore = null;
    }
    setIsRendering(false);
    setFrameProgress((prev) => ({ ...prev, current: 0 }));
  };

  const canAdjustCrop = activeTab === 'export' && !isRendering;
  const framePercent =
    frameProgress.total > 0
      ? Math.min(100, Math.round((frameProgress.current / frameProgress.total) * 100))
      : 0;

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100 selection:bg-indigo-500/30 font-sans">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 bg-slate-900 border-b border-white/5 shadow-2xl z-10">
        <div className="flex items-center gap-4">
          <div className="bg-indigo-600 p-2.5 rounded-xl shadow-lg shadow-indigo-600/20">
            <Video className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="font-bold text-xl tracking-tight bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
              {t.title}
            </h1>
            <p className="text-[10px] uppercase tracking-widest text-indigo-400 font-bold">
              {t.subtitle}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button
            onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}
            className="flex items-center gap-2 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white px-3 py-2 rounded-xl transition border border-white/10"
          >
            <Languages className="w-4 h-4" />
            <span className="text-xs font-bold uppercase tracking-widest">
              {lang === 'en' ? '中文' : 'EN'}
            </span>
          </button>
          <div className="w-[1px] h-6 bg-white/10 mx-1" />
          <label className="flex items-center gap-2 bg-white/5 hover:bg-white/10 text-white px-5 py-2.5 rounded-xl cursor-pointer transition border border-white/10">
            <Upload className="w-4 h-4 text-indigo-400" />
            <span className="text-sm font-semibold">{t.loadModel}</span>
            <input
              type="file"
              accept=".fbx,.glb,.gltf"
              className="hidden"
              onChange={handleFileUpload}
            />
          </label>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        <aside className="w-96 bg-slate-900 border-r border-white/5 flex flex-col shadow-2xl relative z-10">
          <div className="flex border-b border-white/5">
            {[
              { id: 'info', icon: Box, label: 'tabModel' },
              { id: 'settings', icon: Palette, label: 'tabRender' },
              { id: 'export', icon: Activity, label: 'tabExport' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex-1 py-4 flex flex-col items-center gap-1 transition ${activeTab === tab.id ? 'text-indigo-400 border-b-2 border-indigo-400 bg-white/5' : 'text-slate-500 hover:text-slate-300'}`}
              >
                <tab.icon className="w-4 h-4" />
                <span className="text-[9px] font-bold uppercase tracking-tighter">
                  {(t as any)[tab.label]}
                </span>
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-6">
            {loading ? (
              <div className="h-full flex flex-col items-center justify-center gap-4 text-slate-500">
                <Loader2 className="w-10 h-10 animate-spin text-indigo-500" />
                <p className="text-xs font-bold animate-pulse">{t.compiling}</p>
              </div>
            ) : metadata ? (
              <>
                {activeTab === 'info' && (
                  <div className="space-y-6 animate-in slide-in-from-left-4">
                    <div className="bg-slate-800/50 p-4 rounded-2xl border border-white/5 shadow-inner">
                      <div className="flex items-center gap-3 mb-3 text-indigo-400">
                        {metadata.name.toLowerCase().endsWith('.fbx') ? (
                          <FileCode className="w-4 h-4" />
                        ) : (
                          <Box className="w-4 h-4" />
                        )}
                        <span className="text-xs font-bold uppercase tracking-widest">
                          {t.geometry}
                        </span>
                      </div>
                      <p className="text-sm font-medium truncate mb-1">{metadata.name}</p>
                      <p className="text-[10px] text-slate-500">
                        {metadata.boneCount} {t.skeleton}
                      </p>
                    </div>
                    <div className="bg-slate-800/50 p-4 rounded-2xl border border-white/5">
                      <div className="flex items-center gap-3 mb-3 text-indigo-400">
                        <Layers className="w-4 h-4" />{' '}
                        <span className="text-xs font-bold uppercase tracking-widest">
                          {t.sequences}
                        </span>
                      </div>
                      <div className="space-y-2 max-h-48 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-700">
                        {metadata.animations.map((a) => (
                          <div
                            key={a.name || 'default'}
                            className="flex justify-between items-center bg-black/20 p-2 rounded-lg text-[11px]"
                          >
                            <span className="font-mono text-slate-300 truncate w-32">
                              {a.name || 'default'}
                            </span>
                            <span className="text-slate-500">{a.duration.toFixed(2)}s</span>
                          </div>
                        ))}
                        {metadata.animations.length === 0 && (
                          <p className="text-[10px] text-slate-500 italic py-2 text-center">
                            No animations found
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'settings' && (
                  <div className="space-y-6 animate-in fade-in">
                    <div className="space-y-4">
                      <h4 className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest flex items-center gap-2 border-b border-white/5 pb-2">
                        <Palette className="w-3 h-3" /> {t.visuals}
                      </h4>
                      <div className="grid grid-cols-2 gap-4">
                        <label className="block">
                          <span className="text-[9px] text-slate-500 uppercase mb-1 block">
                            {t.bg}
                          </span>
                          <input
                            type="color"
                            className="w-full h-8 bg-transparent cursor-pointer rounded overflow-hidden border border-white/10"
                            value={sceneParams.backgroundColor}
                            onChange={(e) =>
                              setSceneParams((p) => ({ ...p, backgroundColor: e.target.value }))
                            }
                          />
                        </label>
                        <label className="block">
                          <span className="text-[9px] text-slate-500 uppercase mb-1 block">
                            {t.exposure}
                          </span>
                          <input
                            type="range"
                            min="0"
                            max="3"
                            step="0.1"
                            className="w-full accent-indigo-500"
                            value={sceneParams.exposure}
                            onChange={(e) =>
                              setSceneParams((p) => ({ ...p, exposure: Number(e.target.value) }))
                            }
                          />
                        </label>
                      </div>
                      <label className="flex items-center justify-between bg-white/5 p-3 rounded-xl border border-white/5">
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                          {t.shadows}
                        </span>
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-indigo-500"
                          checked={sceneParams.shadowsEnabled}
                          onChange={(e) =>
                            setSceneParams((p) => ({ ...p, shadowsEnabled: e.target.checked }))
                          }
                        />
                      </label>
                    </div>

                    <div className="space-y-4">
                      <h4 className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest flex items-center gap-2 border-b border-white/5 pb-2">
                        <Sun className="w-3 h-3" /> {t.lightSettings}
                      </h4>
                      <div className="space-y-3">
                        <div className="bg-white/5 p-3 rounded-xl border border-white/5 space-y-3">
                          <div className="flex justify-between items-center">
                            <span className="text-[10px] text-slate-400">{t.mainLamp}</span>
                            <input
                              type="color"
                              className="w-6 h-6 bg-transparent cursor-pointer rounded"
                              value={sceneParams.mainLightColor}
                              onChange={(e) =>
                                setSceneParams((p) => ({ ...p, mainLightColor: e.target.value }))
                              }
                            />
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="10"
                            step="0.1"
                            className="w-full accent-indigo-500"
                            value={sceneParams.mainLightIntensity}
                            onChange={(e) =>
                              setSceneParams((p) => ({
                                ...p,
                                mainLightIntensity: Number(e.target.value),
                              }))
                            }
                          />
                        </div>
                        <div className="bg-white/5 p-3 rounded-xl border border-white/5 space-y-3">
                          <div className="flex justify-between items-center">
                            <span className="text-[10px] text-slate-400">{t.ambient}</span>
                            <input
                              type="color"
                              className="w-6 h-6 bg-transparent cursor-pointer rounded"
                              value={sceneParams.ambientColor}
                              onChange={(e) =>
                                setSceneParams((p) => ({ ...p, ambientColor: e.target.value }))
                              }
                            />
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="5"
                            step="0.1"
                            className="w-full accent-indigo-500"
                            value={sceneParams.ambientIntensity}
                            onChange={(e) =>
                              setSceneParams((p) => ({
                                ...p,
                                ambientIntensity: Number(e.target.value),
                              }))
                            }
                          />
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <h4 className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest flex items-center gap-2 border-b border-white/5 pb-2">
                        <Zap className="w-3 h-3" /> {t.animSpeed}
                      </h4>
                      <div className="flex items-center gap-4">
                        <span className="text-xs font-mono text-slate-500">0.1x</span>
                        <input
                          type="range"
                          min="0.1"
                          max="3"
                          step="0.1"
                          className="flex-1 accent-indigo-500"
                          value={sceneParams.animationSpeed}
                          onChange={(e) =>
                            setSceneParams((p) => ({
                              ...p,
                              animationSpeed: Number(e.target.value),
                            }))
                          }
                        />
                        <span className="text-xs font-mono text-indigo-400">
                          {sceneParams.animationSpeed.toFixed(1)}x
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'export' && (
                  <div className="space-y-6 animate-in fade-in">
                    <div className="space-y-4">
                      <label className="block">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-2">
                          {t.format}
                        </span>
                        <select
                          className="w-full bg-slate-800 border border-white/10 rounded-xl p-3 text-sm focus:ring-2 ring-indigo-500/50 outline-none"
                          value={renderConfig.format}
                          onChange={(e) =>
                            setRenderConfig((prev) => ({
                              ...prev,
                              format: e.target.value as RenderingConfig['format'],
                            }))
                          }
                        >
                          <option value="mp4">{t.formatMp4}</option>
                          <option value="webm">{t.formatWebm}</option>
                          <option value="gif">{t.formatGif}</option>
                        </select>
                      </label>
                      <label className="block">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-2">
                          {t.duration}
                        </span>
                        <div className="flex items-center gap-3">
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            className="w-full bg-slate-800 border border-white/10 rounded-xl p-3 text-sm focus:ring-2 ring-indigo-500/50 outline-none"
                            value={renderConfig.duration}
                            onChange={(e) =>
                              setRenderConfig((prev) => ({
                                ...prev,
                                duration: Number(e.target.value),
                              }))
                            }
                          />
                        </div>
                        <p className="text-[10px] text-slate-500 mt-2">{t.durationHint}</p>
                      </label>
                      <label className="block">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-2">
                          {t.viewMode}
                        </span>
                        <div className="grid grid-cols-2 gap-3">
                          <button
                            type="button"
                            onClick={() =>
                              setRenderConfig((prev) => ({ ...prev, viewMode: 'fit' }))
                            }
                            className={`px-3 py-2 rounded-xl text-[11px] font-semibold border transition ${
                              renderConfig.viewMode === 'fit'
                                ? 'bg-indigo-600 border-indigo-500 text-white'
                                : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
                            }`}
                          >
                            {t.viewModeFit}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setRenderConfig((prev) => ({ ...prev, viewMode: 'current' }))
                            }
                            className={`px-3 py-2 rounded-xl text-[11px] font-semibold border transition ${
                              renderConfig.viewMode === 'current'
                                ? 'bg-indigo-600 border-indigo-500 text-white'
                                : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
                            }`}
                          >
                            {t.viewModeCurrent}
                          </button>
                        </div>
                      </label>
                      <label className="block">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-2">
                          {t.resolution}
                        </span>
                        <select
                          className="w-full bg-slate-800 border border-white/10 rounded-xl p-3 text-sm focus:ring-2 ring-indigo-500/50 outline-none"
                          value={resolutionValue}
                          onChange={(e) => {
                            if (e.target.value === 'custom') {
                              setResolutionMode('custom');
                              return;
                            }
                            setResolutionMode('preset');
                            const [w, h] = e.target.value.split('x').map(Number);
                            setRenderConfig((prev) => ({ ...prev, width: w, height: h }));
                            syncCropRectForConfig(w, h);
                          }}
                        >
                          {resolutionPresets.map((preset) => (
                            <option
                              key={`${preset.width}x${preset.height}`}
                              value={`${preset.width}x${preset.height}`}
                            >
                              {preset.label}
                            </option>
                          ))}
                          <option value="custom">{t.customResolution}</option>
                        </select>
                      </label>
                      <div className="space-y-2">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">
                          {t.aspectPresets}
                        </span>
                        <div className="grid grid-cols-3 gap-2">
                          {aspectPresets.map((preset) => (
                            <button
                              key={preset.label}
                              type="button"
                              onClick={() => applyAspectPreset(preset)}
                              className="px-2 py-2 rounded-lg text-[11px] font-semibold border border-white/10 text-slate-300 bg-white/5 hover:bg-white/10 transition"
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      {resolutionValue === 'custom' && (
                        <div className="grid grid-cols-2 gap-4">
                          <label className="block">
                            <span className="text-[9px] text-slate-500 uppercase mb-1 block">
                              {t.width}
                            </span>
                            <input
                              type="number"
                              min="16"
                              step="1"
                              className="w-full bg-slate-800 border border-white/10 rounded-xl p-3 text-sm focus:ring-2 ring-indigo-500/50 outline-none"
                              value={renderConfig.width}
                              onChange={(e) => {
                                const nextWidth = toDimension(e.target.value, renderConfig.width);
                                setRenderConfig((prev) => ({
                                  ...prev,
                                  width: nextWidth,
                                }));
                                syncCropRectForConfig(nextWidth, renderConfig.height);
                              }}
                            />
                          </label>
                          <label className="block">
                            <span className="text-[9px] text-slate-500 uppercase mb-1 block">
                              {t.height}
                            </span>
                            <input
                              type="number"
                              min="16"
                              step="1"
                              className="w-full bg-slate-800 border border-white/10 rounded-xl p-3 text-sm focus:ring-2 ring-indigo-500/50 outline-none"
                              value={renderConfig.height}
                              onChange={(e) => {
                                const nextHeight = toDimension(e.target.value, renderConfig.height);
                                setRenderConfig((prev) => ({
                                  ...prev,
                                  height: nextHeight,
                                }));
                                syncCropRectForConfig(renderConfig.width, nextHeight);
                              }}
                            />
                          </label>
                        </div>
                      )}
                      <label className="block">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-2">
                          {t.framerate}
                        </span>
                        <select
                          className="w-full bg-slate-800 border border-white/10 rounded-xl p-3 text-sm focus:ring-2 ring-indigo-500/50 outline-none"
                          value={renderConfig.fps}
                          onChange={(e) =>
                            setRenderConfig((prev) => ({ ...prev, fps: Number(e.target.value) }))
                          }
                        >
                          <option value="24">24 FPS ({t.cinematic})</option>
                          <option value="30">30 FPS ({t.standard})</option>
                          <option value="60">60 FPS ({t.smooth})</option>
                        </select>
                      </label>
                      {renderConfig.format === 'gif' ? (
                        <label className="block">
                          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-2">
                            {t.gifQuality}
                          </span>
                          <div className="flex items-center gap-3">
                            <input
                              type="range"
                              min="1"
                              max="30"
                              step="1"
                              className="flex-1 accent-indigo-500"
                              value={renderConfig.gifQuality}
                              onChange={(e) =>
                                setRenderConfig((p) => ({
                                  ...p,
                                  gifQuality: Number(e.target.value),
                                }))
                              }
                            />
                            <span className="text-xs font-mono text-indigo-400 w-12">
                              {renderConfig.gifQuality}
                            </span>
                          </div>
                          <p className="text-[10px] text-slate-500 mt-2">{t.gifQualityHint}</p>
                        </label>
                      ) : (
                        <label className="block">
                          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-2">
                            {t.quality}
                          </span>
                          <div className="flex items-center gap-3">
                            <input
                              type="range"
                              min="2000000"
                              max="80000000"
                              step="1000000"
                              className="flex-1 accent-indigo-500"
                              value={renderConfig.bitrate}
                              onChange={(e) =>
                                setRenderConfig((p) => ({ ...p, bitrate: Number(e.target.value) }))
                              }
                            />
                            <span className="text-xs font-mono text-indigo-400 w-12">
                              {renderConfig.bitrate / 1000000}
                            </span>
                          </div>
                        </label>
                      )}
                    </div>
                    {renderNotice && <p className="text-[10px] text-amber-400">{renderNotice}</p>}
                  </div>
                )}
              </>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-slate-600 gap-4 text-center">
                <Box className="w-12 h-12 opacity-10" />
                <p className="text-xs uppercase tracking-widest font-bold">{t.waitingInput}</p>
              </div>
            )}
          </div>

          {videoUrl && (
            <div className="p-6 border-t border-white/5 bg-black/20">
              <a
                href={videoUrl}
                download={`render.${videoFormat}`}
                className="flex items-center justify-center gap-3 w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-4 rounded-2xl transition shadow-xl shadow-indigo-600/30"
              >
                <Download className="w-5 h-5" />
                {t.exportVideo}
              </a>
            </div>
          )}
        </aside>

        {/* Viewport */}
        <section ref={handleViewportRef} className="flex-1 relative bg-black group overflow-hidden">
          <canvas ref={canvasRef} className="w-full h-full cursor-grab active:cursor-grabbing" />

          {!isRendering && metadata && (
            <div className="absolute inset-0 pointer-events-none">
              <div
                className="absolute border-2 border-indigo-400/80 rounded-lg shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
                style={{
                  left: `${cropRect.x * 100}%`,
                  top: `${cropRect.y * 100}%`,
                  width: `${cropRect.width * 100}%`,
                  height: `${cropRect.height * 100}%`,
                }}
              >
                {canAdjustCrop && (
                  <>
                    <div
                      className="absolute inset-x-0 top-0 h-4 cursor-move pointer-events-auto"
                      style={{ touchAction: 'none' }}
                      onPointerDown={handleCropPointerDown}
                      onPointerMove={handleCropPointerMove}
                      onPointerUp={handleCropPointerUp}
                      onPointerCancel={handleCropPointerUp}
                    />
                    <div
                      className="absolute inset-x-0 bottom-0 h-4 cursor-move pointer-events-auto"
                      style={{ touchAction: 'none' }}
                      onPointerDown={handleCropPointerDown}
                      onPointerMove={handleCropPointerMove}
                      onPointerUp={handleCropPointerUp}
                      onPointerCancel={handleCropPointerUp}
                    />
                    <div
                      className="absolute inset-y-0 left-0 w-4 cursor-move pointer-events-auto"
                      style={{ touchAction: 'none' }}
                      onPointerDown={handleCropPointerDown}
                      onPointerMove={handleCropPointerMove}
                      onPointerUp={handleCropPointerUp}
                      onPointerCancel={handleCropPointerUp}
                    />
                    <div
                      className="absolute inset-y-0 right-0 w-4 cursor-move pointer-events-auto"
                      style={{ touchAction: 'none' }}
                      onPointerDown={handleCropPointerDown}
                      onPointerMove={handleCropPointerMove}
                      onPointerUp={handleCropPointerUp}
                      onPointerCancel={handleCropPointerUp}
                    />
                  </>
                )}
              </div>
            </div>
          )}

          <div className="absolute top-6 left-6 pointer-events-none">
            <div className="bg-black/50 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/10 flex items-center gap-3">
              <div
                className={`w-2 h-2 rounded-full ${isRendering ? 'bg-red-500 animate-pulse' : 'bg-green-500'}`}
              />
              <span className="text-[10px] font-bold uppercase tracking-widest text-white/70">
                {isRendering ? t.statusRendering : t.statusReady}
              </span>
            </div>
          </div>

          <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-20">
            {isRendering ? (
              <div className="flex flex-col items-center gap-4">
                {frameProgress.total > 0 && (
                  <div className="w-64 space-y-2">
                    <div className="flex items-center justify-between text-[10px] uppercase tracking-widest font-bold text-slate-300">
                      <span>{t.frameProgress}</span>
                      <span>
                        {frameProgress.current}/{frameProgress.total}
                      </span>
                    </div>
                    <div className="h-2 bg-white/10 rounded-full overflow-hidden border border-white/5 backdrop-blur-sm">
                      <div
                        className="h-full bg-indigo-400 transition-all duration-300"
                        style={{ width: `${framePercent}%` }}
                      />
                    </div>
                  </div>
                )}
                <div className="w-64 space-y-2">
                  <div className="flex items-center justify-between text-[10px] uppercase tracking-widest font-bold text-slate-300">
                    <span>{t.rendering}</span>
                    <span>{progress}%</span>
                  </div>
                  <div className="h-2 bg-white/10 rounded-full overflow-hidden border border-white/5 backdrop-blur-sm">
                    <div
                      className="h-full bg-indigo-500 transition-all duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
                <button
                  onClick={cancelRendering}
                  className="flex items-center gap-3 bg-red-600 hover:bg-red-500 text-white px-8 py-4 rounded-full font-bold shadow-2xl transition transform hover:scale-105 active:scale-95"
                >
                  <Square className="w-4 h-4 fill-current" />
                  {t.cancelBtn} ({progress}%)
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <button
                  onClick={startRendering}
                  disabled={!metadata}
                  className="flex items-center gap-3 bg-white hover:bg-slate-200 disabled:bg-white/5 disabled:text-white/20 text-slate-950 px-10 py-5 rounded-full font-black uppercase tracking-widest transition transform hover:scale-105 active:scale-95 shadow-2xl shadow-white/5"
                >
                  <Play className="w-5 h-5 fill-current" />
                  {t.captureBtn}
                </button>
                <button
                  onClick={logViewParams}
                  className="text-[10px] uppercase tracking-widest font-bold text-slate-300 hover:text-white transition"
                >
                  打印视角参数
                </button>
              </div>
            )}
          </div>

          {!file && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/80 backdrop-blur-xl animate-in fade-in">
              <div className="max-w-md w-full text-center space-y-8 p-12">
                <div className="relative inline-block">
                  <div className="absolute inset-0 bg-indigo-500 blur-3xl opacity-20" />
                  <div className="relative bg-slate-900 w-24 h-24 rounded-3xl flex items-center justify-center mx-auto border border-white/10 shadow-2xl">
                    <Video className="w-12 h-12 text-indigo-500" />
                  </div>
                </div>
                <div>
                  <h2 className="text-3xl font-black mb-3">{t.dropTitle}</h2>
                  <p className="text-slate-400 text-sm leading-relaxed">{t.dropDesc}</p>
                </div>
                <label className="inline-flex items-center gap-3 bg-indigo-600 hover:bg-indigo-500 text-white px-10 py-5 rounded-2xl cursor-pointer font-black uppercase tracking-widest transition shadow-2xl shadow-indigo-600/40 transform hover:-translate-y-1">
                  <Upload className="w-5 h-5" />
                  {t.dropBtn}
                  <input
                    type="file"
                    accept=".fbx,.glb,.gltf"
                    className="hidden"
                    onChange={handleFileUpload}
                  />
                </label>
              </div>
            </div>
          )}
        </section>
      </main>

      <footer className="px-6 py-3 bg-slate-900 border-t border-white/5 flex items-center justify-between text-[10px] text-slate-500 uppercase tracking-widest font-black">
        <div className="flex gap-6">
          <span className="flex items-center gap-2">
            <div className="w-1 h-1 bg-indigo-500 rounded-full" /> {t.engine}: Three.js r182
          </span>
          <span className="flex items-center gap-2">
            <div className="w-1 h-1 bg-indigo-500 rounded-full" /> WebGPU-Ready
          </span>
          <span className="flex items-center gap-2">
            <div className="w-1 h-1 bg-indigo-500 rounded-full" /> {t.codec}: VP9
          </span>
        </div>
      </footer>
    </div>
  );
};

export default Converter;
