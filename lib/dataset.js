'use strict';

/**
 * 虚构账本。全部为演示数据，人名、订单号、金额都不对应真实业务。
 * 覆盖：一人先后试两种口味、重复录入、窗口外样品、退单已入账、
 * 被拒收的退单（原单不存在 / 退单人不对）、只试吃未购买。
 */

const F1 = '柚子气泡';
const F2 = '海盐焦糖';
const F3 = '乌龙青梅';

const events = [
  // 林小满：先试柚子，再试海盐，两次购买。「首次试吃」口径两次都算柚子，
  // 「按顺序分配」口径第一单算柚子、第二单算海盐。
  { id: 'S01', kind: 'sample', person: '林小满', flavor: F1, occurredAt: '2026-09-02T03:00:00Z' },
  { id: 'S02', kind: 'sample', person: '林小满', flavor: F2, occurredAt: '2026-09-08T03:00:00Z' },
  { id: 'O01', kind: 'purchase', person: '林小满', flavor: F2, amount: 128, occurredAt: '2026-09-12T10:00:00Z' },
  { id: 'O02', kind: 'purchase', person: '林小满', flavor: F1, amount: 128, occurredAt: '2026-09-26T10:00:00Z' },

  // 周予安：重复录入一条样品；第二单复购，是补交退单的候选。
  { id: 'S03', kind: 'sample', person: '周予安', flavor: F3, occurredAt: '2026-09-05T02:00:00Z' },
  { id: 'S03D', kind: 'sample', person: '周予安', flavor: F3, occurredAt: '2026-09-05T02:00:30Z' },
  { id: 'S04', kind: 'sample', person: '周予安', flavor: F1, occurredAt: '2026-09-10T02:00:00Z' },
  { id: 'O03', kind: 'purchase', person: '周予安', flavor: F3, amount: 98, occurredAt: '2026-09-15T09:00:00Z' },
  { id: 'O04', kind: 'purchase', person: '周予安', flavor: F1, amount: 98, occurredAt: '2026-09-22T09:00:00Z' },

  // 陈澈：样品在 30 天窗口外，购买因此不归因（正常但无法归因的异常结果）。
  { id: 'S06', kind: 'sample', person: '陈澈', flavor: F2, occurredAt: '2026-08-01T02:00:00Z' },
  { id: 'O05', kind: 'purchase', person: '陈澈', flavor: F2, amount: 88, occurredAt: '2026-09-20T09:00:00Z' },

  // 宋一禾：购买口味与归因口味可以不同；首单在 v1 已入账一张退单。
  { id: 'S07', kind: 'sample', person: '宋一禾', flavor: F2, occurredAt: '2026-09-06T02:00:00Z' },
  { id: 'S08', kind: 'sample', person: '宋一禾', flavor: F2, occurredAt: '2026-09-25T02:00:00Z' },
  { id: 'O06', kind: 'purchase', person: '宋一禾', flavor: F2, amount: 108, occurredAt: '2026-09-30T09:00:00Z' },
  { id: 'R02', kind: 'refund', person: '宋一禾', flavor: F2, reference: 'O06', occurredAt: '2026-10-05T08:00:00Z' },
  { id: 'O07', kind: 'purchase', person: '宋一禾', flavor: F1, amount: 108, occurredAt: '2026-10-02T09:00:00Z' },

  // 许知遥：两条退单都会被拒收——一条原单不存在，一条退单人不对。
  { id: 'S09', kind: 'sample', person: '许知遥', flavor: F1, occurredAt: '2026-09-11T02:00:00Z' },
  { id: 'O08', kind: 'purchase', person: '许知遥', flavor: F1, amount: 158, occurredAt: '2026-10-08T09:00:00Z' },
  { id: 'R03', kind: 'refund', person: '唐屿', flavor: F1, reference: 'O08', occurredAt: '2026-10-09T08:00:00Z' },
  { id: 'R04', kind: 'refund', person: '许知遥', flavor: F1, reference: 'O999', occurredAt: '2026-10-10T08:00:00Z' },

  // 唐屿：两单同口味，顺序口径下第二单只能复用最近一次试吃。
  { id: 'S10', kind: 'sample', person: '唐屿', flavor: F3, occurredAt: '2026-09-18T02:00:00Z' },
  { id: 'O09', kind: 'purchase', person: '唐屿', flavor: F3, amount: 128, occurredAt: '2026-09-28T09:00:00Z' },
  { id: 'O10', kind: 'purchase', person: '唐屿', flavor: F3, amount: 128, occurredAt: '2026-10-12T09:00:00Z' },

  // 罗青：v1 已包含全额退单，净额本来就是 0。
  { id: 'S11', kind: 'sample', person: '罗青', flavor: F2, occurredAt: '2026-09-01T02:00:00Z' },
  { id: 'O11', kind: 'purchase', person: '罗青', flavor: F2, amount: 68, occurredAt: '2026-09-03T09:00:00Z' },
  { id: 'R05', kind: 'refund', person: '罗青', flavor: F2, reference: 'O11', occurredAt: '2026-09-06T08:00:00Z' },

  // 韩沐：只试吃、没购买——样品计入派发，但不会变成归因购买。
  { id: 'S12', kind: 'sample', person: '韩沐', flavor: F3, occurredAt: '2026-09-14T02:00:00Z' },
];

const FIRST_REPORT_ASOF = '2026-10-15T00:00:00.000Z';
const LATE_REFUND_RECORDED = '2026-10-22T00:00:00.000Z';

/**
 * 可补交的退单队列。业务发生时间都在 v1 截止之前，录入时间在 v1 之后，
 * 所以它们只能出现在新报表里，并让旧报表的复购逐笔回转。
 * O02 在「首次试吃」口径归属柚子气泡，在「按顺序分配」口径归属海盐焦糖：
 * 同一张退单，两种口径回冲的却是不同口味。
 */
const LATE_REFUNDS = [
  {
    orderId: 'O02',
    refundId: 'R10',
    occurredAt: '2026-09-29T08:00:00Z',
    note: '林小满的复购（第 2 单）退单，业务时间在 v1 之前、录入在 v1 之后',
  },
  {
    orderId: 'O04',
    refundId: 'R11',
    occurredAt: '2026-09-25T08:00:00Z',
    note: '周予安的复购（第 2 单）退单，同样迟到',
  },
  {
    orderId: 'O08',
    refundId: 'R12',
    occurredAt: '2026-10-11T08:00:00Z',
    note: '许知遥唯一一单的退单，用来对比首购回转与复购回转',
  },
];

module.exports = { events, FIRST_REPORT_ASOF, LATE_REFUND_RECORDED, LATE_REFUNDS };
