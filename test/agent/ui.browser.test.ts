import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

test('Agent 协作真实控件：A 版阶段对话、确认、补充与窄屏', async () => {
  const server = await createServer({ configFile: false, root:process.cwd(), plugins:[react()], server:{host:'127.0.0.1',port:0},logLevel:'error' });
  await server.listen();
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:900}});
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/agent-ui/index.html`);
    await page.locator('summary').filter({hasText:'查看本阶段全部过程'}).first().click();
    assert.equal(await page.getByText('历史沟通记录').count(),0);
    assert.equal(await page.getByText('AI 分析').count(),0);
    const brief = page.locator('article[data-role="user"][data-brief="true"]').first();
    assert.match(await brief.innerText(), /目的地\s*成都/);
    assert.match(await brief.innerText(), /你的想法/);
    assert.equal(await brief.getByText('演示用户', { exact: true }).count(), 0);
    assert.equal(await brief.locator('[class*="messageAvatar"]').first().innerText(), '演');
    assert.equal(await page.locator('[data-thread="assistant"]').first().getByText('AI', { exact: true }).first().isVisible(), true);
    assert.ok(await page.locator('[data-thread="assistant"]').first().locator('[class*="assistantAvatar"]').count() >= 2);
    assert.ok(await page.getByText('思考片刻',{exact:true}).count() >= 1);
    assert.ok(await page.getByText(/已使用 \d+ 个工具/).count() >= 1);
    assert.equal(await page.getByText('我会先核查适合的景点和酒店，再完善右侧行程。',{exact:true}).isVisible(),true);
    const thinking = page.locator('details[class*="activity"]').filter({hasText:'思考片刻'}).first();
    assert.equal(await thinking.evaluate((node) => (node as HTMLDetailsElement).open), false);
    await thinking.evaluate((node) => { (node as HTMLDetailsElement).open = true; });
    assert.match(await thinking.innerText(), /先核对景点和酒店资源/);
    const tools = page.locator('details[class*="activity"]').filter({hasText:/已使用 \d+ 个工具/}).first();
    await tools.evaluate((node) => {
      const root = node as HTMLDetailsElement;
      root.open = true;
      const first = root.querySelector('details');
      if (first) (first as HTMLDetailsElement).open = true;
    });
    assert.match(await tools.innerText(), /成都熊猫基地/);
    assert.match(await tools.innerText(), /查询景点/);
    await page.getByRole('button',{name:'提交回答并继续'}).click();
    assert.equal(await page.getByRole('alert').count(),2);
    await page.getByRole('button',{name:'轻松一些',exact:true}).click();
    await page.getByRole('textbox',{name:'请补充你希望保留的文案'}).fill('慢慢旅行，留一些亲子时光。');
    await page.getByRole('textbox',{name:'补充你的要求'}).fill('尚未发送的补充');
    assert.equal(await page.getByRole('textbox',{name:'补充你的要求'}).inputValue(),'尚未发送的补充');
    await page.getByRole('button',{name:'提交回答并继续'}).click();
    await page.getByRole('button',{name:'确认方案并录入 VBK'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'提交回答并继续'}).count(),0);
    assert.equal(await page.getByRole('region',{name:'方案对话'}).getByRole('button',{name:'确认方案并录入 VBK'}).count(),1);
    await page.screenshot({path:'/tmp/vbk-agent-ui-desktop.png',fullPage:true});
    await page.getByRole('button',{name:'确认方案并录入 VBK'}).click();
    await page.getByText('已进入 VBK 录入',{exact:true}).waitFor();
    assert.equal(await page.getByText('你的决定', { exact: true }).count() >= 1, true);
    assert.equal(await page.getByRole('button', { name: '暂停执行', exact: true }).count() >= 1, true);
    assert.match(await page.locator('[data-agent-stage]').nth(1).innerText(), /用户已授权/);
    await page.screenshot({path:'/tmp/vbk-agent-ui-approved.png',fullPage:true});
    await page.getByRole('textbox',{name:'补充你的要求'}).fill('中文输入仍可用');
    await page.getByRole('button',{name:'发送',exact:true}).click();
    await page.getByText('中文输入仍可用',{exact:true}).waitFor();
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.screenshot({path:'/tmp/vbk-agent-ui-mobile.png',fullPage:true});
    assert.deepEqual(errors,[]);
  } finally { await browser.close();await server.close(); }
});

test('1916 条持久化事件只挂载最新历史窗口，并可回看旧记录', async () => {
  const server = await createServer({ configFile: false, root:process.cwd(), plugins:[react()], server:{host:'127.0.0.1',port:0},logLevel:'error' });
  await server.listen();
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:900}});
    const errors:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{ if(message.type()==='error') errors.push(message.text()); });
    await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/agent-ui/index.html`);
    await page.getByRole('region',{name:'方案对话'}).waitFor();
    await page.evaluate(()=> (window as any).agentFixture.loadLargeHistory());
    await page.getByText(/更早还有 1796 条记录/).waitFor();
    assert.equal(await page.getByText(/当前显示第 1\/16 页/).count(),1);
    await page.locator('summary').filter({hasText:'查看本阶段全部过程'}).first().click();
    assert.match(await page.locator('[data-thread="assistant"]').innerText(), /已使用 \d+ 个工具/);
    assert.equal(await page.getByRole('button',{name:'查看更早记录'}).count(),1);
    await page.getByRole('button',{name:'查看更早记录'}).click();
    await page.getByText(/较新 120 条记录未在本页显示/).waitFor();
    assert.equal(await page.getByRole('button',{name:'返回最新记录'}).count(),1);
    assert.equal(await page.locator('[data-thread="assistant"]').count(),1);
    assert.deepEqual(errors.filter((error)=>/same key|duplicate key|0-strong/i.test(error)),[]);
  } finally { await browser.close();await server.close(); }
});
