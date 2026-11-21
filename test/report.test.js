'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSession, buildReport, addLateRefund, buildLedger } = require('../lib/report');
const { comparisonPayload } = require('../lib/app');
const { InputError } = require('../lib/rules');

function netOf(report, mode) {
  return report.modes[mode].current.totals.net;
}

test('虚构账本：去重只合并一条，两种口径的已发布基线一致', () => {
  const { deduped, dropped } = buildLedger();
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].id, 'S03D');
  assert.ok(deduped.length > 0);

  const report = buildReport(createSession());
  assert.equal(report.publishedAt, '2026-10-15T00:00:00.000Z');
  assert.equal(report.modes.first.published.totals.net, 974);
  assert.equal(report.modes.sequence.published.totals.net, 974);
  assert.equal(report.modes.first.revision.deltas.length, 0);
  assert.equal(report.modes.sequence.revision.deltas.length, 0);
  assert.equal(report.lateRefundsRemaining, 3);
});

test('虚构账本：两种口径在口味之间分配不同，总净额相同', () => {
  const report = buildReport(createSession());
  const first = Object.fromEntries(report.modes.first.current.flavors.map((f) => [f.flavor, f.net]));
  const sequence = Object.fromEntries(report.modes.sequence.current.flavors.map((f) => [f.flavor, f.net]));

  assert.deepEqual(first, { 柚子气泡: 414, 海盐焦糖: 108, 乌龙青梅: 452 });
  assert.deepEqual(sequence, { 柚子气泡: 384, 海盐焦糖: 236, 乌龙青梅: 354 });

  const comparison = comparisonPayload(report);
  assert.equal(comparison.totals.firstNet, comparison.totals.sequenceNet);
  assert.equal(comparison.totals.ambiguousOrders, 2);
  assert.deepEqual(
    comparison.reassigned.map((r) => r.orderId).sort(),
    ['O02', 'O04'],
  );
  assert.match(comparison.disclaimer, /关联/);
});

test('补交第一张退单：复购回转 -128，两种口径回冲到不同口味', () => {
  const session = createSession();
  const submitted = addLateRefund(session);
  assert.equal(submitted.refundId, 'R10');
  assert.equal(submitted.orderId, 'O02');
  assert.equal(submitted.lateByDays, 23);

  const report = buildReport(session);
  assert.equal(netOf(report, 'first'), 846);
  assert.equal(netOf(report, 'sequence'), 846);
  assert.equal(report.modes.first.revision.netDelta, -128);
  assert.equal(report.modes.sequence.revision.netDelta, -128);

  const firstDelta = report.modes.first.revision.deltas[0];
  assert.equal(firstDelta.orderId, 'O02');
  assert.equal(firstDelta.changeKind, 'repeat-refund');
  assert.equal(firstDelta.attributedFlavor, '柚子气泡');
  assert.equal(report.modes.first.revision.flavorDelta['柚子气泡'], -128);
  assert.equal(report.modes.first.revision.flavorDelta['海盐焦糖'], 0);

  const sequenceDelta = report.modes.sequence.revision.deltas[0];
  assert.equal(sequenceDelta.attributedFlavor, '海盐焦糖');
  assert.equal(report.modes.sequence.revision.flavorDelta['海盐焦糖'], -128);
  assert.equal(report.modes.sequence.revision.flavorDelta['柚子气泡'], 0);

  // 旧报表不被改写。
  assert.equal(report.modes.first.published.totals.net, 974);
  assert.equal(report.modes.sequence.published.totals.net, 974);
});

test('补交三张退单：逐笔列出复购回转，总额与首购回转分开标注', () => {
  const session = createSession();
  addLateRefund(session);
  addLateRefund(session);
  addLateRefund(session);

  const report = buildReport(session);
  assert.equal(report.lateRefundsRemaining, 0);
  assert.equal(netOf(report, 'first'), 590);
  assert.equal(report.modes.first.revision.netDelta, -384);

  const kinds = report.modes.first.revision.deltas.map((d) => [d.orderId, d.changeKind, d.delta]);
  assert.deepEqual(kinds, [
    ['O08', 'first-refund', -158],
    ['O02', 'repeat-refund', -128],
    ['O04', 'repeat-refund', -98],
  ]);
  assert.equal(
    report.modes.first.revision.deltas.filter((d) => d.changeKind === 'repeat-refund')
      .reduce((s, d) => s + d.delta, 0),
    -226,
  );
});

test('拒绝重复补交与超额补交，错误可识别', () => {
  const session = createSession();
  addLateRefund(session);
  addLateRefund(session);
  addLateRefund(session);
  assert.throws(() => addLateRefund(session), (error) => {
    assert.ok(error instanceof InputError);
    assert.equal(error.code, 'NO_MORE_REFUNDS');
    return true;
  });
});

test('已发布报表的两版快照对同一账本可重复计算，结果稳定', () => {
  const session = createSession();
  addLateRefund(session);
  const a = buildReport(session);
  const b = buildReport(session);
  assert.equal(a.modes.first.current.totals.net, b.modes.first.current.totals.net);
  assert.equal(a.modes.sequence.revision.netDelta, b.modes.sequence.revision.netDelta);
  assert.deepEqual(a.modes.first.revision.deltas, b.modes.first.revision.deltas);
});

test('虚构账本里的异常都被规则解释：2 张拒收退单、1 笔未归因、1 条重复', () => {
  const report = buildReport(createSession());
  const mode = report.modes.first;
  assert.equal(mode.rejectedRefunds.length, 2);
  assert.deepEqual(mode.rejectedRefunds.map((r) => r.id).sort(), ['R03', 'R04']);
  assert.equal(mode.unattributed.length, 1);
  assert.equal(mode.unattributed[0].orderId, 'O05');
  assert.equal(report.dedupe.length, 1);
  assert.equal(report.dedupe[0].id, 'S03D');
});
