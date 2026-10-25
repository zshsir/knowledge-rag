/**
 * 应用配置门面：把散乱的环境变量收敛成一组带默认值、带类型的只读 getter。
 *
 * 职责边界：
 * - 只做「读环境变量 + 填默认值 + 校验必填 + 校验数值配置」，不缓存、不热更新，进程启动后取值就不再变
 * - 业务代码不直接读 process.env，一律注入本服务，避免环境变量名散落各处
 *   （确有几个例外：load-env.ts 与 migrate.ts 是独立进程、main.ts 取端口、限流守卫认 NODE_ENV=test）
 * - 只校验「这个值能不能用」，不校验「这个值合不合理」（例如 800 还是 8000 召回更好），那属于业务调参
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppConfigService implements OnModuleInit {
  constructor(private readonly env: ConfigService) {}

  /**
   * 启动即校验，缺一项或配错一项就直接让进程起不来。
   *
   * 步骤：
   * 1. 逐个 getOrThrow 数据库四项——连不上库的实例没有任何意义，早失败比第一个请求 500 更好排查
   * 2. 校验 APP_ORIGIN：Origin 守卫拿它逐个比对请求来源，漏配等于跨站防护直接失效
   * 3. 校验大模型两项 API_KEY / BASE_URL：否则文档能上传、能切分，却会在调模型时才炸
   * 4. 校验切分两项 CHUNK_SIZE / CHUNK_OVERLAP：见 assertChunkingConfig()
   * 5. 校验其余六项数值配置：见 assertNumeric()。这一组是评审 Important #4 补的，
   *    判据与第 4 步同一条原则——「配错」必须变成「起不来」，不能变成「静默的坏行为」
   */
  onModuleInit() {
    this.env.getOrThrow('DB_HOST');
    this.env.getOrThrow('DB_USER');
    this.env.getOrThrow('DB_PASSWORD');
    this.env.getOrThrow('DB_NAME');
    this.env.getOrThrow('APP_ORIGIN');
    this.env.getOrThrow('API_KEY');
    this.env.getOrThrow('BASE_URL');
    this.assertChunkingConfig();
    // 步骤 5：这六项过去只走裸 Number()，配错的表现是「功能静默失效」而不是报错：
    // RETRIEVAL_MIN_SCORE 得到 NaN 后 `row.score >= NaN` 恒为 false ⇒ 每次提问都回「没找到资料」，
    // 而 /api/health 一路绿灯；RETRIEVAL_TOP_K 写成空串得到 0 ⇒ SQL 直接 LIMIT 0，同样静默无结果；
    // MAX_UPLOAD_MB 得到 NaN ⇒ 体积校验永不触发；WORKER_CONCURRENCY 得到 NaN ⇒
    // Math.max(1, NaN) 仍是 NaN，for 循环一次不进、worker 看着活着却永远不取任务；
    // SESSION_TTL_DAYS 得到 NaN ⇒ new Date(NaN) 让会话到期时间写成 Invalid Date；
    // BCRYPT_ROUNDS 配成非法值时 bcryptjs【不会】拒绝——实测（安装的 bcryptjs 3.0.3）
    // cost 为 NaN 或 0 时静默按 10 出哈希、-1 或 3 时静默按 04，只有小数 cost 才在哈希时抛
    // 「Missing salt rounds」，所以配错的后果是新建哈希悄悄从 12 轮降到 10/4 轮、登录注册照常成功。
    this.assertNumeric('RETRIEVAL_MIN_SCORE', { minExclusive: 0, max: 1 });
    this.assertNumeric('RETRIEVAL_TOP_K', { integer: true, min: 1 });
    this.assertNumeric('MAX_UPLOAD_MB', { integer: true, min: 1 });
    this.assertNumeric('WORKER_CONCURRENCY', { integer: true, min: 1 });
    this.assertNumeric('SESSION_TTL_DAYS', { integer: true, min: 1 });
    // 4..31 是 bcryptjs 的有效 cost 定义域；下界取 4 是因为 test/setup-env.ts 用 4 加速单测与 e2e，
    // 抬高它会直接拦死测试环境
    this.assertNumeric('BCRYPT_ROUNDS', { integer: true, min: 4, max: 31 });
    // 刻意【不】纳入闸口的三项，各自都有更大声的失败点，误拦反而会让合法部署起不来：
    // - PORT / DB_PORT：NaN 会让 app.listen / pg 连接在启动那一刻直接抛错，没有静默路径
    // - EMBEDDING_DIMENSIONS：维度是逐向量对着 provider 返回值校验的（embeddings.service.ts），
    //   且真正的硬约束是迁移里写死的 vector(1024)，启动时拿环境变量去对列定义属于另一件事（未做）
    // （BCRYPT_ROUNDS 原本也在这份排除清单里，理由是「bcryptjs 自己会拒绝非法 cost」——
    //   final-fix 实测该理由不成立，上面第 5 步已把它移进闸口，勿再加回）
  }

  /**
   * 数值型环境变量的通用启动校验（判据与 assertChunkingConfig 同一条原则）。
   *
   * 步骤：
   * 1. 漏配（undefined）直接放过：各 getter 都有 `?? 默认值`，默认值本身合法，
   *    把漏配当非法会让所有不写这一行的既有部署起不来
   * 2. 空串与纯空白单独先判：`Number('') === 0`、`Number('  ') === 0`，
   *       不拦就等于「配了空值 = 把上限/条数改成 0」这种最容易被忽略的静默故障。
   *       注意 `??` 兜不住空串（它只对 undefined/null 生效），所以这里必须显式判空白
   * 3. 用 Number() 取值并逐项核对：有限性（含整数要求）、下界、上界，任一项不过就抛错
   * 4. 报错格式与切分闸口一致：点名变量、回显原值与读到的值，只给一条「必须满足什么」的要求句，
   *       运维照着改配置即可，不需要读代码。这里不含密钥，可以安全打进日志
   *
   * 关于 minExclusive：RETRIEVAL_MIN_SCORE 要求严格 >0——0 等于把阈值闸门整个关掉，
   * 任何噪声片段都会进提示词，是另一种静默的答非所问；只有 ≥/≤ 两种闭区间表达不了它。
   *
   * @param name 环境变量名（同时用于取值和拼报错）
   * @param rules integer 是否必须整数；min/max 闭区间；minExclusive 开区间下界
   */
  private assertNumeric(
    name: string,
    rules: { integer?: boolean; min?: number; max?: number; minExclusive?: number },
  ) {
    const raw = this.env.get<string>(name);
    // 步骤 1：没配就用默认值，合法
    if (raw === undefined) return;
    // 步骤 2：空值/纯空白单独拦下，绝不当成 0 放行
    if (raw.trim() === '') {
      throw new Error(
        `${name} 配置无效（原值 ${JSON.stringify(raw)}）：不能是空值或纯空白，` +
          `要么填一个合法数字，要么整行删掉走默认值`,
      );
    }
    const value = Number(raw);
    // 步骤 3：拼出这一项的要求句（与它对应的 getter 注释口径一致）
    const lower =
      rules.minExclusive !== undefined
        ? ` >${rules.minExclusive}`
        : rules.min !== undefined
          ? ` ≥${rules.min}`
          : '';
    const upper = rules.max !== undefined ? ` 且 ≤${rules.max}` : '';
    // 文案排版与切分闸口保持一致（「必须是 ≥1 的整数」这种带空格的写法已被 spec 钉住）
    const requirement = `必须是${lower}${upper} 的${
      rules.integer ? '整数' : '有限数字'
    }`;
    const finiteOk =
      Number.isFinite(value) && (!rules.integer || Number.isInteger(value));
    // 边界判断一律用 `!== undefined` 而不是真值判断：minExclusive: 0 / min: 0 都是合法下界，
    // 写成 `!rules.minExclusive` 会让「下界正好是 0」这条规则被静默跳过（0 就通过 >0 的判据了）
    const boundsOk =
      (rules.minExclusive === undefined || value > rules.minExclusive) &&
      (rules.min === undefined || value >= rules.min) &&
      (rules.max === undefined || value <= rules.max);
    // 步骤 4：任何一项不过都抛启动失败
    if (!finiteOk || !boundsOk) {
      throw new Error(
        `${name} 配置无效（原值 ${JSON.stringify(raw)}，读到 ${value}）：${requirement}`,
      );
    }
  }

  /**
   * 切分参数校验：把「配错的环境变量」变成「启动失败」，而不是变成「静默的坏切片」。
   *
   * 为什么必须在这里拦：chunkSize / chunkOverlap 走的是 `Number(env)`，
   * `CHUNK_SIZE=`（空值）得到 0、拼错字母得到 NaN、写成 800.5 得到小数，三者都不会自己报错；
   * 而切分器为了参数合法会做 `Math.max(1, size)` 与 `min(overlap, size-1)` 的夹紧，
   * 于是 size=NaN 时整篇文档塌成一个远超预期长度的片段、size=0 时每块只前进 1 个字符，
   * 「片段不超过 CHUNK_SIZE」这条保证就这么悄悄没了（嵌入超长文本还会被供应商截断或拒掉）。
   *
   * 规则：
   * - CHUNK_SIZE：≥1 的有限整数
   * - CHUNK_OVERLAP：≥0 的有限整数，且必须严格小于 CHUNK_SIZE（等于时切分没有步进）
   * 报错只点名环境变量名与当前取值，这里不含密钥，可以直接打进日志。
   *
   * 为什么它不改成调用 assertNumeric()：三条出口的文案已被 config.service.spec.ts 逐条钉住
   * （尤其是「重叠 >= 片段长度」这条跨变量的比较，assertNumeric 的单变量模型表达不了），
   * 且 CHUNK_OVERLAP 留空得到 0 属于**合法**取值（不重叠），与 assertNumeric 的空白判据相反。
   * 两者保留各自的写法，是为了不让新闸口改掉既有部署的行为。
   */
  private assertChunkingConfig() {
    const size = this.chunkSize;
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(
        `CHUNK_SIZE 配置无效（原值 ${JSON.stringify(this.env.get('CHUNK_SIZE'))}，读到 ${size}）：必须是 ≥1 的整数`,
      );
    }
    const overlap = this.chunkOverlap;
    if (!Number.isInteger(overlap) || overlap < 0) {
      throw new Error(
        `CHUNK_OVERLAP 配置无效（原值 ${JSON.stringify(this.env.get('CHUNK_OVERLAP'))}，读到 ${overlap}）：必须是 ≥0 且小于 CHUNK_SIZE 的整数`,
      );
    }
    if (overlap >= size) {
      throw new Error(
        `CHUNK_OVERLAP 配置无效（读到 ${overlap}）：必须小于 CHUNK_SIZE（读到 ${size}）`,
      );
    }
  }

  /**
   * 运行环境标识，默认 development。
   * 注意 src 里目前没有消费方（限流守卫是绕过本服务直接读 process.env.NODE_ENV 的），
   * 保留它是为了让「环境」这一判断有统一入口，别各自再抄一遍字符串比较。
   */
  get nodeEnv() {
    return this.env.get('NODE_ENV') ?? 'development';
  }

  /** 是否生产环境。当前无调用方；将来要区分安全分支（如日志详尽程度）时用它，不要再新读一次环境变量 */
  get isProduction() {
    return this.nodeEnv === 'production';
  }

  /** HTTP 监听端口，默认 3300；容器编排里由 PORT 覆盖，方便同机多实例 */
  get port() {
    return Number(this.env.get('PORT') ?? 3300);
  }

  /**
   * 前端可访问源（例如 https://kb.example.com），是 Origin 守卫的比对基准。
   * 故意不给默认值：写错了会导致合法请求被守卫判成跨站，或者反过来让守卫形同虚设。
   */
  get appOrigin() {
    return this.env.getOrThrow<string>('APP_ORIGIN');
  }

  /**
   * 会话 cookie 是否加 Secure 标记。
   * 只认字符串 'true'，其余一律 false——本地 http://localhost 必须能登录，所以默认不开。
   */
  get cookieSecure() {
    return this.env.get('COOKIE_SECURE') === 'true';
  }

  /**
   * 是否开放自助注册。
   * 注意默认是「开放」：只有显式配成 'false' 才关闭，因为私有部署更常靠这个开关一键封住注册入口。
   */
  get registrationEnabled() {
    return this.env.get('REGISTRATION_ENABLED') !== 'false';
  }

  /** bcrypt 加盐轮数，默认 12。调高会拖慢每次登录，调低会让库被拖走时更容易爆破口令。
   *  启动时已由 assertNumeric() 拦为 4..31 的整数：bcryptjs 自己不拒非法 cost（实测 NaN/0 静默按 10、
   *  -1/3 静默按 04），配错不会当场报错，只会悄悄弱化新哈希 */
  get bcryptRounds() {
    return Number(this.env.get('BCRYPT_ROUNDS') ?? 12);
  }

  /** 会话有效期天数，默认 7。同时决定 cookie 过期时间和 sessions 表 expires_at，两处必须一致。
   *  启动时已由 assertNumeric() 校验为 ≥1 的整数：NaN 会让 new Date(NaN) 把到期时间写成 Invalid Date，
   *  会话过期这件事从此静默失效 */
  get sessionTtlDays() {
    return Number(this.env.get('SESSION_TTL_DAYS') ?? 7);
  }

  /**
   * PostgreSQL 连接参数。
   * 用 getOrThrow 而不是给默认值，但它只区分「有没有」这一件事：
   * - 缺失（.env 文件与注入的环境变量里都没有这个键）即抛错，进程起不来
   * - 写错不会在启动时暴露：host 或库名填了个别的值、甚至配成空串，getOrThrow 都照样返回，
   *   进程正常启动然后连到错误的库上（或直到第一次查询才报连接错误）
   * 所以本方法只防漏配、不防错配，部署时的取值核对得另外做。
   * ssl 只认 'true'，本机 docker-compose 走内网明文，云上托管库则需要显式打开。
   */
  get db() {
    return {
      host: this.env.getOrThrow<string>('DB_HOST'),
      port: Number(this.env.get('DB_PORT') ?? 5432),
      user: this.env.getOrThrow<string>('DB_USER'),
      password: this.env.getOrThrow<string>('DB_PASSWORD'),
      database: this.env.getOrThrow<string>('DB_NAME'),
      ssl: this.env.get('DB_SSL') === 'true',
    };
  }

  /**
   * 大模型服务配置（SiliconFlow 等 OpenAI 兼容服务）。
   * - apiKey：Bearer 令牌，绝不输出到日志
   * - baseUrl：去掉结尾斜杠，因为它会被原样交给 LangChain 当 OpenAI 客户端的 baseURL
   *   （见 llm.module.ts 的两处 `configuration: { baseURL }`），结尾斜杠会拼出 `//embeddings`
   * - model：对话模型名，默认 deepseek-ai/DeepSeek-V4.1-Flash
   */
  get llm() {
    return {
      apiKey: this.env.getOrThrow<string>('API_KEY'),
      baseUrl: this.env.getOrThrow<string>('BASE_URL').replace(/\/+$/, ''),
      model: this.env.get<string>('MODEL') ?? 'deepseek-ai/DeepSeek-V4.1-Flash',
    };
  }

  /**
   * 嵌入模型配置。
   * - model：默认 BAAI/bge-m3，中文召回效果较好
   * - dimensions：只在 llm/embeddings.service.ts 里当一次客户端自检的期望长度（返回的向量长度不等就抛「Embedding 维度不正确」），
   *   它既不会作为参数发给 embedding 接口，也不会去改表结构——真正的维度约束写死在
   *   migrations/001_init.sql 的 chunks.embedding vector(1024) 上，且启动时没有任何一致性校验。
   *   所以改这个值不会「让旧向量全部不可用」，而是换一种失败方式：
   *   与模型实际输出维度不符 -> 在 EmbeddingsService.embed 抛错，入库任务失败；
   *   与 vector(1024) 不符 -> 直到 INSERT INTO chunks 才由 Postgres 报维度错误。
   *   真要换维度必须同步改迁移并重建全部切片，只动这个环境变量是换不掉的。
   */
  get embedding() {
    return {
      model: this.env.get<string>('EMBEDDING_MODEL') ?? 'BAAI/bge-m3',
      dimensions: Number(this.env.get('EMBEDDING_DIMENSIONS') ?? 1024),
    };
  }

  /**
   * 上传文件的本地落盘目录，默认 ./storage。
   * 容器里挂成数据卷，否则重启即丢文件；只存原始文件，切分结果在库里。
   */
  get uploadDir() {
    return this.env.get<string>('UPLOAD_DIR') ?? './storage';
  }

  /**
   * 单文件上传上限（MB），默认 20。
   * 校验点在 documents.service 调用 validateUpload 时，不在 multer 层：
   * FileInterceptor 默认走内存存储，请求一进来整个文件就已经完整缓冲在内存里了，
   * 所以这里只省下后面的解析与嵌入，并不省传输与缓冲——超限被拒的那个文件同样已经传完并落进 buffer。
   * 另外 documents.controller 的 FileInterceptor 自带一个写死的 limits.fileSize = 25MB，完全不读本配置，
   * 实际生效的是两者中较小的那个：把 MAX_UPLOAD_MB 配到 25 以上不会放宽任何东西，超过 25MB 的先被 multer 拒掉。
   * 启动时已由 assertNumeric() 校验为 ≥1 的整数：配成 NaN 时 `size > NaN * MB` 恒为 false，
   * 体积校验会静默失效（只有 multer 那道写死的 25MB 还在）。
   */
  get maxUploadMb() {
    return Number(this.env.get('MAX_UPLOAD_MB') ?? 20);
  }

  /**
   * 切分片段的目标长度（字符），默认 800。越大召回上下文越完整但单条越难命中。
   * 取值已在启动时由 assertChunkingConfig() 校验（必须是 ≥1 的整数），所以本方法可以安心只做 `Number()`。
   */
  get chunkSize() {
    return Number(this.env.get('CHUNK_SIZE') ?? 800);
  }

  /**
   * 相邻片段的重叠长度（字符），默认 120。用于避免句子被切断后语义丢失。
   * 启动校验要求它是 ≥0 且严格小于 CHUNK_SIZE 的整数：切分器本身只会把过大的重叠夹到 size-1，
   * 不拦的话「每块只前进 1 个字符、块数暴涨」这种配置照样能跑起来，所以约束放在这里。
   */
  get chunkOverlap() {
    return Number(this.env.get('CHUNK_OVERLAP') ?? 120);
  }

  /** 每次检索召回的片段条数，默认 6。条数越多提示词越长、成本越高，也越容易塞进噪声。
   *  启动时已由 assertNumeric() 校验为 ≥1 的整数（空串/NaN/0 都会让进程起不来，见 onModuleInit） */
  get retrievalTopK() {
    return Number(this.env.get('RETRIEVAL_TOP_K') ?? 6);
  }

  /**
   * 召回的最低相似度分数，默认 0.2。低于阈值的片段直接丢弃。
   * 这是「答不上来就说不知道」的关键阀门：调高会更容易拒答，调低会把无关内容喂进提示词。
   * 启动时已由 assertNumeric() 校验为 >0 且 ≤1 的有限数字：配成 NaN 会让 `score >= NaN` 恒为 false，
   * 于是每次提问都回「没找到资料」而健康检查照样绿灯——这类静默故障只在这道闸口拦得住
   */
  get retrievalMinScore() {
    return Number(this.env.get('RETRIEVAL_MIN_SCORE') ?? 0.2);
  }

  /**
   * 单个 worker 进程同时处理的入库任务数，默认 1。受模型服务限流约束，调高只会带来更多 429。
   * 启动时已由 assertNumeric() 校验为 ≥1 的整数，所以 queue.service.ts 的 Math.max(1, …)
   * 只剩「兜住 0」这一层含义；NaN 以前会一路带到 for 循环里注册出 0 个 worker
   */
  get workerConcurrency() {
    return Number(this.env.get('WORKER_CONCURRENCY') ?? 1);
  }
}
