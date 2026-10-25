/**
 * 新建知识库对话框：名称、描述、访问范围（组织公开 / 指定成员）。
 *
 * 职责与边界：
 * - 只负责收集字段并 POST /orgs/:orgId/knowledge-bases；成功后失效 ['knowledge-bases', orgId]、
 *   弹 toast、回调 onCreated（父级据此跳转）、关闭
 * - 提交按钮在 Dialog 的 footer 里，和表单是兄弟节点，因此必须用 HTML 的 form 属性把按钮挂回表单；
 *   这也是本文件需要唯一 id 的直接原因（见下）
 * - 边界：不负责权限判断（谁能建库由路由/后端决定），也不在这里做删除或改名（那是 KbSettingsDialog）
 *
 * 为什么三个 id 都用 useId() 生成（曾出过线上问题）：
 * - 本对话框有两个挂载点：AppShell 的全局「新建知识库」入口，以及 OrgHomePage 页内按钮；
 *   在组织首页上两者同时存在。Dialog 是原生 <dialog>，关闭时内容仍留在 DOM 里（只是不显示）
 * - 早先出过事故：表单/字段 id 当时是写死的，两个实例同页就产生重复 id。footer 提交按钮的
 *   form="<固定 id>" 按文档顺序只能命中第一个表单，很可能正是那个关着的、不可见的实例；
 *   提交时浏览器去校验那个表单里的 required 字段，而它不可聚焦，于是控制台报
 *   "An invalid form control with name='' is not focusable"，创建请求根本没发出去（表现为点了没反应）
 * - useId 每次实例化给出不同值，三个 id 各自独立（表单一个、名称字段一个、描述字段一个），
 *   实例之间与字段之间都不会再撞
 */
import { useEffect, useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Globe2, Lock, Sparkles } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Textarea } from '../../components/ui/input';
import { useToast } from '../../components/ui/toast';
import { apiFetch, ApiError } from '../../lib/api';
import type { AccessMode, KnowledgeBase } from '../../lib/types';
import { cn } from '../../lib/cn';

/**
 * 新建知识库。
 * 步骤：
 * 1. useId 取三个唯一 id：formId 供 footer 按钮的 form= 回指，nameId/descriptionId 供 label 关联
 * 2. open 变 true 时把字段重置为空、访问范围回到默认的「组织公开」——Dialog 常驻 DOM，
 *    不重置会把上次填了一半的内容带进下一次打开
 * 3. 提交由 useMutation 发 POST；成功走失效 → toast → onCreated → onClose——invalidateQueries 未 await，
 *    跳转时列表只是被触发失效、随后刷新，不保证那一刻已是最新
 * 4. 错误只读 mutation.error，展示在表单顶部；名称非空是唯一的前端禁用条件（其余由后端校验）
 */
export function CreateKbDialog({
  open,
  onClose,
  orgId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  orgId: string;
  onCreated?: (kb: KnowledgeBase) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // 步骤 1：每个实例各自一份 id，同页多实例也不会撞（原因见文件头）
  const formId = useId();
  const nameId = useId();
  const descriptionId = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [accessMode, setAccessMode] = useState<AccessMode>('org');

  // 步骤 2：只在打开时重置。依赖里只有 open，所以在弹窗内编辑不会把自己清掉
  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setAccessMode('org');
    }
  }, [open]);

  // 步骤 3：成功后先失效列表缓存再关闭，父级的跳转/列表刷新都拿得到新数据
  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<KnowledgeBase>(`/orgs/${orgId}/knowledge-bases`, {
        method: 'POST',
        body: JSON.stringify({ name, description, accessMode }),
      }),
    onSuccess: (kb) => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-bases', orgId] });
      toast({ title: '知识库已创建', description: kb.name, type: 'success' });
      onCreated?.(kb);
      onClose();
    },
  });

  const error = mutation.error;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="新建知识库"
      description="一个知识库对应一组文档和围绕它们的对话。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            取消
          </Button>
          <Button
            type="submit"
            form={formId}
            loading={mutation.isPending}
            disabled={!name.trim()}
          >
            创建知识库
          </Button>
        </>
      }
    >
      {/* id 与 footer 按钮的 form= 必须成对：这是把外部提交按钮接回本表单的唯一纽带 */}
      <form
        id={formId}
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700">
            {error instanceof ApiError ? error.message : '创建失败，请稍后重试'}
          </div>
        ) : null}

        <Field label="名称" htmlFor={nameId} hint="1–60 字">
          <Input
            id={nameId}
            name="name"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：产品手册、客服 FAQ"
            autoFocus
            required
          />
        </Field>

        <Field label="描述" htmlFor={descriptionId} hint="可选">
          <Textarea
            id={descriptionId}
            name="description"
            value={description}
            maxLength={500}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="简要说明这个知识库的内容和使用场景"
          />
        </Field>

        <div className="space-y-2">
          <p className="text-sm font-medium text-ink">访问范围</p>
          {/* 两个大号单选卡：org = 组织内所有人默认可问答；restricted = 仅创建者/管理员与显式授权者 */}
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              {
                value: 'org' as const,
                icon: Globe2,
                title: '组织公开',
                text: '所有成员默认可查看与问答',
              },
              {
                value: 'restricted' as const,
                icon: Lock,
                title: '指定成员',
                text: '仅创建者与获授权成员可访问',
              },
            ].map((option) => {
              const active = accessMode === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setAccessMode(option.value)}
                  className={cn(
                    'relative rounded-xl border p-3.5 text-left outline-none transition',
                    active
                      ? 'border-accent/50 bg-accent-soft/70 ring-2 ring-accent/10'
                      : 'border-line bg-white hover:border-line-strong',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <option.icon
                      className={cn('h-4 w-4', active ? 'text-accent' : 'text-soft')}
                    />
                    <span className="text-sm font-medium text-ink">{option.title}</span>
                    {active ? <Check className="ml-auto h-4 w-4 text-accent" /> : null}
                  </div>
                  <p className="mt-1.5 pl-6 text-xs leading-relaxed text-muted">
                    {option.text}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-xl bg-stone-50 px-3.5 py-3 text-xs leading-relaxed text-muted">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
          <span>创建后即可上传 TXT、MD、PDF、DOCX 文档，系统会自动切分并建立向量索引。</span>
        </div>
      </form>
    </Dialog>
  );
}
