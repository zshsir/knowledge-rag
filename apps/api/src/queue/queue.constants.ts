/**
 * 队列的对外契约：队列名 + 任务负载类型。单独一个文件是为了让「投递方」和「消费方」
 * 引用同一个常量与同一个接口，不至于各写一份字符串。
 *
 * 队列名 'document.ingest'：pg-boss 按名字建队列并以它作主键（pgboss.queue 的 PRIMARY KEY (name)），
 * send 与 work 两侧必须用同一个值；改名等于换一条队列，旧队列里已排队的任务不再有人消费。
 *
 * 职责边界：只有类型与字面量，没有 IO，因此两侧（API 进程与 worker 进程）都能零副作用地导入。
 */
export const DOCUMENT_QUEUE = 'document.ingest';

/**
 * 一个「把文档变成可检索切片」的任务负载。
 * 只放四个 id 不放文件内容：文件在磁盘上，worker 按 documents 行里的 storageKey 自己回读，
 * 这样任务体不会随文档大小膨胀，PG 里存的行也一直很小。
 * 四个字段各自的用途：documentId + orgId 定位 documents 行（worker 侧 SQL 带 org_id 过滤，
 * 传错 orgId 就是查不到 → 直接跳过），kbId 写进 chunks 行与实时通知，uploadedBy 决定
 * document:status 额外推给谁（上传者的 user 房间，见 realtime.gateway）。
 * 这就是两侧的全部协议：加字段要同步改 ingestion 的取数与 pg_notify 的载荷，删字段会让已入队的旧任务读到 undefined。
 */
export interface IngestJob {
  documentId: string;
  orgId: string;
  kbId: string;
  uploadedBy: string;
}
