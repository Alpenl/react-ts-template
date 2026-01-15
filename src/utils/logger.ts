/**
 * @file 日志工具
 * @description 基于 pino 的日志记录器，提供简化的 API
 */

import pino from 'pino';

import { LOG_CONFIG } from '../config/index.js';

/**
 * 创建基础日志记录器
 */
const baseLogger = pino({
  level: LOG_CONFIG.level,
  transport: LOG_CONFIG.pretty
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});

/**
 * 日志记录器接口
 *
 * 提供简化的 API，支持 logger.info('message', { data }) 的调用方式
 */
export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/**
 * 创建日志包装器
 *
 * 将 pino 的 API (obj, msg) 转换为更直观的 (msg, obj) 形式
 */
function createLoggerWrapper(pinoLogger: pino.Logger): Logger {
  return {
    debug(msg: string, data?: Record<string, unknown>) {
      if (data) {
        pinoLogger.debug(data, msg);
      } else {
        pinoLogger.debug(msg);
      }
    },
    info(msg: string, data?: Record<string, unknown>) {
      if (data) {
        pinoLogger.info(data, msg);
      } else {
        pinoLogger.info(msg);
      }
    },
    warn(msg: string, data?: Record<string, unknown>) {
      if (data) {
        pinoLogger.warn(data, msg);
      } else {
        pinoLogger.warn(msg);
      }
    },
    error(msg: string, data?: Record<string, unknown>) {
      if (data) {
        pinoLogger.error(data, msg);
      } else {
        pinoLogger.error(msg);
      }
    },
  };
}

/**
 * 创建带命名空间的日志记录器
 *
 * @param namespace - 日志命名空间（通常是模块名）
 * @returns 日志记录器实例
 */
export function createLogger(namespace: string): Logger {
  const childLogger = baseLogger.child({ module: namespace });
  return createLoggerWrapper(childLogger);
}

/**
 * 默认日志记录器
 */
export const logger = createLoggerWrapper(baseLogger);
