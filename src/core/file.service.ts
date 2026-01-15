/**
 * @file 文件服务
 * @description 文件管理相关功能
 */

import fs from 'fs/promises';
import path from 'path';

import { OUTPUTS_DIR, TEMP_DIR, UPLOADS_DIR } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

// 创建日志记录器
const logger = createLogger('FileService');

/**
 * 文件服务类
 *
 * 提供文件管理功能，包括临时文件清理、目录管理等。
 */
export class FileService {
  /**
   * 初始化目录结构
   *
   * 创建必要的目录。
   */
  async initDirectories(): Promise<void> {
    const dirs = [UPLOADS_DIR, OUTPUTS_DIR, TEMP_DIR];

    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
      logger.debug('目录已创建', { dir });
    }

    logger.info('目录结构初始化完成');
  }

  /**
   * 清理临时文件
   *
   * 删除指定时间之前的临时文件。
   *
   * @param maxAgeMs - 最大保留时间（毫秒），默认 1 小时
   */
  async cleanupTempFiles(maxAgeMs = 3600000): Promise<void> {
    logger.info('开始清理临时文件', { maxAgeMs });

    const now = Date.now();
    let cleanedCount = 0;

    try {
      const entries = await fs.readdir(TEMP_DIR, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirPath = path.join(TEMP_DIR, entry.name);
          const stat = await fs.stat(dirPath);

          if (now - stat.mtimeMs > maxAgeMs) {
            await fs.rm(dirPath, { recursive: true, force: true });
            cleanedCount++;
            logger.debug('已删除临时目录', { dir: entry.name });
          }
        }
      }

      logger.info('临时文件清理完成', { cleanedCount });
    } catch (error) {
      logger.error('清理临时文件失败', { error });
    }
  }

  /**
   * 获取文件大小
   *
   * @param filePath - 文件路径
   * @returns 文件大小（字节）
   */
  async getFileSize(filePath: string): Promise<number> {
    const stat = await fs.stat(filePath);
    return stat.size;
  }

  /**
   * 检查文件是否存在
   *
   * @param filePath - 文件路径
   * @returns 是否存在
   */
  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 删除文件
   *
   * @param filePath - 文件路径
   */
  async deleteFile(filePath: string): Promise<void> {
    await fs.unlink(filePath);
    logger.debug('文件已删除', { filePath });
  }

  /**
   * 复制文件
   *
   * @param src - 源文件路径
   * @param dest - 目标文件路径
   */
  async copyFile(src: string, dest: string): Promise<void> {
    await fs.copyFile(src, dest);
    logger.debug('文件已复制', { src, dest });
  }

  /**
   * 获取文件扩展名
   *
   * @param filePath - 文件路径
   * @returns 扩展名（不含点号，小写）
   */
  getExtension(filePath: string): string {
    return path.extname(filePath).slice(1).toLowerCase();
  }
}

// 导出单例实例
export const fileService = new FileService();
