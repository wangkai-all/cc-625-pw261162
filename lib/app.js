'use strict';

/**
 * HTTP 应用：静态页 + JSON 接口。不依赖任何第三方包。
 *
 * 接口：
 *   GET  /api/report             两版快照（published / current）与两种口径
 *   POST /api/comparison         生成「首次试吃 vs 按顺序分配」比较
 *   POST /api/refunds            补交下一张迟到的退单
 *   GET  /api/detail?mode=first  归因逐笔明细、未归因、拒收退单、去重
 *
 * 错误统一为 { error: { code, message, issues? } }。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createSession, buildReport, addLateRefund } = require('./report');
const { FLAVORS, InputError } = require('./rules');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
]);

const DISCLAIMER =
  '以下数字只是关联观察：归因窗口、去重规则都是事先固定的，没有对照组，不能当作样品派发带来的因果增量。';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, body, type) {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function comparisonPayload(report) {
  const modes = report.modes;
  const flavors = FLAVORS.map((flavor) => {
    const first = modes.first.current.flavors.find((f) => f.flavor === flavor);
    const sequence = modes.sequence.current.flavors.find((f) => f.flavor === flavor);
    return {
      flavor,
      firstNet: first.net,
      sequenceNet: sequence.net,
      delta: Math.round((sequence.net - first.net) * 100) / 100,
      firstPurchases: first.attributedPurchases,
      sequencePurchases: sequence.attributedPurchases,
    };
  });
  const firstRows = new Map(modes.first.currentRows.map((r) => [r.orderId, r]));
  const reassigned = [];
  for (const row of modes.sequence.currentRows) {
    const counterpart = firstRows.get(row.orderId);
    if (!counterpart || counterpart.attributedFlavor === row.attributedFlavor) continue;
    reassigned.push({
      orderId: row.orderId,
      person: row.person,
      purchaseFlavor: row.purchaseFlavor,
      firstFlavor: counterpart.attributedFlavor,
      sequenceFlavor: row.attributedFlavor,
      amount: row.amount,
      net: row.net,
      isRepeat: row.isRepeat,
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    publishedAt: report.publishedAt,
    currentAsOf: report.currentAsOf,
    windowDays: report.windowDays,
    flavors,
    totals: {
      firstNet: flavors.reduce((s, f) => s + f.firstNet, 0),
      sequenceNet: flavors.reduce((s, f) => s + f.sequenceNet, 0),
      ambiguousOrders: reassigned.length,
    },
    reassigned,
    disclaimer: DISCLAIMER,
  };
}

function createApp(options) {
  const opts = options || {};
  const state = opts.session || createSession();
  const submittedRefunds = [];
  let comparisonGeneratedAt = null;

  function reportPayload() {
    const report = buildReport(state);
    return {
      ...report,
      disclaimer: DISCLAIMER,
      session: {
        lateRefundsSubmitted: state.lateIndex,
        lateRefundsRemaining: report.lateRefundsRemaining,
        submittedRefunds,
        comparisonGeneratedAt,
      },
    };
  }

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, { error: { code: 'BAD_URL', message: '请求地址无法解析' } });
      return;
    }

    try {
      if (req.method === 'GET' && STATIC_FILES.has(url.pathname)) {
        const entry = STATIC_FILES.get(url.pathname);
        let body;
        try {
          body = fs.readFileSync(path.join(PUBLIC_DIR, entry.file), 'utf8');
        } catch {
          sendJson(res, 500, { error: { code: 'STATIC_MISSING', message: `缺少页面文件 ${entry.file}` } });
          return;
        }
        sendText(res, 200, body, entry.type);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/report') {
        sendJson(res, 200, reportPayload());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/detail') {
        const mode = url.searchParams.get('mode') === 'sequence' ? 'sequence' : 'first';
        const report = reportPayload();
        const bundle = report.modes[mode];
        sendJson(res, 200, {
          mode,
          publishedAt: report.publishedAt,
          currentAsOf: report.currentAsOf,
          windowDays: report.windowDays,
          rows: bundle.currentRows,
          unattributed: bundle.unattributed,
          refunds: bundle.refunds,
          rejectedRefunds: bundle.rejectedRefunds,
          pendingRefunds: bundle.pendingRefunds,
          dedupe: report.dedupe,
          disclaimer: DISCLAIMER,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/comparison') {
        const report = reportPayload();
        const comparison = comparisonPayload(report);
        comparisonGeneratedAt = comparison.generatedAt;
        sendJson(res, 200, comparison);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/refunds') {
        const submitted = addLateRefund(state);
        submittedRefunds.push(submitted);
        sendJson(res, 201, {
          submitted,
          session: {
            lateRefundsSubmitted: state.lateIndex,
            lateRefundsRemaining: submitted.remaining,
            submittedRefunds,
          },
        });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `没有这个接口：${req.method} ${url.pathname}` } });
        return;
      }
      sendText(res, 404, '找不到这个页面', 'text/plain; charset=utf-8');
    } catch (error) {
      if (error instanceof InputError) {
        sendJson(res, 409, {
          error: { code: error.code, message: error.message, issues: error.issues },
        });
        return;
      }
      console.error('[server] 未处理异常', error);
      sendJson(res, 500, { error: { code: 'INTERNAL', message: '服务器内部错误' } });
    }
  }

  return { handle, state };
}

function createServer(options) {
  const http = require('node:http');
  const app = createApp(options);
  return http.createServer((req, res) => {
    app.handle(req, res).catch((error) => {
      console.error('[server] 请求失败', error);
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'INTERNAL', message: '服务器内部错误' } });
      else res.end();
    });
  });
}

module.exports = { createApp, createServer, comparisonPayload };
