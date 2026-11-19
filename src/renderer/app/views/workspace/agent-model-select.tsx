import type { AiModelCatalogs, AiProvider, Settings } from "../../../../shared/contracts";
import { aiModelChoices } from "../../../../shared/contracts";
import { Select } from "../../helpers/Select";
import { canQuickSwitchAiModel } from "../../helpers/ai-test-receipts";
import styles from "./agent-conversation.module.less";

const selectionValue = (provider: AiProvider, model: string) => `${provider}:${model}`;

export function AgentModelSelect({ settings, modelLists, disabled, switching, onChange }: {
  settings: Settings | null;
  modelLists: AiModelCatalogs;
  disabled: boolean;
  switching: boolean;
  onChange(provider: AiProvider, model: string): Promise<void>;
}) {
  if (!settings) return <span className={styles.modelLoading}>模型加载中…</span>;

  const choices = aiModelChoices(settings, modelLists);
  const active = choices.find((choice) => choice.active);
  const availableChoices = choices.filter((choice) => canQuickSwitchAiModel(
    settings,
    choice.provider,
    choice.value,
    undefined,
    Boolean(modelLists[choice.provider]?.some((model) => model.id === choice.value)),
  ));
  const availableKeys = new Set(availableChoices.map((choice) => selectionValue(choice.provider, choice.value)));
  const value = active ? selectionValue(active.provider, active.value) : "";

  return <label className={styles.modelPicker}>
    <span className={styles.modelPickerLabel}>模型</span>
    <Select
      className={styles.modelSelect}
      controlSize="compact"
      aria-label="选择下一次请求使用的 AI 模型"
      value={value}
      disabled={disabled || switching || !availableChoices.length}
      onChange={(event) => {
        const divider = event.target.value.indexOf(":");
        if (divider < 0) return;
        const provider = event.target.value.slice(0, divider) as AiProvider;
        const model = event.target.value.slice(divider + 1);
        void onChange(provider, model);
      }}
    >
      {choices.map((choice) => {
        const available = availableKeys.has(selectionValue(choice.provider, choice.value));
        return <option
          key={selectionValue(choice.provider, choice.value)}
          value={selectionValue(choice.provider, choice.value)}
          disabled={!available}
        >
          {choice.providerLabel} · {choice.label}{available ? "" : choice.configured ? "（需先测试）" : "（未配置）"}
        </option>;
      })}
    </Select>
    <span className={styles.modelPickerHint} role="status" aria-live="polite">
      {switching ? "切换中…" : !availableChoices.length ? "请先到设置配置模型" : disabled ? "任务运行中" : "下一次请求"}
    </span>
  </label>;
}
