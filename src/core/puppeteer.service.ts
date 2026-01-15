/**
 * @file Puppeteer 服务
 * @description 管理 Puppeteer 浏览器实例，负责 3D 模型的渲染和帧捕获
 *
 * 这个服务使用 headless Chrome 来运行 Three.js 渲染器，
 * 逐帧捕获渲染结果并保存为 PNG 图片序列。
 */

import fs from 'fs/promises';
import path from 'path';
import puppeteer, { Browser } from 'puppeteer';

import { PUPPETEER_CONFIG, RENDERER_HTML, TEMP_DIR } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

// 创建日志记录器
const logger = createLogger('PuppeteerService');

/**
 * 渲染任务配置
 */
export interface PuppeteerRenderConfig {
  /** 输出宽度 */
  width: number;
  /** 输出高度 */
  height: number;
  /** 帧率 */
  fps: number;
  /** 视频时长（秒） */
  duration: number;
  /** 动画播放速度 */
  animationSpeed: number;
  /** 场景配置 */
  scene: {
    backgroundColor: string;
    exposure: number;
    shadowsEnabled: boolean;
  };
}

/**
 * 渲染进度回调
 */
export type ProgressCallback = (current: number, total: number) => void;

/**
 * Puppeteer 服务类
 *
 * 负责管理 headless Chrome 浏览器实例，
 * 执行 3D 模型渲染和帧捕获任务。
 */
export class PuppeteerService {
  /** 浏览器实例 */
  private browser: Browser | null = null;

  /**
   * 初始化浏览器
   *
   * 启动 headless Chrome 浏览器实例。
   * 在执行渲染任务前必须先调用此方法。
   */
  async initialize(): Promise<void> {
    if (this.browser) {
      logger.warn('浏览器已初始化，跳过');
      return;
    }

    logger.info('正在启动 headless Chrome...');

    this.browser = await puppeteer.launch({
      headless: PUPPETEER_CONFIG.headless,
      args: PUPPETEER_CONFIG.args,
    });

    logger.info('浏览器启动成功');
  }

  /**
   * 渲染 3D 模型为帧序列
   *
   * 加载模型文件，逐帧渲染并捕获为 PNG 图片。
   *
   * @param modelPath - 模型文件路径
   * @param taskId - 任务 ID（用于创建临时目录）
   * @param config - 渲染配置
   * @param onProgress - 进度回调函数
   * @returns 帧文件路径数组和动画时长
   */
  async renderModel(
    modelPath: string,
    taskId: string,
    config: PuppeteerRenderConfig,
    onProgress?: ProgressCallback
  ): Promise<{ frames: string[]; animationDuration: number }> {
    if (!this.browser) {
      throw new Error('浏览器未初始化，请先调用 initialize()');
    }

    logger.info('开始渲染任务', { taskId, modelPath, config });

    // 创建帧输出目录
    const framesDir = path.join(TEMP_DIR, taskId, 'frames');
    await fs.mkdir(framesDir, { recursive: true });

    // 创建新页面
    const page = await this.browser.newPage();

    try {
      // 设置视口大小
      await page.setViewport({
        width: config.width,
        height: config.height,
        deviceScaleFactor: 1,
      });

      // 加载渲染器页面
      const rendererUrl = `file://${RENDERER_HTML}`;
      logger.debug('加载渲染器页面', { url: rendererUrl });

      await page.goto(rendererUrl, {
        waitUntil: 'networkidle0',
        timeout: 30000,
      });

      // 等待渲染器脚本加载完成
      await page.waitForFunction(() => {
        return typeof (window as Window & { ModelRenderer?: unknown }).ModelRenderer !== 'undefined';
      }, { timeout: 10000 });

      logger.debug('渲染器脚本已加载');

      // 读取模型文件
      const modelData = await fs.readFile(modelPath);
      const modelBase64 = modelData.toString('base64');
      const extension = path.extname(modelPath).slice(1).toLowerCase();

      logger.debug('模型文件已读取', {
        extension,
        size: modelData.length,
      });

      // 在浏览器中初始化渲染器并加载模型
      const modelInfo = await page.evaluate(
        async (base64Data: string, ext: string, cfg: PuppeteerRenderConfig) => {
          // 获取 Canvas 元素
          const canvas = document.getElementById('canvas') as HTMLCanvasElement;
          if (!canvas) {
            throw new Error('找不到 Canvas 元素');
          }

          // 设置 Canvas 大小
          canvas.width = cfg.width;
          canvas.height = cfg.height;

          // 创建渲染器实例
          const renderer = new window.ModelRenderer(canvas, cfg.width, cfg.height, {
            backgroundColor: cfg.scene.backgroundColor,
            exposure: cfg.scene.exposure,
            shadowsEnabled: cfg.scene.shadowsEnabled,
          });

          // 解码 Base64 模型数据
          const binaryString = atob(base64Data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }

          // 加载模型
          const metadata = await renderer.loadModel(bytes.buffer, ext);

          // 保存渲染器实例到全局
          window.__renderer = renderer;

          return {
            ...metadata,
            animationDuration: renderer.getAnimationDuration(),
          };
        },
        modelBase64,
        extension,
        config
      );

      logger.info('模型加载完成', modelInfo);

      // 计算渲染参数
      const animationDuration = modelInfo.animationDuration || 5;
      const targetDuration = config.duration > 0 ? config.duration : animationDuration;
      const totalFrames = Math.ceil(targetDuration * config.fps);
      const frameTime = 1 / config.fps;

      logger.info('开始帧捕获', {
        animationDuration,
        targetDuration,
        totalFrames,
        fps: config.fps,
      });

      // 预渲染几帧，确保材质和光照完全加载
      logger.debug('预渲染场景...');
      await page.evaluate(() => {
        if (window.__renderer) {
          // 预渲染 3 帧
          for (let i = 0; i < 3; i++) {
            window.__renderer.renderFrame(0);
          }
        }
      });
      // 等待 GPU 完成
      await new Promise((resolve) => setTimeout(resolve, 100));

      // 计算所有帧的时间点
      const allFrameTimes: number[] = [];
      for (let i = 0; i < totalFrames; i++) {
        const elapsed = i * frameTime * config.animationSpeed;
        const time = animationDuration > 0 ? elapsed % animationDuration : 0;
        allFrameTimes.push(time);
      }

      // 一次性在浏览器中渲染所有帧（使用同步批量渲染方法）
      logger.debug('开始批量渲染帧...');
      const frameDataArray = await page.evaluate((times: number[]) => {
        if (window.__renderer) {
          return window.__renderer.renderFramesBatch(times, 'image/jpeg', 0.92);
        }
        return [];
      }, allFrameTimes);

      // 报告渲染完成
      if (onProgress) {
        onProgress(totalFrames, totalFrames);
      }

      // 并行写入所有帧文件
      logger.debug('写入帧文件...');
      const frames: string[] = [];
      const writePromises = frameDataArray.map((data, i) => {
        const framePath = path.join(framesDir, `frame_${String(i).padStart(6, '0')}.jpg`);
        frames.push(framePath);
        const buffer = Buffer.from(data, 'base64');
        return fs.writeFile(framePath, buffer);
      });

      await Promise.all(writePromises);

      logger.info('帧捕获完成', { totalFrames: frames.length });

      return {
        frames,
        animationDuration,
      };
    } finally {
      // 清理渲染器
      await page.evaluate(() => {
        if (window.__renderer) {
          window.__renderer.dispose();
          window.__renderer = null;
        }
      });

      // 关闭页面
      await page.close();
    }
  }

  /**
   * 关闭浏览器
   *
   * 释放浏览器资源。在服务停止时调用。
   */
  async close(): Promise<void> {
    if (this.browser) {
      logger.info('正在关闭浏览器...');
      await this.browser.close();
      this.browser = null;
      logger.info('浏览器已关闭');
    }
  }

  /**
   * 检查浏览器是否已初始化
   */
  isInitialized(): boolean {
    return this.browser !== null;
  }
}

// 导出单例实例
export const puppeteerService = new PuppeteerService();
