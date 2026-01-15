/**
 * @file 渲染相关类型定义
 * @description 定义 3D 模型渲染服务所需的所有类型接口
 */

/**
 * 动画信息
 * 描述模型中单个动画的基本信息
 */
export interface AnimationInfo {
  /** 动画名称 */
  name: string;
  /** 动画时长（秒） */
  duration: number;
}

/**
 * 模型元数据
 * 描述加载的 3D 模型的基本信息
 */
export interface ModelMetadata {
  /** 模型文件名 */
  name: string;
  /** 模型包含的动画列表 */
  animations: AnimationInfo[];
  /** 骨骼数量 */
  boneCount: number;
}

/**
 * 场景配置
 * 定义 Three.js 场景的各项参数
 */
export interface SceneConfig {
  /** 相机位置 */
  cameraPosition: { x: number; y: number; z: number };
  /** 相机观察目标点 */
  lookAt: { x: number; y: number; z: number };
  /** 主光源颜色（十六进制字符串） */
  mainLightColor: string;
  /** 主光源强度 */
  mainLightIntensity: number;
  /** 主光源位置 */
  mainLightPosition: { x: number; y: number; z: number };
  /** 环境光强度 */
  ambientIntensity: number;
  /** 环境光颜色（十六进制字符串） */
  ambientColor: string;
  /** 环境氛围预设 */
  environmentVibe: 'studio' | 'night' | 'sunset' | 'neon';
  /** 背景颜色（十六进制字符串） */
  backgroundColor: string;
  /** 曝光度 */
  exposure: number;
  /** 是否启用阴影 */
  shadowsEnabled: boolean;
  /** 动画播放速度倍率 */
  animationSpeed: number;
  /** 相机视野角度（度） */
  fov: number;
}

/**
 * 渲染配置
 * 定义视频渲染的输出参数
 */
export interface RenderingConfig {
  /** 帧率 (FPS) */
  fps: number;
  /** 输出宽度（像素） */
  width: number;
  /** 输出高度（像素） */
  height: number;
  /** 视频码率（bps） */
  bitrate: number;
  /** 输出格式 */
  format: 'webm' | 'mp4' | 'gif';
  /** 视频时长（秒），0 表示使用动画时长 */
  duration: number;
  /** GIF 质量（1-30，越小越清晰） */
  gifQuality: number;
  /** 视图模式：fit=自动适配，current=当前视角 */
  viewMode: 'fit' | 'current';
}

/**
 * 渲染选项
 * 渲染服务的输入参数
 */
export interface RenderOptions {
  /** 模型文件路径 (FBX/GLB) */
  modelPath: string;
  /** 输出视频路径（可选，不指定则自动生成） */
  outputPath?: string;
  /** 输出格式，默认 mp4 */
  format?: 'mp4' | 'gif';
  /** 输出宽度，默认 1080 (9:16 竖屏) */
  width?: number;
  /** 输出高度，默认 1920 */
  height?: number;
  /** 帧率，默认 30 */
  fps?: number;
  /** 视频时长（秒），0 表示使用动画时长 */
  duration?: number;
  /** 背景颜色，默认 #020617 */
  backgroundColor?: string;
  /** 动画播放速度，默认 1.0 */
  animationSpeed?: number;
  /** 曝光度，默认 1.5 */
  exposure?: number;
  /** 是否启用阴影，默认 true */
  shadowsEnabled?: boolean;
}

/**
 * 渲染结果
 * 渲染服务的输出结果
 */
export interface RenderResult {
  /** 是否成功 */
  success: boolean;
  /** 输出文件路径 */
  outputPath?: string;
  /** 视频时长（秒） */
  duration?: number;
  /** 文件大小（字节） */
  fileSize?: number;
  /** 错误信息 */
  error?: string;
}

/**
 * 视频拼接选项
 */
export interface ConcatOptions {
  /** 左侧视频路径 */
  video1Path: string;
  /** 右侧视频路径 */
  video2Path: string;
  /** 输出视频路径（可选，不指定则自动生成） */
  outputPath?: string;
  /** 输出宽度 */
  outputWidth?: number;
  /** 输出高度 */
  outputHeight?: number;
}

/**
 * 视频拼接结果
 */
export interface ConcatResult {
  /** 是否成功 */
  success: boolean;
  /** 输出文件路径 */
  outputPath?: string;
  /** 错误信息 */
  error?: string;
}

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

// 为了类型兼容，声明 THREE 命名空间
declare global {
  namespace THREE {
    interface LineSegments {}
    interface Object3D {}
  }
}
