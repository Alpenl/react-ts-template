/**
 * @file 全局类型声明
 * @description 扩展全局类型定义
 */

import type { ModelMetadata } from './render.types.js';

/**
 * 模型渲染器接口
 * 在浏览器端运行的 Three.js 渲染器
 */
interface ModelRendererInterface {
  /** 加载模型 */
  loadModel(data: ArrayBuffer, extension: string): Promise<ModelMetadata>;
  /** 渲染指定时间的帧 */
  renderFrame(time: number): void;
  /** 获取动画时长 */
  getAnimationDuration(): number;
  /** 释放资源 */
  dispose(): void;
}

/**
 * 扩展 Window 接口
 */
declare global {
  interface Window {
    /** 模型渲染器类 */
    ModelRenderer: new (
      canvas: HTMLCanvasElement,
      width: number,
      height: number,
      config: Record<string, unknown>
    ) => ModelRendererInterface;
    /** 当前渲染器实例 */
    __renderer: ModelRendererInterface | null;
  }
}

export {};
