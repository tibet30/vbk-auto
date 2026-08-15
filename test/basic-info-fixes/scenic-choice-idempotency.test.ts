import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { fillScenicAreaSpots } from "../../src/main/automation/ctrip/basic-info/scenic.js";

test("已提交 choice 时跳过同名景点，且不受第四级当前值影响", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>.ant-select-dropdown-hidden { display: none; }</style>
      <div id="scenic_area">
        <span class="ant-select-selection__choice" title="西安城墙（西安/陕西/中国）"><span class="ant-select-selection__choice__content">西安城墙（西安/陕西/中国）</span><span class="ant-select-selection__choice__remove">×</span></span>
        <div id="country" role="combobox"><span class="ant-select-selection-item" title="中国">中国</span><input class="ant-select-search__field" placeholder="国家" /></div>
        <div id="province" role="combobox"><span class="ant-select-selection-item" title="陕西">陕西</span><input class="ant-select-search__field" placeholder="省份" /></div>
        <div id="city" role="combobox"><span class="ant-select-selection-item" title="西安">西安</span><input class="ant-select-search__field" placeholder="城市/景区" /></div>
        <div id="spot" role="combobox"><span class="ant-select-selection-item" title="西安明城墙">西安明城墙</span><input class="ant-select-search__field" placeholder="景点" /></div>
        <button id="add" type="button">添加</button>
      </div>
      <div class="ant-select-dropdown ant-select-dropdown-hidden"><div class="ant-select-item-option">西安城墙</div></div>
      <script>
        window.scenicEvents = [];
        document.querySelectorAll('#scenic_area [role="combobox"]').forEach((box) => {
          box.addEventListener('click', () => window.scenicEvents.push('click:' + box.id));
          box.querySelector('input').addEventListener('input', () => window.scenicEvents.push('input:' + box.id));
        });
        document.querySelector('#add').addEventListener('click', () => window.scenicEvents.push('add'));
      </script>
    `);
    const logs: string[] = [];
    await fillScenicAreaSpots(page, "陕西", ["西安城墙"], logs);
    const observed = await page.evaluate(() => (window as unknown as { scenicEvents: string[] }).scenicEvents);
    assert.equal(observed.filter((event) => event.startsWith("click:")).length, 0);
    assert.equal(observed.filter((event) => event.startsWith("input:")).length, 0);
    assert.equal(observed.filter((event) => event === "add").length, 0);
    assert.ok(logs.some((log) => log.includes("已存在")));
  } finally {
    await browser.close();
  }
});

test("无已提交 choice 时精确选择景点并添加完整标签", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>.ant-select-dropdown-hidden { display: none; }</style>
      <div id="scenic_area">
        <div id="country" role="combobox"><input class="ant-select-search__field" placeholder="国家" /></div>
        <div id="province" role="combobox"><input class="ant-select-search__field" placeholder="省份" /></div>
        <div id="city" role="combobox"><input class="ant-select-search__field" placeholder="城市/景区" /></div>
        <div id="spot" role="combobox" aria-controls="spot-options"><input class="ant-select-search__field" placeholder="景点" /></div>
        <button id="add" type="button">添加</button>
      </div>
      <div id="spot-options" class="ant-select-dropdown ant-select-dropdown-hidden"><div class="ant-select-item-option">西安城墙</div></div>
      <script>
        window.scenicEvents = [];
        const dropdown = document.querySelector('.ant-select-dropdown');
        const spot = document.querySelector('#spot');
        document.querySelectorAll('#scenic_area [role="combobox"]').forEach((box) => {
          box.addEventListener('click', () => { window.scenicEvents.push('click:' + box.id); if (box.id === 'spot') dropdown.classList.remove('ant-select-dropdown-hidden'); });
          box.querySelector('input').addEventListener('input', () => window.scenicEvents.push('input:' + box.id));
        });
        document.querySelector('.ant-select-item-option').addEventListener('click', () => {
          window.scenicEvents.push('choose');
          const item = document.createElement('span'); item.className = 'ant-select-selection-item'; item.title = '西安城墙'; item.textContent = '西安城墙'; spot.prepend(item);
          dropdown.classList.add('ant-select-dropdown-hidden');
        });
        document.querySelector('#add').addEventListener('click', () => {
          window.scenicEvents.push('add'); const tag = document.createElement('span'); tag.className = 'ant-tag'; tag.textContent = '西安城墙（西安/陕西/中国）'; document.querySelector('#scenic_area').append(tag); spot.querySelector('.ant-select-selection-item').remove();
        });
      </script>
    `);
    const logs: string[] = [];
    await fillScenicAreaSpots(page, "陕西", ["西安城墙"], logs);
    const observed = await page.evaluate(() => (window as unknown as { scenicEvents: string[] }).scenicEvents);
    assert.ok(observed.includes("click:spot"));
    assert.ok(observed.some((event) => event.startsWith("input:spot")));
    assert.ok(observed.includes("add"));
    assert.equal(await page.locator("#scenic_area .ant-tag").innerText(), "西安城墙（西安/陕西/中国）");
  } finally {
    await browser.close();
  }
});

test("第四级当前同名值不算已添加", async () => {
  // 真实 VBK 第四级 combobox 当前选择值渲染为 .ant-select-selection-item（未提交）。
  // 没有专门的「防御性排除」会把同名输入误判为已在国家景区标签中。
  // 本测试固定：即便第四级当前显示「西安城墙」，输入「西安城墙」也必须走
  // 正常新增流程（点击搜索 → 选 → 添加），最终 .ant-tag 写入完整标签文本。
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>.ant-select-dropdown-hidden { display: none; }</style>
      <div id="scenic_area">
        <div id="country" role="combobox"><span class="ant-select-selection-selected-value" title="中国">中国</span></div>
        <div id="province" role="combobox"><span class="ant-select-selection-selected-value" title="陕西">陕西</span></div>
        <div id="city" role="combobox"><span class="ant-select-selection-selected-value" title="西安">西安</span></div>
        <div id="spot" role="combobox" aria-controls="spot-options"><span class="ant-select-selection-item" title="西安城墙">西安城墙</span><input class="ant-select-search__field" placeholder="景点" /></div>
        <button id="add" type="button">添加</button>
      </div>
      <div id="spot-options" class="ant-select-dropdown ant-select-dropdown-hidden"><div class="ant-select-item-option">西安城墙</div></div>
      <script>
        window.scenicEvents = [];
        const dropdown = document.querySelector('.ant-select-dropdown');
        const spot = document.querySelector('#spot');
        document.querySelectorAll('#scenic_area [role="combobox"]').forEach((box) => {
          const input = box.querySelector('input');
          box.addEventListener('click', () => {
            window.scenicEvents.push('click:' + box.id);
            if (box.id === 'spot') dropdown.classList.remove('ant-select-dropdown-hidden');
          });
          if (input) input.addEventListener('input', () => window.scenicEvents.push('input:' + box.id));
        });
        document.querySelector('.ant-select-item-option').addEventListener('click', () => {
          window.scenicEvents.push('choose');
          const item = spot.querySelector('.ant-select-selection-item');
          if (item) {
            item.textContent = '西安城墙（西安/陕西/中国）';
            item.setAttribute('title', '西安城墙（西安/陕西/中国）');
          }
          dropdown.classList.add('ant-select-dropdown-hidden');
        });
        document.querySelector('#add').addEventListener('click', () => {
          window.scenicEvents.push('add');
          const tag = document.createElement('span');
          tag.className = 'ant-tag';
          tag.textContent = '西安城墙（西安/陕西/中国）';
          document.querySelector('#scenic_area').append(tag);
          const item = spot.querySelector('.ant-select-selection-item');
          if (item) item.remove();
        });
      </script>
    `);
    const logs: string[] = [];
    await fillScenicAreaSpots(page, "陕西", ["西安城墙"], logs);
    const observed = await page.evaluate(() => (window as unknown as { scenicEvents: string[] }).scenicEvents);
    assert.ok(observed.includes("click:spot"), "第四级当前同名值不算已添加，必须进入搜索流程，实际事件：" + JSON.stringify(observed));
    assert.ok(observed.includes("add"), "必须点击添加按钮完成新增，实际事件：" + JSON.stringify(observed));
    assert.ok(!logs.some((log) => log.includes("已存在")), "不得因为第四级当前显示同值而误判为已存在，实际 logs：" + JSON.stringify(logs));
    assert.equal(await page.locator("#scenic_area .ant-tag").innerText(), "西安城墙（西安/陕西/中国）", "新增完成后 .ant-tag 必须写入完整标签文本");
  } finally {
    await browser.close();
  }
});

test("页面已提交 4 项景点时不再搜索 / 添加", async () => {
  // 已有 ≥ 3 项景点时，本次调用不应触发任何 combobox 点击 / 输入 / 添加按钮。
  // 仅为保护边界：填到 4 项这种「意外超限」的场景也不能继续追加，必须硬切断。
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>.ant-select-dropdown-hidden { display: none; }</style>
      <div id="scenic_area">
        <span class="ant-tag">秦始皇兵马俑（西安/陕西/中国）</span>
        <span class="ant-tag">大雁塔（西安/陕西/中国）</span>
        <span class="ant-tag">华清宫（西安/陕西/中国）</span>
        <span class="ant-tag">钟楼（西安/陕西/中国）</span>
        <div id="country" role="combobox"><input class="ant-select-search__field" placeholder="国家" /></div>
        <div id="province" role="combobox"><input class="ant-select-search__field" placeholder="省份" /></div>
        <div id="city" role="combobox"><input class="ant-select-search__field" placeholder="城市/景区" /></div>
        <div id="spot" role="combobox" aria-controls="spot-options"><input class="ant-select-search__field" placeholder="景点" /></div>
        <button id="add" type="button">添加</button>
      </div>
      <div class="ant-select-dropdown ant-select-dropdown-hidden"><div class="ant-select-item-option">大明宫</div></div>
      <script>
        window.scenicEvents = [];
        document.querySelectorAll('#scenic_area [role="combobox"]').forEach((box) => {
          box.addEventListener('click', () => window.scenicEvents.push('click:' + box.id));
          const input = box.querySelector('input');
          if (input) input.addEventListener('input', () => window.scenicEvents.push('input:' + box.id));
        });
        document.querySelector('#add').addEventListener('click', () => window.scenicEvents.push('add'));
      </script>
    `);
    const logs: string[] = [];
    await fillScenicAreaSpots(page, "陕西", ["大明宫", "未央宫"], logs);
    const observed = await page.evaluate(() => (window as unknown as { scenicEvents: string[] }).scenicEvents);
    assert.equal(observed.length, 0, "已提交 4 项景点时不能再点击任何控件，实际事件：" + JSON.stringify(observed));
    assert.equal(await page.locator("#scenic_area .ant-tag").count(), 4, "现有 4 项景点必须原封不动");
    assert.ok(logs.some((log) => log.includes("≥ 3")), "必须日志告知页面已达上限，实际 logs：" + JSON.stringify(logs));
  } finally {
    await browser.close();
  }
});

test("页面已提交 2 项景点时只补 1 项（达到 3 后停止）", async () => {
  // 已有 2 项 -> 本次最多补 1 项（3 - 2 = 1）。
  // 即使传入多个候选，达到上限后必须停止；后续点击不会被发出。
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>.ant-select-dropdown-hidden { display: none; }</style>
      <div id="scenic_area">
        <span class="ant-tag">秦始皇兵马俑（西安/陕西/中国）</span>
        <span class="ant-tag">大雁塔（西安/陕西/中国）</span>
        <div id="country" role="combobox"><input class="ant-select-search__field" placeholder="国家" /></div>
        <div id="province" role="combobox"><input class="ant-select-search__field" placeholder="省份" /></div>
        <div id="city" role="combobox"><input class="ant-select-search__field" placeholder="城市/景区" /></div>
        <div id="spot" role="combobox" aria-controls="spot-options"><input class="ant-select-search__field" placeholder="景点" /></div>
        <button id="add" type="button">添加</button>
      </div>
      <div id="spot-options" class="ant-select-dropdown ant-select-dropdown-hidden"><div class="ant-select-item-option">华清宫</div><div class="ant-select-item-option">钟楼</div></div>
      <script>
        window.scenicEvents = [];
        const dropdown = document.querySelector('.ant-select-dropdown');
        const spot = document.querySelector('#spot');
        document.querySelectorAll('#scenic_area [role="combobox"]').forEach((box) => {
          box.addEventListener('click', () => {
            window.scenicEvents.push('click:' + box.id);
            if (box.id === 'spot') dropdown.classList.remove('ant-select-dropdown-hidden');
          });
          const input = box.querySelector('input');
          if (input) input.addEventListener('input', () => window.scenicEvents.push('input:' + box.id));
        });
        document.querySelectorAll('.ant-select-item-option').forEach((item) => {
          item.addEventListener('click', () => {
            window.scenicEvents.push('choose:' + item.textContent);
            const itemSpan = document.createElement('span');
            itemSpan.className = 'ant-select-selection-item';
            itemSpan.title = item.textContent + '（西安/陕西/中国）';
            itemSpan.textContent = item.textContent + '（西安/陕西/中国）';
            spot.prepend(itemSpan);
            dropdown.classList.add('ant-select-dropdown-hidden');
          });
        });
        document.querySelector('#add').addEventListener('click', () => {
          window.scenicEvents.push('add');
          const tag = document.createElement('span');
          tag.className = 'ant-tag';
          const item = spot.querySelector('.ant-select-selection-item');
          tag.textContent = item ? item.title : '未命名';
          document.querySelector('#scenic_area').append(tag);
          if (item) item.remove();
        });
      </script>
    `);
    const logs: string[] = [];
    await fillScenicAreaSpots(page, "陕西", ["华清宫", "钟楼"], logs);
    const observed = await page.evaluate(() => (window as unknown as { scenicEvents: string[] }).scenicEvents);
    const addCount = observed.filter((event) => event === "add").length;
    assert.equal(addCount, 1, "已有 2 项时最多新增 1 项，实际 add 次数：" + addCount + "，事件：" + JSON.stringify(observed));
    assert.equal(await page.locator("#scenic_area .ant-tag").count(), 3, "完成后应有 3 项景点");
    assert.ok(logs.some((log) => log.includes("≥ 3") && log.includes("停止")), "应在达到 3 后写日志，实际 logs：" + JSON.stringify(logs));
  } finally {
    await browser.close();
  }
});

test("页面满 3 项且候选与已提交同名时不重复添加", async () => {
  // 已提交 3 项且传入「同名」候选 -> 必须用 taggedSpotExists 路径短路，
  // 不能因为页面以达到上限而表面看起来「什么都没做」。
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>.ant-select-dropdown-hidden { display: none; }</style>
      <div id="scenic_area">
        <span class="ant-tag">西安城墙（西安/陕西/中国）</span>
        <span class="ant-tag">大雁塔（西安/陕西/中国）</span>
        <span class="ant-tag">华清宫（西安/陕西/中国）</span>
        <div id="country" role="combobox"><input class="ant-select-search__field" placeholder="国家" /></div>
        <div id="provobox" role="combobox"><input class="ant-select-search__field" placeholder="省份" /></div>
        <div id="city" role="combobox"><input class="ant-select-search__field" placeholder="城市/景区" /></div>
        <div id="spot" role="combobox" aria-controls="spot-options"><input class="ant-select-search__field" placeholder="景点" /></div>
        <button id="add" type="button">添加</button>
      </div>
      <div class="ant-select-dropdown ant-select-dropdown-hidden"><div class="ant-select-item-option">西安城墙</div></div>
      <script>
        window.scenicEvents = [];
        document.querySelectorAll('#scenic_area [role="combobox"]').forEach((box) => {
          box.addEventListener('click', () => window.scenicEvents.push('click:' + box.id));
          const input = box.querySelector('input');
          if (input) input.addEventListener('input', () => window.scenicEvents.push('input:' + box.id));
        });
        document.querySelector('#add').addEventListener('click', () => window.scenicEvents.push('add'));
      </script>
    `);
    const logs: string[] = [];
    await fillScenicAreaSpots(page, "陕西", ["西安城墙"], logs);
    const observed = await page.evaluate(() => (window as unknown as { scenicEvents: string[] }).scenicEvents);
    assert.equal(observed.length, 0, "满 3 项 + 同名候选时不能发出任何交互事件，实际：" + JSON.stringify(observed));
    assert.equal(await page.locator("#scenic_area .ant-tag").count(), 3, "现有 3 项景点不应被重复添加");
    assert.ok(logs.some((log) => log.includes("≥ 3")), "应日志告知页面已达上限，实际 logs：" + JSON.stringify(logs));
  } finally {
    await browser.close();
  }
});

test("省份标签「陕西(中国)」「陕西（中国）」「陕西省(中国)」不占用景点名额", async () => {
  // 省份在 VBK 中可能以「陕西」「陕西(中国)」「陕西（中国）」「陕西省(中国)」
  // 等多种形状渲染。仅以括号判定会把「陕西(中国)」误计为景点。
  // 本测试固定：仅凭“类似“陕西(中国)”这种省份标签，spots 名额不扣。
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>.ant-select-dropdown-hidden { display: none; }</style>
      <div id="scenic_area">
        <span class="ant-tag">陕西(中国)</span>
        <span class="ant-tag">陕西（中国）</span>
        <span class="ant-tag">陕西省(中国)</span>
        <span class="ant-tag">秦始皇兵马俑（西安/陕西/中国）</span>
        <span class="ant-tag">大雁塔（西安/陕西/中国）</span>
        <div id="country" role="combobox"><input class="ant-select-search__field" placeholder="国家" /></div>
        <div id="province" role="combobox"><input class="ant-select-search__field" placeholder="省份" /></div>
        <div id="city" role="combobox"><input class="ant-select-search__field" placeholder="城市/景区" /></div>
        <div id="spot" role="combobox" aria-controls="spot-options"><input class="ant-select-search__field" placeholder="景点" /></div>
        <button id="add" type="button">添加</button>
      </div>
      <div id="spot-options" class="ant-select-dropdown ant-select-dropdown-hidden"><div class="ant-select-item-option">华清宫</div></div>
      <script>
        window.scenicEvents = [];
        const dropdown = document.querySelector('.ant-select-dropdown');
        const spot = document.querySelector('#spot');
        document.querySelectorAll('#scenic_area [role="combobox"]').forEach((box) => {
          box.addEventListener('click', () => {
            window.scenicEvents.push('click:' + box.id);
            if (box.id === 'spot') dropdown.classList.remove('ant-select-dropdown-hidden');
          });
          const input = box.querySelector('input');
          if (input) input.addEventListener('input', () => window.scenicEvents.push('input:' + box.id));
        });
        document.querySelector('.ant-select-item-option').addEventListener('click', () => {
          window.scenicEvents.push('choose');
          const itemSpan = document.createElement('span');
          itemSpan.className = 'ant-select-selection-item';
          itemSpan.title = '华清宫（西安/陕西/中国）';
          itemSpan.textContent = '华清宫（西安/陕西/中国）';
          spot.prepend(itemSpan);
          dropdown.classList.add('ant-select-dropdown-hidden');
        });
        document.querySelector('#add').addEventListener('click', () => {
          window.scenicEvents.push('add');
          const tag = document.createElement('span');
          tag.className = 'ant-tag';
          tag.textContent = '华清宫（西安/陕西/中国）';
          document.querySelector('#scenic_area').append(tag);
          const item = spot.querySelector('.ant-select-selection-item');
          if (item) item.remove();
        });
      </script>
    `);
    const logs: string[] = [];
    await fillScenicAreaSpots(page, "陕西", ["华清宫"], logs);
    const observed = await page.evaluate(() => (window as unknown as { scenicEvents: string[] }).scenicEvents);
    assert.ok(observed.includes("add"), "省份标签不占名额，实际景点仍需补充，必须点击 add，实际事件：" + JSON.stringify(observed));
    assert.equal(await page.locator("#scenic_area .ant-tag").count(), 6, "原本 3 个省份 + 2 个景点 + 1 新增 = 6");
    assert.ok(!logs.some((log) => log.includes("≥ 3")), "省份标签不应被计为景点，故页面不是已满，实际 logs：" + JSON.stringify(logs));
  } finally {
    await browser.close();
  }
});
