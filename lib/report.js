'use strict';

/**
 * 报表快照：把同一份账本渲染成「v1 已发布」「v2 当前」两版，
 * 并在 v2 里逐笔说明哪些复购从旧报表回转。
 *
 * 旧报表永远保留它发布时的样子（v1），不因为补交退单而改写；
 * 新报表另起一版，用 revision.deltas 指明差额来自哪几笔订单。
 */

const { attribute } = require('./attribution');
const { FLAVORS, normalizeEvents, dedupeEvents, utcIso, InputError } = require('./rules');
const dataset = require('./dataset');

function buildLedger() {
  const normalized = normalizeEvents(dataset.events);
  const { events: deduped, dropped } = dedupeEvents(normalized);
  return { deduped, dropped };
}

/** 未补交时的报表截止：首次发布日期与账本中最晚录入时间取大。 */
function baselineAsOf(ledger, firstPublishedAt) {
  const latestRecorded = ledger.reduce((max, e) => Math.max(max, e.recordedAt), firstPublishedAt);
  return Math.max(latestRecorded, firstPublishedAt);
}

function addLateRefund(state) {
  const index = state.lateIndex;
  if (index >= dataset.LATE_REFUNDS.length) {
    throw new InputError('NO_MORE_REFUNDS', '已经没有可补交的退单了');
  }
  const next = dataset.LATE_REFUNDS[index];
  const original = state.ledger.find((e) => e.id === next.orderId);
  if (!original) {
    throw new InputError('MISSING_ORDER', `原订单 ${next.orderId} 不在账本里，无法补交退单`);
  }
  if (state.ledger.some((e) => e.id === next.refundId)) {
    throw new InputError('DUPLICATE_REFUND', `退单 ${next.refundId} 已经补交过`);
  }
  const appended = {
    id: next.refundId,
    kind: 'refund',
    person: original.person,
    flavor: original.flavor,
    reference: next.orderId,
    occurredAt: Date.parse(next.occurredAt),
    recordedAt: Date.parse(dataset.LATE_REFUND_RECORDED),
  };
  state.ledger.push(appended);
  state.lateIndex += 1;
  return {
    refundId: next.refundId,
    orderId: next.orderId,
    person: original.person,
    flavor: original.flavor,
    occurredAt: utcIso(appended.occurredAt),
    recordedAt: utcIso(appended.recordedAt),
    lateByDays: Math.round((appended.recordedAt - appended.occurredAt) / 86400000),
    note: next.note,
    remaining: dataset.LATE_REFUNDS.length - state.lateIndex,
  };
}

function createSession() {
  const { deduped, dropped } = buildLedger();
  return {
    ledger: deduped,
    dropped,
    lateIndex: 0,
    firstPublishedAt: Date.parse(dataset.FIRST_REPORT_ASOF),
  };
}

function summarizeSnapshot(snapshot) {
  return {
    mode: snapshot.mode,
    asOf: snapshot.asOfIso,
    windowDays: snapshot.windowDays,
    totals: snapshot.totals,
    flavors: FLAVORS.map((flavor) => ({ ...snapshot.flavors[flavor] })),
  };
}

/**
 * 当前会话的两版快照。
 * published = 首次发布时可见的账本（旧报表，永不改写）。
 * current   = 现在可见的账本（可含补交退单）。
 * 两种口径各算一份，current.revision 以同口径的 published 为基线。
 */
function buildReport(state) {
  const publishedAt = state.firstPublishedAt;
  const currentAsOf = baselineAsOf(state.ledger, publishedAt) + 1000;
  const modes = {};
  for (const mode of ['first', 'sequence']) {
    const published = attribute(state.ledger, { mode, asOf: publishedAt });
    const current = attribute(state.ledger, { mode, asOf: currentAsOf, visibleBefore: publishedAt });
    modes[mode] = {
      published: summarizeSnapshot(published),
      current: summarizeSnapshot(current),
      publishedRows: published.rows,
      currentRows: current.rows,
      revision: current.revision,
      refunds: current.refunds,
      rejectedRefunds: current.rejectedRefunds,
      pendingRefunds: current.pendingRefunds,
      unattributed: current.unattributed,
    };
  }

  return {
    publishedAt: utcIso(publishedAt),
    currentAsOf: utcIso(currentAsOf),
    windowDays: 30,
    modes,
    dedupe: state.dropped,
    lateRefundsSubmitted: state.lateIndex,
    lateRefundsRemaining: dataset.LATE_REFUNDS.length - state.lateIndex,
    modeDelta: FLAVORS.map((flavor) => {
      const first = modes.first.current.flavors.find((f) => f.flavor === flavor).net;
      const sequence = modes.sequence.current.flavors.find((f) => f.flavor === flavor).net;
      return { flavor, firstNet: first, sequenceNet: sequence, delta: Math.round((sequence - first) * 100) / 100 };
    }),
  };
}

module.exports = { createSession, buildReport, addLateRefund, buildLedger };
