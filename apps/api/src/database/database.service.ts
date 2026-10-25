/**
 * 数据库访问底座：持有一个 pg 连接池，对外只提供「执行 SQL」和「开事务」两件事。
 *
 * 职责边界：
 * - 不写任何具体 SQL、不理解业务表结构，那些属于 repositories/ 下的仓储
 * - 不做重试/熔断：连接级故障直接抛给调用方，由 HTTP 层或队列层决定怎么反馈
 * - 不管理 schema 版本，迁移是独立脚本 migrate.ts
 *
 * 连接池参数（max=10）要留意的取舍：API 进程与 worker 进程各建一个池，
 * 总连接数 = 实例数 × 10，扩缩容前先确认 Postgres 的 max_connections 扛得住。
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { AppConfigService } from '../config/config.service';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(config: AppConfigService) {
    // 连接参数完全来自配置服务；max=10 是每进程上限，空闲连接 30s 回收以免长期占用服务端槽位
    this.pool = new Pool({
      ...config.db,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  /**
   * 单条语句查询（自动从池里借还连接）。
   * 走参数化 $1/$2，禁止字符串拼接——多租户条件全靠参数传入，拼接会打开注入风险。
   */
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  /**
   * 在一个事务里执行一组读写。
   *
   * 步骤：
   * 1. BEGIN → 回调 → COMMIT，回调抛错则 ROLLBACK 并原样抛出，绝不吞异常
   * 2. 回调必须用入参 client 发 SQL：连接池里其他连接看不到这个事务，用 this.query 会绕过事务原子性
   * 3. finally 里 release 归还连接，包括抛错的路径，否则连接泄漏到池耗尽
   *
   * 用于「一条失败要全部回滚」的组合写，例如删除知识库时连带清理成员与文档。
   */
  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      // 回滚后继续上抛：调用方需要知道写入没生效，静默回滚等于数据悄悄丢
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 进程退出前关闭连接池，避免遗留连接让 Postgres 侧长期处于 idle 状态 */
  async onModuleDestroy() {
    await this.pool.end();
  }
}
