/**
 * 口令服务：bcrypt 哈希与校验的薄封装，全项目只有这一个入口碰口令算法。
 * 轮数不写死在代码里，而是来自配置 config.bcryptRounds（环境变量 BCRYPT_ROUNDS，默认 12）；
 * 测试环境由 test/setup-env.ts 显式降到 4——bcrypt 是故意慢的算法，单测/e2e 每次都全速
 * 跑一遍登录注册，不降轮数测试会被自己拖垮。
 * 边界：不校验强度（长度规则在 DTO 里：8~72 字符，上限 72 是因为 bcrypt 静默丢弃 72 字节
 * 之后的内容，与其悄悄截断不如在入口拒绝）；不存储、不比较明文之外的任何东西。
 */
import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { AppConfigService } from '../config/config.service';

@Injectable()
export class PasswordService {
  constructor(private readonly config: AppConfigService) {}

  /** 注册/改密时调用：产出自带随机盐的 bcrypt 哈希，可直接入库 */
  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.config.bcryptRounds);
  }

  /** 登录/改密核验时调用：库里的哈希原样传入，bcrypt 自己从盐重算比对 */
  verify(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
