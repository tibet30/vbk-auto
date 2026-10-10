/**
 * EmptyProductState：产品列表为空时的占位；
 *   - aiConfigured=false 时引导去「设置」配置 API Key；
 *   - aiConfigured=true 时引导创建第一个产品。
 */

import { FileText } from "lucide-react";
import shared from "../../views/shared.module.less";

export function EmptyProductState({
  aiConfigured,
  providerLabel,
}: {
  aiConfigured: boolean;
  providerLabel: string;
}) {
  if (!aiConfigured) {
    return (
      <div className={shared.emptyState}>
        <FileText size={28} />
        <h3>请先配置 AI 模型</h3>
        <p>当前尚未配置 {providerLabel} 的 API Key，无法创建产品。请到「设置」中完成 AI 模型配置后再回来。</p>
      </div>
    );
  }
  return (
    <div className={shared.emptyState}>
      <FileText size={28} />
      <h3>还没有产品</h3>
      <p>从目的地、天数和产品形态开始，几分钟内得到可审查的通用方案。</p>
    </div>
  );
}