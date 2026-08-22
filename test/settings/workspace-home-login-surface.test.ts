// 回归契约测试：保证「新增登录 / 登录 VBK」按钮真的能在 view=workspace 且无
// product 时打开一个可见的 VBK WebView surface。
//
// 三个根因被本测试锁定：
//   1) workspace-home 必须存在 LoginBrowserPanel 挂载点：
//      否则 derived.ts 的 useLayoutEffect 拿不到 ref，bounds/visible 不下发。
//   2) openLogin / addNewLogin 必须把 view 切到 workspace、browserOpen=true、
//      stage=vbk、loginPanelOpen=true —— 顺序上 setView 必须先于 setLoginPanelOpen。
//   3) addNewLogin 必须清空 stale vbkLogin.loggedIn，否则 derived.ts 的
//      「已登录且 loginPanelOpen 则自动收起」effect 会立刻把它关掉。
//
// 本次回归新增的契约：
//   - 登录面板展开时必须是「单一 VBK stage」：工作台首页卸载，VBK 页面占满主区域；
//   - LoginBrowserPanel 挂载期间必须持续持有 ref={browserRef} 的真 DOM；
//     不允许有 placeholder 死分支；
//   - 关闭按钮必须同时把 browserOpen / loginPanelOpen 置 false；
//   - 登录完成必须由用户点击“我已完成 VBK 登录”手动触发状态探测；
//   - openLogin 的 catch 必须调 setNotice 显式抛错，且不修改
//     loginPanelOpen / browserOpen（即保留登录 surface）；
//   - 刷新按钮必须使用 checkingVbkLogin 做 disabled 与 spin 图标，
//     防止并发重复探测。
//
// 之所以用「静态契约」而不是「真渲染测试」：
//   - 仓库 test infra 是 `node:test + tsx`，没有任何 React Testing Library / jsdom；
//   - 真正驱动一个 setState + useEffect 的场景需要 React reconciler 和 fake timers，
//     反而不如源码级契约直接命中本次回归。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

function read(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

const homeIndexSrc = read("src/renderer/app/views/workspace-home/index.tsx");
const homePanelSrc = read("src/renderer/app/views/workspace-home/LoginBrowserPanel.tsx");
const homePanelLessSrc = read("src/renderer/app/views/workspace-home/login-browser.module.less");
const homeIndexLessSrc = read("src/renderer/app/views/workspace-home/index.module.less");
const workflowSrc = read("src/renderer/app/actions/workflow.ts");
const vbkLoginBlockSrc = read("src/renderer/app/views/settings/vbk-login-block.tsx");

function sliceBetween(haystack: string, start: number, stop: number): string {
  // 闭区间 [start, stop]
  return haystack.slice(start, stop);
}

test("VBK 已记录账号的当前徽章跟随实时账号名称，避免显示旧快照名称", () => {
  assert.match(
    vbkLoginBlockSrc,
    /const\s+currentListAccount\s*=\s*currentAccount\s*\?[\s\S]*?accountName:\s*currentAccount[\s\S]*?:\s*snapCurrent;/,
    "已记录账号的当前徽章必须使用实时检测到的账号名称，不能优先显示旧快照名称。",
  );
  assert.match(
    vbkLoginBlockSrc,
    /<AccountList[\s\S]*?current=\{currentListAccount\}/,
    "AccountList 必须接收经过实时账号名称校正的当前账号。",
  );
});

test("VBK 刷新状态后同步刷新已记录账号列表", () => {
  assert.match(
    vbkLoginBlockSrc,
    /const\s+handleRefreshStatus\s*=\s*async\s*\(\)\s*=>\s*\{[\s\S]*?await\s+checkVbkLogin\(true\)[\s\S]*?await\s+refreshVbkLoginAccounts\(\)[\s\S]*?\};/,
    "刷新状态必须同时重新读取已记录账号，避免磁盘已有账号但界面列表仍是旧快照。",
  );
  assert.match(vbkLoginBlockSrc, /onClick=\{\(\)\s*=>\s*void\s+handleRefreshStatus\(\)\}/);
});

test("workspace-home 必须在 loginPanelOpen=true 时挂载 LoginBrowserPanel", () => {
  // 必须形如：{loginPanelOpen && <LoginBrowserPanel model={model} />}
  // 关键不变量：挂载条件来自 loginPanelOpen；否则浏览器永远不会被打开。
  assert.match(
    homeIndexSrc,
    /\{loginPanelOpen\s*&&\s*<LoginBrowserPanel\s+model=\{model\}\s*\/>\}/,
    "workspace-home/index.tsx 必须在 loginPanelOpen=true 时挂载 <LoginBrowserPanel model={model} />，"
    + "否则 derived.ts 的 useLayoutEffect 拿不到 browserRef，bounds/visible 永远不下发。",
  );
  // 不允许走「追加在 workspace-home 卡片下方」的旧分支（showLoginSurface 风格）。
  // 锁定的是「同一 grid 中分栏」的两列结构，而不是额外挂一段在卡片下方。
  assert.doesNotMatch(
    homeIndexSrc,
    /showLoginSurface\s*&&\s*<LoginBrowserPanel/,
    "LoginBrowserPanel 不应再以 showLoginSurface 卡片追加的方式挂载；"
    + "必须改为两列 login stage 中的右栏。",
  );
});

test("workspace-home 在登录打开时使用单一 VBK stage，不再 50/50 分栏", () => {
  assert.match(
    homeIndexSrc,
    /\{!loginPanelOpen\s*&&\s*<div\s+className=\{styles\.homeMain\}>/,
    "登录打开时工作台首页必须卸载，避免与 VBK 页面各占 50%。",
  );
  assert.doesNotMatch(
    homeIndexLessSrc,
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(0,\s*1fr\)/,
    "登录打开时不允许再使用两列 1fr/1fr layout。",
  );
  assert.match(
    homeIndexLessSrc,
    /\.homeStageOpen\s*\{[\s\S]*?height:\s*100%;[\s\S]*?display:\s*block/,
    "登录打开时 workspace-home 必须是单一全高 VBK stage。",
  );
  assert.match(
    homePanelLessSrc,
    /\.panel\s*\{[\s\S]*?height:\s*100%;[\s\S]*?min-height:\s*0/,
    "LoginBrowserPanel 必须占满 stage 高度，让 VBK viewport 成为主任务面。",
  );
});

test("LoginBrowserPanel 持续持有真 DOM ref（无 placeholder 死分支），并具备关闭操作", () => {
  // 必须存在 ref={browserRef}，否则 main 进程的 BrowserView 拿不到坐标。
  assert.match(
    homePanelSrc,
    /ref=\{browserRef\}/,
    "LoginBrowserPanel 必须把 browserRef 挂到一个真 DOM 节点，否则 derived.ts 的 useLayoutEffect 无法下发 bounds。",
  );
  // 必须存在 data-testid 锚点，让未来 e2e 能稳定选到登录 surface。
  assert.match(
    homePanelSrc,
    /data-testid="login-browser-viewport"/,
    "LoginBrowserPanel 的 viewport 必须有 data-testid 锚点，便于 e2e 校验 surface 是否真的渲染。",
  );
  // 不允许出现 placeholder 死分支（browserOpen 条件渲染两种 DOM 的写法）。
  // 简化后的唯一路径：父级卸载组件即关闭，不在组件内留 placeholder。
  assert.doesNotMatch(
    homePanelSrc,
    /\{browserOpen\s*\?\s*\(/,
    "LoginBrowserPanel 不应再有 browserOpen ? viewport : placeholder 分支；"
    + "持续挂载 + 父级卸载 是这次简化的唯一路径。",
  );
  // 关闭按钮：同时把 browserOpen 和 loginPanelOpen 置 false。
  // 关键不变量：点击关闭后两者必须都为 false，否则登录 surface / BrowserView 都会残留。
  assert.match(
    homePanelSrc,
    /const\s+handleClose\s*=\s*\(\s*\)\s*=>\s*\{[\s\S]*?setBrowserOpen\(false\)[\s\S]*?setLoginPanelOpen\(false\)[\s\S]*?\};/,
    "LoginBrowserPanel 的关闭按钮必须同时关闭 browserOpen 与 loginPanelOpen，"
    + "否则登录 surface / BrowserView 会一直残留在工作台首页。",
  );
});

test("LoginBrowserPanel 刷新按钮使用 checkingVbkLogin 做 disabled 与 loading 图标", () => {
  // 刷新按钮的 disabled 必须包含 checkingVbkLogin：避免用户连续点击导致并发探测。
  assert.match(
    homePanelSrc,
    /onClick=\{[^}]*checkVbkLogin\([^)]*\)[^}]*\}[\s\S]*?disabled=\{checkingVbkLogin\}/,
    "刷新按钮必须以 checkingVbkLogin 做 disabled，避免并发重复探测。",
  );
  // loading 图标：RefreshCw 必须根据 checkingVbkLogin 切换 spin 类。
  assert.match(
    homePanelSrc,
    /RefreshCw[\s\S]*?className=\{checkingVbkLogin\s*\?\s*styles\.spin\s*:\s*undefined\}/,
    "刷新按钮的 RefreshCw 图标必须根据 checkingVbkLogin 切换 spin 类，"
    + "避免探测期间没有任何视觉反馈。",
  );
  // spin 样式：必须有 keyframes 让 icon 旋转；不允许只写空样式。
  assert.match(
    homePanelLessSrc,
    /@keyframes\s+loginBrowserSpin\s*\{[\s\S]*?rotate\(360deg\)/,
    "login-browser.module.less 必须定义 loginBrowserSpin 关键帧动画，否则 loading 不会旋转。",
  );
});

test("LoginBrowserPanel 必须提供手动完成登录按钮，成功后刷新账号并回设置页", () => {
  assert.match(
    homePanelSrc,
    /我已完成 VBK 登录/,
    "登录完成必须由用户手动确认，不能只靠页面就绪自动探测。",
  );
  assert.match(
    homePanelSrc,
    /const\s+handleLoginDone\s*=\s*async\s*\(\s*\)\s*=>\s*\{[\s\S]*?await checkVbkLogin\(true\)[\s\S]*?await refreshVbkLoginAccounts\(\)/,
    "完成登录按钮必须先刷新 VBK 登录态，再刷新已记录账号列表。",
  );
  assert.match(
    homePanelSrc,
    /if \(next\?\.loggedIn\) \{[\s\S]*?setBrowserOpen\(false\)[\s\S]*?setLoginPanelOpen\(false\)[\s\S]*?setView\("settings"\)/,
    "检测到已登录后必须关闭 VBK login stage 并回到设置页展示账号结果。",
  );
});

test("openLogin 与 addNewLogin 都必须把 view 切到 workspace 并设 stage=browserOpen=vbk=loginPanelOpen=true", () => {
  // openLogin 函数体（从「const openLogin = 」起截到下一个「};」）必须包含
  // setView("workspace") / setBrowserOpen(true) / setStage("vbk") / setLoginPanelOpen(true)；
  // 顺序上 setView 必须先于 setLoginPanelOpen，避免路由切换晚于面板打开。
  const openLoginMatch = workflowSrc.match(/const\s+openLogin\s*=\s*\(\s*\)\s*=>\s*\{/);
  assert.ok(openLoginMatch, "workflow.ts 必须存在 const openLogin = () => { ... }");
  const openLoginStart = openLoginMatch.index! + openLoginMatch[0].length;
  // 用一个简单的括号匹配扫描到下一个「};」开头的位置。
  const closeIdx = workflowSrc.indexOf("\n  };", openLoginStart);
  assert.notEqual(closeIdx, -1, "无法定位 openLogin 闭合边界");
  const openLoginBody = sliceBetween(workflowSrc, openLoginStart, closeIdx + "\n  };".length);

  for (const required of [
    'setView("workspace")',
    'setBrowserOpen(true)',
    'setStage("vbk")',
    'setLoginPanelOpen(true)',
  ]) {
    assert.ok(
      openLoginBody.includes(required),
      `openLogin 必须包含 ${required}，确保 login surface 真正挂载并可见`,
    );
  }
  // setView 必须在 setLoginPanelOpen 之前；否则路由没切到 workspace，
  // ActiveRoute 还停在 AppSettingsPage，<LoginBrowserPanel> 不会被渲染。
  const viewIdx = openLoginBody.indexOf('setView("workspace")');
  const panelIdx = openLoginBody.indexOf("setLoginPanelOpen(true)");
  assert.ok(
    viewIdx >= 0 && panelIdx >= 0 && viewIdx < panelIdx,
    "openLogin 中 setView(\"workspace\") 必须先于 setLoginPanelOpen(true)，"
    + "否则路由还在 settings 时 loginPanelOpen 已被置 true，surface 没机会挂载。",
  );

  // addNewLogin 函数体必须同样包含上面四个 setter，且必须显式 setVbkLogin(null)
  // 清空 stale 登录判断，否则 derived.ts 的「已登录且 loginPanelOpen 则自动收起」
  // effect 会立刻把它关掉。
  const addNewLoginMatch = workflowSrc.match(/const\s+addNewLogin\s*=\s*async\s*\(\s*\)\s*=>\s*\{/);
  assert.ok(addNewLoginMatch, "workflow.ts 必须存在 const addNewLogin = async () => { ... }");
  const addNewLoginStart = addNewLoginMatch.index! + addNewLoginMatch[0].length;
  const addNewLoginCloseIdx = workflowSrc.indexOf("\n  };", addNewLoginStart);
  assert.notEqual(addNewLoginCloseIdx, -1, "无法定位 addNewLogin 闭合边界");
  const addNewLoginBody = sliceBetween(workflowSrc, addNewLoginStart, addNewLoginCloseIdx + "\n  };".length);

  for (const required of [
    'setView("workspace")',
    'setBrowserOpen(true)',
    'setStage("vbk")',
    'setLoginPanelOpen(true)',
    "setVbkLogin(null)",
  ]) {
    assert.ok(
      addNewLoginBody.includes(required),
      `addNewLogin 必须包含 ${required}，`
      + "其中 setVbkLogin(null) 用于清空 stale vbkLogin.loggedIn，"
      + "避免被 derived.ts 中「已登录且 loginPanelOpen 则自动收起」effect 立刻关掉。",
    );
  }
  const addViewIdx = addNewLoginBody.indexOf('setView("workspace")');
  const addPanelIdx = addNewLoginBody.indexOf("setLoginPanelOpen(true)");
  assert.ok(
    addViewIdx >= 0 && addPanelIdx >= 0 && addViewIdx < addPanelIdx,
    "addNewLogin 中 setView(\"workspace\") 必须先于 setLoginPanelOpen(true)，"
    + "否则路由还在 settings 时 loginPanelOpen 已被置 true，surface 没机会挂载。",
  );
});

test("openLogin 的 catch 必须 setNotice 显式抛错并保留登录 surface", () => {
  // 在 openLogin 函数体内定位 .catch 子句，断言：
  //   - 至少一次 setNotice(...)
  //   - 不允许 setLoginPanelOpen(false) / setBrowserOpen(false) —— 失败时必须保留 surface
  //   - 不允许 setVbkLogin({ loggedIn: false, ... }) —— 旧写法等价于「无提示的失败兜底」
  const openLoginMatch = workflowSrc.match(/const\s+openLogin\s*=\s*\(\s*\)\s*=>\s*\{/);
  assert.ok(openLoginMatch, "workflow.ts 必须存在 const openLogin = () => { ... }");
  const openLoginStart = openLoginMatch.index! + openLoginMatch[0].length;
  const closeIdx = workflowSrc.indexOf("\n  };", openLoginStart);
  const openLoginBody = sliceBetween(workflowSrc, openLoginStart, closeIdx + "\n  };".length);

  const catchMatch = openLoginBody.match(/\.catch\s*\(\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\}\s*\)/);
  assert.ok(catchMatch, "openLogin 必须存在 browser.login().catch(...) 错误处理分支");
  const catchBody = catchMatch[1];

  assert.match(
    catchBody,
    /setNotice\s*\(/,
    "openLogin 的 catch 必须 setNotice 显式抛错；旧的 setVbkLogin({ loggedIn: false, ... }) 不再视为可接受的失败兜底。",
  );
  assert.doesNotMatch(
    catchBody,
    /setLoginPanelOpen\(false\)/,
    "openLogin 的 catch 不应 setLoginPanelOpen(false)：失败时必须保留登录 surface，让用户能看到 notice 并继续重试。",
  );
  assert.doesNotMatch(
    catchBody,
    /setBrowserOpen\(false\)/,
    "openLogin 的 catch 不应 setBrowserOpen(false)：失败时必须保留登录 surface。",
  );
  assert.doesNotMatch(
    catchBody,
    /setVbkLogin\(\{\s*loggedIn:\s*false/,
    "openLogin 的 catch 不应使用 setVbkLogin({ loggedIn: false, ... })：这会让失败看起来像「已登出」，丢掉错误上下文。",
  );
});

test("登录面板打开期间不自动探测，必须等待用户手动确认", () => {
  const derivedSrc = read("src/renderer/app/state/derived.ts");
  const workflowOpenLogin = workflowSrc.slice(
    workflowSrc.indexOf("  const openLogin = () => {"),
    workflowSrc.indexOf("  /**\n   * 「新增登录」"),
  );
  const workflowAddLogin = workflowSrc.slice(
    workflowSrc.indexOf("  const addNewLogin = async () => {"),
    workflowSrc.indexOf("  /**\n   * 切换到本机已记录"),
  );
  assert.match(
    derivedSrc,
    /const loginPanelOpenRef = useRef\(loginPanelOpen\);[\s\S]*loginPanelOpenRef\.current = loginPanelOpen;/,
    "derived.ts 必须用 ref 读取登录面板最新开关状态，避免空 deps effect 读到旧值。",
  );
  assert.match(
    derivedSrc,
    /onPageReady\(\(\) => \{[\s\S]*?if \(loginPanelOpenRef\.current\) return;[\s\S]*?checkVbkLogin\(\)/,
    "登录面板打开时 page-ready 自动探测必须跳过。",
  );
  assert.match(
    derivedSrc,
    /setTimeout\(\(\) => \{[\s\S]*?if \(loginPanelOpenRef\.current\) return;[\s\S]*?checkVbkLogin\(\)/,
    "登录面板打开时启动兜底自动探测也必须跳过。",
  );
  assert.doesNotMatch(
    derivedSrc,
    /vbkLogin\?\.loggedIn[\s\S]*?setLoginPanelOpen\(false\)/,
    "登录成功后不允许全局 effect 自动收起登录面板，必须由完成登录按钮收尾。",
  );
  assert.doesNotMatch(
    workflowOpenLogin,
    /\.then\(\(\)\s*=>\s*checkVbkLogin\(\)\)/,
    "openLogin 只负责打开 VBK 页面，不应自动触发登录态确认。",
  );
  assert.doesNotMatch(
    workflowAddLogin,
    /checkVbkLogin\(\)/,
    "addNewLogin 只负责保存旧账号并打开新登录入口，不应自动确认新账号。",
  );
});
