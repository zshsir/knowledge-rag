/**
 * API 进程入口：把 AppModule 装配成 HTTP 服务并监听端口。
 *
 * 职责边界：
 * - 只做「进程级」的启动编排——那些必须在全局生效、且不适合写在模块里的中间件
 * - Origin 校验与异常过滤不写在这里，它们作为 APP_GUARD / APP_FILTER 由 app.module.ts 注册，
 *   这样测试里用 TestingModule 起的应用也能拿到同一套安全边界
 * - 刻意不调用 enableCors：前后端同源部署（APP_ORIGIN 就是浏览器地址栏那个源），
 *   跨站写请求交给 Origin 守卫拒绝即可，放开 CORS 只会白白扩大攻击面
 * - 不含业务路由；入口层也不通过依赖注入取配置，端口直接读环境变量
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  // 步骤 1：创建应用实例（此时 DI 图构建完成，各模块的 onModuleInit 会校验必填环境变量）
  const app = await NestFactory.create(AppModule);

  // 步骤 2：统一加 /api 前缀，前端只需认一个前缀，也便于反向代理把非 /api 流量全部交给静态站
  app.setGlobalPrefix('api');

  // 步骤 3：cookie-parser——会话令牌放在 httpOnly cookie 里，没有它所有鉴权请求都读不到身份
  app.use(cookieParser());

  // 步骤 4：helmet 设置一组安全响应头（CSP、X-Frame-Options 等），零成本挡住一批常见攻击面
  app.use(helmet());

  // 步骤 5：全局校验管道。
  // whitelist=true 丢掉 DTO 未声明的字段，防止请求方靠多余字段污染入库数据；
  // transform=true 把字符串按 DTO 类型转成数字/布尔，控制器拿到的才是声明的类型。
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // 步骤 6：监听端口。入口刻意不依赖 DI，直接读原始环境变量，
  // 默认值 3300 与 AppConfigService.port 的默认值必须保持一致，否则本地起的服务和配置里认的端口会不是同一个。
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3300);
}
// bootstrap 是 fire-and-forget：Node 靠事件循环保活，进程不需要 await 返回值
void bootstrap();
