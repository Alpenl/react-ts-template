/**
 * @file 配置文件
 * @description 定义渲染服务的默认配置和环境变量
 */

import path from 'path';
import { fileURLToPath } from 'url';

// 获取当前文件目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 项目根目录
 */
export const ROOT_DIR = path.resolve(__dirname, '../..');

/**
 * 渲染器目录（编译后的浏览器端代码）
 */
export const RENDERER_DIR = path.join(ROOT_DIR, 'public', 'renderer');

/**
 * 渲染器 HTML 文件路径
 */
export const RENDERER_HTML = path.join(RENDERER_DIR, 'index.html');

/**
 * 上传文件临时目录
 */
export const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');

/**
 * 输出文件目录
 */
export const OUTPUTS_DIR = path.join(ROOT_DIR, 'outputs');

/**
 * 临时文件目录（帧序列等）
 */
export const TEMP_DIR = path.join(ROOT_DIR, 'temp');

/**
 * 默认渲染配置
 */
export const DEFAULT_RENDER_CONFIG = {
  /** 输出格式 */
  format: 'mp4' as const,
  /** 输出宽度（9:16 竖屏） */
  width: 1080,
  /** 输出高度 */
  height: 1920,
  /** 帧率 */
  fps: 30,
  /** 视频时长（秒），0 表示使用动画时长 */
  duration: 0,
  /** 背景颜色 */
  backgroundColor: '#020617',
  /** 动画播放速度 */
  animationSpeed: 1.0,
  /** 曝光度 */
  exposure: 1.5,
  /** 是否启用阴影 */
  shadowsEnabled: true,
};

/**
 * Puppeteer 配置
 */
export const PUPPETEER_CONFIG = {
  /** 是否使用 headless 模式 */
  headless: true,
  /** 启动参数 */
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--use-gl=swiftshader', // 使用软件渲染
    '--disable-web-security',
    '--allow-file-access-from-files',
  ],
  /** 默认视口大小 */
  defaultViewport: {
    width: 1080,
    height: 1920,
  },
};

/**
 * FFmpeg 配置
 */
export const FFMPEG_CONFIG = {
  /** MP4 编码器 */
  videoCodec: 'libx264',
  /** 像素格式 */
  pixelFormat: 'yuv420p',
  /** 编码预设 */
  preset: 'medium',
  /** 默认 CRF 值（质量，越小越好，范围 0-51） */
  crf: 23,
};

/**
 * 日志配置
 */
export const LOG_CONFIG = {
  /** 日志级别 */
  level: process.env.LOG_LEVEL || 'info',
  /** 是否美化输出 */
  pretty: process.env.NODE_ENV !== 'production',
};
