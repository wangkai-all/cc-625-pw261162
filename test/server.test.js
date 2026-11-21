'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createServer } = require('../lib/app');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

async function startServer(t) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function getJson(base, pathname) {
  const res = await fetch(`${base}${pathname}`);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

async function postJson(base, pathname) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return { status: res.status, body: await res.json() };
}

test('页面可以取到，业务结果区带 data-evidence-result 属性', async (t) => {
  const base = await startServer(t);
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /data-evidence-result/);

  for (const asset of ['/app.js', '/styles.css']) {
    const file = await fetch(`${base}${asset}`);
    assert.equal(file.status, 200, asset);
  }
});

test('data-evidence-* 属性在服务端 HTML 上给出可核对的初始位置', async (t) => {
  const base = await startServer(t);
  const html = await (await fetch(`${base}/`)).text();
  for (const attribute of [
    'data-evidence-state',
    'data-evidence-net-first',
    'data-evidence-net-sequence',
    'data-evidence-submitted-refunds',
    'data-evidence-revision-net-first',
    'data-evidence-comparison-orders',
  ]) {
    assert.match(html, new RegExp(attribute), attribute);
  }
});

test('两个按钮在页面上存在，文案与题面一致', async (t) => {
  const base = await startServer(t);
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /生成原复购比较/);
  assert.match(html, /补交一张退单/);
  assert.match(html, /查看归因明细/);
});

test('GET /api/report 返回两版快照与两种口径，且带关联声明', async (t) => {
  const base = await startServer(t);
  const { status, headers, body } = await getJson(base, '/api/report');
  assert.equal(status, 200);
  assert.match(headers.get('content-type'), /application\/json/);
  assert.equal(body.modes.first.published.totals.net, 974);
  assert.equal(body.modes.sequence.current.totals.net, 974);
  assert.equal(body.session.lateRefundsRemaining, 3);
  assert.match(body.disclaimer, /关联/);
  assert.equal(body.modes.first.revision.deltas.length, 0);
});

test('POST /api/comparison 说明两种口径的差额只来自分配', async (t) => {
  const base = await startServer(t);
  const { status, body } = await postJson(base, '/api/comparison');
  assert.equal(status, 200);
  assert.equal(body.totals.ambiguousOrders, 2);
  assert.equal(body.totals.firstNet, body.totals.sequenceNet);
  assert.deepEqual(body.reassigned.map((r) => r.orderId).sort(), ['O02', 'O04']);
  assert.match(body.disclaimer, /关联/);
});

test('POST /api/refunds 补交退单后，新报表逐笔指出哪笔复购回转', async (t) => {
  const base = await startServer(t);
  const { status, body } = await postJson(base, '/api/refunds');
  assert.equal(status, 201);
  assert.equal(body.submitted.refundId, 'R10');
  assert.equal(body.submitted.remaining, 2);

  const after = await getJson(base, '/api/report');
  assert.equal(after.body.modes.first.current.totals.net, 846);
  assert.equal(after.body.modes.first.published.totals.net, 974);
  assert.equal(after.body.modes.first.revision.netDelta, -128);
  assert.equal(after.body.session.lateRefundsSubmitted, 1);

  const delta = after.body.modes.first.revision.deltas[0];
  assert.equal(delta.orderId, 'O02');
  assert.match(delta.change, /复购回转/);
});

test('补交三次后按钮耗尽，第四次返回 409 而不是假装成功', async (t) => {
  const base = await startServer(t);
  for (let i = 0; i < 3; i += 1) {
    const ok = await postJson(base, '/api/refunds');
    assert.equal(ok.status, 201);
  }
  const exhausted = await postJson(base, '/api/refunds');
  assert.equal(exhausted.status, 409);
  assert.equal(exhausted.body.error.code, 'NO_MORE_REFUNDS');
  const report = await getJson(base, '/api/report');
  assert.equal(report.body.session.lateRefundsRemaining, 0);
});

test('GET /api/detail 分别给出两种口径的逐笔明细与异常清单', async (t) => {
  const base = await startServer(t);
  const first = await getJson(base, '/api/detail?mode=first');
  const sequence = await getJson(base, '/api/detail?mode=sequence');
  assert.equal(first.status, 200);
  assert.equal(sequence.status, 200);
  assert.equal(first.body.rows.length, 10);
  assert.equal(first.body.rejectedRefunds.length, 2);
  assert.equal(first.body.unattributed.length, 1);
  assert.equal(first.body.dedupe.length, 1);

  const firstRow = first.body.rows.find((r) => r.orderId === 'O02');
  const sequenceRow = sequence.body.rows.find((r) => r.orderId === 'O02');
  assert.equal(firstRow.attributedFlavor, '柚子气泡');
  assert.equal(sequenceRow.attributedFlavor, '海盐焦糖');
});

test('未知接口与非法路由返回结构化 404', async (t) => {
  const base = await startServer(t);
  const api = await getJson(base, '/api/nope');
  assert.equal(api.status, 404);
  assert.equal(api.body.error.code, 'NOT_FOUND');
  const page = await fetch(`${base}/nope`);
  assert.equal(page.status, 404);
});

test('GET 请求不会改动会话状态', async (t) => {
  const base = await startServer(t);
  await getJson(base, '/api/report');
  await getJson(base, '/api/detail?mode=sequence');
  await getJson(base, '/api/report');
  const report = await getJson(base, '/api/report');
  assert.equal(report.body.session.lateRefundsSubmitted, 0);
  assert.equal(report.body.modes.first.current.totals.net, 974);
});

test('静态资源落到 public 目录内的固定白名单，不读取任意路径', () => {
  const listed = fs.readdirSync(PUBLIC_DIR).sort();
  assert.deepEqual(listed, ['app.js', 'index.html', 'styles.css']);
});
