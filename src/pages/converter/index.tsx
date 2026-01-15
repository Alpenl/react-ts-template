import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import {
  Activity,
  Axis3d,
  Box,
  FileCode,
  FolderOpen,
  Languages,
  Layers,
  Loader2,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Sun,
  Upload,
} from 'lucide-react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

import { Locale, translations } from './locales';
import { ExampleItem, ModelMetadata, SceneConfig } from './types';

const OSS_BASE_URL = 'https://momax-test2.oss-cn-beijing.aliyuncs.com/examples';

const EXAMPLE_OSS_IDS = [1, 3, 4, 6, 7, 8];
const EXAMPLES: ExampleItem[] = EXAMPLE_OSS_IDS.map((ossId, index) => ({
  id: index + 1,
  label: index + 1,
  fbxUrl: `${OSS_BASE_URL}/${ossId}/示例${ossId}.fbx`,
  videoUrl: `${OSS_BASE_URL}/${ossId}/示例${ossId}.mp4`,
}));
const EXAMPLE_STEP_TARGETS: Record<number, number> = {
  1: 5,
  2: 6,
  3: 0,
  4: 4,
  5: 5.5,
  6: 4.5,
};

const motionBoneTokens = ['hips', 'hip', 'pelvis', 'root', 'center', 'master'];
const footBoneTokens = ['foot', 'toe', 'ankle', 'ball'];
const leftBoneTokens = ['left', 'l_', 'l-', '_l', '.l', 'l.'];
const rightBoneTokens = ['right', 'r_', 'r-', '_r', '.r', 'r.'];
const initialMotionStats = {
  speed: 0,
  stepCount: 0,
  leftFootHeight: null as number | null,
  rightFootHeight: null as number | null,
  axisDelta: { x: 0, y: 0, z: 0 },
  frameIndex: 0,
  elapsed: 0,
};
const animationStep = 1 / 30;
const cmToMeter = 0.01;
const footContactThresholdRatio = 0.15; // 15% from min height is considered ground contact
const minFootLiftRange = 5; // cm, ignore micro jitter
const footLiftThresholdRatio = 0.1; // 10% above min height to mark a lift
const footContactSlack = 0.5; // cm, tolerate small height jitter around ground
const minStepInterval = 0.2; // s, suppress duplicate counts for a single contact
const loopTimeEpsilon = 1e-4; // s, avoid false loop detection due to float jitter
const chartWindow = 80;
const chartWidth = 260;
const chartHeight = 72;

const collectBones = (root: THREE.Object3D) => {
  const bones: THREE.Bone[] = [];
  root.traverse((child) => {
    if ((child as THREE.Bone).isBone) bones.push(child as THREE.Bone);
  });
  return bones;
};

const pickMotionBone = (bones: THREE.Bone[]) => {
  if (bones.length === 0) return null;
  const match = bones.find((bone) => {
    const name = bone.name.toLowerCase();
    return motionBoneTokens.some((token) => name.includes(token));
  });
  return match ?? bones[0];
};

const pickFootBones = (bones: THREE.Bone[]) => {
  if (bones.length === 0) return [];
  const matches = bones.filter((bone) => {
    const name = bone.name.toLowerCase();
    return footBoneTokens.some((token) => name.includes(token));
  });
  return matches.length > 0 ? matches : bones;
};

const splitFootBones = (bones: THREE.Bone[]) => {
  const left: THREE.Bone[] = [];
  const right: THREE.Bone[] = [];
  for (const bone of bones) {
    const name = bone.name.toLowerCase();
    if (leftBoneTokens.some((token) => name.includes(token))) {
      left.push(bone);
    } else if (rightBoneTokens.some((token) => name.includes(token))) {
      right.push(bone);
    }
  }
  return { left, right };
};

const splitFootBonesByAxis = (root: THREE.Object3D, bones: THREE.Bone[]) => {
  const left: THREE.Bone[] = [];
  const right: THREE.Bone[] = [];
  const worldPos = new THREE.Vector3();

  root.updateMatrixWorld(true);
  for (const bone of bones) {
    bone.getWorldPosition(worldPos);
    if (worldPos.x <= 0) {
      left.push(bone);
    } else {
      right.push(bone);
    }
  }

  return { left, right };
};

const resolveFootSides = (root: THREE.Object3D, footBones: THREE.Bone[]) => {
  const named = splitFootBones(footBones);
  if (named.left.length > 0 && named.right.length > 0) return named;
  if (footBones.length === 0) return named;
  return splitFootBonesByAxis(root, footBones);
};

// Pre-analyze animation to calculate dynamic foot thresholds
const analyzeFootThresholds = (
  root: THREE.Object3D,
  mixer: THREE.AnimationMixer,
  action: THREE.AnimationAction,
  footBones: THREE.Bone[],
  leftFootBones: THREE.Bone[],
  rightFootBones: THREE.Bone[],
) => {
  const clip = action.getClip();
  const duration = clip.duration;
  const sampleRate = 30;
  const totalSamples = Math.ceil(duration * sampleRate);

  const leftYValues: number[] = [];
  const rightYValues: number[] = [];
  const worldPos = new THREE.Vector3();
  const allFootBones = footBones.length > 0 ? footBones : [...leftFootBones, ...rightFootBones];

  if (allFootBones.length === 0) {
    return {
      leftThreshold: 0,
      rightThreshold: 0,
      leftRange: 0,
      rightRange: 0,
    };
  }

  // Sample the animation
  for (let i = 0; i <= totalSamples; i++) {
    const time = i / sampleRate;
    mixer.setTime(time);
    root.updateMatrixWorld(true);

    let groundY = Infinity;
    for (const bone of allFootBones) {
      bone.getWorldPosition(worldPos);
      groundY = Math.min(groundY, worldPos.y);
    }
    if (!Number.isFinite(groundY)) groundY = 0;

    // Get left foot Y
    if (leftFootBones.length > 0) {
      let minY = Infinity;
      for (const bone of leftFootBones) {
        bone.getWorldPosition(worldPos);
        minY = Math.min(minY, worldPos.y);
      }
      if (Number.isFinite(minY)) leftYValues.push(minY - groundY);
    }

    // Get right foot Y
    if (rightFootBones.length > 0) {
      let minY = Infinity;
      for (const bone of rightFootBones) {
        bone.getWorldPosition(worldPos);
        minY = Math.min(minY, worldPos.y);
      }
      if (Number.isFinite(minY)) rightYValues.push(minY - groundY);
    }
  }

  // Reset mixer to start
  mixer.setTime(0);

  // Calculate thresholds (15% from min height)
  const calcThreshold = (values: number[]) => {
    if (values.length === 0) return { threshold: 0, range: 0 };
    const minY = Math.min(...values);
    const maxY = Math.max(...values);
    const range = maxY - minY;
    if (!Number.isFinite(range) || range < minFootLiftRange) {
      return { threshold: minY, range: 0 };
    }
    return { threshold: minY + range * footContactThresholdRatio, range };
  };

  const leftStats = calcThreshold(leftYValues);
  const rightStats = calcThreshold(rightYValues);

  return {
    leftThreshold: leftStats.threshold,
    rightThreshold: rightStats.threshold,
    leftRange: leftStats.range,
    rightRange: rightStats.range,
  };
};

const calcLiftThreshold = (threshold: number, range: number) => {
  if (!Number.isFinite(range) || range <= 0) return threshold;
  const min = threshold - range * footContactThresholdRatio;
  return min + range * footLiftThresholdRatio;
};

const estimateStepCount = (
  root: THREE.Object3D,
  mixer: THREE.AnimationMixer,
  action: THREE.AnimationAction,
  footBones: THREE.Bone[],
  leftFootBones: THREE.Bone[],
  rightFootBones: THREE.Bone[],
  thresholds: {
    leftThreshold: number;
    rightThreshold: number;
    leftRange: number;
    rightRange: number;
  },
) => {
  const clip = action.getClip();
  const duration = clip.duration;
  const sampleRate = 30;
  const totalSamples = Math.ceil(duration * sampleRate);
  const allFootBones = footBones.length > 0 ? footBones : [...leftFootBones, ...rightFootBones];
  if (allFootBones.length === 0) return 0;

  const worldPos = new THREE.Vector3();
  const leftLiftThreshold = calcLiftThreshold(thresholds.leftThreshold, thresholds.leftRange);
  const rightLiftThreshold = calcLiftThreshold(thresholds.rightThreshold, thresholds.rightRange);
  let rawSteps = 0;
  let leftWasAbove = false;
  let rightWasAbove = false;
  let lastLeftStepTime = -Infinity;
  let lastRightStepTime = -Infinity;

  for (let i = 0; i <= totalSamples; i += 1) {
    const time = i / sampleRate;
    mixer.setTime(time);
    root.updateMatrixWorld(true);

    let groundY = Infinity;
    let leftMin = Infinity;
    let rightMin = Infinity;

    for (const bone of allFootBones) {
      bone.getWorldPosition(worldPos);
      groundY = Math.min(groundY, worldPos.y);
    }
    if (!Number.isFinite(groundY)) groundY = 0;

    if (leftFootBones.length > 0) {
      for (const bone of leftFootBones) {
        bone.getWorldPosition(worldPos);
        leftMin = Math.min(leftMin, worldPos.y);
      }
    }
    if (rightFootBones.length > 0) {
      for (const bone of rightFootBones) {
        bone.getWorldPosition(worldPos);
        rightMin = Math.min(rightMin, worldPos.y);
      }
    }

    const leftRelativeHeight = Number.isFinite(leftMin) ? leftMin - groundY : null;
    const rightRelativeHeight = Number.isFinite(rightMin) ? rightMin - groundY : null;
    const leftAbove =
      thresholds.leftRange >= minFootLiftRange &&
      leftRelativeHeight !== null &&
      leftRelativeHeight >= leftLiftThreshold;
    const rightAbove =
      thresholds.rightRange >= minFootLiftRange &&
      rightRelativeHeight !== null &&
      rightRelativeHeight >= rightLiftThreshold;

    if (!leftWasAbove && leftAbove && time - lastLeftStepTime >= minStepInterval) {
      rawSteps += 0.5;
      lastLeftStepTime = time;
    }
    if (!rightWasAbove && rightAbove && time - lastRightStepTime >= minStepInterval) {
      rawSteps += 0.5;
      lastRightStepTime = time;
    }

    leftWasAbove = leftAbove;
    rightWasAbove = rightAbove;
  }

  mixer.setTime(0);
  return rawSteps;
};

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

const buildSparklinePath = (values: number[], width: number, height: number) => {
  if (values.length === 0) {
    return { line: '', area: '', last: null as { x: number; y: number } | null };
  }
  const safeValues = values.map((value) => (Number.isFinite(value) ? value : 0));
  const min = Math.min(...safeValues);
  const max = Math.max(...safeValues);
  const range = max - min;
  const pad = 6;
  const innerWidth = Math.max(width - pad * 2, 1);
  const innerHeight = Math.max(height - pad * 2, 1);
  const step = safeValues.length > 1 ? innerWidth / (safeValues.length - 1) : 0;
  const points = safeValues.map((value, index) => {
    const ratio = range === 0 ? 0.5 : (value - min) / range;
    const x = pad + index * step;
    const y = pad + (1 - ratio) * innerHeight;
    return { x, y };
  });
  const line = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(' ');
  const baselineY = pad + innerHeight;
  const area = `${line} L ${points[points.length - 1].x.toFixed(2)},${baselineY.toFixed(
    2,
  )} L ${points[0].x.toFixed(2)},${baselineY.toFixed(2)} Z`;
  return { line, area, last: points[points.length - 1] };
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
  const [lang, setLang] = useState<Locale>('en');
  const t = translations[lang];

  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [metadata, setMetadata] = useState<ModelMetadata | null>(null);
  const [motionStats, dispatchMotionStats] = useReducer(
    (_: typeof initialMotionStats, next: typeof initialMotionStats) => next,
    initialMotionStats,
  );
  const [activeTab, setActiveTab] = useState<'info' | 'settings'>('info');
  const [isPaused, setIsPaused] = useState(false);
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  const [currentVideoUrl, setCurrentVideoUrl] = useState<string | null>(null);
  const [selectedExampleId, setSelectedExampleId] = useState<number | null>(null);
  const [chartSeries, dispatchChartSeries] = useReducer(
    (
      state: { speed: number[]; stepRate: number[] },
      updater: (prev: { speed: number[]; stepRate: number[] }) => {
        speed: number[];
        stepRate: number[];
      },
    ) => updater(state),
    {
      speed: [],
      stepRate: [],
    },
  );

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
    fov: 45,
  });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sceneParamsRef = useRef(sceneParams);
  const isPausedRef = useRef(isPaused);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const animationTickRef = useRef({ accumulator: 0 });
  const animationActionRef = useRef<THREE.AnimationAction | null>(null);
  const actionTimeRef = useRef(0);
  const chartMetaRef = useRef({ lastStepCount: 0, lastSampleTime: 0, lastSampleIndex: -1 });
  const metricsTargetsRef = useRef<{
    motionBone: THREE.Object3D | null;
    footBones: THREE.Bone[];
    leftFootBones: THREE.Bone[];
    rightFootBones: THREE.Bone[];
    leftFootThreshold: number;
    rightFootThreshold: number;
    leftFootRange: number;
    rightFootRange: number;
    stepScale: number;
  }>({
    motionBone: null,
    footBones: [],
    leftFootBones: [],
    rightFootBones: [],
    leftFootThreshold: 1,
    rightFootThreshold: 1,
    leftFootRange: 0,
    rightFootRange: 0,
    stepScale: 1,
  });
  const metricsRef = useRef<{
    hasPrev: boolean;
    speed: number;
    leftFootHeight: number | null;
    rightFootHeight: number | null;
    axisVelocity: THREE.Vector3;
    rawStepCount: number;
    stepCount: number;
    leftFootContact: boolean | null;
    rightFootContact: boolean | null;
    leftFootLifted: boolean;
    rightFootLifted: boolean;
    lastLeftStepTime: number;
    lastRightStepTime: number;
    lastPos: THREE.Vector3;
    tempPos: THREE.Vector3;
    tempFootPos: THREE.Vector3;
    lastUiUpdate: number;
    frameIndex: number;
    elapsed: number;
    lastLoopIndex: number;
    lastLoopTime: number;
  }>({
    hasPrev: false,
    speed: 0,
    leftFootHeight: null,
    rightFootHeight: null,
    axisVelocity: new THREE.Vector3(),
    rawStepCount: 0,
    stepCount: 0,
    leftFootContact: null,
    rightFootContact: null,
    leftFootLifted: false,
    rightFootLifted: false,
    lastLeftStepTime: -Infinity,
    lastRightStepTime: -Infinity,
    lastPos: new THREE.Vector3(),
    tempPos: new THREE.Vector3(),
    tempFootPos: new THREE.Vector3(),
    lastUiUpdate: 0,
    frameIndex: 0,
    elapsed: 0,
    lastLoopIndex: 0,
    lastLoopTime: 0,
  });
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
  const viewportSizeRef = useRef({ width: 1, height: 1 });

  const togglePause = useCallback(() => {
    setIsPaused((prev) => !prev);
  }, []);

  const handleViewportResize = useCallback(() => {
    if (!canvasRef.current || !sceneRef.current) return;
    const parent = canvasRef.current.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    const { camera, renderer } = sceneRef.current;
    const view = viewportSizeRef.current;
    if (view.width !== width || view.height !== height) {
      viewportSizeRef.current = { width, height };
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    }
  }, []);

  const handleViewportRef = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    viewportSizeRef.current = { width: rect.width, height: rect.height };
    if (!sceneRef.current) return;
    const { camera, renderer } = sceneRef.current;
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
    renderer.setSize(rect.width, rect.height);
  }, []);

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

  useEffect(() => {
    isPausedRef.current = isPaused;
    // Sync video play/pause state
    const video = videoRef.current;
    if (video) {
      if (isPaused) {
        video.pause();
      } else {
        video.play().catch(() => {});
      }
    }
  }, [isPaused]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      togglePause();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [togglePause]);

  useEffect(() => {
    if (!canvasRef.current || !sceneRef.current) return;
    const frame = requestAnimationFrame(() => {
      handleViewportResize();
    });
    return () => cancelAnimationFrame(frame);
  }, [handleViewportResize, isSidebarVisible]);

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

    const resetLoopState = (loopIndex: number, loopTime: number) => {
      const metrics = metricsRef.current;
      metrics.stepCount = 0;
      metrics.rawStepCount = 0;
      metrics.frameIndex = 0;
      metrics.elapsed = 0;
      metrics.hasPrev = false;
      metrics.speed = 0;
      metrics.axisVelocity.set(0, 0, 0);
      metrics.leftFootHeight = null;
      metrics.rightFootHeight = null;
      metrics.leftFootContact = null;
      metrics.rightFootContact = null;
      metrics.leftFootLifted = false;
      metrics.rightFootLifted = false;
      metrics.lastLeftStepTime = -Infinity;
      metrics.lastRightStepTime = -Infinity;
      metrics.lastUiUpdate = 0;
      metrics.lastLoopIndex = loopIndex;
      metrics.lastLoopTime = loopTime;
      chartMetaRef.current = { lastStepCount: 0, lastSampleTime: 0, lastSampleIndex: -1 };
      dispatchChartSeries(() => ({ speed: [], stepRate: [] }));
    };

    const animate = () => {
      requestAnimationFrame(animate);
      const delta = clock.getDelta();
      let advanced = 0;
      let steps = 0;
      let loopedThisFrame = false;
      const mixer = sceneRef.current?.mixer;
      if (mixer) {
        if (!isPausedRef.current) {
          const tick = animationTickRef.current;
          tick.accumulator += delta;
          while (tick.accumulator >= animationStep) {
            mixer.update(animationStep);
            tick.accumulator -= animationStep;
            advanced += animationStep;
            steps += 1;
          }
        } else {
          animationTickRef.current.accumulator = 0;
        }
      }
      if (steps > 0) {
        metricsRef.current.frameIndex += steps;
        metricsRef.current.elapsed += steps * animationStep;
      }
      const action = animationActionRef.current;
      if (steps > 0 && action) {
        const prevTime = actionTimeRef.current;
        const currentTime = action.time;
        const clipDuration = action.getClip().duration;
        const loopIndex = clipDuration > 0 ? Math.floor(currentTime / clipDuration) : 0;
        const loopTime =
          clipDuration > 0 ? metricsRef.current.elapsed % clipDuration : metricsRef.current.elapsed;
        // Sync video with animation
        const video = videoRef.current;
        if (video && video.duration && Number.isFinite(video.duration)) {
          const animDuration = clipDuration;
          if (animDuration > 0) {
            const normalizedTime = loopTime / animDuration;
            const targetVideoTime = normalizedTime * video.duration;
            // Only seek if difference is significant (> 0.1s) to avoid constant seeking
            if (Math.abs(video.currentTime - targetVideoTime) > 0.1) {
              video.currentTime = targetVideoTime;
            }
          }
        }
        const loopedByTime =
          clipDuration > 0 && loopTime + loopTimeEpsilon < metricsRef.current.lastLoopTime;
        const didLoop =
          currentTime + loopTimeEpsilon < prevTime ||
          loopIndex !== metricsRef.current.lastLoopIndex ||
          loopedByTime;
        if (didLoop) {
          resetLoopState(loopIndex, loopTime);
          loopedThisFrame = true;
        } else {
          metricsRef.current.lastLoopIndex = loopIndex;
          metricsRef.current.lastLoopTime = loopTime;
        }
        actionTimeRef.current = currentTime;
      }
      if (sceneRef.current?.controls) sceneRef.current.controls.update();
      if (sceneRef.current?.skeletonHelper) {
        sceneRef.current.skeletonHelper.updateMatrixWorld(true);
      }
      if (sceneRef.current?.rigHelper) {
        updateRigHelper(sceneRef.current.rigHelper);
      }

      const model = sceneRef.current?.model;
      if (model && !isPausedRef.current) {
        const metrics = metricsRef.current;
        const shouldSample = advanced > 0 || !metrics.hasPrev;
        if (shouldSample) {
          const motionTarget = metricsTargetsRef.current.motionBone ?? model;
          motionTarget.getWorldPosition(metrics.tempPos);
          if (metrics.hasPrev && advanced > 0) {
            const deltaX = metrics.tempPos.x - metrics.lastPos.x;
            const deltaY = metrics.tempPos.y - metrics.lastPos.y;
            const deltaZ = metrics.tempPos.z - metrics.lastPos.z;
            metrics.axisVelocity.set(deltaX / advanced, deltaY / advanced, deltaZ / advanced);
            metrics.speed = metrics.axisVelocity.length();
          } else if (!metrics.hasPrev) {
            metrics.speed = 0;
            metrics.axisVelocity.set(0, 0, 0);
          }
          metrics.lastPos.copy(metrics.tempPos);
          metrics.hasPrev = true;

          const targets = metricsTargetsRef.current;
          const { footBones, leftFootBones, rightFootBones } = targets;
          let leftFootHeight: number | null = null;
          let rightFootHeight: number | null = null;
          let groundY: number | null = null;

          if (footBones.length > 0) {
            let leftMin = Infinity;
            let rightMin = Infinity;
            let minY = Infinity;
            const useAxisSplit = leftFootBones.length === 0 || rightFootBones.length === 0;

            if (useAxisSplit) {
              for (const bone of footBones) {
                bone.getWorldPosition(metrics.tempFootPos);
                minY = Math.min(minY, metrics.tempFootPos.y);
                if (metrics.tempFootPos.x <= 0) {
                  leftMin = Math.min(leftMin, metrics.tempFootPos.y);
                } else {
                  rightMin = Math.min(rightMin, metrics.tempFootPos.y);
                }
              }
            } else {
              for (const bone of leftFootBones) {
                bone.getWorldPosition(metrics.tempFootPos);
                minY = Math.min(minY, metrics.tempFootPos.y);
                leftMin = Math.min(leftMin, metrics.tempFootPos.y);
              }
              for (const bone of rightFootBones) {
                bone.getWorldPosition(metrics.tempFootPos);
                minY = Math.min(minY, metrics.tempFootPos.y);
                rightMin = Math.min(rightMin, metrics.tempFootPos.y);
              }
            }

            if (Number.isFinite(minY)) groundY = minY;
            if (Number.isFinite(leftMin)) leftFootHeight = leftMin;
            if (Number.isFinite(rightMin)) rightFootHeight = rightMin;
          }

          metrics.leftFootHeight = leftFootHeight;
          metrics.rightFootHeight = rightFootHeight;

          const leftRelativeHeight =
            leftFootHeight !== null && groundY !== null ? leftFootHeight - groundY : null;
          const rightRelativeHeight =
            rightFootHeight !== null && groundY !== null ? rightFootHeight - groundY : null;

          const action = animationActionRef.current;
          const clipDuration = action?.getClip().duration ?? 0;
          const timeInLoop = clipDuration > 0 ? metrics.elapsed % clipDuration : metrics.elapsed;
          if (!loopedThisFrame && clipDuration > 0) {
            if (timeInLoop + loopTimeEpsilon < metrics.lastLoopTime) {
              resetLoopState(metrics.lastLoopIndex, timeInLoop);
            } else {
              metrics.lastLoopTime = timeInLoop;
            }
          }
          let stepDelta = 0;
          const leftLiftThreshold = calcLiftThreshold(
            targets.leftFootThreshold,
            targets.leftFootRange,
          );
          const rightLiftThreshold = calcLiftThreshold(
            targets.rightFootThreshold,
            targets.rightFootRange,
          );
          const leftReady =
            targets.leftFootRange >= minFootLiftRange &&
            leftRelativeHeight !== null &&
            leftRelativeHeight >= leftLiftThreshold;
          const rightReady =
            targets.rightFootRange >= minFootLiftRange &&
            rightRelativeHeight !== null &&
            rightRelativeHeight >= rightLiftThreshold;

          if (
            !metrics.leftFootLifted &&
            leftReady &&
            timeInLoop - metrics.lastLeftStepTime >= minStepInterval
          ) {
            stepDelta += 0.5;
            metrics.lastLeftStepTime = timeInLoop;
          }
          if (
            !metrics.rightFootLifted &&
            rightReady &&
            timeInLoop - metrics.lastRightStepTime >= minStepInterval
          ) {
            stepDelta += 0.5;
            metrics.lastRightStepTime = timeInLoop;
          }

          metrics.leftFootLifted = leftReady;
          metrics.rightFootLifted = rightReady;
          metrics.leftFootContact =
            leftRelativeHeight === null
              ? null
              : leftRelativeHeight <= targets.leftFootThreshold + footContactSlack;
          metrics.rightFootContact =
            rightRelativeHeight === null
              ? null
              : rightRelativeHeight <= targets.rightFootThreshold + footContactSlack;

          if (stepDelta > 0) {
            metrics.rawStepCount += stepDelta;
            const stepScale = Number.isFinite(targets.stepScale) ? targets.stepScale : 1;
            metrics.stepCount = Math.round(metrics.rawStepCount * stepScale * 2) / 2;
          }

          const normalized =
            clipDuration > 0 ? Math.min(Math.max(timeInLoop / clipDuration, 0), 1) : 0;
          const sampleIndex = Math.min(chartWindow - 1, Math.floor(normalized * chartWindow));
          const chartMeta = chartMetaRef.current;

          if (sampleIndex !== chartMeta.lastSampleIndex) {
            const deltaSeconds = timeInLoop - chartMeta.lastSampleTime;
            if (deltaSeconds > 0) {
              const stepDelta = metrics.stepCount - chartMeta.lastStepCount;
              const stepRate = stepDelta / deltaSeconds;
              const speedValue = Number.isFinite(metrics.speed) ? metrics.speed * cmToMeter : 0;
              dispatchChartSeries((prevSeries) => {
                const nextSpeed = [...prevSeries.speed, speedValue];
                const nextStepRate = [...prevSeries.stepRate, stepRate];
                if (nextSpeed.length > chartWindow) {
                  nextSpeed.splice(0, nextSpeed.length - chartWindow);
                }
                if (nextStepRate.length > chartWindow) {
                  nextStepRate.splice(0, nextStepRate.length - chartWindow);
                }
                return { speed: nextSpeed, stepRate: nextStepRate };
              });
              chartMetaRef.current = {
                lastStepCount: metrics.stepCount,
                lastSampleTime: timeInLoop,
                lastSampleIndex: sampleIndex,
              };
            } else {
              chartMetaRef.current = {
                lastStepCount: metrics.stepCount,
                lastSampleTime: timeInLoop,
                lastSampleIndex: sampleIndex,
              };
            }
          }

          const now = performance.now();
          if (now - metrics.lastUiUpdate > 150) {
            dispatchMotionStats({
              speed: metrics.speed,
              stepCount: metrics.stepCount,
              leftFootHeight,
              rightFootHeight,
              axisDelta: {
                x: metrics.axisVelocity.x,
                y: metrics.axisVelocity.y,
                z: metrics.axisVelocity.z,
              },
              frameIndex: metrics.frameIndex,
              elapsed: metrics.elapsed,
            });
            metrics.lastUiUpdate = now;
          }
        }
      }
      renderer.render(scene, camera);
    };
    animate();

    const parent = canvasRef.current?.parentElement;
    if (parent) {
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
    setSelectedExampleId(null);
    setCurrentVideoUrl(null);
    dispatchMotionStats(initialMotionStats);
    setIsPaused(false);
    dispatchChartSeries(() => ({ speed: [], stepRate: [] }));
    chartMetaRef.current = { lastStepCount: 0, lastSampleTime: 0, lastSampleIndex: -1 };
    metricsRef.current = {
      ...metricsRef.current,
      hasPrev: false,
      speed: 0,
      leftFootHeight: null,
      rightFootHeight: null,
      axisVelocity: new THREE.Vector3(),
      rawStepCount: 0,
      stepCount: 0,
      leftFootContact: null,
      rightFootContact: null,
      leftFootLifted: false,
      rightFootLifted: false,
      lastLeftStepTime: -Infinity,
      lastRightStepTime: -Infinity,
      lastUiUpdate: 0,
      frameIndex: 0,
      elapsed: 0,
      lastLoopIndex: 0,
      lastLoopTime: 0,
    };
    metricsTargetsRef.current = {
      motionBone: null,
      footBones: [],
      leftFootBones: [],
      rightFootBones: [],
      leftFootThreshold: 1,
      rightFootThreshold: 1,
      leftFootRange: 0,
      rightFootRange: 0,
      stepScale: 1,
    };
    animationTickRef.current.accumulator = 0;

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
        let action: THREE.AnimationAction | null = null;
        if (animations.length > 0) {
          mixer = new THREE.AnimationMixer(root);
          action = mixer.clipAction(animations[0]);
          action.play();
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
        animationActionRef.current = action;
        actionTimeRef.current = 0;
        const bones = collectBones(root);
        const footBones = pickFootBones(bones);
        const { left: leftFootBones, right: rightFootBones } = resolveFootSides(root, footBones);

        // Calculate dynamic foot thresholds by pre-analyzing animation
        let leftFootThreshold = 1;
        let rightFootThreshold = 1;
        let leftFootRange = 0;
        let rightFootRange = 0;
        if (mixer && action && footBones.length > 0) {
          const thresholds = analyzeFootThresholds(
            root,
            mixer,
            action,
            footBones,
            leftFootBones,
            rightFootBones,
          );
          leftFootThreshold = thresholds.leftThreshold;
          rightFootThreshold = thresholds.rightThreshold;
          leftFootRange = thresholds.leftRange;
          rightFootRange = thresholds.rightRange;
        }

        metricsTargetsRef.current = {
          motionBone: pickMotionBone(bones),
          footBones,
          leftFootBones,
          rightFootBones,
          leftFootThreshold,
          rightFootThreshold,
          leftFootRange,
          rightFootRange,
          stepScale: 1,
        };
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

  const loadExample = async (example: ExampleItem) => {
    if (!sceneRef.current) return;

    setLoading(true);
    setSelectedExampleId(example.id);
    setCurrentVideoUrl(example.videoUrl);
    dispatchMotionStats(initialMotionStats);
    setIsPaused(false);
    dispatchChartSeries(() => ({ speed: [], stepRate: [] }));
    chartMetaRef.current = { lastStepCount: 0, lastSampleTime: 0, lastSampleIndex: -1 };
    metricsRef.current = {
      ...metricsRef.current,
      hasPrev: false,
      speed: 0,
      leftFootHeight: null,
      rightFootHeight: null,
      axisVelocity: new THREE.Vector3(),
      rawStepCount: 0,
      stepCount: 0,
      leftFootContact: null,
      rightFootContact: null,
      leftFootLifted: false,
      rightFootLifted: false,
      lastLeftStepTime: -Infinity,
      lastRightStepTime: -Infinity,
      lastUiUpdate: 0,
      frameIndex: 0,
      elapsed: 0,
      lastLoopIndex: 0,
      lastLoopTime: 0,
    };
    metricsTargetsRef.current = {
      motionBone: null,
      footBones: [],
      leftFootBones: [],
      rightFootBones: [],
      leftFootThreshold: 1,
      rightFootThreshold: 1,
      leftFootRange: 0,
      rightFootRange: 0,
      stepScale: 1,
    };
    animationTickRef.current.accumulator = 0;

    try {
      const response = await fetch(example.fbxUrl);
      const arrayBuffer = await response.arrayBuffer();

      const loader = new FBXLoader();
      const object = loader.parse(arrayBuffer, '');
      const animations = object.animations;

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
      let action: THREE.AnimationAction | null = null;
      if (animations.length > 0) {
        mixer = new THREE.AnimationMixer(root);
        action = mixer.clipAction(animations[0]);
        action.play();
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
      animationActionRef.current = action;
      actionTimeRef.current = 0;
      const bones = collectBones(root);
      const footBones = pickFootBones(bones);
      const { left: leftFootBones, right: rightFootBones } = resolveFootSides(root, footBones);

      // Calculate dynamic foot thresholds by pre-analyzing animation
      let leftFootThreshold = 1;
      let rightFootThreshold = 1;
      let leftFootRange = 0;
      let rightFootRange = 0;
      let stepScale = 1;
      if (mixer && action && footBones.length > 0) {
        const thresholds = analyzeFootThresholds(
          root,
          mixer,
          action,
          footBones,
          leftFootBones,
          rightFootBones,
        );
        leftFootThreshold = thresholds.leftThreshold;
        rightFootThreshold = thresholds.rightThreshold;
        leftFootRange = thresholds.leftRange;
        rightFootRange = thresholds.rightRange;

        const expectedSteps = EXAMPLE_STEP_TARGETS[example.label];
        if (expectedSteps !== undefined) {
          const rawSteps = estimateStepCount(
            root,
            mixer,
            action,
            footBones,
            leftFootBones,
            rightFootBones,
            thresholds,
          );
          if (rawSteps > 0) {
            stepScale = expectedSteps / rawSteps;
          } else if (expectedSteps === 0) {
            stepScale = 0;
          }
        }
      }

      metricsTargetsRef.current = {
        motionBone: pickMotionBone(bones),
        footBones,
        leftFootBones,
        rightFootBones,
        leftFootThreshold,
        rightFootThreshold,
        leftFootRange,
        rightFootRange,
        stepScale,
      };
      if (!hasMesh) {
        frameCameraToObject(sceneRef.current!.camera, sceneRef.current!.controls, root);
      } else {
        applyViewForModel(sceneRef.current!.camera, sceneRef.current!.controls, root);
      }

      const meta: ModelMetadata = {
        name: `${t.example}${example.label}.fbx`,
        boneCount: 0,
        animations: animations.map((a) => ({ name: a.name, duration: a.duration })),
      };
      object.traverse((child) => {
        if ((child as THREE.Bone).isBone) meta.boneCount++;
      });

      setMetadata(meta);
      setFile(new File([], `${t.example}${example.label}.fbx`));
      setActiveTab('info');
    } catch (err) {
      console.error('Error loading example:', err);
    } finally {
      setLoading(false);
    }
  };

  const speedText = Number.isFinite(motionStats.speed)
    ? `${(motionStats.speed * cmToMeter).toFixed(2)} ${t.unitSpeed}`
    : t.noData;
  const leftFootHeightText =
    motionStats.leftFootHeight === null
      ? t.noData
      : `${(motionStats.leftFootHeight * cmToMeter).toFixed(2)} ${t.unitDistance}`;
  const rightFootHeightText =
    motionStats.rightFootHeight === null
      ? t.noData
      : `${(motionStats.rightFootHeight * cmToMeter).toFixed(2)} ${t.unitDistance}`;
  const axisDeltaValues = [
    motionStats.axisDelta.x,
    motionStats.axisDelta.y,
    motionStats.axisDelta.z,
  ];
  const axisDeltaText = axisDeltaValues.every((value) => Number.isFinite(value))
    ? `X:${(motionStats.axisDelta.x * cmToMeter).toFixed(2)} Y:${(
        motionStats.axisDelta.y * cmToMeter
      ).toFixed(2)} Z:${(motionStats.axisDelta.z * cmToMeter).toFixed(2)} ${t.unitSpeed}`
    : t.noData;
  const stepCountText = Number.isFinite(motionStats.stepCount)
    ? `${motionStats.stepCount}`
    : t.noData;
  const frameText = Number.isFinite(motionStats.frameIndex)
    ? `#${motionStats.frameIndex}`
    : t.noData;
  const elapsedText = Number.isFinite(motionStats.elapsed)
    ? `${motionStats.elapsed.toFixed(2)} ${t.unitTime}`
    : t.noData;
  const stepRateValue =
    chartSeries.stepRate.length > 0 ? chartSeries.stepRate[chartSeries.stepRate.length - 1] : NaN;
  const stepRateText = Number.isFinite(stepRateValue)
    ? `${stepRateValue.toFixed(2)} ${t.unitRate}`
    : t.noData;
  const speedSpark = buildSparklinePath(chartSeries.speed, chartWidth, chartHeight);
  const stepSpark = buildSparklinePath(chartSeries.stepRate, chartWidth, chartHeight);
  const pauseText = isPaused ? t.resume : t.pause;
  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100 selection:bg-indigo-500/30 font-sans">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 bg-slate-900 border-b border-white/5 shadow-2xl z-10">
        <div className="flex items-center gap-4">
          <div className="bg-indigo-600 p-2.5 rounded-xl shadow-lg shadow-indigo-600/20">
            <Box className="w-6 h-6 text-white" />
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
            onClick={() => setIsSidebarVisible((prev) => !prev)}
            className="flex items-center gap-2 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white px-3 py-2 rounded-xl transition border border-white/10"
          >
            {isSidebarVisible ? (
              <PanelLeftClose className="w-4 h-4" />
            ) : (
              <PanelLeftOpen className="w-4 h-4" />
            )}
            <span className="text-xs font-bold uppercase tracking-widest">
              {isSidebarVisible ? t.hidePanel : t.showPanel}
            </span>
          </button>
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
            <input type="file" accept=".fbx" className="hidden" onChange={handleFileUpload} />
          </label>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        {isSidebarVisible && (
          <aside className="w-96 bg-slate-900 border-r border-white/5 flex flex-col shadow-2xl relative z-10">
            {/* Examples Section */}
            <div className="p-4 border-b border-white/5">
              <div className="flex items-center gap-2 mb-3 text-indigo-400">
                <FolderOpen className="w-4 h-4" />
                <span className="text-xs font-bold uppercase tracking-widest">{t.examples}</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {EXAMPLES.map((example) => (
                  <button
                    key={example.id}
                    onClick={() => loadExample(example)}
                    disabled={loading}
                    className={`p-2 rounded-lg text-xs font-bold transition border ${
                      selectedExampleId === example.id
                        ? 'bg-indigo-600 text-white border-indigo-500'
                        : 'bg-slate-800/50 text-slate-300 border-white/5 hover:bg-slate-700/50 hover:text-white'
                    } ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    {t.example}
                    {example.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex border-b border-white/5">
              {[
                { id: 'info' as const, icon: Box, label: 'tabModel' },
                { id: 'settings' as const, icon: Palette, label: 'tabRender' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
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
          </aside>
        )}

        {/* Viewport */}
        <section ref={handleViewportRef} className="flex-1 relative bg-black group overflow-hidden">
          <canvas ref={canvasRef} className="w-full h-full cursor-grab active:cursor-grabbing" />

          {/* Video Player - Top Left */}
          {currentVideoUrl && (
            <div className="absolute left-6 top-6 z-20">
              <div className="rounded-2xl border border-white/10 bg-slate-950/70 p-2 shadow-[0_24px_60px_rgba(15,23,42,0.55)] backdrop-blur-xl ring-1 ring-indigo-500/10">
                <video
                  ref={videoRef}
                  src={currentVideoUrl}
                  loop
                  muted
                  playsInline
                  className="w-80 h-auto rounded-xl"
                />
              </div>
            </div>
          )}

          {metadata && (
            <div className="absolute right-6 bottom-6 z-20 pointer-events-none">
              <div className="pointer-events-auto w-[360px] rounded-2xl border border-white/10 bg-slate-950/70 p-4 shadow-[0_24px_60px_rgba(15,23,42,0.55)] backdrop-blur-xl ring-1 ring-indigo-500/10">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-indigo-300">
                    <Activity className="h-4 w-4" />
                    <span className="text-[11px] font-semibold uppercase tracking-[0.2em]">
                      {t.motionStats}
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-500">{t.unitHint}</span>
                </div>
                <div className="h-px w-full bg-gradient-to-r from-transparent via-indigo-400/40 to-transparent" />
                <div className="mt-4 space-y-4">
                  <div className="rounded-xl border border-white/5 bg-slate-900/60 p-3">
                    <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.2em] text-slate-400">
                      <span>{t.currentFrame}</span>
                      <span className="font-mono text-slate-100">{frameText}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs">
                      <span className="text-slate-500">{t.elapsedTime}</span>
                      <span className="font-mono text-slate-100">{elapsedText}</span>
                    </div>
                  </div>

                  <div className="space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">{t.moveSpeed}</span>
                      <span className="font-mono text-slate-100">{speedText}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">{t.stepCount}</span>
                      <span className="font-mono text-slate-100">{stepCountText}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">{t.leftFootHeight}</span>
                      <span className="font-mono text-slate-100">{leftFootHeightText}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">{t.rightFootHeight}</span>
                      <span className="font-mono text-slate-100">{rightFootHeightText}</span>
                    </div>
                    <div className="flex items-start justify-between gap-3">
                      <span className="flex items-center gap-2 text-slate-400 shrink-0">
                        <Axis3d
                          className="h-3.5 w-3.5 text-indigo-300/80 shrink-0"
                          strokeWidth={1.5}
                        />
                        {t.axisDelta}
                      </span>
                      <span className="font-mono text-[11px] leading-tight text-right text-slate-100 whitespace-nowrap min-w-0">
                        {axisDeltaText}
                      </span>
                    </div>
                  </div>

                  <div className="grid gap-3">
                    <div className="rounded-xl border border-white/5 bg-slate-900/50 p-3">
                      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-300">
                        <span>{t.speedTrend}</span>
                        <span className="font-mono text-slate-100">{speedText}</span>
                      </div>
                      <svg
                        className="mt-2 h-20 w-full"
                        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                        preserveAspectRatio="none"
                      >
                        <defs>
                          <linearGradient id="speedFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#818cf8" stopOpacity="0.35" />
                            <stop offset="100%" stopColor="#818cf8" stopOpacity="0" />
                          </linearGradient>
                          <linearGradient id="speedStroke" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="#a5b4fc" />
                            <stop offset="100%" stopColor="#c4b5fd" />
                          </linearGradient>
                        </defs>
                        {speedSpark.area && <path d={speedSpark.area} fill="url(#speedFill)" />}
                        {speedSpark.line && (
                          <path
                            d={speedSpark.line}
                            fill="none"
                            stroke="url(#speedStroke)"
                            strokeWidth="2"
                          />
                        )}
                        {speedSpark.last && (
                          <circle
                            cx={speedSpark.last.x}
                            cy={speedSpark.last.y}
                            r="2.5"
                            fill="#a5b4fc"
                          />
                        )}
                      </svg>
                    </div>

                    <div className="rounded-xl border border-white/5 bg-slate-900/50 p-3">
                      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-300">
                        <span>{t.stepRate}</span>
                        <span className="font-mono text-slate-100">{stepRateText}</span>
                      </div>
                      <svg
                        className="mt-2 h-20 w-full"
                        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                        preserveAspectRatio="none"
                      >
                        <defs>
                          <linearGradient id="stepFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.35" />
                            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
                          </linearGradient>
                          <linearGradient id="stepStroke" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="#38bdf8" />
                            <stop offset="100%" stopColor="#34d399" />
                          </linearGradient>
                        </defs>
                        {stepSpark.area && <path d={stepSpark.area} fill="url(#stepFill)" />}
                        {stepSpark.line && (
                          <path
                            d={stepSpark.line}
                            fill="none"
                            stroke="url(#stepStroke)"
                            strokeWidth="2"
                          />
                        )}
                        {stepSpark.last && (
                          <circle
                            cx={stepSpark.last.x}
                            cy={stepSpark.last.y}
                            r="2.5"
                            fill="#38bdf8"
                          />
                        )}
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {metadata && (
            <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
              <button
                type="button"
                onClick={togglePause}
                className="pointer-events-auto flex items-center gap-3 bg-slate-900/80 hover:bg-slate-800 text-white px-10 py-5 rounded-full font-bold uppercase tracking-widest border border-white/10 shadow-2xl backdrop-blur-md transition"
              >
                {isPaused ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}
                {pauseText}
              </button>
            </div>
          )}

          {!file && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/80 backdrop-blur-xl animate-in fade-in">
              <div className="max-w-md w-full text-center space-y-8 p-12">
                <div className="relative inline-block">
                  <div className="absolute inset-0 bg-indigo-500 blur-3xl opacity-20" />
                  <div className="relative bg-slate-900 w-24 h-24 rounded-3xl flex items-center justify-center mx-auto border border-white/10 shadow-2xl">
                    <Box className="w-12 h-12 text-indigo-500" />
                  </div>
                </div>
                <div>
                  <h2 className="text-3xl font-black mb-3">{t.dropTitle}</h2>
                  <p className="text-slate-400 text-sm leading-relaxed">{t.dropDesc}</p>
                </div>
                <label className="inline-flex items-center gap-3 bg-indigo-600 hover:bg-indigo-500 text-white px-10 py-5 rounded-2xl cursor-pointer font-black uppercase tracking-widest transition shadow-2xl shadow-indigo-600/40 transform hover:-translate-y-1">
                  <Upload className="w-5 h-5" />
                  {t.dropBtn}
                  <input type="file" accept=".fbx" className="hidden" onChange={handleFileUpload} />
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
        </div>
      </footer>
    </div>
  );
};

export default Converter;
