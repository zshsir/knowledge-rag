/**
 * 健康探针控制器：GET /api/health（前缀 api 来自 main.ts 的 setGlobalPrefix）。
 * 职责：只回答「这个 API 进程现在能不能干活」——探两样东西：Postgres 是否可查询、
 *      入库队列是否已启动。
 * 不做什么：不查任何业务表、不探对象存储/模型服务/Redis、不返回版本号或运行指标，
 *          也不做「只读流量摘除」这类精细的就绪分级；读写权限、租户数据一律不涉及。
 * 匿名可达：@Public() 让它豁免全局 AuthGuard 的登录校验（元数据键 IS_PUBLIC_KEY，
 *      判据在 common/guards/auth.guard.ts），否则容器启动阶段探针会一直拿到 401。
 *      注意 @Public() 只豁免登录：全局限流（app.module 的 100 次/60 秒）与 Origin 守卫仍在链上，
 *      只是 OriginGuard 对 GET 直接放过。
 * 部署侧后果：deploy/docker-compose.yml 的 api 健康检查就是这个 URL，脚本只判 `r.ok`（非 2xx 全算失败），
 *      所以下面队列分支抛出的 503 会把整个 api 容器标成 unhealthy——这是有意的：
 *      队列没起来时上传接口同样会 503，探针提前反映比静默成功更接近真相。
 *      探针按 interval 30s 轮询，折算约 2 次/分钟，远小于全局限流额度。
 */
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { DatabaseService } from '../database/database.service';
import { QueueService } from '../queue/queue.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly queue: QueueService,
  ) {}

  /**
   * 探一次。步骤：
   * 1. `SELECT 1`：真正走一次连接池取连接并发 SQL，池子挂了这里就抛（pg 的驱动错误会被
   *    AllExceptionsFilter 收敛成 5xx，探针拿不到 200 即判失败）
   * 2. 读 QueueService.health()：它只看 QueueService 内部那个 started 布尔量，
   *    取值是 'ok' | 'down'，不向 pg-boss 发请求、也不数积压
   * 3. queue 不是 'ok' 就抛 503「任务队列未就绪」——刻意不把 db ok + queue down 包成 200，
   *    因为 compose 探针只判状态码，返回体没人读
   * 4. 两项都过才返回 { status:'ok', db:'ok', queue }；status 与 db 恒为 'ok' 字面量
   *    （走到这一步才会 return，失败路径全靠异常表达），queue 字段带着上一步的原值
   * 已知缺口：第 3 步的 503 分支与返回体的 queue 字段在全仓库 e2e 里没有断言，
   * test/health.e2e-spec.ts 只覆盖「匿名可达 + status/db 为 ok」。
   */
  @Public()
  @Get()
  async check() {
    // 步骤 1：库连通性
    await this.db.query('SELECT 1');
    // 步骤 2：队列启动标记
    const queue = this.queue.health();
    // 步骤 3：队列未就绪 → 503
    if (queue !== 'ok') {
      throw new ServiceUnavailableException('任务队列未就绪');
    }
    // 步骤 4：成功响应
    return { status: 'ok', db: 'ok', queue };
  }
}
