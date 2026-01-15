/**
 * @file 浏览器端 3D 模型渲染器
 * @description 在 Puppeteer 控制的浏览器中运行，负责加载和渲染 3D 模型
 *
 * 这个模块会被编译成独立的 JS 文件，在 headless Chrome 中运行。
 * 它提供了 ModelRenderer 类，用于：
 * 1. 初始化 Three.js 场景
 * 2. 加载 FBX/GLB 模型
 * 3. 播放动画
 * 4. 逐帧渲染
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import {
  alignRootToGround,
  applyViewForModel,
  createRigHelper,
  frameCameraToObject,
  needsPreciseBounds,
  updateRigHelper,
  type RigHelper,
} from './three-utils.js';

/**
 * 场景配置接口
 */
interface SceneConfig {
  /** 背景颜色 */
  backgroundColor: string;
  /** 曝光度 */
  exposure: number;
  /** 是否启用阴影 */
  shadowsEnabled: boolean;
  /** 动画播放速度 */
  animationSpeed: number;
  /** 相机视野角度 */
  fov: number;
  /** 主光源强度 */
  mainLightIntensity: number;
  /** 主光源颜色 */
  mainLightColor: string;
  /** 环境光强度 */
  ambientIntensity: number;
  /** 环境光颜色 */
  ambientColor: string;
}

/**
 * 默认场景配置
 */
const DEFAULT_SCENE_CONFIG: SceneConfig = {
  backgroundColor: '#020617',
  exposure: 1.5,
  shadowsEnabled: true,
  animationSpeed: 1.0,
  fov: 45,
  mainLightIntensity: 5.0,
  mainLightColor: '#ffffff',
  ambientIntensity: 3.0,
  ambientColor: '#ffffff',
};

/**
 * 3D 模型渲染器类
 *
 * 负责在浏览器中渲染 3D 模型，支持 FBX 和 GLB 格式。
 * 提供逐帧渲染功能，供 Puppeteer 捕获。
 */
class ModelRenderer {
  /** Three.js 场景 */
  private scene: THREE.Scene;
  /** 透视相机 */
  private camera: THREE.PerspectiveCamera;
  /** WebGL 渲染器 */
  private renderer: THREE.WebGLRenderer;
  /** 动画混合器 */
  private mixer: THREE.AnimationMixer | null = null;
  /** 当前加载的模型 */
  private model: THREE.Object3D | null = null;
  /** 骨骼辅助线（用于纯骨骼模型） */
  private skeletonHelper: THREE.SkeletonHelper | null = null;
  /** 骨骼连接线辅助（用于无网格模型） */
  private rigHelper: RigHelper | null = null;
  /** 轨道控制器 */
  private controls: OrbitControls;
  /** 主方向光 */
  private mainLight: THREE.DirectionalLight;
  /** 环境光 */
  private ambientLight: THREE.AmbientLight;
  /** 地面网格 */
  private floor: THREE.Mesh;
  /** 场景配置 */
  private config: SceneConfig;
  /** 动画时长 */
  private animationDuration = 0;

  /**
   * 创建渲染器实例
   *
   * @param canvas - HTML Canvas 元素
   * @param width - 渲染宽度
   * @param height - 渲染高度
   * @param config - 场景配置（可选）
   */
  constructor(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    config: Partial<SceneConfig> = {}
  ) {
    // 合并配置
    this.config = { ...DEFAULT_SCENE_CONFIG, ...config };

    // 创建场景
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.config.backgroundColor);

    // 创建相机（使用 9:16 竖屏比例）
    const aspect = width / height;
    this.camera = new THREE.PerspectiveCamera(this.config.fov, aspect, 0.1, 5000);
    this.camera.position.set(300, 200, 300);

    // 创建渲染器
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true, // 重要：允许截图
    });
    this.renderer.setPixelRatio(1); // 固定像素比，确保输出一致
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ReinhardToneMapping;
    this.renderer.toneMappingExposure = this.config.exposure;

    // 创建环境光
    this.ambientLight = new THREE.AmbientLight(
      this.config.ambientColor,
      this.config.ambientIntensity
    );
    this.scene.add(this.ambientLight);

    // 创建主方向光（从相机方向照射，确保模型正面被照亮）
    this.mainLight = new THREE.DirectionalLight(
      this.config.mainLightColor,
      this.config.mainLightIntensity
    );
    // 光源位置：在模型前方偏上，与相机同侧
    this.mainLight.position.set(0, 400, 500);
    this.mainLight.castShadow = this.config.shadowsEnabled;
    this.mainLight.shadow.mapSize.width = 2048;
    this.mainLight.shadow.mapSize.height = 2048;
    this.scene.add(this.mainLight);

    // 添加补光（从侧面照射，减少阴影）
    const fillLight = new THREE.DirectionalLight('#ffffff', 2.0);
    fillLight.position.set(-300, 200, 300);
    this.scene.add(fillLight);

    // 添加背光（轮廓光）
    const backLight = new THREE.DirectionalLight('#ffffff', 1.5);
    backLight.position.set(0, 200, -400);
    this.scene.add(backLight);

    // 创建网格辅助线
    const grid = new THREE.GridHelper(2000, 50, 0x1e293b, 0x0f172a);
    this.scene.add(grid);

    // 创建地面
    const planeGeometry = new THREE.PlaneGeometry(2000, 2000);
    const planeMaterial = new THREE.MeshStandardMaterial({
      color: 0x020617,
      roughness: 0.8,
    });
    this.floor = new THREE.Mesh(planeGeometry, planeMaterial);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    // 创建轨道控制器
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    console.log('[ModelRenderer] 渲染器初始化完成', { width, height });
  }

  /**
   * 加载 3D 模型
   *
   * 支持 FBX 和 GLB/GLTF 格式。加载后会自动：
   * 1. 缩放模型到合适大小
   * 2. 对齐模型到地面
   * 3. 设置相机视角
   * 4. 播放第一个动画
   *
   * @param data - 模型文件的 ArrayBuffer 数据
   * @param extension - 文件扩展名（fbx/glb/gltf）
   * @returns 模型元数据
   */
  async loadModel(
    data: ArrayBuffer,
    extension: string
  ): Promise<{
    name: string;
    animations: Array<{ name: string; duration: number }>;
    boneCount: number;
  }> {
    console.log('[ModelRenderer] 开始加载模型', { extension, dataSize: data.byteLength });

    let object: THREE.Object3D | null = null;
    let animations: THREE.AnimationClip[] = [];

    try {
      // 根据扩展名选择加载器
      if (extension === 'fbx') {
        // 加载 FBX 模型
        const loader = new FBXLoader();
        object = loader.parse(data, '');
        animations = (object as THREE.Group).animations || [];
      } else if (extension === 'glb' || extension === 'gltf') {
        // 加载 GLB/GLTF 模型
        const loader = new GLTFLoader();
        const gltf = await new Promise<{
          scene: THREE.Group;
          scenes: THREE.Group[];
          animations: THREE.AnimationClip[];
          parser: { getDependencies: (type: string) => Promise<THREE.Object3D[]> };
        }>((resolve, reject) => {
          loader.parse(data, '', resolve as (gltf: unknown) => void, reject);
        });

        // 获取场景根节点
        let sceneRoot = gltf.scene ?? gltf.scenes?.[0] ?? null;

        // 如果场景为空，尝试从节点依赖中获取
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
        animations = gltf.animations || [];
      }

      if (!object) {
        throw new Error(`不支持的模型格式: ${extension}`);
      }

      // 清理之前的模型
      this.cleanupModel();

      // 创建根容器
      const root = new THREE.Group();
      root.add(object);

      // 检测是否需要精确边界计算
      const preciseBounds = needsPreciseBounds(object);

      // 统计模型信息
      let hasMesh = false;
      let hasBone = false;
      let boneCount = 0;

      object.traverse((child) => {
        if ((child as THREE.Bone).isBone) {
          hasBone = true;
          boneCount++;
        }
        if ((child as THREE.Mesh).isMesh) {
          hasMesh = true;
          // 启用阴影
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });

      // 保存动画到 userData
      root.userData.animations = animations;

      // 创建动画混合器并播放第一个动画
      if (animations.length > 0) {
        this.mixer = new THREE.AnimationMixer(root);
        this.mixer.clipAction(animations[0]).play();
        this.mixer.setTime(0);
        this.animationDuration = animations[0].duration;
      }

      // 对齐模型到地面
      alignRootToGround(root, 250, preciseBounds);

      // 添加到场景
      this.scene.add(root);

      // 为纯骨骼模型创建辅助可视化
      if (!hasMesh && hasBone) {
        // 使用骨骼辅助线
        const helper = new THREE.SkeletonHelper(root);
        (helper.material as THREE.LineBasicMaterial).color.set(0xff7a18);
        helper.frustumCulled = false;
        this.scene.add(helper);
        this.skeletonHelper = helper;
      } else if (!hasMesh) {
        // 使用骨骼连接线
        const rigHelper = createRigHelper(root);
        if (rigHelper) {
          this.scene.add(rigHelper.helper);
          this.rigHelper = rigHelper;
          updateRigHelper(rigHelper);
        }
      }

      // 保存模型引用
      this.model = root;

      // 设置相机视角
      if (!hasMesh) {
        frameCameraToObject(this.camera, this.controls, root);
      } else {
        applyViewForModel(this.camera, this.controls, root);
      }

      console.log('[ModelRenderer] 模型加载完成', {
        hasMesh,
        hasBone,
        boneCount,
        animationCount: animations.length,
        animationDuration: this.animationDuration,
      });

      // 返回模型元数据
      return {
        name: extension.toUpperCase() + ' Model',
        animations: animations.map((a) => ({ name: a.name || 'default', duration: a.duration })),
        boneCount,
      };
    } catch (error) {
      console.error('[ModelRenderer] 模型加载失败', error);
      throw error;
    }
  }

  /**
   * 清理当前模型
   */
  private cleanupModel(): void {
    // 移除模型
    if (this.model) {
      this.scene.remove(this.model);
      this.model = null;
    }

    // 移除骨骼辅助线
    if (this.skeletonHelper) {
      this.scene.remove(this.skeletonHelper);
      this.skeletonHelper.geometry.dispose();
      if (Array.isArray(this.skeletonHelper.material)) {
        this.skeletonHelper.material.forEach((m) => m.dispose());
      } else {
        this.skeletonHelper.material.dispose();
      }
      this.skeletonHelper = null;
    }

    // 移除骨骼连接线
    if (this.rigHelper) {
      this.scene.remove(this.rigHelper.helper);
      this.rigHelper.helper.geometry.dispose();
      if (Array.isArray(this.rigHelper.helper.material)) {
        this.rigHelper.helper.material.forEach((m) => m.dispose());
      } else {
        (this.rigHelper.helper.material as THREE.Material).dispose();
      }
      this.rigHelper = null;
    }

    // 清理动画混合器
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
    }
  }

  /**
   * 渲染指定时间点的帧
   *
   * @param time - 动画时间（秒）
   */
  renderFrame(time: number): void {
    // 更新动画
    if (this.mixer) {
      this.mixer.setTime(time);
    }

    // 更新骨骼辅助线
    if (this.skeletonHelper) {
      this.skeletonHelper.updateMatrixWorld(true);
    }

    // 更新骨骼连接线
    if (this.rigHelper) {
      updateRigHelper(this.rigHelper);
    }

    // 渲染场景
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * 批量渲染多帧并返回 base64 数据
   * 优化版本：使用 toBlob 异步 API
   *
   * @param times - 时间点数组
   * @param format - 图像格式 ('image/jpeg' | 'image/png')
   * @param quality - JPEG 质量 (0-1)
   * @returns base64 编码的图像数据数组
   */
  async renderFramesBatchAsync(times: number[], format = 'image/jpeg', quality = 0.92): Promise<string[]> {
    const results: string[] = [];
    const canvas = this.renderer.domElement;

    for (const time of times) {
      // 更新动画
      if (this.mixer) {
        this.mixer.setTime(time);
      }

      // 更新骨骼辅助线
      if (this.skeletonHelper) {
        this.skeletonHelper.updateMatrixWorld(true);
      }

      // 更新骨骼连接线
      if (this.rigHelper) {
        updateRigHelper(this.rigHelper);
      }

      // 渲染场景
      this.renderer.render(this.scene, this.camera);

      // 使用 toBlob 异步获取图像数据（比 toDataURL 更高效）
      const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob((b) => resolve(b!), format, quality);
      });

      // 转换为 base64
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      results.push(btoa(binary));
    }

    return results;
  }

  /**
   * 批量渲染多帧并返回 base64 数据（同步版本）
   *
   * @param times - 时间点数组
   * @param format - 图像格式 ('image/jpeg' | 'image/png')
   * @param quality - JPEG 质量 (0-1)
   * @returns base64 编码的图像数据数组
   */
  renderFramesBatch(times: number[], format = 'image/jpeg', quality = 0.92): string[] {
    const results: string[] = [];
    const canvas = this.renderer.domElement;

    for (const time of times) {
      // 更新动画
      if (this.mixer) {
        this.mixer.setTime(time);
      }

      // 更新骨骼辅助线
      if (this.skeletonHelper) {
        this.skeletonHelper.updateMatrixWorld(true);
      }

      // 更新骨骼连接线
      if (this.rigHelper) {
        updateRigHelper(this.rigHelper);
      }

      // 渲染场景
      this.renderer.render(this.scene, this.camera);

      // 获取图像数据
      const dataUrl = canvas.toDataURL(format, quality);
      results.push(dataUrl.split(',')[1]);
    }

    return results;
  }

  /**
   * 获取动画时长
   *
   * @returns 动画时长（秒）
   */
  getAnimationDuration(): number {
    return this.animationDuration;
  }

  /**
   * 获取 Canvas 元素
   *
   * @returns Canvas 元素
   */
  getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /**
   * 销毁渲染器，释放资源
   */
  dispose(): void {
    console.log('[ModelRenderer] 销毁渲染器');

    this.cleanupModel();
    this.renderer.dispose();
    this.controls.dispose();
  }
}

// 将 ModelRenderer 暴露到全局，供 Puppeteer 调用
declare global {
  interface Window {
    ModelRenderer: typeof ModelRenderer;
    __renderer: ModelRenderer | null;
  }
}

window.ModelRenderer = ModelRenderer;
window.__renderer = null;

console.log('[Renderer] 渲染器脚本已加载');
