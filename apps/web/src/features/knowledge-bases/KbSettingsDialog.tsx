/**
 * 知识库设置弹窗：改名 / 改描述 + 危险区的「删除知识库」。
 *
 * 职责与边界：
 * - 只发 PATCH 与 DELETE /orgs/:orgId/knowledge-bases/:kbId；访问范围与成员授权不在这里，在成员页
 * - canDelete 由父级（KbLayout）算好传入，用于是否渲染危险区；它只是体验层的显隐，
 *   后端对删除另有「创建者或组织 owner/admin」的判定
 * - 删除是两段式：先点「删除知识库」展开二次确认，再点「确认永久删除」才发请求；
 *   没有「输入库名才能删」这类强确认，只靠两次点击防误触
 * - 本组件全局只挂载一处（KbLayout），所以表单 id 可以写死，不像 CreateKbDialog 需要 useId
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Textarea } from '../../components/ui/input';
import { useToast } from '../../components/ui/toast';
import { apiFetch, ApiError } from '../../lib/api';
import type { KnowledgeBase } from '../../lib/types';

/**
 * 知识库设置。
 * 步骤：
 * 1. 打开时用最新的 kb 重置 name/description 与二次确认状态——Dialog 常驻 DOM，
 *    不重置会把上一次未保存的编辑或已展开的删除确认带进下一次打开
 * 2. 保存：PATCH 名称与描述（不传 accessMode，避免把成员页刚改的访问范围覆盖回去）
 *    → 失效 ['kb'] 与列表 → toast → 关闭
 * 3. 删除：DELETE → 失效列表、removeQueries 掉 ['kb']（库已不存在，留着只会命中缓存）
 *    → toast → 先 onClose 再 onDeleted（父级跳回组织首页）
 * 4. 两类错误合并展示在表单顶部；删除按钮自身另有 loading，避免二次提交
 */
export function KbSettingsDialog({
  open,
  onClose,
  kb,
  orgId,
  canDelete,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  kb: KnowledgeBase;
  orgId: string;
  canDelete: boolean;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(kb.name);
  const [description, setDescription] = useState(kb.description);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (open) {
      setName(kb.name);
      setDescription(kb.description);
      setConfirmDelete(false);
    }
  }, [open, kb.name, kb.description]);

  const update = useMutation({
    mutationFn: () =>
      apiFetch<KnowledgeBase>(`/orgs/${orgId}/knowledge-bases/${kb.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, description }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kb', orgId, kb.id] });
      queryClient.invalidateQueries({ queryKey: ['knowledge-bases', orgId] });
      toast({ title: '知识库设置已更新', type: 'success' });
      onClose();
    },
  });

  const remove = useMutation({
    mutationFn: () =>
      apiFetch(`/orgs/${orgId}/knowledge-bases/${kb.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-bases', orgId] });
      queryClient.removeQueries({ queryKey: ['kb', orgId, kb.id] });
      toast({ title: '知识库已删除', type: 'success' });
      onClose();
      onDeleted();
    },
  });

  const error = update.error ?? remove.error;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="知识库设置"
      description="修改名称与描述；访问范围与成员授权在成员页面管理。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
            取消
          </Button>
          <Button
            type="submit"
            form="kb-settings-form"
            loading={update.isPending}
            disabled={!name.trim()}
          >
            保存修改
          </Button>
        </>
      }
    >
      <form
        id="kb-settings-form"
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          update.mutate();
        }}
      >
        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700">
            {error instanceof ApiError ? error.message : '操作失败，请稍后重试'}
          </div>
        ) : null}

        <Field label="名称" htmlFor="kb-settings-name">
          <Input
            id="kb-settings-name"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field label="描述" htmlFor="kb-settings-description">
          <Textarea
            id="kb-settings-description"
            value={description}
            maxLength={500}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </form>

      {canDelete ? (
        <div className="mt-7 rounded-xl border border-red-200 bg-red-50/60 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
            <div className="flex-1">
              <p className="text-sm font-medium text-red-800">删除知识库</p>
              <p className="mt-1 text-xs leading-relaxed text-red-700">
                将永久删除该知识库的文档、向量索引与所有对话，且无法恢复。
              </p>
              {confirmDelete ? (
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    variant="danger"
                    size="sm"
                    loading={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    确认永久删除
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setConfirmDelete(false)}
                    disabled={remove.isPending}
                  >
                    取消
                  </Button>
                </div>
              ) : (
                <Button
                  variant="danger"
                  size="sm"
                  className="mt-3"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  删除知识库
                </Button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
