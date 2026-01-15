/**
 * @file 渲染器构建脚本
 * @description 使用 esbuild 将渲染器代码打包成浏览器可用的 JS 文件
 *
 * 这个脚本会：
 * 1. 将 src/renderer/renderer.ts 及其依赖打包成单个 JS 文件
 * 2. 将 Three.js 库内联到输出文件中
 * 3. 复制 index.html 到输出目录
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// 获取当前文件目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 项目根目录
const rootDir = path.resolve(__dirname, '..');

// 源文件目录
const srcDir = path.join(rootDir, 'src', 'renderer');

// 输出目录
const outDir = path.join(rootDir, 'public', 'renderer');

/**
 * 构建渲染器
 */
async function buildRenderer(): Promise<void> {
  console.log('🔨 开始构建渲染器...');
  console.log(`   源目录: ${srcDir}`);
  console.log(`   输出目录: ${outDir}`);

  // 确保输出目录存在
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
    console.log('   ✅ 创建输出目录');
  }

  try {
    // 使用 esbuild 打包渲染器
    const result = await esbuild.build({
      entryPoints: [path.join(srcDir, 'renderer.ts')],
      bundle: true,
      outfile: path.join(outDir, 'renderer.js'),
      format: 'esm',
      target: ['chrome100', 'firefox100', 'safari15'],
      platform: 'browser',
      sourcemap: true,
      minify: false, // 开发时不压缩，方便调试
      metafile: true,
      // 将 Three.js 打包进去
      external: [],
      // 定义环境变量
      define: {
        'process.env.NODE_ENV': '"production"',
      },
      // 日志级别
      logLevel: 'info',
    });

    // 输出构建信息
    const outputs = Object.keys(result.metafile?.outputs || {});
    console.log('   ✅ 打包完成');
    outputs.forEach((output) => {
      const stats = result.metafile?.outputs[output];
      if (stats) {
        const sizeKB = (stats.bytes / 1024).toFixed(2);
        console.log(`      - ${path.basename(output)}: ${sizeKB} KB`);
      }
    });

    // 复制 index.html
    const htmlSrc = path.join(srcDir, 'index.html');
    const htmlDest = path.join(outDir, 'index.html');
    fs.copyFileSync(htmlSrc, htmlDest);
    console.log('   ✅ 复制 index.html');

    console.log('🎉 渲染器构建完成！');
  } catch (error) {
    console.error('❌ 构建失败:', error);
    process.exit(1);
  }
}

// 执行构建
buildRenderer();
