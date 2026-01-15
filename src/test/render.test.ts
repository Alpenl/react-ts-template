/**
 * @file 渲染功能测试
 * @description 测试 3D 模型渲染为视频的功能
 *
 * 使用方法:
 *   pnpm test:render
 *
 * 或者指定模型文件:
 *   tsx src/test/render.test.ts <model-path>
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
const logger = createLogger('RenderTest');

/**
 * 查找测试模型文件
 *
 * 在 assets 目录下查找可用的测试模型。
 */
async function findTestModel(): Promise<string | null> {
  const assetsDir = path.join(ROOT_DIR, 'assets');

  try {
    // 检查 assets 目录是否存在
    await fs.access(assetsDir);

    // 递归查找模型文件
    const findModels = async (dir: string): Promise<string[]> => {
      const models: string[] = [];
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          const subModels = await findModels(fullPath);
          models.push(...subModels);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (['.fbx', '.glb', '.gltf'].includes(ext)) {
            models.push(fullPath);
          }
        }
      }

      return models;
    };

    const models = await findModels(assetsDir);

    if (models.length > 0) {
      logger.info(`找到 ${models.length} 个测试模型`);
      models.forEach((m) => logger.debug(`  - ${path.relative(ROOT_DIR, m)}`));
      return models[0];
    }
  } catch {
    // assets 目录不存在
  }

  return null;
}

/**
 * 运行渲染测试
 */
async function runTest(): Promise<void> {
  logger.info('========================================');
  logger.info('       3D 模型渲染测试');
  logger.info('========================================');

  // 获取命令行参数中的模型路径
  let modelPath = process.argv[2];

  if (!modelPath) {
    // 默认测试模型路径
    modelPath = path.join(ROOT_DIR, 'input', '升龙拳.fbx');
  }

  // 确保路径是绝对路径
  modelPath = path.resolve(modelPath);

  logger.info(`测试模型: ${modelPath}`);

  // 检查文件是否存在
  try {
    await fs.access(modelPath);
  } catch {
    logger.error(`模型文件不存在: ${modelPath}`);
    process.exit(1);
  }

  // 输出路径
  const outputDir = path.join(ROOT_DIR, 'outputs');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(outputDir, `test_${timestamp}.mp4`);

  logger.info(`输出路径: ${outputPath}`);
  logger.info('');

  try {
    // 执行渲染
    logger.info('开始渲染...');
    const startTime = Date.now();

    const result = await renderService.render(
      {
        modelPath,
        outputPath,
        format: 'mp4',
        width: 1080,
        height: 1920,
        fps: 30,
        duration: 0, // 使用动画时长
        backgroundColor: '#020617',
        animationSpeed: 1.0,
      },
      (progress) => {
        // 显示进度
        const bar = '█'.repeat(Math.floor(progress.percent / 5)) + '░'.repeat(20 - Math.floor(progress.percent / 5));
        process.stdout.write(`\r[${bar}] ${progress.percent}% - ${progress.message || progress.stage}`);

        if (progress.stage === 'completed' || progress.stage === 'failed') {
          console.log(''); // 换行
        }
      }
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    logger.info('');
    logger.info('========================================');

    if (result.success) {
      logger.info('✅ 渲染成功!');
      logger.info(`   输出文件: ${result.outputPath}`);
      logger.info(`   视频时长: ${result.duration?.toFixed(2)}s`);
      logger.info(`   文件大小: ${((result.fileSize || 0) / 1024 / 1024).toFixed(2)} MB`);
      logger.info(`   耗时: ${elapsed}s`);
    } else {
      logger.error('❌ 渲染失败!');
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
