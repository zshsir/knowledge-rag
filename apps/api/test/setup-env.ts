/**
 * e2e 的进程级环境准备：在测试代码跑起来之前把几个必需的环境变量钉死。
 * 生效范围：只有 test/jest-e2e.json 的 setupFiles 引它，也就是只有 `npm run test:e2e` 会执行；
 *      单元测试走 jest.config.js（rootDir=src），不加载本文件——那边的 spec 不起 Nest 容器、不连库。
 * 时机与优先级：setupFiles 早于模块图加载，因此这里的赋值先落 process.env。
 *      随后 AppConfigModule 用 @nestjs/config 读 .env（顺序 apps/api/.env → 仓库根 .env），
 *      而它只把「process.env 里还没有」的键写回去，所以本文件这五项不会被 .env 覆盖。
 *      其余键（DB_HOST / DB_PORT / DB_USER / DB_PASSWORD，以及模型相关的
 *      EMBEDDING_MODEL / EMBEDDING_DIMENSIONS / API_KEY / BASE_URL / MODEL）
 *      都不在这里设，来自 .env 或真实环境变量——本文件刻意不复制一份，避免测试里再养一套配置源，
 *      也避免在这里出现任何真实凭据。
 * 安全边界：测试只连 knowledge_rag_test，绝不指向开发库 knowledge_rag_dev 或生产库 knowledge_rag。
 *      DB_NAME 用 `||` 保留外部覆盖：`npm run test:e2e` 本身已经 cross-env 成同名库，
 *      这条默认值是给「直接跑 jest --config test/jest-e2e.json」这类手工路径兜底的。
 */
// 让 AppConfigService 走测试分支，更关键的是豁免限流：AppThrottlerGuard 在
// NODE_ENV==='test' 时整体直接放行（common/guards/app-throttler.guard.ts），
// 否则 e2e 里反复注册/登录会先撞上 100 次/60 秒的额度而拿到 429
process.env.NODE_ENV = 'test';
// 数据库名：默认落测试库，允许外部覆盖（见文件头的 DB 三库口径）
process.env.DB_NAME = process.env.DB_NAME || 'knowledge_rag_test';
// 与 OriginGuard 比对的期望值：e2e 里 supertest/socket.io 都发这个 Origin，改这里要同步改用例
process.env.APP_ORIGIN = 'http://localhost:5173';
// 把 bcrypt 轮数从默认 12 压到 4：e2e 反复注册真实用户，4 轮够快且不影响哈希逻辑正确性
// （只在本仓库测试里用这个值，生产仍走 config.service.ts 的默认 12）
process.env.BCRYPT_ROUNDS = '4';
// 上传落盘目录：相对 cwd（apps/api）即 apps/api/test/tmp-uploads，已进 .gitignore，
// 这样 e2e 写的文件不会污染真实 STORAGE 目录，也不需要在用例结束后删库外的文件
process.env.UPLOAD_DIR = './test/tmp-uploads';
