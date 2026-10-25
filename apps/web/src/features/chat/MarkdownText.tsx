/**
 * 助手回答的 Markdown 渲染：GFM（表格、删除线、任务列表、自动链接等）+ 统一的外链行为。
 *
 * 边界与安全：
 * - 没有挂 rehype-raw，正文里的原始 HTML 按文本转义显示，不会被当标签执行
 * - 只覆盖 a 组件：链接强制新标签页打开，并带 rel="noreferrer noopener"（切断 window.opener）
 * - 代码块不做语法高亮（未引入高亮插件），配色由 styles/index.css 的 .markdown pre/code 负责
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** 渲染一段 Markdown 文本；content 为空串时 react-markdown 输出空容器，调用方无需另外判空 */
export function MarkdownText({ content }: { content: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
