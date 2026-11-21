'use strict';

/**
 * 归因规则的输入层：常量、校验、去重。
 * 规则本身在 attribution.js，报表快照在 report.js。
 *
 * 每条事件有两套时间：
 *   occurredAt 业务发生时间——决定归因窗口的归属。
 *   recordedAt  录入系统时间——决定它何时才出现在报表里。
 * 退单「迟到」就是 occurredAt 早于上一版报表、recordedAt 却晚于它。
 */

const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
const FLAVORS = Object.freeze(['柚子气泡', '海盐焦糖', '乌龙青梅']);
const KINDS = Object.freeze(['sample', 'purchase', 'refund']);
const MAX_EVENTS = 5000;
const DATE_MIN = Date.UTC(2020, 0, 1);
const DATE_MAX = Date.UTC(2035, 11, 31);

class InputError extends Error {
  constructor(code, message, issues) {
    super(message);
    this.name = 'InputError';
    this.code = code;
    this.issues = issues || [];
  }
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function utcIso(ms) {
  return new Date(ms).toISOString();
}

function isIsoInstant(value) {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= DATE_MIN && ms <= DATE_MAX;
}

/**
 * 校验并归一化事件。任何一条非法都整体拒绝，不静默丢弃。
 * 返回按发生时间、id 排序的事件数组。
 */
function normalizeEvents(raw) {
  if (!Array.isArray(raw)) {
    throw new InputError('INVALID_EVENTS', 'events 必须是数组');
  }
  if (raw.length > MAX_EVENTS) {
    throw new InputError('TOO_MANY_EVENTS', `事件数 ${raw.length} 超过 ${MAX_EVENTS} 条上限`);
  }
  const issues = [];
  const events = [];
  const seenIds = new Set();

  raw.forEach((item, index) => {
    const at = `第 ${index + 1} 条`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push({ index, message: `${at}：不是对象` });
      return;
    }
    const kind = typeof item.kind === 'string' ? item.kind : '';
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const person = typeof item.person === 'string' ? item.person.trim() : '';
    const flavor = typeof item.flavor === 'string' ? item.flavor : '';
    if (!KINDS.includes(kind)) {
      issues.push({ index, message: `${at}：类型「${kind || '空'}」不认识，只能是 sample / purchase / refund` });
      return;
    }
    if (!id) {
      issues.push({ index, message: `${at}：缺少 id` });
      return;
    }
    if (seenIds.has(id)) {
      issues.push({ index, message: `${at}：id「${id}」重复` });
      return;
    }
    if (!person) {
      issues.push({ index, message: `${at}：缺少 person` });
      return;
    }
    if (!FLAVORS.includes(flavor)) {
      issues.push({ index, message: `${at}：口味「${flavor || '空'}」不在三种内` });
      return;
    }
    if (!isIsoInstant(item.occurredAt)) {
      issues.push({ index, message: `${at}：时间「${item.occurredAt ?? '空'}」不是 2020–2035 的 UTC ISO 时间` });
      return;
    }
    // recordedAt 缺省等于 occurredAt；显式给出时必须是合法时间且不早于业务时间。
    if (item.recordedAt !== undefined && !isIsoInstant(item.recordedAt)) {
      issues.push({ index, message: `${at}：录入时间「${item.recordedAt ?? '空'}」不是合法 UTC 时间` });
      return;
    }
    if (item.recordedAt !== undefined && Date.parse(item.recordedAt) < Date.parse(item.occurredAt)) {
      issues.push({ index, message: `${at}：录入时间早于业务发生时间，账本不可能这样` });
      return;
    }

    const occurredAt = Date.parse(item.occurredAt);
    const recordedAt = item.recordedAt === undefined ? occurredAt : Date.parse(item.recordedAt);
    const event = {
      id,
      person,
      kind,
      flavor,
      occurredAt,
      recordedAt,
      amount: 0,
      reference: '',
    };

    if (kind === 'purchase') {
      const amount = item.amount;
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 100000) {
        issues.push({ index, message: `${at}：金额必须是 0–100000 的正数，收到「${amount ?? '空'}」` });
        return;
      }
      event.amount = round2(amount);
    }

    if (kind === 'refund') {
      const reference = typeof item.reference === 'string' ? item.reference.trim() : '';
      if (!reference) {
        issues.push({ index, message: `${at}：退单必须带 reference（原订单号）` });
        return;
      }
      event.reference = reference;
    }

    seenIds.add(id);
    events.push(event);
  });

  if (issues.length > 0) {
    throw new InputError('INVALID_EVENTS', `输入里有 ${issues.length} 条非法记录`, issues);
  }
  events.sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
  return events;
}

/**
 * 去重：同人 + 同类型 + 同口味 + 同一 UTC 分钟（按业务时间）的重复录入只留一条。
 * 退单不按分钟合并——同一个原订单的两张退单是两笔独立事实，
 * 交给归因层的「一单最多冲一次」规则拒收。保留录入时间最早的一条：
 * 后补录的重复记录不会把早已发布的原始记录顶掉。
 */
function dedupeEvents(events) {
  const ordered = events.slice().sort(
    (a, b) => a.recordedAt - b.recordedAt || a.occurredAt - b.occurredAt || a.id.localeCompare(b.id),
  );
  const kept = [];
  const dropped = [];
  const firstByKey = new Map();
  for (const event of ordered) {
    const minute = Math.floor(event.occurredAt / 60000);
    // 退单是独立的钱款事实：即使同一分钟对同一订单退两次，也不按分钟合并。
    const key = event.kind === 'refund'
      ? [event.person, event.kind, event.id].join('\u0000')
      : [event.person, event.kind, event.flavor, minute].join('\u0000');
    const prior = firstByKey.get(key);
    if (prior) {
      dropped.push({
        id: event.id,
        duplicateOf: prior.id,
        person: event.person,
        kind: event.kind,
        flavor: event.flavor,
        occurredAt: utcIso(event.occurredAt),
        recordedAt: utcIso(event.recordedAt),
        reason: '同一人、同一口味、同一 UTC 分钟重复录入',
      });
      continue;
    }
    firstByKey.set(key, event);
    kept.push(event);
  }
  kept.sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
  dropped.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  return { events: kept, dropped };
}

module.exports = {
  WINDOW_DAYS,
  DAY_MS,
  FLAVORS,
  KINDS,
  MAX_EVENTS,
  InputError,
  round2,
  utcIso,
  isIsoInstant,
  normalizeEvents,
  dedupeEvents,
};
