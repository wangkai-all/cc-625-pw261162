'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeEvents,
  dedupeEvents,
  isIsoInstant,
  InputError,
  FLAVORS,
} = require('../lib/rules');

const A = '柚子气泡';
const B = '海盐焦糖';
const C = '乌龙青梅';

function ev(over) {
  return {
    id: 'E1',
    kind: 'sample',
    person: '甲',
    flavor: A,
    occurredAt: '2026-09-01T00:00:00Z',
    ...over,
  };
}

test('isIsoInstant 接受 UTC 时间，拒绝本地时间与越界日期', () => {
  assert.equal(isIsoInstant('2026-09-01T00:00:00Z'), true);
  assert.equal(isIsoInstant('2026-09-01T00:00Z'), true);
  assert.equal(isIsoInstant('2026-09-01T00:00:00.500Z'), true);
  assert.equal(isIsoInstant('2026-09-01T00:00:00+08:00'), false);
  assert.equal(isIsoInstant('2026-09-01'), false);
  assert.equal(isIsoInstant('2019-12-31T23:59:59Z'), false);
  assert.equal(isIsoInstant('2036-01-01T00:00:00Z'), false);
  assert.equal(isIsoInstant(12345), false);
  assert.equal(isIsoInstant(undefined), false);
});

test('normalizeEvents 拒绝非数组与超量输入', () => {
  assert.throws(() => normalizeEvents(null), (error) => {
    assert.ok(error instanceof InputError);
    assert.equal(error.code, 'INVALID_EVENTS');
    return true;
  });
  const huge = Array.from({ length: 5001 }, (_, i) => ev({ id: `E${i}` }));
  assert.throws(() => normalizeEvents(huge), (error) => error.code === 'TOO_MANY_EVENTS');
});

test('normalizeEvents 逐条报告非法记录，不静默丢弃', () => {
  const raw = [
    ev({ id: 'E1' }),
    ev({ id: 'E2', kind: 'gift' }),
    ev({ id: 'E3', person: '' }),
    ev({ id: 'E4', flavor: '荔枝' }),
    ev({ id: 'E5', occurredAt: '2026-13-01T00:00:00Z' }),
    ev({ id: 'E6', kind: 'purchase', amount: 0 }),
    ev({ id: 'E7', kind: 'purchase', amount: '128' }),
    ev({ id: 'E8', kind: 'refund' }),
    ev({ id: 'E1' }),
  ];
  assert.throws(() => normalizeEvents(raw), (error) => {
    assert.equal(error.code, 'INVALID_EVENTS');
    assert.equal(error.issues.length, 8);
    assert.match(error.issues[0].message, /gift/);
    assert.match(error.issues[1].message, /person/);
    assert.match(error.issues[2].message, /口味/);
    assert.match(error.issues[3].message, /时间/);
    assert.match(error.issues[4].message, /金额/);
    assert.match(error.issues[5].message, /金额/);
    assert.match(error.issues[6].message, /reference/);
    assert.match(error.issues[7].message, /重复/);
    return true;
  });
});

test('normalizeEvents 拒绝录入时间早于业务时间，缺省时录入时间等于业务时间', () => {
  assert.throws(
    () => normalizeEvents([ev({ id: 'E1', recordedAt: '2026-08-01T00:00:00Z' })]),
    (error) => error.code === 'INVALID_EVENTS',
  );
  const [event] = normalizeEvents([ev({ id: 'E1' })]);
  assert.equal(event.recordedAt, event.occurredAt);
  assert.equal(event.recordedAt, Date.parse('2026-09-01T00:00:00Z'));
});

test('normalizeEvents 按业务时间排序，金额四舍五入到分', () => {
  const events = normalizeEvents([
    ev({ id: 'E2', kind: 'purchase', amount: 128.005, occurredAt: '2026-09-03T00:00:00Z' }),
    ev({ id: 'E1', occurredAt: '2026-09-02T00:00:00Z' }),
  ]);
  assert.deepEqual(events.map((e) => e.id), ['E1', 'E2']);
  assert.equal(events[1].amount, 128.01);
  assert.equal(events[0].amount, 0);
  assert.equal(events[0].reference, '');
});

test('dedupeEvents 合并同人同口味同分钟的重复录入，保留最早录入的一条', () => {
  const events = normalizeEvents([
    ev({ id: 'S1', occurredAt: '2026-09-01T00:00:00Z', recordedAt: '2026-09-01T00:00:10Z' }),
    ev({ id: 'S2', occurredAt: '2026-09-01T00:00:30Z', recordedAt: '2026-09-02T00:00:00Z' }),
  ]);
  const { events: kept, dropped } = dedupeEvents(events);
  assert.deepEqual(kept.map((e) => e.id), ['S1']);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].id, 'S2');
  assert.equal(dropped[0].duplicateOf, 'S1');
});

test('dedupeEvents 不跨口味、不跨人、不跨分钟合并', () => {
  const events = normalizeEvents([
    ev({ id: 'S1', occurredAt: '2026-09-01T00:00:00Z' }),
    ev({ id: 'S2', flavor: B, occurredAt: '2026-09-01T00:00:10Z' }),
    ev({ id: 'S3', person: '乙', occurredAt: '2026-09-01T00:00:20Z' }),
    ev({ id: 'S4', occurredAt: '2026-09-01T00:01:00Z' }),
  ]);
  const { events: kept, dropped } = dedupeEvents(events);
  assert.equal(kept.length, 4);
  assert.equal(dropped.length, 0);
});

test('dedupeEvents 退单不按分钟合并，交给归因层的「一单最多冲一次」', () => {
  const events = normalizeEvents([
    ev({ id: 'P1', kind: 'purchase', amount: 100, occurredAt: '2026-09-01T00:00:00Z' }),
    ev({ id: 'P2', kind: 'purchase', amount: 100, occurredAt: '2026-09-01T00:05:00Z' }),
    ev({ id: 'R1', kind: 'refund', reference: 'P1', occurredAt: '2026-09-01T00:00:00Z' }),
    ev({ id: 'R2', kind: 'refund', reference: 'P1', occurredAt: '2026-09-01T00:00:20Z' }),
    ev({ id: 'R3', kind: 'refund', reference: 'P2', occurredAt: '2026-09-01T00:00:30Z' }),
  ]);
  const { events: kept, dropped } = dedupeEvents(events);
  assert.deepEqual(kept.filter((e) => e.kind === 'refund').map((e) => e.id), ['R1', 'R2', 'R3']);
  assert.equal(dropped.length, 0);
});

test('三种口味常量被冻结，防止运行时被改写', () => {
  assert.deepEqual([...FLAVORS], [A, B, C]);
  assert.ok(Object.isFrozen(FLAVORS));
});
