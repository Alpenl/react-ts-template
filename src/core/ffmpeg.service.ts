/**
 * @file FFmpeg 服务
 * @description 使用 FFmpeg 进行视频编码和处理
 *
 * 这个服务负责：
 * 1. 将 PNG 帧序列编码为 MP4 或 GIF 视频
 * 2. 左右并排拼接两个视频
 */

import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs/promises';
import path from 'path';

import { FFMPEG_CONFIG } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

// 创建日志记录器
const logger = createLogger('FFmpegService');

/**
 * 视频编码配置
 */
export interface EncodeConfig {
  /** 帧率 */
  fps: number;
  /** 输出格式 */
  format: 'mp4' | 'gif';
  /** 质量（1-100，越大越好） */
  quality?: number;
}

/**
 * 视频拼接配置
 */
export interface ConcatConfig {
  /** 输出宽度 */
  outputWidth?: number;
  /** 输出高度 */
  outputHeight?: number;
}

/**
 * 进度回调
 */
export type ProgressCallback = (percent: number) => void;

/**
 * FFmpeg 服务类
 *
 * 提供视频编码和处理功能。
 */
export class FFmpegService {
  /**
   * 将帧序列编码为视频
   *
   * @param framesDir - 帧文件目录
   * @param outputPath - 输出视频路径
   * @param config - 编码配置
   * @param onProgress - 进度回调
   */
  async framesToVideo(
    framesDir: string,
    outputPath: string,
    config: EncodeConfig,
    onProgress?: ProgressCallback
  ): Promise<void> {
    logger.info('开始视频编码', { framesDir, outputPath, config });

    // 帧文件模式
    const inputPattern = path.join(framesDir, 'frame_%06d.png');

    // 确保输出目录存在
    const outputDir = path.dirname(outputPath);
    await fs.mkdir(outputDir, { recursive: true });

    return new Promise((resolve, reject) => {
      let command = ffmpeg()
        .input(inputPattern)
        .inputFPS(config.fps);

      if (config.format === 'mp4') {
        // MP4 编码配置
        // 计算 CRF 值：quality 100 -> CRF 18, quality 1 -> CRF 51
        const crf = config.quality
          ? Math.round(51 - (config.quality / 100) * 33)
          : FFMPEG_CONFIG.crf;

        command = command
          .videoCodec(FFMPEG_CONFIG.videoCodec)
          .outputOptions([
            `-pix_fmt ${FFMPEG_CONFIG.pixelFormat}`,
            `-crf ${crf}`,
            `-preset ${FFMPEG_CONFIG.preset}`,
            // 确保视频可以在大多数播放器中播放
            '-movflags +faststart',
          ]);

        logger.debug('MP4 编码参数', { crf, preset: FFMPEG_CONFIG.preset });
      } else if (config.format === 'gif') {
        // GIF 编码配置
        // 使用调色板优化 GIF 质量
        const scale = 'scale=540:-1:flags=lanczos';
        const palette = 'split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse';

        command = command.outputOptions([
          '-vf',
          `fps=${Math.min(config.fps, 15)},${scale},${palette}`,
        ]);

        logger.debug('GIF 编码参数', { fps: Math.min(config.fps, 15) });
      }

      command
        .output(outputPath)
        .on('start', (commandLine) => {
          logger.debug('FFmpeg 命令', { command: commandLine });
        })
        .on('progress', (progress) => {
          if (onProgress && progress.percent) {
            onProgress(progress.percent);
          }
        })
        .on('end', () => {
          logger.info('视频编码完成', { outputPath });
          resolve();
        })
        .on('error', (err) => {
          logger.error('视频编码失败', { error: err.message });
          reject(err);
        })
        .run();
    });
  }

  /**
   * 左右并排拼接两个视频
   *
   * 将两个视频水平拼接在一起，用于对比观看。
   *
   * @param video1Path - 左侧视频路径
   * @param video2Path - 右侧视频路径
   * @param outputPath - 输出视频路径
   * @param config - 拼接配置
   * @param onProgress - 进度回调
   */
  async concatSideBySide(
    video1Path: string,
    video2Path: string,
    outputPath: string,
    config?: ConcatConfig,
    onProgress?: ProgressCallback
  ): Promise<void> {
    logger.info('开始视频拼接', { video1Path, video2Path, outputPath, config });

    // 默认输出尺寸
    const outputWidth = config?.outputWidth || 1920;
    const outputHeight = config?.outputHeight || 1080;

    // 每个视频的宽度（左右各占一半）
    const halfWidth = Math.floor(outputWidth / 2);

    // 确保输出目录存在
    const outputDir = path.dirname(outputPath);
    await fs.mkdir(outputDir, { recursive: true });

    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(video1Path)
        .input(video2Path)
        // 使用复杂滤镜进行拼接
        // 1. 将两个视频缩放到相同高度，宽度为输出宽度的一半
        // 2. 水平堆叠两个视频
        .complexFilter([
          `[0:v]scale=${halfWidth}:${outputHeight}:force_original_aspect_ratio=decrease,pad=${halfWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2[v0]`,
          `[1:v]scale=${halfWidth}:${outputHeight}:force_original_aspect_ratio=decrease,pad=${halfWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2[v1]`,
          `[v0][v1]hstack=inputs=2[v]`,
        ])
        .outputOptions(['-map', '[v]'])
        .videoCodec(FFMPEG_CONFIG.videoCodec)
        .outputOptions([
          `-pix_fmt ${FFMPEG_CONFIG.pixelFormat}`,
          `-crf ${FFMPEG_CONFIG.crf}`,
          `-preset ${FFMPEG_CONFIG.preset}`,
          '-movflags +faststart',
        ])
        .output(outputPath)
        .on('start', (commandLine) => {
          logger.debug('FFmpeg 命令', { command: commandLine });
        })
        .on('progress', (progress) => {
          if (onProgress && progress.percent) {
            onProgress(progress.percent);
          }
        })
        .on('end', () => {
          logger.info('视频拼接完成', { outputPath });
          resolve();
        })
        .on('error', (err) => {
          logger.error('视频拼接失败', { error: err.message });
          reject(err);
        })
        .run();
    });
  }

  /**
   * 获取视频信息
   *
   * @param videoPath - 视频文件路径
   * @returns 视频信息
   */
  async getVideoInfo(videoPath: string): Promise<{
    duration: number;
    width: number;
    height: number;
    fps: number;
  }> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(err);
          return;
        }

        const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
        if (!videoStream) {
          reject(new Error('视频中没有找到视频流'));
          return;
        }

        // 解析帧率
        let fps = 30;
        if (videoStream.r_frame_rate) {
          const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
          fps = den ? num / den : num;
        }

        resolve({
          duration: metadata.format.duration || 0,
          width: videoStream.width || 0,
          height: videoStream.height || 0,
          fps,
        });
      });
    });
  }
}

// 导出单例实例
export const ffmpegService = new FFmpegService();
