/**
 * 配置服务的启动校验单测：只测 `onModuleInit` 这道闸口，守的是「数值配置配错 = 起不来」。
 * 两组用例分别对应两个闸口：B5 加的切分校验（文案被逐条钉死，不许改），以及
 * Important #4 补的其余六项数值校验（RETRIEVAL_MIN_SCORE / RETRIEVAL_TOP_K / MAX_UPLOAD_MB /
 * WORKER_CONCURRENCY / SESSION_TTL_DAYS，外加 final-fix Item A 纳入的 BCRYPT_ROUNDS），
 * 后者走的是可复用的 assertNumeric()。
 *
 * 职责边界：
 * - 不逐个测 getter 的默认值语义（那些只是读环境变量），只保证「非法值一律让进程起不来」
 * - 用假的 ConfigService（一个纯对象）驱动，不读真实的 .env，因此这里出现的取值都是测试自己构造的
 *
 * 为什么要给这些数值配置加闸口：它们都走 `Number(env)`，
 * 配成空串得 0、配错字母得 NaN；而下游没有一处会因此报错——切分器把越界值夹成合法值、
 * `score >= NaN` 恒为 false、`LIMIT 0` 直接不召回、`Math.max(1, NaN)` 仍是 NaN，
 * 每一种都是「健康检查绿灯但功能已经坏了」的静默故障（见 config.service.ts 的两处注释）。
 */
import { AppConfigService } from './config.service';

/** onModuleInit 里 getOrThrow 的必填项，取一份合法值，让用例只差切分配置这一处变量 */
const REQUIRED_ENV: Record<string, string> = {
  DB_HOST: 'localhost',
  DB_USER: 'postgres',
  DB_PASSWORD: 'password',
  DB_NAME: 'knowledge_rag_test',
  APP_ORIGIN: 'http://localhost:5173',
  API_KEY: 'test-key',
  BASE_URL: 'https://example.test/v1',
};

/**
 * 用给定环境变量构造配置服务。
 * 步骤：拷贝必填项 → 覆盖本用例关心的键 → 只实现 get / getOrThrow 两个方法（其余 getter 用不到）。
 */
function createService(env: Record<string, string>): AppConfigService {
  const values: Record<string, string> = { ...REQUIRED_ENV, ...env };
  const fakeConfigService = {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (values[key] === undefined) throw new Error(`缺少环境变量 ${key}`);
      return values[key];
    },
  };
  return new AppConfigService(fakeConfigService as never);
}

describe('AppConfigService 切分配置启动校验', () => {
  // 回归点：默认值 800/120 必须「能启动」且确实落到这两个数上——闸口新加时最容易顺手把
  // 漏配当成非法，那会让所有没显式写 CHUNK_* 的既有部署直接起不来
  it('未配置时使用默认 800 / 120 并通过校验', () => {
    const service = createService({});
    expect(() => service.onModuleInit()).not.toThrow();
    expect(service.chunkSize).toBe(800);
    expect(service.chunkOverlap).toBe(120);
  });

  // 回归点：overlap = 0 是合法配置（片段间不重叠），闸口不许把它当成「漏配」拦下
  it('显式配置一组合法值（含 overlap 为 0）通过校验', () => {
    const service = createService({ CHUNK_SIZE: '1000', CHUNK_OVERLAP: '0' });
    expect(() => service.onModuleInit()).not.toThrow();
  });

  // 每一项都必须让启动失败。这里刻意断言到「分支专属」的原因子句，而不只是点名环境变量：
  // assertChunkingConfig 有三条独立出口，若只匹配变量名，「负重叠」和「重叠 >= 片段长度」
  // 都只会命中 CHUNK_OVERLAP，两个分支就无法区分。三条出口的措辞各不重叠：
  // - CHUNK_SIZE 非法（0/NaN/负/小数/Infinity）：原因是「必须是 ≥1 的整数」
  // - CHUNK_OVERLAP 非法整数（NaN/负）：原因是「必须是 ≥0」（且这段后面接的是「小于」，不含「≥1」）
  // - CHUNK_OVERLAP >= CHUNK_SIZE：原因是「必须小于 CHUNK_SIZE（读到 …）」（不含「必须是」）
  // 注意 CHUNK_OVERLAP 留空会得到 0：0 是合法重叠（不重叠），归在「漏配但无害」，不在这里拦。
  it.each([
    ['CHUNK_SIZE', '空串被 Number 读成 0', { CHUNK_SIZE: '' }, '必须是 ≥1 的整数'],
    ['CHUNK_SIZE', '拼错字母得到 NaN', { CHUNK_SIZE: 'abc' }, '必须是 ≥1 的整数'],
    ['CHUNK_SIZE', '零长度没有意义', { CHUNK_SIZE: '0' }, '必须是 ≥1 的整数'],
    ['CHUNK_SIZE', '负数长度', { CHUNK_SIZE: '-10' }, '必须是 ≥1 的整数'],
    ['CHUNK_SIZE', '非整数长度', { CHUNK_SIZE: '800.5' }, '必须是 ≥1 的整数'],
    ['CHUNK_SIZE', 'Infinity 同样非法', { CHUNK_SIZE: '1e999' }, '必须是 ≥1 的整数'],
    ['CHUNK_OVERLAP', '拼错字母得到 NaN', { CHUNK_OVERLAP: 'x' }, '必须是 ≥0'],
    ['CHUNK_OVERLAP', '负数重叠', { CHUNK_OVERLAP: '-1' }, '必须是 ≥0'],
    [
      'CHUNK_OVERLAP',
      '重叠等于片段长度',
      { CHUNK_OVERLAP: '800' },
      '必须小于 CHUNK_SIZE（读到',
    ],
    [
      'CHUNK_OVERLAP',
      '重叠大于片段长度',
      { CHUNK_OVERLAP: '5000' },
      '必须小于 CHUNK_SIZE（读到',
    ],
  ])('%s 非法时启动即失败（%s）', (name, _reason, env, reasonClause) => {
    const service = createService(env);
    // 先点名变量名（便于运维定位是哪行配置），再命中该分支独有的原因子句（区分三条出口）
    expect(() => service.onModuleInit()).toThrow(new RegExp(name));
    expect(() => service.onModuleInit()).toThrow(reasonClause);
  });

  // 回归点：报错要能「照着改」——把两个当前值都印出来，运维不必再去猜是哪个变量配错。
  // 断言依赖参数的先后顺序（先 OVERLAP 后 SIZE），调整文案顺序时这条要同步改
  it('重叠过大时错误信息同时给出两个当前值，便于直接改配置', () => {
    const service = createService({ CHUNK_SIZE: '800', CHUNK_OVERLAP: '900' });
    expect(() => service.onModuleInit()).toThrow(/CHUNK_OVERLAP.*900.*800/);
  });
});

/**
 * 其余六个数值环境变量的启动校验（评审 Important #4 修的五项 + final-fix Item A 纳入的 BCRYPT_ROUNDS）。
 * 为什么单独一个 describe：上面那组是 B5 就有的切分闸口，措辞被钉死；这一组是同一原则
 * 铺开到「配错就静默失效」的其余数值项，规则各不相同，混在一起读会误以为共享同一条判据。
 * 每条都单独成案的原因：这几项的静默故障后果完全不同（全库拒答 / 永不超限 / 会话永不过期 /
 * worker 起不来 / 新哈希悄悄变弱），一旦有人把 assertNumeric 改成「只 warn 不抛」，必须能看出是哪一类先红。
 */
describe('AppConfigService 数值配置启动校验', () => {
  /**
   * 非法取值表：变量名 / 说明 / 注入的环境变量 / 期望的错误句。
   * 期望句都取「各分支独有」的片段，与上面的切分表同一口径：只匹配变量名就无法区分
   * 「不是数字」「不是整数」「越界」「空值」这四条出口。
   */
  it.each([
    [
      'RETRIEVAL_MIN_SCORE',
      '拼错字母得到 NaN，于是 row.score >= NaN 恒为 false',
      { RETRIEVAL_MIN_SCORE: 'abc' },
      '必须是 >0 且 ≤1 的有限数字',
    ],
    [
      'RETRIEVAL_MIN_SCORE',
      '空串被 Number 读成 0，等于阈值全开',
      { RETRIEVAL_MIN_SCORE: '' },
      '不能是空值或纯空白',
    ],
    [
      'RETRIEVAL_MIN_SCORE',
      '纯空白同样是 0',
      { RETRIEVAL_MIN_SCORE: '   ' },
      '不能是空值或纯空白',
    ],
    [
      'RETRIEVAL_MIN_SCORE',
      '0 关掉阈值闸门（任何片段都会进提示词）',
      { RETRIEVAL_MIN_SCORE: '0' },
      '必须是 >0 且 ≤1 的有限数字',
    ],
    [
      'RETRIEVAL_MIN_SCORE',
      '大于 1 的阈值永远召不回片段',
      { RETRIEVAL_MIN_SCORE: '1.5' },
      '必须是 >0 且 ≤1 的有限数字',
    ],
    [
      'RETRIEVAL_TOP_K',
      '空串被 Number 读成 0，SQL 直接 LIMIT 0',
      { RETRIEVAL_TOP_K: '' },
      '不能是空值或纯空白',
    ],
    [
      'RETRIEVAL_TOP_K',
      '拼错字母得到 NaN',
      { RETRIEVAL_TOP_K: 'x' },
      '必须是 ≥1 的整数',
    ],
    [
      'RETRIEVAL_TOP_K',
      '小数条数无法落进 LIMIT',
      { RETRIEVAL_TOP_K: '6.5' },
      '必须是 ≥1 的整数',
    ],
    [
      'RETRIEVAL_TOP_K',
      '0 条等于不检索',
      { RETRIEVAL_TOP_K: '0' },
      '必须是 ≥1 的整数',
    ],
    [
      'MAX_UPLOAD_MB',
      'NaN 让体积校验永不触发',
      { MAX_UPLOAD_MB: 'twenty' },
      '必须是 ≥1 的整数',
    ],
    [
      'MAX_UPLOAD_MB',
      '空串（等于不限？其实是 0）',
      { MAX_UPLOAD_MB: '' },
      '不能是空值或纯空白',
    ],
    [
      'WORKER_CONCURRENCY',
      'NaN 时 Math.max(1, NaN) 仍是 NaN，for 循环一次都不进',
      { WORKER_CONCURRENCY: 'NaN' },
      '必须是 ≥1 的整数',
    ],
    [
      'WORKER_CONCURRENCY',
      '小数并发',
      { WORKER_CONCURRENCY: '1.5' },
      '必须是 ≥1 的整数',
    ],
    [
      'SESSION_TTL_DAYS',
      'NaN 让会话到期时间算成 Invalid Date',
      { SESSION_TTL_DAYS: 'seven' },
      '必须是 ≥1 的整数',
    ],
    [
      'SESSION_TTL_DAYS',
      '0 天等于会话立刻失效',
      { SESSION_TTL_DAYS: '0' },
      '必须是 ≥1 的整数',
    ],
    // BCRYPT_ROUNDS（final-fix Item A 纳入）：bcryptjs 对非法 cost【不】报错，实测它会把
    // NaN / 0 静默按 cost 10、-1 / 3 静默按 cost 04（只有小数 cost 才在哈希时抛），
    // 配错的表现是「新哈希悄悄变弱」而不是登录注册当场失败——所以必须由启动闸口拦
    [
      'BCRYPT_ROUNDS',
      '拼错字母得到 NaN，bcryptjs 静默按 cost 10 出哈希',
      { BCRYPT_ROUNDS: 'abc' },
      '必须是 ≥4 且 ≤31 的整数',
    ],
    [
      'BCRYPT_ROUNDS',
      '0 同样被 bcryptjs 静默按 cost 10 处理（实测值，不是当场报错）',
      { BCRYPT_ROUNDS: '0' },
      '必须是 ≥4 且 ≤31 的整数',
    ],
    [
      'BCRYPT_ROUNDS',
      '32 超出 bcryptjs 的有效 cost 域（31 为上界，越界会在哈希时抛错）',
      { BCRYPT_ROUNDS: '32' },
      '必须是 ≥4 且 ≤31 的整数',
    ],
    [
      'BCRYPT_ROUNDS',
      '空串——写了等于没写，但按数值闸口口径判非法',
      { BCRYPT_ROUNDS: '' },
      '不能是空值或纯空白',
    ],
  ])('%s 非法时启动即失败（%s）', (name, _reason, env, reasonClause) => {
    const service = createService(env);
    expect(() => service.onModuleInit()).toThrow(new RegExp(name));
    expect(() => service.onModuleInit()).toThrow(reasonClause);
  });

  // 回归点：1e999 是 .env 里写得出、Number 读成 Infinity 的真实写法。它必须被拦下（非有限值），
  // 且报错要像切分闸口那样把「读到的值」打出来——运维看日志就能认出是溢出而不是拼错字母
  it('配成 Infinity 时同样拦下，并在报错里回显读到的值', () => {
    const service = createService({ RETRIEVAL_TOP_K: '1e999' });
    expect(() => service.onModuleInit()).toThrow(/RETRIEVAL_TOP_K.*读到 Infinity/);
  });

  // 回归点：本闸口最坏的反面是「把今天能跑的部署拦死」。这一条写全八项数值配置的合法取值
  // （BCRYPT_ROUNDS 取默认 12，其余与生产 .env.production 的当前写法一致），必须一路通过；
  // 它替代了逐个 getter 的默认值断言，因为默认值那条已由上面的切分用例覆盖同一机制
  it('一组当前有效的取值（含生产 .env.production 的全部数值项）照常启动', () => {
    const service = createService({
      CHUNK_SIZE: '800',
      CHUNK_OVERLAP: '120',
      RETRIEVAL_TOP_K: '6',
      RETRIEVAL_MIN_SCORE: '0.2',
      MAX_UPLOAD_MB: '20',
      WORKER_CONCURRENCY: '1',
      SESSION_TTL_DAYS: '7',
      BCRYPT_ROUNDS: '12',
    });
    expect(() => service.onModuleInit()).not.toThrow();
    expect(service.retrievalTopK).toBe(6);
    expect(service.retrievalMinScore).toBe(0.2);
    expect(service.maxUploadMb).toBe(20);
    expect(service.workerConcurrency).toBe(1);
    expect(service.sessionTtlDays).toBe(7);
    expect(service.bcryptRounds).toBe(12);
  });

  // 回归点：阈值取上限 1 是合法的（只召回完全同向的片段），闸口不能把它当越界拦掉
  it('边界合法值通过校验：阈值 1、Top-K 1、TTL 1 天', () => {
    const service = createService({
      RETRIEVAL_MIN_SCORE: '1',
      RETRIEVAL_TOP_K: '1',
      SESSION_TTL_DAYS: '1',
    });
    expect(() => service.onModuleInit()).not.toThrow();
  });

  // 回归点：漏配不拦。这六项都有默认值，CI 与 e2e 环境基本只显式写其中两三行，
  // 把「没写」当非法会让所有不写这些行的既有部署起不来
  it('六项全部漏配时走默认值并照常启动', () => {
    const service = createService({});
    expect(() => service.onModuleInit()).not.toThrow();
    expect(service.retrievalTopK).toBe(6);
    expect(service.retrievalMinScore).toBe(0.2);
    expect(service.bcryptRounds).toBe(12);
  });

  // 回归点（final-fix Item A）：BCRYPT_ROUNDS 的合法域就是 bcryptjs 的 cost 域 4..31，
  // 两个端点必须放行——4 是本仓库单测与 e2e（test/setup-env.ts:25）在用的值，
  // 抬高下界会直接让测试环境起不来；31 是 bcryptjs 的上界
  it('BCRYPT_ROUNDS 取 4 与 31 两个端点都合法', () => {
    const four = createService({ BCRYPT_ROUNDS: '4' });
    expect(() => four.onModuleInit()).not.toThrow();
    expect(four.bcryptRounds).toBe(4);
    const service = createService({ BCRYPT_ROUNDS: '31' });
    expect(() => service.onModuleInit()).not.toThrow();
    expect(service.bcryptRounds).toBe(31);
  });

  // 回归点：刻意【不】纳入闸口的三项各有各的大声失败点，误加进去只会让合法部署起不来。
  // PORT=0 是随机端口写法，EMBEDDING_DIMENSIONS 的维度对齐是逐向量校验的，
  // 都必须在闸口下顺利通过。（BCRYPT_ROUNDS 原在此列，final-fix Item A 因实测
  // bcryptjs 根本不拦非法 cost 而把它移进了闸口，合法用例见上面两条）
  it('PORT / DB_PORT / EMBEDDING_DIMENSIONS 不由本闸口拦', () => {
    const service = createService({
      PORT: '0',
      DB_PORT: '5432',
      EMBEDDING_DIMENSIONS: '1024',
    });
    expect(() => service.onModuleInit()).not.toThrow();
  });
});
