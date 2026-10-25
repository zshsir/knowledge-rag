/**
 * e2e 用的「起一个真 API」工厂：起完整 AppModule，交给 supertest 直接打，不占端口。
 * 职责：把散在每个 e2e 文件里的四步装配收敛成一个函数，保证测试用的应用和 main.ts 起的
 *      应用形状一致（全局前缀、cookie 解析、全局校验管道）。
 * 步骤：
 * 1. Test.createTestingModule({ imports: [AppModule] }).compile()：走真实的 Nest DI 图，
 *    所以各模块的 onModuleInit 都会跑——包括 AppConfigService 的必填环境变量校验和
 *    QueueService 的 pg-boss 启动（它连的库由 setup-env.ts 定成 knowledge_rag_test，
 *    pg-boss 自己会在那条连接上建它需要的表，业务表则由 migrate:test 先建好）
 * 2. setGlobalPrefix('api')：与 main.ts 同一前缀，用例里的 URL 才能写成 /api/...
 * 3. use(cookieParser())：会话令牌在 httpOnly cookie 里，没有这行所有鉴权用例都读不到身份
 * 4. useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))：与 main.ts 同参数，
 *    多余字段被丢掉、DTO 类型被转换，测试才不会比生产更宽松
 * 5. await app.init()：初始化 Nest 生命周期但不调 listen，supertest 直接对 http server 发请求，
 *    所以没有真实端口可连——需要真 socket 连接的 realtime.e2e-spec.ts 因此不走本函数
 * 与生产入口的差异（只有这一处）：不加 helmet，所以 e2e 断言不到安全响应头，别在这里加期望。
 * 边界：不建库、不跑迁移（迁移是 npm run pretest:e2e → migrate:test）、不清库
 *      （同目录的 resetDatabase 目前是未被引用的工具，见它自己的文件头），也不关应用
 *      ——afterAll 里的 app.close() 由各 suite 自己调。
 * 消费方：9 个 e2e suite 里有 7 个走本函数（auth / conversations / database / documents /
 *      health / knowledge-bases / organizations）。另两个 ingestion.e2e-spec.ts 与
 *      realtime.e2e-spec.ts 需要 overrideProvider（换掉嵌入 provider / 对话模型 provider），
 *      Test 链必须自己写，于是把上面这几行各抄了一遍（realtime 还多一步 listen(0)）——
 *      现状是重复，改本函数时记得同步核对那两个文件。
 */
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from '../../src/app.module';

export async function createTestApp(): Promise<INestApplication> {
  // 步骤 1：编译完整 AppModule（含守卫、过滤器、队列与数据库连接池的真实实例）
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  // 步骤 2~4：对齐 main.ts 的三项装配
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // 步骤 5：init 而不 listen，交给 supertest
  await app.init();
  return app;
}
