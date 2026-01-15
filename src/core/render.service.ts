/**
 * @file 渲染服务
 * @description 整合 Puppeteer 和 FFmpeg 服务，提供完整的 3D 模型渲染功能
 *
 * 这是渲染服务的主入口，负责：
 * 1. 协调 Puppeteer 进行帧捕获
 * 2. 协调 FFmpeg 进行视频编码
 * 3. 管理临时文件和输出文件
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

import { DEFAULT_RENDER_CONFIG, OUTPUTS_DIR, TEMP_DIR } from '../config/index.js';
import type { ConcatOptions, ConcatResult, RenderOptions, RenderResult } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { ffmpegService } from './ffmpeg.service.js';
import { puppeteerService } from './puppeteer.service.js';

// 创建日志记录器
const logger = createLogger('RenderService');

/**
 * 渲染进度回调
 */
export interface RenderProgress {
  /** 当前阶段 */
  stage: 'initializing' | 'rendering' | 'encoding' | 'completed' | 'failed';
  /** 进度百分比（0-100） */
  percent: number;
  /** 当前帧/总帧数（渲染阶段） */
  frame?: { current: number; total: number };
  /** 消息 */
  message?: string;
}

/**
 * 进度回调函数类型
 */
export type RenderProgressCallback = (progress: RenderProgress) => void;

/**
 * 渲染服务类
 *
 * 提供 3D 模型渲染和视频拼接的完整功能。
 */
export class RenderService {
  /** 是否已初始化 */
  private initialized = false;

  /**
   * 初始化服务
   *
   * 启动 Puppeteer 浏览器，创建必要的目录。
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('服务已初始化，跳过');
      return;
    }

    logger.info('正在初始化渲染服务...');

    // 创建必要的目录
    await fs.mkdir(OUTPUTS_DIR, { recursive: true });
    await fs.mkdir(TEMP_DIR, { recursive: true });

    // 初始化 Puppeteer
    await puppeteerService.initialize();

    this.initialized = true;
    logger.info('渲染服务初始化完成');
  }

  /**
   * 渲染 3D 模型为视频
   *
   * 完整的渲染流程：
   * 1. 验证输入文件
   * 2. 使用 Puppeteer 逐帧渲染
   * 3. 使用 FFmpeg 编码为视频
   * 4. 清理临时文件
   *
   * @param options - 渲染选项
   * @param onProgress - 进度回调
   * @returns 渲染结果
   */
  async render(options: RenderOptions, onProgress?: RenderProgressCallback): Promise<RenderResult> {
    // 确保服务已初始化
    if (!this.initialized) {
      await this.initialize();
    }

    // 生成任务 ID
    const taskId = uuidv4();
    logger.info('开始渲染任务', { taskId, options });

    // 报告初始化阶段
    onProgress?.({
      stage: 'initializing',
      percent: 0,
      message: '正在初始化...',
    });

    try {
      // 验证输入文件
      const modelPath = options.modelPath;
      const modelStat = await fs.stat(modelPath);
      if (!modelStat.isFile()) {
        throw new Error(`模型文件不存在: ${modelPath}`);
      }

      // 验证文件扩展名
      const extension = path.extname(modelPath).slice(1).toLowerCase();
      if (!['fbx', 'glb', 'gltf'].includes(extension)) {
        throw new Error(`不支持的模型格式: ${extension}`);
      }

      // 合并配置
      const config = {
        format: options.format || DEFAULT_RENDER_CONFIG.format,
        width: options.width || DEFAULT_RENDER_CONFIG.width,
        height: options.height || DEFAULT_RENDER_CONFIG.height,
        fps: options.fps || DEFAULT_RENDER_CONFIG.fps,
        duration: options.duration ?? DEFAULT_RENDER_CONFIG.duration,
        backgroundColor: options.backgroundColor || DEFAULT_RENDER_CONFIG.backgroundColor,
        animationSpeed: options.animationSpeed || DEFAULT_RENDER_CONFIG.animationSpeed,
        exposure: options.exposure || DEFAULT_RENDER_CONFIG.exposure,
        shadowsEnabled: options.shadowsEnabled ?? DEFAULT_RENDER_CONFIG.shadowsEnabled,
      };

      logger.debug('渲染配置', config);

      // 确定输出路径
      const outputPath =
        options.outputPath || path.join(OUTPUTS_DIR, `${taskId}.${config.format}`);

      // 报告渲染阶段
      onProgress?.({
        stage: 'rendering',
        percent: 5,
        message: '正在渲染帧...',
      });

      // 使用 Puppeteer 渲染帧序列
      const { frames, animationDuration } = await puppeteerService.renderModel(
        modelPath,
        taskId,
        {
          width: config.width,
          height: config.height,
          fps: config.fps,
          duration: config.duration,
          animationSpeed: config.animationSpeed,
          scene: {
            backgroundColor: config.backgroundColor,
            exposure: config.exposure,
            shadowsEnabled: config.shadowsEnabled,
          },
        },
        (current, total) => {
          // 渲染阶段占 5% - 70%
          const percent = 5 + Math.round((current / total) * 65);
          onProgress?.({
            stage: 'rendering',
            percent,
            frame: { current, total },
            message: `正在渲染帧 ${current}/${total}`,
          });
        }
      );

      logger.info('帧渲染完成', { frameCount: frames.length });

      // 报告编码阶段
      onProgress?.({
        stage: 'encoding',
        percent: 70,
        message: '正在编码视频...',
      });

      // 使用 FFmpeg 编码视频
      const framesDir = path.dirname(frames[0]);
      await ffmpegService.framesToVideo(
        framesDir,
        outputPath,
        {
          fps: config.fps,
          format: config.format,
          quality: 80,
        },
        (percent) => {
          // 编码阶段占 70% - 95%
          const totalPercent = 70 + Math.round(percent * 0.25);
          onProgress?.({
            stage: 'encoding',
            percent: totalPercent,
            message: `正在编码视频 ${Math.round(percent)}%`,
          });
        }
      );

      // 获取输出文件信息
      const outputStat = await fs.stat(outputPath);

      // 清理临时文件
      const tempDir = path.join(TEMP_DIR, taskId);
      await fs.rm(tempDir, { recursive: true, force: true });
      logger.debug('临时文件已清理', { tempDir });

      // 报告完成
      onProgress?.({
        stage: 'completed',
        percent: 100,
        message: '渲染完成',
      });

      const result: RenderResult = {
        success: true,
        outputPath,
        duration: animationDuration,
        fileSize: outputStat.size,
      };

      logger.info('渲染任务完成', { taskId, result });
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('渲染任务失败', { taskId, error: errorMessage });

      // 报告失败
      onProgress?.({
        stage: 'failed',
        percent: 0,
        message: `渲染失败: ${errorMessage}`,
      });

      // 尝试清理临时文件
      try {
        const tempDir = path.join(TEMP_DIR, taskId);
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // 忽略清理错误
      }

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * 左右并排拼接两个视频
   *
   * @param options - 拼接选项
   * @param onProgress - 进度回调
   * @returns 拼接结果
   */
  async concat(
    options: ConcatOptions,
    onProgress?: (percent: number) => void
  ): Promise<ConcatResult> {
    // 确保服务已初始化
    if (!this.initialized) {
      await this.initialize();
    }

    const taskId = uuidv4();
    logger.info('开始视频拼接任务', { taskId, options });

    try {
      // 验证输入文件
      await fs.access(options.video1Path);
      await fs.access(options.video2Path);

      // 确定输出路径
      const outputPath = options.outputPath || path.join(OUTPUTS_DIR, `concat_${taskId}.mp4`);

      // 执行拼接
      await ffmpegService.concatSideBySide(
        options.video1Path,
        options.video2Path,
        outputPath,
        {
          outputWidth: options.outputWidth,
          outputHeight: options.outputHeight,
        },
        onProgress
      );

      const result: ConcatResult = {
        success: true,
        outputPath,
      };

      logger.info('视频拼接完成', { taskId, result });
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('视频拼接失败', { taskId, error: errorMessage });

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * 关闭服务
   *
   * 释放所有资源。
   */
  async close(): Promise<void> {
    logger.info('正在关闭渲染服务...');
    await puppeteerService.close();
    this.initialized = false;
    logger.info('渲染服务已关闭');
  }

  /**
   * 检查服务是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// 导出单例实例
export const renderService = new RenderService();
