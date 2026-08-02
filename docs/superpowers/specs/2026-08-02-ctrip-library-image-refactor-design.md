# 携程图库选图通用化 — Design

## Context

`vbk-auto` 自动把运营确认的产品录入携程 VBK 平台时,封面图必须从携程图库导入,不能上传外部图。当前在 `src/main/automation/ctrip.ts:513` 的 `selectCtripLibraryCover` 已经实现了「打开图库弹窗 → 选 POI → 描述 → 查询 → 选图 → 同意 → 导入」的流程,但只服务于封面一个区块。运营后续需要让「路线」「景点」「特色」等图片区块也接入同样的图库导入流程;同时当前实现的等待策略以 `delay()` 轮询为主,出现过「查询后没有任何匹配图却并未直接报错,而是轮询到超时才退出」的情况,封面流程未走到选中图片那一步就被中断过。

产品 JSON 中的 `presentation.cover` 已经定义得够用;目标是抽出一个通用模块,为后续多个区块接入零成本,顺手修复封面流程现有的等待策略。

## Goals

- 抽出 `selectCtripLibraryImage(page, params)` 通用模块,使其能被封面/路线/景点/特色等任意「添加图片」卡片复用。
- 现有 `selectCtripLibraryCover` 改为内部调用通用模块;保持对外签名不变,既有业务无需改动。
- 显式等待替代轮询:每个关键交互节点都用 `waitFor({ state, timeout })` 等待元素进入期望状态,而非 `delay()` 后再观察。
- 当 POI 在携程图库不存在任何符合质量要求的图片时,明确报错;不允许静默选第一张。
- 为通用模块加单元/集成测试,验证等待策略与错误抛出的正确性。

## Non-goals

- 本阶段不交付路线 / 景点 / 特色区块的图库导入接入(留作后续单独 spec)。
- 不引入视觉自检或截图比对。
- 不改变 `findBestCtripLibraryImage` 的纯函数语义 — 它现在按 minQuality + 横版 ≥1280×800 选取,通用模块直接复用。
- 不调整现有的 UI 配色、按钮风格、错误提示文案以外的措辞。
- 不修改 `presentation` schema 结构(`cover.source` 仍是 `ctripLibrary`)。

## Design

### 1. 模块结构(`src/main/automation/ctrip.ts`)

| 名称 | 职责 |
| --- | --- |
| `selectCtripLibraryImage(page, params)` | 新增。**唯一与图库弹窗 UI 交互**的函数。负责:定位添加图片卡片、hover、点「图库导入」、等待弹窗出现、选 POI、填描述、点「查询」、等待至少一张结果、评分选图、勾选协议、点「同意并导入」、等待弹窗关闭。 |
| `selectCtripLibraryCover(page, cover)` | 现有包装,内部改为调用通用模块;负责:定位封面 `addCard`、调用通用模块、验证封面已落位(`hasCoverImage`)。 |

`selectCtripLibraryImage` 不持有产品 JSON 知识;它只接收 `params: LibraryImageParams` 并返回 `{ reused: boolean }`。

### 2. `LibraryImageParams` 接口

```ts
type LibraryImageAspect = "landscape" | "any";

type LibraryImageParams = {
  /** 区块的「添加图片」卡片,通用模块 hover 这个元素后点击「图库导入」 */
  trigger: Locator;
  /** 携程图库 POI,例如 "晋祠博物馆" */
  poi: string;
  /** 描述输入框(可空),用于 #description 输入框 */
  description?: string;
  /** 最低质量分,默认 3 */
  minQuality?: number;
  /** 横竖版约束,默认 "landscape"(≥1280×800) */
  aspect?: LibraryImageAspect;
  /** 用于错误信息的语义标签,例如 "封面" / "路线" */
  label: string;
};
```

`selectCtripLibraryCover` 把 `trigger` 固化为封面 `addCard`(由 `section.locator('.add-image-card')` 取得),把 `label` 固化为 `"封面"`,把 `aspect` 固化为 `"landscape"`,其它参数从 `presentation.cover` 来。

### 3. `findBestCtripLibraryImage` 微调

现状:

```ts
if (lowestQuality < minQuality || width < 1280 || height < 800 || width < height) return;
```

新增 `aspect` 参数(默认 `"landscape"`):

- `"landscape"`:保留现有约束(`width >= 1280 && height >= 800 && width >= height`)。
- `"any"`:只保留 `width >= 1 && height >= 1`,允许竖版。

纯函数测试已有覆盖逻辑,本次只增加 aspect 分支用例。

### 4. 通用模块的关键等待节点

| # | 操作 | 等待策略 |
| --- | --- | --- |
| 1 | `trigger.hover()` | `hover` 自身立即返回 |
| 2 | 等待「图库导入」链接可见 | `getByText('图库导入', { exact: true }).waitFor({ state: 'visible', timeout: 3_000 })` |
| 3 | 点击「图库导入」 | 点击后等弹窗 |
| 4 | 弹窗出现 | `page.getByRole('dialog').filter({ hasText: '从图库资源导入' }).waitFor({ state: 'visible', timeout: 10_000 })` |
| 5 | 选 POI | 复用现有 `selectSearchOption(page, dialog, 'PoiId', poi, '携程图库景点')` |
| 6 | 填描述(若有) | `dialog.locator('#description').fill(...)` |
| 7 | 点「查询」按钮可见 | `dialog.getByRole('button', { name: /查\s*询/ }).waitFor({ state: 'visible' }).then(...)` |
| 8 | 至少一张结果出现 | `dialog.locator('.importpic-modal-picitem').first().waitFor({ state: 'visible', timeout: 10_000 })` |
| 9 | 评分选图 | `findBestCtripLibraryImage(candidates, minQuality, aspect)`;若返回 -1 → 抛错并退出,不自动选 |
| 10 | 点击选中卡片 | `cards.nth(selectedIndex).click()` |
| 11 | 勾选协议 | 复用现有 `await agreement.click()` 逻辑 |
| 12 | 点「同意并导入」 | `await confirm.waitFor({ state: 'visible' }).then(() => confirm.click())` |
| 13 | 弹窗关闭 | `dialog.waitFor({ state: 'hidden', timeout: 15_000 })` |

`selectCtripLibraryImage` 不再使用 `delay()` 循环观察状态;`selectCtripLibraryCover` 末尾的封面落位轮询(限 10 秒)保留,因为 VBK 页面在弹窗关闭后异步渲染封面预览,先轮询确认这是合理且必要的。

### 5. 错误处理

- **POI 选项不存在** — 复用现有逻辑,错误信息加入 `${label}` 前缀: `"${label}: 携程图库景点未找到 '${poi}';可选 X、Y、Z"`。
- **0 张匹配图** — 抛出 `"${label}: '${poi}' 在携程图库未找到符合质量要求的图片(质量分 ≥ ${minQuality},最小 ${aspect === 'landscape' ? '1280×800' : '任意'})"`;**不**自动选第一张,留待用户手动添加。
- **弹窗未出现 / 未关闭** — 抛出 `"${label}: 图库弹窗未在 X 秒内出现/关闭"`(包含具体超时节点)。
- **协议按钮未勾选** — 抛出 `"${label}: 协议未自动勾选,请在 VBK 弹窗中手动同意"`。

所有错误信息都包含 `${label}` 与 `${poi}`,便于日志归因。

### 6. 测试

#### `test/library-image.test.ts`(新增)

启动 Playwright Chromium,载入一段最小静态 HTML,模拟图库弹窗(包含触发卡片、添加图片链接、POI 下拉、描述输入、查询按钮、N 张结果卡片、协议 checkbox、确认按钮):

- **场景 1:** POI 选项存在、6 张结果卡片、minQuality 3、横版约束,断言点击第 N(N 为评分最高)张卡片、勾选协议、点确认、弹窗关闭。
- **场景 2:** POI 选项不存在,断言抛 `"携程图库景点未找到..."` 错误。
- **场景 3:** 查询后 0 张结果,断言抛 `"未找到符合质量要求的图片"` 错误且**不**自动选。
- **场景 4:** 候选项全部竖版,`aspect: 'any'` 可选到、`aspect: 'landscape'` 抛错。

#### `test/find-best-ctrip-library-image.test.ts`(新增,与已有同类测试拆分)

覆盖新 `aspect` 参数:

- `"landscape"` 既有行为保留(已有测试用例补一两条追加)
- `"any"` 接受竖版
- 缺图/缺分辨率解析时仍按现状返回 `-1`

#### 既有测试

`selectCtripLibraryCover` 行为不变,既有的封面集成测试(若存在)继续通过。

## Risks

- 结果容器的等待必须区分「加载中」与「已加载 0 条」:点完「查询」后,先等 `.importpic-modal-picitem` 元素本身可见或出现空态(`.importpic-modal-empty` 或类似提示文案),二选其一都在 10 秒内发生,否则报"查询结果未在 10 秒内返回";再依据 `cards.count()` 决定走「评分选图」分支还是「0 张抛错」分支。
- 截图/截图比对不进(已在 Non-goals)。
- 测试 HTML 模拟的 DOM 结构必须与 VBK 真实结构对齐,否则集成测试无法发现真实 bug。
