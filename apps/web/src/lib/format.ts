/**
 * 展示层用到的四个格式化函数：体积、日期、相对时间、头像缩写。
 * 边界：纯函数，只吃输入吐字符串——不读环境变量、不碰 Date 之外的状态，也不负责国际化
 * （语言与地区写死 zh-CN，产品目前只有中文界面）。调用方是 components/ui 与 features/** 的页面。
 * 共同约定：所有函数都不抛错，脏输入（NaN、非法日期串、空字符串）走兜底显示。
 */

/**
 * 字节数转人类可读体积，例如 1536 → "1.5 KB"。
 * 步骤：
 * 1. 非有限数（NaN/Infinity）与 <=0 一律显示 "0 B"，后端 sizeBytes 异常时不至于渲染出 "NaN MB"
 * 2. 用 log(bytes)/log(1024) 定位落在哪一档，再夹到单位表最后一档
 * 3. 取整规则：整字节档或数值 >=10 时不留小数，否则保留一位——避免 "0.0 KB" 也避免 "1023.45 MB"
 * 已知上限：单位表只到 GB，TB 级文件会显示成 "10240 GB" 这类大数而不是 "10 TB"；
 * 上传侧最硬的一道是 multer 写死的 25MB（documents.controller.ts:71，服务层 MAX_UPLOAD_MB 默认 20），
 * 所以现实数据碰不到 TB，不扩表。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

/**
 * 绝对时间，用于列表与消息的精确时刻，例如 "2026年10月23日 15:04"。
 * 步骤：
 * 1. 字符串按 new Date 解析（后端给的是带时区的 ISO 串），渲染走浏览器本地时区
 * 2. 非法日期返回破折号 "—"，比显示 "Invalid Date" 更适合表格
 * 3. Intl.DateTimeFormat 固定 zh-CN，精确到分钟，不带秒
 */
export function formatDate(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * 相对时间（"刚刚 / N 分钟前 / N 小时前 / N 天前"），超过 7 天退化成 "10月23日"。
 * 步骤：
 * 1. 用 Date.now() 减出毫秒差，diff 为 NaN（非法日期串）时返回空串，让调用方自己决定占位
 * 2. 依次按分钟/小时/天取整档位，向下取整，所以 "59 分钟前" 之后才变成 "刚刚"
 * 3. 一周之外改用月份+日期：再往后数「多少天前」已经没有意义
 * 注意两个现状：diff 为负（服务端时钟比本地快）会落进第 2 步显示 "刚刚"；
 * 结果不会自己刷新——只有组件重渲染时才会重新算一次。
 */
export function timeAgo(value: string): string {
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  if (Number.isNaN(diff)) return '';
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/**
 * 头像里的缩写文字（配合 components/ui/avatar.tsx 的底色圆块显示）。
 * 步骤：
 * 1. trim 后为空返回 "?"，避免头像里出现空白块
 * 2. 多段名字取首段与末段的首字符，例如 "Ada Lovelace" → "AL"
 * 3. 单段名字取前两个字符：这里用 Array.from 而不是 slice，为的是按码点切，
 *    中文名 "张三" 得到 "张三" 而不会切碎代理对
 * 已知限制：第 2 步按下标取字符，取的是 UTF-16 码元而不是码点，emoji 或代理对开头的名字
 * 可能取到半个代理对（显示成乱码方块）；用户自填的姓名以字母/汉字为主，故保持现状。
 */
export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length > 1) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  return Array.from(trimmed).slice(0, 2).join('').toUpperCase();
}
