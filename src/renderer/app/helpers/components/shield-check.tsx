/**
 * ShieldCheck：内联 SVG 盾牌 + 勾号图标；
 *   - 用 lucide-react 的 ShieldCheck 在某些视图里会因为 svg 命名空间 / 项目字体策略
 *     与 less 模块冲突，故保留自绘版本；
 *   - role="presentation" + aria-hidden 让屏幕阅读器忽略，仅作装饰。
 */

export function ShieldCheck(props: { size?: number; className?: string }) {
  const { size = 16, className } = props;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="presentation"
      aria-hidden="true"
    >
      <path d="M12 3l8 3v5c0 4.5-3 8.4-8 9-5-.6-8-4.5-8-9V6l8-3z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}