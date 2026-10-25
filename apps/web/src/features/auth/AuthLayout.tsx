/**
 * 登录 / 注册 / 邀请三个页面共用的视觉外壳：左「品牌展示区」+ 右「表单卡片」的两栏布局。
 *
 * 视觉结构（只描述意图，具体尺寸见 JSX）：
 * - 左栏是深色「极光面板」：深蓝黑底 + 细网格 + 三团大半径模糊光斑（靛蓝/青/紫）营造纵深，
 *   角落压一枚超大的半透明 ATLAS 水印。内容是自上而下的：Logo 与「私有部署」状态徽标 →
 *   渐变大标题与副标题 → 三张能力卡（知识集中管理 / 权限精确到库 / 答案带引用）→
 *   三个数字指标 → 知识地图与演示回答卡 → 版权与合规脚注
 * - 右栏是浅色画布：点阵背景 + 两团淡色光斑，中间一张白色圆角卡片承载 eyebrow / 标题 / 描述 /
 *   表单（children）/ 切换链接（footer），卡片下方一行「数据不离开部署环境」的提示
 * - 左栏是纯装饰，全部是静态文案与写死的演示数据（DemoAnswerCard 不是真实检索结果），
 *   也刻意不带任何交互；真正的表单逻辑都在各页面通过 children/footer 传进来
 *
 * 断点取舍：
 * - lg 以下只保留右栏，左栏整体不渲染：手机/平板宽度下把一半屏幕给品牌展示会挤压表单，
 *   且深色面板在小屏上只剩折行的大字，信息密度极低。此时 Logo 与「私有部署」徽标移到卡片上方，
 *   保证品牌与合规信息不丢
 * - lg ~ 2xl 是「一栏文字 + 内嵌演示图」：左栏只有一列，知识地图被塞进文字流末尾（宽度再收窄一层），
 *   否则单独占半列会把标题挤成窄条
 * - 2xl 起左栏内部改成左右两列，知识地图与演示回答卡才独立到右半列，形成「文案 | 产品演示」的对照
 *   ——两处挂载分别由 2xl:hidden / hidden 2xl:flex 控制，这是同一份 KnowledgeMap 出现两次的直接原因
 */
import { BookOpen, FileText, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react';
import { Logo } from '../../components/ui/logo';
import { KnowledgeMap } from './KnowledgeMap';

/**
 * 认证页外壳。
 * 步骤：
 * 1. 外层两栏网格：lg 起左品牌区 + 右表单区，lg 以下只剩右栏
 * 2. 左栏（hidden lg:flex）：底层是网格 + 三团模糊光斑 + ATLAS 水印这些绝对定位的装饰层，
 *    之上是 z-10 的内容列；页脚单独固定在内容列底部
 * 3. 左栏内容列内部再分：文字块 + 演示块。2xl 以下演示块内嵌在文字块末尾，2xl 起抽到右半列
 * 4. 右栏：背景装饰 → 窄屏专属的 Logo/徽标 → 表单卡片（eyebrow、标题、描述、children、footer）
 *    → 卡片下的隐私提示
 */
export function AuthLayout({
  eyebrow,
  title,
  description,
  children,
  footer,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="grid min-h-screen bg-canvas lg:grid-cols-[1.08fr_1fr]">
      {/* 左栏：纯装饰的品牌面板。hidden lg:flex —— 小屏不渲染，见文件头的断点取舍 */}
      <aside className="relative hidden overflow-hidden bg-[#0a0f1e] text-white lg:flex lg:flex-col">
        <div className="absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.05)_1px,transparent_1px)] [background-size:44px_44px]" />
        <div className="absolute -left-28 -top-28 h-[440px] w-[440px] rounded-full bg-indigo-600/25 blur-[130px]" />
        <div className="absolute bottom-[-12%] right-[-8%] h-[400px] w-[400px] rounded-full bg-cyan-400/10 blur-[130px]" />
        <div className="absolute left-1/3 top-1/2 h-[280px] w-[280px] rounded-full bg-violet-500/10 blur-[110px]" />
        <span className="pointer-events-none absolute -bottom-8 -right-4 select-none text-[170px] font-black leading-none tracking-tighter text-white/[0.02]">
          ATLAS
        </span>

        <div className="relative z-10 flex h-full flex-col px-12 py-10 xl:px-14 xl:py-12">
          <div className="flex items-center justify-between">
            <Logo light />
            <span className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[10px] font-medium tracking-[0.18em] text-slate-400 lg:inline-flex">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
              PRIVATE DEPLOYMENT
            </span>
          </div>

          <div className="mt-12 grid flex-1 gap-12 2xl:grid-cols-[minmax(0,1.05fr)_minmax(340px,0.95fr)] 2xl:items-center">
            <div className="max-w-2xl">
              <span className="inline-flex items-center gap-2 rounded-full border border-indigo-300/20 bg-indigo-400/10 px-4 py-1.5 text-[11px] font-medium tracking-[0.14em] text-indigo-200">
                <Sparkles className="h-3.5 w-3.5" />
                Private knowledge, shared intelligence
              </span>
              <h1 className="mt-7 text-balance text-[44px] font-semibold leading-[1.06] tracking-tight xl:text-5xl 2xl:text-6xl">
                <span className="bg-gradient-to-br from-white via-indigo-100 to-indigo-300/70 bg-clip-text text-transparent">
                  让团队知识，
                  <br />
                  随手可得。
                </span>
              </h1>
              <p className="mt-6 max-w-lg text-[15px] leading-7 text-slate-400">
                把散落在文档里的经验，变成可检索、可追溯、可信赖的答案。
                为团队而生，为每一个具体问题而答。
              </p>

              <div className="mt-9 space-y-3">
                {[
                  { icon: BookOpen, title: '知识集中管理', text: '多格式文档统一入库，原文件随时可查。' },
                  { icon: ShieldCheck, title: '权限精确到库', text: '组织角色与知识库三级授权并行。' },
                  { icon: Sparkles, title: '答案带引用', text: '每条结论都能回到原文片段验证。' },
                ].map((item) => (
                  <div
                    key={item.title}
                    className="flex items-start gap-3.5 rounded-2xl border border-white/[0.06] bg-white/[0.04] p-4 backdrop-blur-sm transition duration-200 hover:border-indigo-300/25 hover:bg-white/[0.06]"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/30 to-indigo-400/10 text-indigo-200 ring-1 ring-inset ring-white/10">
                      <item.icon className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-white">{item.title}</p>
                      <p className="mt-1 text-xs leading-relaxed text-slate-400">{item.text}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-8 grid max-w-md grid-cols-3 gap-3">
                {[
                  ['1024', '维向量'],
                  ['4', '文档格式'],
                  ['3', '级权限'],
                ].map(([value, label]) => (
                  <div
                    key={label}
                    className="rounded-2xl border border-white/[0.06] bg-white/[0.04] px-3 py-3 text-center backdrop-blur-sm"
                  >
                    <p className="text-xl font-semibold tracking-tight text-white">{value}</p>
                    <p className="mt-1 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-500">
                      {label}
                    </p>
                  </div>
                ))}
              </div>

              {/* 2xl 以下：文字块与演示块共处一列，演示块收窄后内嵌在文字末尾 */}
              <div className="mt-7 2xl:hidden">
                <div className="mx-auto w-full max-w-[420px]">
                  <div className="mx-auto w-full max-w-[300px]">
                    <KnowledgeMap />
                  </div>
                  <div className="mt-5">
                    <DemoAnswerCard />
                  </div>
                </div>
              </div>
            </div>

            {/* 2xl 起：演示块独立成左栏的右半列，与上方的内嵌版本互斥（同一时刻只显示一份） */}
            <div className="hidden flex-col gap-6 2xl:flex">
              <KnowledgeMap />
              <DemoAnswerCard />
            </div>
          </div>

          <div className="relative z-10 mt-8 flex items-center justify-between border-t border-white/[0.06] pt-5 text-[11px] text-slate-500">
            <span>© {new Date().getFullYear()} Atlas · Knowledge RAG</span>
            <span className="flex items-center gap-4">
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="h-3 w-3 text-emerald-400/80" />
                私有部署
              </span>
              <span className="inline-flex items-center gap-1.5">
                <LockKeyhole className="h-3 w-3 text-indigo-300/80" />
                数据不离开服务器
              </span>
            </span>
          </div>
        </div>
      </aside>

      <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas px-5 py-12 sm:px-8">
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              'radial-gradient(rgba(15, 23, 42, 0.10) 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        />
        <div className="pointer-events-none absolute -left-24 top-16 h-72 w-72 rounded-full bg-indigo-200/30 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -right-16 h-80 w-80 rounded-full bg-emerald-200/20 blur-3xl" />

        <div className="relative w-full max-w-md">
          <div className="mb-8 flex items-center justify-between lg:hidden">
            <Logo />
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-medium text-emerald-700">
              <ShieldCheck className="h-3 w-3" />
              私有部署
            </span>
          </div>

          <div className="relative animate-slide-up overflow-hidden rounded-3xl border border-line bg-white/95 p-7 shadow-2xl shadow-slate-900/[0.07] backdrop-blur sm:p-8">
            <div className="absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-indigo-200 to-transparent" />
            <div className="hidden items-center justify-between lg:flex">
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-soft">
                Secure workspace
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-medium text-emerald-700">
                <ShieldCheck className="h-3 w-3" />
                私有部署
              </span>
            </div>

            <div className="mt-6 lg:mt-5">
              {eyebrow ? (
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
                  {eyebrow}
                </p>
              ) : null}
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-ink">{title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">{description}</p>
              <div className="mt-8">{children}</div>
              {footer ? <div className="mt-6 text-sm text-muted">{footer}</div> : null}
            </div>
          </div>

          <div className="mt-5 flex items-center justify-center gap-2 text-[11px] text-soft">
            <LockKeyhole className="h-3.5 w-3.5" />
            Session 仅存于你的服务器 · 数据不离开部署环境
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * 左栏底部的「演示回答」卡片：写死的静态示意（一个带引用角标的答案 + 两个来源标签），
 * 只用来说明产品形态。它不发起任何请求，数字与文件名都不可信，不要当成真实检索结果。
 */
function DemoAnswerCard() {
  return (
    <div className="relative rounded-2xl border border-white/[0.08] bg-white/[0.04] p-5 shadow-2xl shadow-black/30 backdrop-blur-md">
      <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-indigo-300/50 to-transparent" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[11px] text-slate-400">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
          </span>
          Atlas 正在检索 3 个知识库
        </div>
        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[9px] font-medium tracking-[0.18em] text-slate-400">
          LIVE
        </span>
      </div>
      <div className="mt-4 rounded-xl bg-white p-4 shadow-xl shadow-slate-950/40">
        <p className="text-sm leading-relaxed text-slate-800">
          根据产品手册，当前版本的发布代号是 <span className="font-semibold">Atlas</span>
          <span className="ml-1 rounded bg-indigo-50 px-1 py-0.5 font-medium text-indigo-600">
            [1]
          </span>
          ，核心链路使用 RAG 检索增强生成。
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-1 text-[10px] font-medium text-indigo-700">
            <FileText className="h-3 w-3" />
            产品手册.pdf
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 text-[10px] font-medium text-stone-500">
            <FileText className="h-3 w-3" />
            发布流程.md
          </span>
        </div>
      </div>
    </div>
  );
}
