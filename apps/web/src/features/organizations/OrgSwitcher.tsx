/**
 * 侧栏顶部的组织切换器：显示当前组织与我的角色，展开后可切组织、建组织、进成员/设置页。
 *
 * 切换语义（非显然）：
 * - 「切换」就是一次路由跳转 /orgs/{目标 id}，落到该组织首页；没有服务端会话级「当前组织」，
 *   也不保存到本地存储。请求作用域始终由 URL 里的 orgId 决定，各页面缓存键也都带 orgId
 * - 跳转会离开当前知识库的深路径（例如正在某个 kb 的对话页），这是有意的：目标组织的子路径未必存在
 * - 成员/设置两个入口固定指向「当前」org，不是列表里被点的那一个
 * 边界：organizations 列表来自 AuthProvider；AppShell 已保证传入的 org 一定存在。
 */
import { Link, useNavigate } from 'react-router-dom';
import { Building2, Check, ChevronDown, Plus, Settings2, Users } from 'lucide-react';
import { Avatar } from '../../components/ui/avatar';
import {
  Dropdown,
  DropdownItem,
  DropdownSeparator,
} from '../../components/ui/dropdown';
import type { Organization } from '../../lib/types';

/**
 * 组织切换器主体。
 * 步骤：
 * 1. 触发器展示当前组织名与角色（owner/admin/member 的中文标签）
 * 2. 面板列出全部组织，点击即 close + navigate(`/orgs/{id}`)，当前组织打勾
 * 3. 分隔线下是「创建组织」（/orgs/new）与本组织的「组织成员 / 组织设置」
 */
export function OrgSwitcher({
  org,
  organizations,
}: {
  org: Organization;
  organizations: Organization[];
}) {
  const navigate = useNavigate();

  return (
    <Dropdown
      trigger={
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2.5 text-left text-white outline-none transition hover:bg-white/[0.08] focus-visible:ring-2 focus-visible:ring-indigo-400/40"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-200">
            <Building2 className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{org.name}</span>
            <span className="block text-[11px] capitalize text-slate-400">
              {org.role === 'owner' ? '所有者' : org.role === 'admin' ? '管理员' : '成员'}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 text-slate-500" />
        </button>
      }
      panelClassName="w-full min-w-[240px]"
    >
      {(close) => (
        <>
          <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-soft">
            切换组织
          </p>
          {organizations.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                close();
                navigate(`/orgs/${item.id}`);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition hover:bg-stone-100"
            >
              <Avatar name={item.name} size="sm" />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {/* 当前组织打勾；列表顺序由后端按组织创建时间升序返回，切换器顺序因此保持稳定 */}
              {item.id === org.id ? <Check className="h-4 w-4 text-accent" /> : null}
            </button>
          ))}
          <DropdownSeparator />
          <DropdownItem
            onClick={() => {
              close();
              navigate('/orgs/new');
            }}
          >
            <Plus className="h-4 w-4 text-muted" />
            创建组织
          </DropdownItem>
          <DropdownSeparator />
          <DropdownItem
            onClick={() => {
              close();
              navigate(`/orgs/${org.id}/members`);
            }}
          >
            <Users className="h-4 w-4 text-muted" />
            组织成员
          </DropdownItem>
          <DropdownItem
            onClick={() => {
              close();
              navigate(`/orgs/${org.id}/settings`);
            }}
          >
            <Settings2 className="h-4 w-4 text-muted" />
            组织设置
          </DropdownItem>
        </>
      )}
    </Dropdown>
  );
}
