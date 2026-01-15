/**
 * @file Three.js 工具函数
 * @description 从原项目提取的 Three.js 相关工具函数，用于 3D 模型处理
 *
 * 这些函数在浏览器端渲染器中使用，处理模型边界计算、骨骼可视化、
 * 模型对齐和相机定位等功能。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * 骨骼辅助线类型
 * 用于可视化模型骨骼结构
 */
export interface RigHelper {
  /** Three.js 线段对象 */
  helper: THREE.LineSegments;
  /** 骨骼父子关系对 */
  pairs: Array<{ child: THREE.Object3D; parent: THREE.Object3D }>;
}

/**
 * 检测模型是否需要精确边界计算
 *
 * 对于包含蒙皮网格（SkinnedMesh）的模型，需要使用精确边界计算，
 * 因为蒙皮网格的顶点位置会随骨骼动画变化。
 *
 * @param model - 要检测的 3D 模型对象
 * @returns 如果模型包含蒙皮网格则返回 true
 */
export const needsPreciseBounds = (model: THREE.Object3D): boolean => {
  let precise = false;
  model.traverse((child) => {
    if ((child as THREE.SkinnedMesh).isSkinnedMesh) {
      precise = true;
    }
  });
  return precise;
};

/**
 * 获取模型骨骼的边界框
 *
 * 遍历模型中的所有骨骼节点，计算它们的世界坐标位置，
 * 返回包含所有骨骼的最小边界框。
 *
 * @param root - 模型根节点
 * @returns 包含所有骨骼的边界框，如果没有骨骼则返回空边界框
 */
export const getBoneBounds = (root: THREE.Object3D): THREE.Box3 => {
  const box = new THREE.Box3();
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  let hasBone = false;
  const worldPos = new THREE.Vector3();

  // 更新世界矩阵以确保位置计算正确
  root.updateMatrixWorld(true);

  // 遍历所有子节点，找出骨骼节点
  root.traverse((child) => {
    if ((child as THREE.Bone).isBone) {
      hasBone = true;
      child.getWorldPosition(worldPos);
      min.min(worldPos);
      max.max(worldPos);
    }
  });

  // 如果没有骨骼，返回空边界框
  if (!hasBone) return box;

  box.min.copy(min);
  box.max.copy(max);
  return box;
};

/**
 * 获取模型所有节点的边界框
 *
 * 遍历模型中的所有节点，计算它们的世界坐标位置，
 * 返回包含所有节点的最小边界框。
 *
 * @param root - 模型根节点
 * @returns 包含所有节点的边界框
 */
export const getNodeBounds = (root: THREE.Object3D): THREE.Box3 => {
  const box = new THREE.Box3();
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  let hasNode = false;
  const worldPos = new THREE.Vector3();

  // 更新世界矩阵
  root.updateMatrixWorld(true);

  // 遍历所有子节点
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

/**
 * 获取模型的边界框（综合方法）
 *
 * 首先尝试使用 Three.js 内置的 setFromObject 方法，
 * 如果失败则尝试骨骼边界，最后尝试节点边界。
 *
 * @param root - 模型根节点
 * @param precise - 是否使用精确计算（对蒙皮网格有效）
 * @returns 模型的边界框
 */
export const getObjectBounds = (root: THREE.Object3D, precise = false): THREE.Box3 => {
  // 首先尝试标准方法
  const box = new THREE.Box3().setFromObject(root, precise);
  if (!box.isEmpty()) return box;

  // 如果标准方法失败，尝试骨骼边界
  const boneBox = getBoneBounds(root);
  if (!boneBox.isEmpty()) return boneBox;

  // 最后尝试节点边界
  return getNodeBounds(root);
};

/**
 * 创建骨骼辅助线
 *
 * 为模型创建可视化的骨骼连接线，用于显示骨骼结构。
 * 每条线连接子节点和父节点。
 *
 * @param root - 模型根节点
 * @returns 骨骼辅助线对象，如果没有可显示的骨骼则返回 null
 */
export const createRigHelper = (root: THREE.Object3D): RigHelper | null => {
  const pairs: Array<{ child: THREE.Object3D; parent: THREE.Object3D }> = [];

  // 更新世界矩阵
  root.updateMatrixWorld(true);

  // 收集所有父子关系对
  root.traverse((child) => {
    if (child === root) return;
    if (!child.parent) return;
    pairs.push({ child, parent: child.parent });
  });

  // 如果没有父子关系，返回 null
  if (pairs.length === 0) return null;

  // 创建线段几何体
  const positions = new Float32Array(pairs.length * 2 * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  // 创建线段材质（橙色，半透明）
  const material = new THREE.LineBasicMaterial({
    color: 0xff7a18,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.9,
  });

  // 创建线段对象
  const helper = new THREE.LineSegments(geometry, material);
  helper.frustumCulled = false;

  return { helper, pairs };
};

/**
 * 更新骨骼辅助线位置
 *
 * 根据当前骨骼位置更新辅助线的顶点位置，
 * 用于动画播放时实时更新骨骼可视化。
 *
 * @param rig - 骨骼辅助线对象
 */
export const updateRigHelper = (rig: RigHelper): void => {
  const position = rig.helper.geometry.getAttribute('position') as THREE.BufferAttribute;
  const worldPos = new THREE.Vector3();
  let idx = 0;

  // 更新每对父子节点的连接线
  for (const { child, parent } of rig.pairs) {
    // 子节点位置
    child.getWorldPosition(worldPos);
    position.setXYZ(idx++, worldPos.x, worldPos.y, worldPos.z);
    // 父节点位置
    parent.getWorldPosition(worldPos);
    position.setXYZ(idx++, worldPos.x, worldPos.y, worldPos.z);
  }

  // 标记需要更新
  position.needsUpdate = true;
};

/**
 * 将模型对齐到地面
 *
 * 缩放模型到目标大小，并将模型底部对齐到 Y=0 平面，
 * 同时将模型中心对齐到 X=0, Z=0。
 *
 * @param root - 模型根节点
 * @param targetSize - 目标大小（最大维度），默认 250
 * @param precise - 是否使用精确边界计算
 */
export const alignRootToGround = (
  root: THREE.Object3D,
  targetSize = 250,
  precise = false
): void => {
  // 更新世界矩阵
  root.updateMatrixWorld(true);

  // 获取边界框
  const box = getObjectBounds(root, precise);
  if (box.isEmpty()) return;

  // 计算缩放比例
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = Number.isFinite(maxDim) && maxDim > 0 ? targetSize / maxDim : 1;

  // 应用缩放
  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);

  // 重新计算缩放后的边界框
  const scaledBox = getObjectBounds(root, precise);
  if (scaledBox.isEmpty()) return;

  // 计算中心点
  const center = scaledBox.getCenter(new THREE.Vector3());

  // 设置位置：X/Z 居中，Y 底部对齐到地面
  root.position.set(-center.x, -scaledBox.min.y, -center.z);
  root.updateMatrixWorld(true);
};

/**
 * 将相机对焦到目标对象
 *
 * 自动调整相机位置和参数，使目标对象完整显示在视野中。
 *
 * @param camera - 透视相机
 * @param controls - 轨道控制器（可选）
 * @param object - 目标对象
 * @param margin - 边距倍数，默认 2
 */
export const frameCameraToObject = (
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls | null,
  object: THREE.Object3D,
  margin = 2
): void => {
  // 更新世界矩阵
  object.updateMatrixWorld(true);

  // 获取边界框
  const box = getObjectBounds(object, true);
  if (box.isEmpty()) return;

  // 计算边界框大小和中心
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxSize = Math.max(size.x, size.y, size.z);

  // 根据视野角度计算所需距离
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const fitHeightDistance = maxSize / (2 * Math.tan(fov / 2));
  const fitWidthDistance = fitHeightDistance / camera.aspect;
  const distance = margin * Math.max(fitHeightDistance, fitWidthDistance);

  // 计算相机方向
  const currentTarget = controls ? controls.target : center;
  const direction = new THREE.Vector3().subVectors(camera.position, currentTarget);
  if (direction.lengthSq() === 0) direction.set(1, 1, 1);
  direction.normalize();

  // 设置相机位置
  camera.position.copy(center).add(direction.multiplyScalar(distance));

  // 调整近远裁剪面
  camera.near = Math.max(distance / 100, 0.1);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();

  // 更新控制器目标
  if (controls) {
    controls.target.copy(center);
    controls.update();
  } else {
    camera.lookAt(center);
  }
};

/**
 * 预设视角配置
 * 用于统一的模型展示视角
 */
export const viewPreset = {
  cameraPosition: new THREE.Vector3(-533.2114976476801, 130.61937589294004, 629.7917070129056),
  controlsTarget: new THREE.Vector3(61.36949013775254, 124.18544261444927, 63.603582359940226),
};

/**
 * 应用预设视角
 *
 * @param camera - 透视相机
 * @param controls - 轨道控制器（可选）
 * @param preset - 视角预设配置
 */
export const applyViewPreset = (
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls | null,
  preset: { cameraPosition: THREE.Vector3; controlsTarget: THREE.Vector3 }
): void => {
  camera.position.copy(preset.cameraPosition);

  if (controls) {
    controls.target.copy(preset.controlsTarget);
  }

  // 根据距离调整裁剪面
  const distance = camera.position.distanceTo(preset.controlsTarget);
  camera.near = Math.max(distance / 100, 0.1);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();

  if (controls) controls.update();
};

/**
 * 为模型应用视角
 *
 * 自动计算相机位置，确保模型居中显示在画面中央。
 * 相机从正前方稍微偏上的角度观察模型。
 *
 * @param camera - 透视相机
 * @param controls - 轨道控制器（可选）
 * @param model - 目标模型
 */
export const applyViewForModel = (
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls | null,
  model: THREE.Object3D
): void => {
  // 更新世界矩阵
  model.updateMatrixWorld(true);

  // 获取模型边界框
  const box = getObjectBounds(model, true);
  if (box.isEmpty()) {
    frameCameraToObject(camera, controls, model);
    return;
  }

  // 计算边界框大小和中心
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  // 对于竖屏（9:16），主要关注高度
  const maxSize = Math.max(size.x, size.y, size.z);

  // 根据视野角度计算所需距离
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const fitHeightDistance = size.y / (2 * Math.tan(fov / 2));
  const fitWidthDistance = fitHeightDistance / camera.aspect;
  // 使用较大的距离，并添加边距
  const distance = 1.5 * Math.max(fitHeightDistance, fitWidthDistance);

  // 相机位置：正前方，稍微偏上
  // Z 轴正方向为正前方，相机在 Z 正方向观察模型
  camera.position.set(
    center.x,           // X: 与模型中心对齐（确保水平居中）
    center.y * 1.1,     // Y: 稍微高于模型中心（从上往下看，使人物在画面中偏下）
    center.z + distance // Z: 在模型前方
  );

  // 调整近远裁剪面
  camera.near = Math.max(distance / 100, 0.1);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();

  // 设置观察目标为模型中心
  if (controls) {
    controls.target.copy(center);
    controls.update();
  } else {
    camera.lookAt(center);
  }
};

/**
 * 获取动画的帧数
 *
 * @param clip - 动画剪辑
 * @returns 动画帧数
 */
export const getClipFrameCount = (clip: THREE.AnimationClip | null): number => {
  if (!clip) return 0;

  let maxFrames = 0;
  for (const track of clip.tracks) {
    const count = track.times.length;
    if (count > maxFrames) maxFrames = count;
  }

  // 如果轨道中有帧数据，返回最大帧数
  if (maxFrames > 0) return maxFrames;

  // 否则根据时长估算（假设 60fps）
  if (Number.isFinite(clip.duration) && clip.duration > 0) {
    return Math.max(1, Math.round(clip.duration * 60));
  }

  return 0;
};

/**
 * 限制数值在指定范围内
 *
 * @param value - 输入值
 * @param min - 最小值
 * @param max - 最大值
 * @returns 限制后的值
 */
export const clamp = (value: number, min: number, max: number): number => {
  return Math.min(Math.max(value, min), max);
};
