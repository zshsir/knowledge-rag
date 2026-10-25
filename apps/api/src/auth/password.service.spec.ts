/**
 * PasswordService 单测：守「哈希不是明文、正确口令 verify 为 true、错误口令为 false」这条契约。
 * 边界：只测这层薄封装本身，不测注册/登录接口（那在 apps/api/test 的 auth e2e 里），
 *      也不测 bcrypt 算法正确性；不连库、不启动 Nest。
 * 为什么轮数用 4：bcrypt 是故意慢的算法，生产默认 12（config.service.ts 的 `get bcryptRounds()`，测试环境由
 *      test/setup-env.ts 把 BCRYPT_ROUNDS 也降到 4），单测这里同样取 4，只为让用例跑得快，
 *      不改变「哈希可回验、错口令拒」的行为。
 */
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  // 假配置：只给 hash/verify 真正读取的 bcryptRounds 一项，用 as never 跳过 AppConfigService
  const service = new PasswordService({ bcryptRounds: 4 } as never);

  // 回归点：口令若被原样写进哈希结果（或 verify 恒真/恒假），登录与改密核验会整体失真；
  // 三个断合起来钉住「单向 + 可回验 + 拒绝错口令」，这是口令层最小的完整契约
  it('hashes and verifies a password', async () => {
    const hash = await service.hash('correct horse');
    expect(hash).not.toBe('correct horse');
    await expect(service.verify('correct horse', hash)).resolves.toBe(true);
    await expect(service.verify('wrong', hash)).resolves.toBe(false);
  });
});
