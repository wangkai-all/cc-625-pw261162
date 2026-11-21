'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeEvents } = require('../lib/rules');
const { attribute, windowStartFor } = require('../lib/attribution');

const A = '柚子气泡';
const B = '海盐焦糖';
const C = '乌龙青梅';

function ledger(raw) {
  return normalizeEvents(raw);
}

function run(raw, options) {
  return attribute(ledger(raw), {
    mode: 'first',
    windowDays: 30,
    ...options,
  });
}

function flavorNet(snapshot, flavor) {
  return snapshot.flavors[flavor].net;
}

test('windowStartFor 按 UTC 自然日对齐，左闭右开', () => {
  const orderAt = Date.parse('2026-10-01T15:30:00Z');
  assert.equal(windowStartFor(orderAt, 30), Date.parse('2026-09-01T00:00:00Z'));
});

test('首次试吃：窗口内最早一次试吃拿走到期订单，跨口味时仍归首试', () => {
  const at = Date.parse('2026-09-20T12:00:00Z');
  const snapshot = run([
    { id: 'S1', kind: 'sample', person: '甲', flavor: A, occurredAt: '2026-09-02T00:00:00Z' },
    { id: 'S2', kind: 'sample', person: '甲', flavor: B, occurredAt: '2026-09-10T00:00:00Z' },
    { id: 'P1', kind: 'purchase', person: '甲', flavor: B, amount: 100, occurredAt: '2026-09-18T00:00:00Z' },
  ], { asOf: at });

  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].sampleId, 'S1');
  assert.equal(snapshot.rows[0].attributedFlavor, A);
  assert.equal(snapshot.rows[0].purchaseFlavor, B);
  assert.equal(snapshot.rows[0].sameFlavor, false);
  assert.equal(flavorNet(snapshot, A), 100);
  assert.equal(flavorNet(snapshot, B), 0);
});

test('按顺序分配：同一人两笔购买依次领取两个在先试吃', () => {
  const at = Date.parse('2026-09-30T12:00:00Z');
  const raw = [
    { id: 'S1', kind: 'sample', person: '甲', flavor: A, occurredAt: '2026-09-02T00:00:00Z' },
    { id: 'S2', kind: 'sample', person: '甲', flavor: B, occurredAt: '2026-09-08T00:00:00Z' },
    { id: 'P1', kind: 'purchase', person: '甲', flavor: B, amount: 100, occurredAt: '2026-09-12T00:00:00Z' },
    { id: 'P2', kind: 'purchase', person: '甲', flavor: A, amount: 200, occurredAt: '2026-09-26T00:00:00Z' },
  ];
  const first = run(raw, { asOf: at, mode: 'first' });
  const sequence = run(raw, { asOf: at, mode: 'sequence' });

  assert.equal(first.rows.find((r) => r.orderId === 'P1').attributedFlavor, A);
  assert.equal(first.rows.find((r) => r.orderId === 'P2').attributedFlavor, A);
  assert.equal(flavorNet(first, A), 300);
  assert.equal(flavorNet(first, B), 0);

  assert.equal(sequence.rows.find((r) => r.orderId === 'P1').attributedFlavor, A);
  assert.equal(sequence.rows.find((r) => r.orderId === 'P2').attributedFlavor, B);
  assert.equal(flavorNet(sequence, A), 100);
  assert.equal(flavorNet(sequence, B), 200);

  // 两种口径总净额一致，差额只在口味之间分配。
  assert.equal(first.totals.net, sequence.totals.net);
  assert.equal(sequence.rows.find((r) => r.orderId === 'P2').isRepeat, true);
  assert.equal(sequence.totals.repeatNet, 200);
});

test('按顺序分配：试吃用完后复购归给窗口内最近一次在先试吃', () => {
  const at = Date.parse('2026-10-20T00:00:00Z');
  const snapshot = run([
    { id: 'S1', kind: 'sample', person: '甲', flavor: C, occurredAt: '2026-09-05T00:00:00Z' },
    { id: 'P1', kind: 'purchase', person: '甲', flavor: C, amount: 50, occurredAt: '2026-09-10T00:00:00Z' },
    { id: 'P2', kind: 'purchase', person: '甲', flavor: C, amount: 60, occurredAt: '2026-10-12T00:00:00Z' },
  ], { asOf: at, mode: 'sequence' });

  // 第二笔购买已超出窗口（试吃在窗口外），因此没有可归的在先试吃。
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.unattributed.length, 1);
  assert.equal(snapshot.unattributed[0].orderId, 'P2');
  assert.equal(flavorNet(snapshot, C), 50);
});

test('按顺序分配：窗口内试吃用完时，复购复用最近一次在窗试吃', () => {
  const at = Date.parse('2026-10-05T00:00:00Z');
  const snapshot = run([
    { id: 'S1', kind: 'sample', person: '甲', flavor: C, occurredAt: '2026-09-01T00:00:00Z' },
    { id: 'S2', kind: 'sample', person: '甲', flavor: A, occurredAt: '2026-09-02T00:00:00Z' },
    { id: 'P1', kind: 'purchase', person: '甲', flavor: C, amount: 50, occurredAt: '2026-09-20T00:00:00Z' },
    { id: 'P2', kind: 'purchase', person: '甲', flavor: A, amount: 60, occurredAt: '2026-09-21T00:00:00Z' },
    { id: 'P3', kind: 'purchase', person: '甲', flavor: C, amount: 70, occurredAt: '2026-09-22T00:00:00Z' },
  ], { asOf: at, mode: 'sequence' });

  assert.deepEqual(
    snapshot.rows.map((r) => [r.orderId, r.attributedFlavor]),
    [['P1', C], ['P2', A], ['P3', A]],
  );
  assert.equal(flavorNet(snapshot, C), 50);
  assert.equal(flavorNet(snapshot, A), 130);
});

test('样品必须严格早于订单；同一时刻的样品不算在先试吃', () => {
  const at = Date.parse('2026-09-20T00:00:00Z');
  const sameInstant = run([
    { id: 'S1', kind: 'sample', person: '甲', flavor: A, occurredAt: '2026-09-10T00:00:00Z' },
    { id: 'P1', kind: 'purchase', person: '甲', flavor: A, amount: 80, occurredAt: '2026-09-10T00:00:00Z' },
  ], { asOf: at });
  assert.equal(sameInstant.rows.length, 0);
  assert.equal(sameInstant.unattributed.length, 1);
  assert.equal(sameInstant.unattributed[0].reason, '窗口内没有在先试吃，未归因');
});

test('窗口外的试吃不参与归因，购买单列为未归因', () => {
  const at = Date.parse('2026-09-30T00:00:00Z');
  const snapshot = run([
    { id: 'S1', kind: 'sample', person: '甲', flavor: A, occurredAt: '2026-08-01T00:00:00Z' },
    { id: 'P1', kind: 'purchase', person: '甲', flavor: A, amount: 88, occurredAt: '2026-09-20T00:00:00Z' },
  ], { asOf: at });
  assert.equal(snapshot.rows.length, 0);
  assert.equal(snapshot.unattributed.length, 1);
  assert.equal(snapshot.unattributed[0].windowStart, '2026-08-21T00:00:00.000Z');
  assert.equal(snapshot.totals.unattributedGross, 88);
  assert.equal(snapshot.totals.net, 0);
  assert.equal(snapshot.totals.attributedGross, 0);
  assert.equal(snapshot.totals.grossAll, 88);
});

test('窗口边界：订单日 30 天前的 00:00Z 含在内，前一毫秒不含', () => {
  const orderAt = '2026-09-30T00:00:00Z';
  const inside = run([
    { id: 'S1', kind: 'sample', person: '甲', flavor: A, occurredAt: '2026-08-31T00:00:00Z' },
    { id: 'P1', kind: 'purchase', person: '甲', flavor: A, amount: 10, occurredAt: orderAt },
  ], { asOf: Date.parse('2026-09-30T01:00:00Z') });
  assert.equal(inside.rows.length, 1);

  const outside = run([
    { id: 'S1', kind: 'sample', person: '甲', flavor: A, occurredAt: '2026-08-30T23:59:59.999Z' },
    { id: 'P1', kind: 'purchase', person: '甲', flavor: A, amount: 10, occurredAt: orderAt },
  ], { asOf: Date.parse('2026-09-30T01:00:00Z') });
  assert.equal(outside.rows.length, 0);
});

test('退单只冲原订单：整单退净额归零，不挪到同期其他订单', () => {
  const at = Date.parse('2026-10-10T00:00:00Z');
  const snapshot = run([
    { id: 'S1', kind: 'sample', person: '甲', flavor: A, occurredAt: '2026-09-01T00:00:00Z' },
    { id: 'P1', kind: 'purchase', person: '甲', flavor: A, amount: 100, occurredAt: '2026-09-05T00:00:00Z' },
    { id: 'P2', kind: 'purchase', person: '甲', flavor: A, amount: 200, occurredAt: '2026-09-08T00:00:00Z' },
    { id: 'R1', kind: 'refund', person: '甲', flavor: A, reference: 'P2', occurredAt: '2026-09-09T00:00:00Z' },
  ], { asOf: at });

  assert.equal(flavorNet(snapshot, A), 100);
  const p2 = snapshot.rows.find((r) => r.orderId === 'P2');
  assert.equal(p2.refundedAmount, 200);
  assert.equal(p2.net, 0);
  assert.equal(p2.refundId, 'R1');
  assert.equal(snapshot.refunds.length, 1);
  assert.equal(snapshot.totals.refunded, 200);
  assert.equal(snapshot.refunds[0].refundedAmount, 200);
});

test('拒收退单：原单不存在、退单人不对、口味不对、时间倒置、重复退单', () => {
  const at = Date.parse('2026-10-20T00:00:00Z');
  const snapshot = run([
    { id: 'S1', kind: 'sample', person: '甲', flavor: A, occurredAt: '2026-09-01T00:00:00Z' },
    { id: 'P1', kind: 'purchase', person: '甲', flavor: A, amount: 100, occurredAt: '2026-09-05T00:00:00Z' },
    { id: 'R1', kind: 'refund', person: '甲', flavor: A, reference: 'P999', occurredAt: '2026-09-06T00:00:00Z' },
    { id: 'R2', kind: 'refund', person: '乙', flavor: A, reference: 'P1', occurredAt: '2026-09-06T00:00:00Z' },
    { id: 'R3', kind: 'refund', person: '甲', flavor: B, reference: 'P1', occurredAt: '2026-09-06T00:00:00Z' },
    { id: 'R4', kind: 'refund', person: '甲', flavor: A, reference: 'P1', occurredAt: '2026-09-01T00:00:00Z' },
    { id: 'R5', kind: 'refund', person: '甲', flavor: A, reference: 'P1', occurredAt: '2026-09-07T00:00:00Z' },
    { id: 'R6', kind: 'refund', person: '甲', flavor: A, reference: 'P1', occurredAt: '2026-09-08T00:00:00Z' },
  ], { asOf: at });

  assert.equal(snapshot.refunds.length, 1);
  assert.equal(snapshot.rejectedRefunds.length, 5);
  const reasons = snapshot.rejectedRefunds.map((r) => r.id).sort();
  assert.deepEqual(reasons, ['R1', 'R2', 'R3', 'R4', 'R6']);
  assert.equal(flavorNet(snapshot, A), 0);
});

test('asOf 之后录入的退单不参与本版，列在 pendingRefunds', () => {
  const snapshot = run([
    { id: 'S1', kind: 'sample', person: '甲', flavor: A, occurredAt: '2026-09-01T00:00:00Z' },
    { id: 'P1', kind: 'purchase', person: '甲', flavor: A, amount: 100, occurredAt: '2026-09-05T00:00:00Z' },
    {
      id: 'R1',
      kind: 'refund',
      person: '甲',
      flavor: A,
      reference: 'P1',
      occurredAt: '2026-09-06T00:00:00Z',
      recordedAt: '2026-10-25T00:00:00Z',
    },
  ], { asOf: Date.parse('2026-10-15T00:00:00Z') });

  assert.equal(snapshot.refunds.length, 0);
  assert.equal(snapshot.pendingRefunds.length, 1);
  assert.equal(snapshot.pendingRefunds[0].id, 'R1');
  assert.equal(flavorNet(snapshot, A), 100);
});

test('业务时间早于截止、录入晚于截止的退单：本版可见，并让复购逐笔回转', () => {
  const events = ledger([
    { id: 'S1', kind: 'sample', person: '甲', flavor: A, occurredAt: '2026-09-01T00:00:00Z' },
    { id: 'S2', kind: 'sample', person: '甲', flavor: B, occurredAt: '2026-09-02T00:00:00Z' },
    { id: 'P1', kind: 'purchase', person: '甲', flavor: A, amount: 100, occurredAt: '2026-09-05T00:00:00Z' },
    { id: 'P2', kind: 'purchase', person: '甲', flavor: B, amount: 200, occurredAt: '2026-09-06T00:00:00Z' },
    {
      id: 'R1',
      kind: 'refund',
      person: '甲',
      flavor: B,
      reference: 'P2',
      occurredAt: '2026-09-07T00:00:00Z',
      recordedAt: '2026-10-20T00:00:00Z',
    },
  ]);
  const publishedAt = Date.parse('2026-10-15T00:00:00Z');
  const currentAsOf = Date.parse('2026-10-25T00:00:00Z');

  const published = attribute(events, { mode: 'sequence', asOf: publishedAt });
  const current = attribute(events, { mode: 'sequence', asOf: currentAsOf, visibleBefore: publishedAt });

  assert.equal(published.totals.net, 300);
  assert.equal(current.totals.net, 100);
  assert.equal(current.revision.netDelta, -200);
  assert.equal(current.revision.deltas.length, 1);
  const delta = current.revision.deltas[0];
  assert.equal(delta.orderId, 'P2');
  assert.equal(delta.changeKind, 'repeat-refund');
  assert.equal(delta.beforeNet, 200);
  assert.equal(delta.afterNet, 0);
  assert.equal(delta.delta, -200);
  assert.equal(current.revision.flavorDelta[B], -200);
});

test('没有补交退单时，revision 为空且两版逐笔一致', () => {
  const events = ledger([
    { id: 'S1', kind: 'sample', person: '甲', flavor: A, occurredAt: '2026-09-01T00:00:00Z' },
    { id: 'P1', kind: 'purchase', person: '甲', flavor: A, amount: 100, occurredAt: '2026-09-05T00:00:00Z' },
  ]);
  const publishedAt = Date.parse('2026-10-15T00:00:00Z');
  const current = attribute(events, {
    mode: 'first',
    asOf: Date.parse('2026-10-20T00:00:00Z'),
    visibleBefore: publishedAt,
  });
  assert.equal(current.revision.deltas.length, 0);
  assert.equal(current.revision.netDelta, 0);
  assert.equal(current.totals.net, 100);
});

test('没有购买的试吃只计入派发数，不产生归因', () => {
  const snapshot = run([
    { id: 'S1', kind: 'sample', person: '甲', flavor: C, occurredAt: '2026-09-01T00:00:00Z' },
  ], { asOf: Date.parse('2026-09-30T00:00:00Z') });

  assert.equal(snapshot.rows.length, 0);
  assert.equal(snapshot.totals.samples, 1);
  assert.equal(snapshot.flavors[C].samples, 1);
  assert.equal(snapshot.flavors[C].usedSamples, 0);
  assert.equal(snapshot.flavors[C].unusedSamples, 1);
  assert.equal(snapshot.totals.net, 0);
});

test('金额四舍五入到分，合计不漂移', () => {
  const snapshot = run([
    { id: 'S1', kind: 'sample', person: '甲', flavor: A, occurredAt: '2026-09-01T00:00:00Z' },
    { id: 'P1', kind: 'purchase', person: '甲', flavor: A, amount: 0.1, occurredAt: '2026-09-05T00:00:00Z' },
    { id: 'P2', kind: 'purchase', person: '甲', flavor: A, amount: 0.2, occurredAt: '2026-09-06T00:00:00Z' },
  ], { asOf: Date.parse('2026-09-30T00:00:00Z') });
  assert.equal(snapshot.totals.net, 0.3);
  assert.equal(snapshot.rows[1].isRepeat, true);
});

test('两种口径都只观察同一批账本：总量不变，口味之间的分配可变', () => {
  const raw = [
    { id: 'S1', kind: 'sample', person: '甲', flavor: A, occurredAt: '2026-09-01T00:00:00Z' },
    { id: 'S2', kind: 'sample', person: '甲', flavor: B, occurredAt: '2026-09-02T00:00:00Z' },
    { id: 'P1', kind: 'purchase', person: '甲', flavor: A, amount: 10, occurredAt: '2026-09-05T00:00:00Z' },
    { id: 'P2', kind: 'purchase', person: '甲', flavor: B, amount: 20, occurredAt: '2026-09-06T00:00:00Z' },
  ];
  const at = Date.parse('2026-09-30T00:00:00Z');
  const first = run(raw, { asOf: at, mode: 'first' });
  const sequence = run(raw, { asOf: at, mode: 'sequence' });
  assert.equal(first.totals.grossAll, sequence.totals.grossAll);
  assert.equal(first.totals.attributed, sequence.totals.attributed);
  // 总净额相同，但口味之间换了位置：首次口径 30 全归 A，顺序口径 A=10、B=20。
  assert.equal(first.totals.net, sequence.totals.net);
  assert.equal(flavorNet(first, A), 30);
  assert.equal(flavorNet(sequence, A), 10);
  assert.equal(flavorNet(sequence, B), 20);
});
