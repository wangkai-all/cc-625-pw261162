'use strict';

/**
 * 归因与退单回转。
 *
 * 固定窗口：订单时间前 30 天，起点按 UTC 自然日对齐，左闭右开。
 * 样品必须严格早于订单时间，才算「在先试吃」。
 *
 * 两种口径：
 *   first    窗口内最早一次在先试吃，拿走到期购买的全部归因额。
 *   sequence 购买按时间顺序领取尚未用过的在先试吃；窗口内试吃领完后，
 *            复购归给窗口内最近一次在先试吃。
 *
 * 退单：只冲 reference 指向的那一笔购买（整单退）。一张订单最多冲一次，
 * 重复退单拒收。全额退的购买仍保留归因记录，净额为 0——报表里看得见
 * 「从复购回转」，而同期其他订单不受影响。
 *
 * 「退单迟到」= 业务时间早于上一版报表，录入时间却晚于它。上一版报表
 * 已经发布、不能改写，所以本次快照要区分两件事：
 *   - 新事件是否可见：recordedAt <= asOf。
 *   - 它对旧报表造成的差额：按旧报表的可见集合重算一遍，逐笔对比。
 */

const {
  WINDOW_DAYS,
  DAY_MS,
  FLAVORS,
  round2,
  utcIso,
} = require('./rules');

function emptyFlavors() {
  const out = {};
  for (const flavor of FLAVORS) {
    out[flavor] = {
      flavor,
      samples: 0,
      usedSamples: 0,
      attributedPurchases: 0,
      firstPurchases: 0,
      repeatPurchases: 0,
      refundedPurchases: 0,
      gross: 0,
      refunded: 0,
      net: 0,
      firstNet: 0,
      repeatNet: 0,
    };
  }
  return out;
}

function windowStartFor(orderAt, windowDays) {
  const shifted = new Date(orderAt - windowDays * DAY_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
}

/**
 * 把退单挂到订单上。返回 { byOrder, rejected }；拒收的退单必须单列，
 * 不能悄悄丢掉，否则报表对不上账。
 */
function attachRefunds(visible, purchasesById) {
  const byOrder = new Map();
  const rejected = [];
  for (const event of visible) {
    if (event.kind !== 'refund') continue;
    const order = purchasesById.get(event.reference);
    const reject = (reason) => rejected.push({
      id: event.id,
      person: event.person,
      reference: event.reference,
      occurredAt: utcIso(event.occurredAt),
      reason,
    });

    if (!order) {
      reject('原订单不存在或尚未录入，本单未冲减任何金额');
      continue;
    }
    if (order.person !== event.person) {
      reject(`原订单属于「${order.person}」，退单人是「${event.person}」，已拒收`);
      continue;
    }
    if (event.flavor !== order.flavor) {
      reject(`原订单口味是「${order.flavor}」，退单口味却是「${event.flavor}」，已拒收`);
      continue;
    }
    if (event.occurredAt < order.occurredAt) {
      reject('退单时间早于原订单时间，已拒收');
      continue;
    }
    if (byOrder.has(order.id)) {
      reject(`订单 ${order.id} 已有退单，重复退单不重复冲减`);
      continue;
    }
    byOrder.set(order.id, event);
  }
  return { byOrder, rejected };
}

/**
 * @param {Array} events normalizeEvents 的产物（整段账本，含晚录入、未来事件）
 * @param {{mode: 'first'|'sequence', asOf: number, windowDays?: number,
 *          visibleBefore?: number}} options
 *   visibleBefore 给出时，额外按「只看到 recordedAt <= visibleBefore 的事件」
 *   重算一遍旧口径，用来逐笔解释新报表相对旧报表从哪些复购回转。���
 */
function attribute(events, options) {
  const mode = options.mode === 'sequence' ? 'sequence' : 'first';
  const asOf = options.asOf;
  const windowDays = options.windowDays || WINDOW_DAYS;

  const visible = events.filter((e) => e.recordedAt <= asOf);
  const purchases = visible.filter((e) => e.kind === 'purchase');
  const purchasesById = new Map(purchases.map((p) => [p.id, p]));
  const { byOrder, rejected } = attachRefunds(visible, purchasesById);

  const samplesByPerson = new Map();
  const purchasesByPerson = new Map();
  const sampleById = new Map();
  for (const event of visible) {
    if (event.kind === 'sample') {
      const list = samplesByPerson.get(event.person) || [];
      list.push(event);
      samplesByPerson.set(event.person, list);
      sampleById.set(event.id, event);
    } else if (event.kind === 'purchase') {
      const list = purchasesByPerson.get(event.person) || [];
      list.push(event);
      purchasesByPerson.set(event.person, list);
    }
  }
  for (const list of samplesByPerson.values()) {
    list.sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
  }
  for (const list of purchasesByPerson.values()) {
    list.sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
  }

  const flavors = emptyFlavors();
  const rows = [];
  const unattributed = [];
  const refunds = [];
  const usedSampleIds = new Set();

  for (const [person, personPurchases] of purchasesByPerson) {
    const allSamples = samplesByPerson.get(person) || [];
    let pointer = 0;

    for (let index = 0; index < personPurchases.length; index += 1) {
      const purchase = personPurchases[index];
      const start = windowStartFor(purchase.occurredAt, windowDays);
      const inWindow = allSamples.filter(
        (s) => s.occurredAt >= start && s.occurredAt < purchase.occurredAt,
      );

      let pick = null;
      if (mode === 'first') {
        pick = inWindow[0] || null;
      } else {
        let candidate = pointer;
        while (candidate < allSamples.length && allSamples[candidate].occurredAt < start) {
          candidate += 1;
        }
        if (candidate < allSamples.length && allSamples[candidate].occurredAt < purchase.occurredAt) {
          pick = allSamples[candidate];
          pointer = candidate + 1;
        } else if (inWindow.length > 0) {
          pick = inWindow[inWindow.length - 1];
        }
      }

      const refund = byOrder.get(purchase.id) || null;
      const refundedAmount = refund ? purchase.amount : 0;
      const net = refund ? 0 : purchase.amount;

      if (!pick) {
        unattributed.push({
          orderId: purchase.id,
          person,
          purchaseFlavor: purchase.flavor,
          amount: purchase.amount,
          net,
          refundId: refund ? refund.id : null,
          occurredAt: utcIso(purchase.occurredAt),
          windowStart: utcIso(start),
          reason: mode === 'first' ? '窗口内没有在先试吃，未归因' : '窗口内没有可分配的在先试吃，未归因',
        });
        continue;
      }

      const attributedFlavor = pick.flavor;
      const isRepeat = index > 0;
      const bucket = flavors[attributedFlavor];
      bucket.usedSamples += 1;
      bucket.attributedPurchases += 1;
      if (isRepeat) bucket.repeatPurchases += 1;
      else bucket.firstPurchases += 1;
      bucket.gross = round2(bucket.gross + purchase.amount);
      bucket.refunded = round2(bucket.refunded + refundedAmount);
      bucket.net = round2(bucket.net + net);
      if (isRepeat) bucket.repeatNet = round2(bucket.repeatNet + net);
      else bucket.firstNet = round2(bucket.firstNet + net);
      if (refund) bucket.refundedPurchases += 1;
      usedSampleIds.add(pick.id);

      if (refund) {
        refunds.push({
          refundId: refund.id,
          orderId: purchase.id,
          person,
          purchaseFlavor: purchase.flavor,
          attributedFlavor,
          refundedAmount,
          occurredAt: utcIso(refund.occurredAt),
          recordedAt: utcIso(refund.recordedAt),
          recordedLate: refund.recordedAt > refund.occurredAt,
          reason: '整单退，冲减该笔购买及其归因',
        });
      }

      rows.push({
        orderId: purchase.id,
        person,
        purchaseFlavor: purchase.flavor,
        attributedFlavor,
        sampleId: pick.id,
        sampleFlavor: pick.flavor,
        sampleAt: utcIso(pick.occurredAt),
        occurredAt: utcIso(purchase.occurredAt),
        windowStart: utcIso(start),
        amount: purchase.amount,
        refundedAmount,
        net,
        refundId: refund ? refund.id : null,
        purchaseIndex: index + 1,
        isRepeat,
        sameFlavor: pick.flavor === purchase.flavor,
      });
    }
  }

  for (const flavor of FLAVORS) {
    const bucket = flavors[flavor];
    bucket.samples = visible.filter((e) => e.kind === 'sample' && e.flavor === flavor).length;
    bucket.usedSamples = usedSampleIds.size === 0
      ? 0
      : [...usedSampleIds].reduce((count, sampleId) => {
        const sample = sampleById.get(sampleId);
        return count + (sample && sample.flavor === flavor ? 1 : 0);
      }, 0);
    bucket.unusedSamples = bucket.samples - bucket.usedSamples;
  }

  rows.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.orderId.localeCompare(b.orderId));
  refunds.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.refundId.localeCompare(b.refundId));

  const unattributedGross = round2(unattributed.reduce((s, u) => s + u.amount, 0));
  const attributedGross = round2(rows.reduce((s, r) => s + r.amount, 0));
  const totals = {
    people: purchasesByPerson.size,
    samples: visible.filter((e) => e.kind === 'sample').length,
    purchases: purchases.length,
    attributed: rows.length,
    unattributed: unattributed.length,
    unattributedGross,
    attributedGross,
    grossAll: round2(attributedGross + unattributedGross),
    refunded: round2(rows.reduce((s, r) => s + r.refundedAmount, 0)),
    net: round2(rows.reduce((s, r) => s + r.net, 0)),
    repeatNet: round2(rows.filter((r) => r.isRepeat).reduce((s, r) => s + r.net, 0)),
    firstNet: round2(rows.filter((r) => !r.isRepeat).reduce((s, r) => s + r.net, 0)),
  };

  // 相对上一版已发布报表的逐笔回转：按旧可见集合重算，再与本版对齐。
  let revision = null;
  if (Number.isFinite(options.visibleBefore)) {
    const prior = attribute(events, { mode, asOf: options.visibleBefore, windowDays });
    const priorByOrder = new Map(prior.rows.map((r) => [r.orderId, r]));
    const currentByOrder = new Map(rows.map((r) => [r.orderId, r]));
    const deltas = [];

    for (const [orderId, before] of priorByOrder) {
      const after = currentByOrder.get(orderId);
      if (!after) {
        deltas.push({
          orderId,
          person: before.person,
          attributedFlavor: before.attributedFlavor,
          beforeNet: before.net,
          afterNet: 0,
          delta: -before.net,
          change: '移出归因',
          changeKind: 'removed',
        });
        continue;
      }
      const delta = round2(after.net - before.net);
      if (delta === 0 && after.attributedFlavor === before.attributedFlavor) continue;
      let change = '口径变化';
      let changeKind = 'reassigned';
      if (after.refundId && !before.refundId) {
        change = after.isRepeat ? '复购回转（补交退单）' : '首购回转（补交退单）';
        changeKind = after.isRepeat ? 'repeat-refund' : 'first-refund';
      }
      deltas.push({
        orderId,
        person: after.person,
        attributedFlavor: after.attributedFlavor,
        beforeFlavor: before.attributedFlavor,
        beforeNet: before.net,
        afterNet: after.net,
        delta,
        change,
        changeKind,
        refundId: after.refundId || null,
      });
    }

    // 旧报表里没有、本版新增的已发布订单（迟录购买）也要指出来。
    for (const [orderId, after] of currentByOrder) {
      if (priorByOrder.has(orderId)) continue;
      deltas.push({
        orderId,
        person: after.person,
        attributedFlavor: after.attributedFlavor,
        beforeFlavor: null,
        beforeNet: 0,
        afterNet: after.net,
        delta: after.net,
        change: '新入账',
        changeKind: 'added',
        refundId: after.refundId || null,
      });
    }

    deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.orderId.localeCompare(b.orderId));

    const priorFlavorNet = {};
    const currentFlavorNet = {};
    for (const flavor of FLAVORS) {
      priorFlavorNet[flavor] = prior.flavors[flavor].net;
      currentFlavorNet[flavor] = flavors[flavor].net;
    }

    revision = {
      priorAsOf: prior.asOf,
      priorAsOfIso: prior.asOfIso,
      priorTotals: prior.totals,
      priorFlavorNet,
      currentFlavorNet,
      flavorDelta: Object.fromEntries(
        FLAVORS.map((f) => [f, round2(currentFlavorNet[f] - priorFlavorNet[f])]),
      ),
      netDelta: round2(totals.net - prior.totals.net),
      purchaseDelta: totals.purchases - prior.totals.purchases,
      deltas,
    };
  }

  // 录入晚于 asOf 的退单不进本版，但要告诉读者下一版会变。
  const pendingRefunds = events
    .filter((e) => e.kind === 'refund' && e.recordedAt > asOf)
    .map((e) => ({
      id: e.id,
      person: e.person,
      reference: e.reference,
      occurredAt: utcIso(e.occurredAt),
      recordedAt: utcIso(e.recordedAt),
      lateByHours: Math.round((e.recordedAt - e.occurredAt) / 3600000),
      reason: '录入时间晚于本次报表截止，下一版才处理',
    }));

  return {
    mode,
    asOf,
    asOfIso: utcIso(asOf),
    windowDays,
    flavors,
    rows,
    unattributed,
    refunds,
    rejectedRefunds: rejected,
    pendingRefunds,
    revision,
    totals,
  };
}

module.exports = { attribute, windowStartFor, attachRefunds, emptyFlavors };
