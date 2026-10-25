/**
 * e2e 的清库工具：一条 TRUNCATE 把全部业务表清空。
 * 职责：只提供「把 knowledge_rag_test 恢复到干净状态」这一个动作，不做别的（不建表、
 *      不插种子数据、不删磁盘上的上传文件）。
 * 表的清单：列出的 11 张正是 migrations 里 CREATE TABLE 出来的全部业务表
 *      （users、sessions、organizations、memberships、invites、knowledge_bases、
 *      knowledge_base_members、documents、chunks、conversations、messages），
 *      一张不多一张不少；pg-boss 自己那套队列表不在这里，清库不会动队列历史。
 * CASCADE 的必要性：documents → chunks 等有外键，TRUNCATE 单表会被外键挡住；
 *      加 CASCADE 让依赖链上的表一起清，所以这张清单的书写顺序不影响结果。
 * 现状（重要，别误会成「e2e 已经在用它」）：全仓库没有任何 e2e 引用这个函数，
 *      提到它的只有两处注释——test/auth.e2e-spec.ts 的文件头（那里明确写了「目前没有任何 e2e 引用」）
 *      和同目录 create-app.ts 的文件头。用例之间靠各自新建带时间戳邮箱的用户来隔离。
 *      本文件因此是一段未被执行的工具代码，
 *      留着是给后续需要全库隔离的用例；改动它不会被任何测试发现。
 * 安全边界：只应对 knowledge_rag_test 使用——它无条件清空整库数据，
 *      拿它对 knowledge_rag_dev 或生产库 knowledge_rag 执行就是删数据。
 */
import { DatabaseService } from '../../src/database/database.service';

/**
 * 一步到位：对文件头列出的 11 张业务表发一条 TRUNCATE ... CASCADE。
 * 参数只有一个：调用方从容器里取出的 DatabaseService（走应用那套连接池，不另开连接）。
 * 没有做的事：不接表名白名单/参数化（这条 SQL 全字面量，不存在注入面）、
 *      不做事务包裹、不清 pg-boss 队列表、也不删磁盘上的上传文件。
 */
export async function resetDatabase(db: DatabaseService) {
  await db.query(`
    TRUNCATE messages, conversations, chunks, documents,
      knowledge_base_members, knowledge_bases, invites, memberships,
      organizations, sessions, users CASCADE
  `);
}
