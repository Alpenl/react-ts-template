/**
 * @file 应用入口
 * @description 渲染服务的主入口文件，用于测试和开发
 *
 * 这个文件提供了一个简单的命令行接口来测试渲染功能。
 * 在生产环境中，将通过 RabbitMQ 接收任务。
 */

import path from 'path';

import { renderService } from './core/render.service.js';
import { createLogger } from './utils/logger.js';

// 创建日志记录器
const logger = createLogger('Main');

/**
 * 主函数
 *
 * 解析命令行参数并执行相应的操作。
 */
async function main(): Promise<void> {
  logger.info('3D 模型渲染服务启动');
  logger.info('使用方法:');
  logger.info('  渲染测试: pnpm test:render');
  logger.info('  拼接测试: pnpm test:concat');

  // 获取命令行参数
  const args = process.argv.slice(2);

  if (args.length === 0) {
    logger.info('没有指定操作，服务进入待机状态');
    logger.info('按 Ctrl+C 退出');

    // 初始化服务
    await renderService.initialize();

    // 保持进程运行
    process.on('SIGINT', async () => {
      logger.info('收到退出信号，正在关闭服务...');
      await renderService.close();
      process.exit(0);
    });

    return;
  }

  // 处理命令
  const command = args[0];

  switch (command) {
    case 'render': {
      // 渲染命令: node dist/index.js render <model-path> [output-path]
      const modelPath = args[1];
      const outputPath = args[2];

      if (!modelPath) {
        logger.error('请指定模型文件路径');
        process.exit(1);
      }

      await testRender(modelPath, outputPath);
      break;
    }

    case 'concat': {
      // 拼接命令: node dist/index.js concat <video1> <video2> [output-path]
      const video1 = args[1];
      const video2 = args[2];
      const outputPath = args[3];

      if (!video1 || !video2) {
        logger.error('请指定两个视频文件路径');
        process.exit(1);
      }

      await testConcat(video1, video2, outputPath);
      break;
    }

    default:
      logger.error(`未知命令: ${command}`);
      logger.info('可用命令: render, concat');
      process.exit(1);
  }
}

/**
 * 测试渲染功能
 */
async function testRender(modelPath: string, outputPath?: string): Promise<void> {
  logger.info('开始渲染测试', { modelPath, outputPath });

  try {
    const result = await renderService.render(
      {
        modelPath: path.resolve(modelPath),
        outputPath: outputPath ? path.resolve(outputPath) : undefined,
        format: 'mp4',
        width: 1080,
        height: 1920,
        fps: 30,
      },
      (progress) => {
        logger.info(`[${progress.stage}] ${progress.percent}% - ${progress.message || ''}`);
      }
    );

    if (result.success) {
      logger.info('渲染成功', {
        outputPath: result.outputPath,
        duration: result.duration,
        fileSize: result.fileSize,
      });
    } else {
      logger.error('渲染失败', { error: result.error });
    }
  } finally {
    await renderService.close();
  }
}

/**
 * 测试拼接功能
 */
async function testConcat(video1: string, video2: string, outputPath?: string): Promise<void> {
  logger.info('开始拼接测试', { video1, video2, outputPath });

  try {
    const result = await renderService.concat(
      {
        video1Path: path.resolve(video1),
        video2Path: path.resolve(video2),
        outputPath: outputPath ? path.resolve(outputPath) : undefined,
      },
      (percent) => {
        logger.info(`拼接进度: ${Math.round(percent)}%`);
      }
    );

    if (result.success) {
      logger.info('拼接成功', { outputPath: result.outputPath });
    } else {
      logger.error('拼接失败', { error: result.error });
    }
  } finally {
    await renderService.close();
  }
}

// 运行主函数
main().catch((error) => {
  logger.error('程序异常退出', { error });
  process.exit(1);
});
