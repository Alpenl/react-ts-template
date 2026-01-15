/**
 * @file 视频拼接功能测试
 * @description 测试左右并排拼接两个视频的功能
 *
 * 使用方法:
 *   pnpm test:concat
 *
 * 或者指定视频文件:
 *   tsx src/test/concat.test.ts <video1> <video2>
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { renderService } from '../core/render.service.js';
import { createLogger } from '../utils/logger.js';

// 获取当前文件目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 项目根目录
const ROOT_DIR = path.resolve(__dirname, '../..');

// 创建日志记录器
const logger = createLogger('ConcatTest');

/**
 * 查找测试视频文件
 *
 * 在 outputs 目录下查找可用的测试视频。
 */
async function findTestVideos(): Promise<string[]> {
  const outputsDir = path.join(ROOT_DIR, 'outputs');

  try {
    await fs.access(outputsDir);

    const entries = await fs.readdir(outputsDir, { withFileTypes: true });
    const videos: string[] = [];

    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.mp4', '.webm'].includes(ext)) {
          videos.push(path.join(outputsDir, entry.name));
        }
      }
    }

    return videos;
  } catch {
    return [];
  }
}

/**
 * 运行拼接测试
 */
async function runTest(): Promise<void> {
  logger.info('========================================');
  logger.info('       视频拼接测试');
  logger.info('========================================');

  // 获取命令行参数中的视频路径
  let video1Path = process.argv[2];
  let video2Path = process.argv[3];

  if (!video1Path || !video2Path) {
    // 尝试查找测试视频
    logger.info('未指定视频文件，正在查找测试视频...');
    const videos = await findTestVideos();

    if (videos.length < 2) {
      logger.error('未找到足够的测试视频文件（需要至少 2 个）');
      logger.info('请先运行渲染测试生成视频，或通过命令行参数指定:');
      logger.info('  tsx src/test/concat.test.ts <video1> <video2>');
      process.exit(1);
    }

    video1Path = videos[0];
    video2Path = videos[1];

    logger.info(`找到 ${videos.length} 个测试视频`);
  }

  // 确保路径是绝对路径
  video1Path = path.resolve(video1Path);
  video2Path = path.resolve(video2Path);

  logger.info(`视频 1: ${video1Path}`);
  logger.info(`视频 2: ${video2Path}`);

  // 检查文件是否存在
  try {
    await fs.access(video1Path);
    await fs.access(video2Path);
  } catch {
    logger.error('视频文件不存在');
    process.exit(1);
  }

  // 输出路径
  const outputDir = path.join(ROOT_DIR, 'outputs');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(outputDir, `concat_${timestamp}.mp4`);

  logger.info(`输出路径: ${outputPath}`);
  logger.info('');

  try {
    // 执行拼接
    logger.info('开始拼接...');
    const startTime = Date.now();

    const result = await renderService.concat(
      {
        video1Path,
        video2Path,
        outputPath,
        outputWidth: 1920,
        outputHeight: 1080,
      },
      (percent) => {
        // 显示进度
        const bar = '█'.repeat(Math.floor(percent / 5)) + '░'.repeat(20 - Math.floor(percent / 5));
        process.stdout.write(`\r[${bar}] ${Math.round(percent)}%`);

        if (percent >= 100) {
          console.log(''); // 换行
        }
      }
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    logger.info('');
    logger.info('========================================');

    if (result.success) {
      // 获取输出文件大小
      const stat = await fs.stat(result.outputPath!);
      const sizeMB = (stat.size / 1024 / 1024).toFixed(2);

      logger.info('✅ 拼接成功!');
      logger.info(`   输出文件: ${result.outputPath}`);
      logger.info(`   文件大小: ${sizeMB} MB`);
      logger.info(`   耗时: ${elapsed}s`);
    } else {
      logger.error('❌ 拼接失败!');
      logger.error(`   错误: ${result.error}`);
    }

    logger.info('========================================');
  } finally {
    // 关闭服务
    await renderService.close();
  }
}

// 运行测试
runTest().catch((error) => {
  logger.error('测试异常', { error });
  process.exit(1);
});
