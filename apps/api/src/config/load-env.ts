/**
 * 给非 Nest 进程用的极简环境变量加载器（目前只有迁移脚本用）。
 *
 * 职责边界：
 * - 迁移脚本是独立进程，拿不到 Nest 的 ConfigModule，所以自己按 `cwd/.env` → `cwd/../../.env` 顺序读文件
 * - 只搬数据库连接所需的最小字段，不提供 llm / 上传等业务配置，避免脚本和主应用共享一套启动依赖
 * - 不做默认值以外的兜底：必填项缺失就抛错，宁可迁移不执行也不要连错库
 */
import { loadEnvFile } from 'node:process';
import { join } from 'node:path';

try {
  // 步骤 1：优先读当前工作目录的 .env（在 apps/api 下直接跑 npm run migrate 时的位置）
  loadEnvFile(join(process.cwd(), '.env'));
} catch {
  // 这个工作目录没有 .env：不是错误，继续尝试上一级
}

try {
  // 步骤 2：兜底读仓库根的 .env；容器里环境变量由 compose 注入，两个文件都不存在，同样跳过
  loadEnvFile(join(process.cwd(), '../../.env'));
} catch {
  // 生产环境直接靠真实环境变量启动，没有 .env 文件属于正常情况
}

/**
 * 读出迁移需要的数据库连接参数。
 *
 * 步骤：
 * 1. 四项必填逐个检查，任一为空立刻抛错并指明变量名——否则 pg 会连到默认库，报错更难定位
 * 2. DB_PORT / DB_SSL 用默认值（5432、不加密），本机 docker-compose 无需额外配置
 */
export function loadConfig() {
  const required = (key: string) => {
    const value = process.env[key];
    if (!value) {
      throw new Error(`Missing required env ${key}`);
    }
    return value;
  };

  return {
    db: {
      host: required('DB_HOST'),
      port: Number(process.env.DB_PORT ?? 5432),
      user: required('DB_USER'),
      password: required('DB_PASSWORD'),
      database: required('DB_NAME'),
      ssl: process.env.DB_SSL === 'true',
    },
  };
}
