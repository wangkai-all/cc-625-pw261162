'use strict';

/**
 * 页面逻辑：只读本地服务，不缓存业务结果。
 * 所有可核对的结果同时写到 #results 的 data-evidence-* 属性上，
 * 方便测试或人工在操作前后直接比对。
 */

const resultsEl = document.getElementById('results');
const statusEl = document.getElementById('action-status');
const btnCompare = document.getElementById('btn-compare');
const btnRefund = document.getElementById('btn-refund');
const btnDetail = document.getElementById('btn-detail');
const revisionBody = document.getElementById('revision-body');
const comparePanel = document.getElementById('panel-compare');
const compareBody = document.getElementById('compare-body');
const compareChip = document.getElementById('compare-chip');
const compareSub = document.getElementById('compare-sub');
const detailPanel = document.getElementById('panel-detail');
const detailBody = document.getElementById('detail-body');
const detailChip = document.getElementById('detail-chip');
const detailSub = document.getElementById('detail-sub');
const anomalyBody = document.getElementById('anomaly-body');
const tooltip = document.getElementById('tooltip');

const state = {
  report: null,
  mode: 'first',
  compare: null,
  detail: null,
};

const money = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
function yuan(n) {
  return `¥${money.format(Math.round(n * 100) / 100)}`;
}
function signedYuan(n) {
  const v = Math.round(n * 100) / 100;
  if (v === 0) return '¥0';
  return `${v > 0 ? '+' : '−'}¥${money.format(Math.abs(v))}`;
}
function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}
function shortTime(iso) {
  return iso ? iso.slice(5, 16).replace('T', ' ') : '—';
}
function dayOf(iso) {
  return iso ? iso.slice(0, 10) : '—';
}
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---------------- tooltip ---------------- */
function bindTooltip(root) {
  root.querySelectorAll('[data-tip]').forEach((el) => {
    const show = (event) => {
      tooltip.innerHTML = el.getAttribute('data-tip');
      tooltip.hidden = false;
      const rect = event.currentTarget.getBoundingClientRect();
      const width = tooltip.offsetWidth;
      let left = rect.left + rect.width / 2 - width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${rect.top - tooltip.offsetHeight - 8}px`;
    };
    const hide = () => { tooltip.hidden = true; };
    el.addEventListener('mouseenter', show);
    el.addEventListener('focus', show);
    el.addEventListener('mouseleave', hide);
    el.addEventListener('blur', hide);
  });
}

/* ---------------- fetch helpers ---------------- */
async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error?.message || `请求失败（HTTP ${res.status}）`);
    err.code = body?.error?.code;
    err.issues = body?.error?.issues;
    throw err;
  }
  return body;
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error?.message || `请求失败（HTTP ${res.status}）`);
    err.code = body?.error?.code;
    throw err;
  }
  return body;
}

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.classList.toggle('is-error', kind === 'error');
  statusEl.classList.toggle('is-good', kind === 'good');
}

function busy(button, isBusy) {
  if (!button) return;
  button.disabled = isBusy;
  if (isBusy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

/* ---------------- KPI ---------------- */
function renderKpis(report) {
  const mode = report.modes[state.mode];
  const current = mode.current;
  const published = mode.published;
  const totals = current.totals;
  const prior = published.totals;
  const revision = mode.revision;
  const deltaNet = Math.round((totals.net - prior.net) * 100) / 100;

  const tiles = [
    {
      label: '归因净额',
      value: yuan(totals.net),
      note: `归因口径 · ${state.mode === 'first' ? '首次试吃' : '按顺序分配'}`,
      delta: deltaNet === 0
        ? '<span class="flat">与旧报表一致</span>'
        : `<span class="${deltaNet > 0 ? 'up' : 'down'}">${signedYuan(deltaNet)}</span> 相对旧报表`,
    },
    {
      label: '归因订单',
      value: `${totals.attributed}<span class="unit">/ ${totals.purchases}</span>`,
      note: `${totals.unattributed} 笔未归因（${yuan(totals.unattributedGross)}）`,
      delta: revision && revision.purchaseDelta !== 0
        ? `<span class="${revision.purchaseDelta > 0 ? 'up' : 'down'}">${revision.purchaseDelta > 0 ? '+' : ''}${revision.purchaseDelta}</span> 笔新入账`
        : '<span class="flat">订单数与旧报表一致</span>',
    },
    {
      label: '复购净额',
      value: yuan(totals.repeatNet),
      note: '同一人第 2 单及以后',
      delta: `<span class="flat">首购 ${yuan(totals.firstNet)}</span>`,
    },
    {
      label: '退单冲减',
      value: yuan(totals.refunded),
      note: `${mode.refunds.length} 张已入账 · ${mode.rejectedRefunds.length} 张被拒收`,
      delta: report.session.lateRefundsRemaining > 0
        ? `<span class="down">还有 ${report.session.lateRefundsRemaining} 张可补交</span>`
        : '<span class="flat">演示退单已全部补交</span>',
    },
  ];

  const grid = document.getElementById('kpis');
  grid.innerHTML = tiles.map((tile) => `
    <div class="kpi">
      <div class="kpi-label">${escapeHtml(tile.label)}</div>
      <div class="kpi-value">${tile.value}</div>
      <div class="kpi-delta">${tile.delta}</div>
      <div class="kpi-note">${escapeHtml(tile.note)}</div>
    </div>`).join('');
}

/* ---------------- revision panel ---------------- */
function renderRevision(report) {
  const mode = report.modes[state.mode];
  const current = mode.current;
  const published = mode.published;
  const revision = mode.revision;
  const modeName = state.mode === 'first' ? '首次试吃' : '按顺序分配';

  if (!revision) {
    revisionBody.innerHTML = '<p class="empty-state">还没有版本比较结果。</p>';
    return;
  }

  const changedFlavors = Object.entries(revision.flavorDelta)
    .filter(([, v]) => v !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

  const callout = revision.deltas.length === 0
    ? `<div class="rev-callout is-clear"><span aria-hidden="true">✓</span><div><strong>新旧两版逐笔一致。</strong>没有退单改变已发布订单的归因；补交一张退单后，这里会出现逐笔差额。</div></div>`
    : `<div class="rev-callout"><span aria-hidden="true">!</span><div><strong>有 ${revision.deltas.length} 笔订单在新报表里变了。</strong>旧报表保持 ${shortTime(report.publishedAt)} 的发布原样，新报表截止 ${shortTime(report.currentAsOf)}；差额合计 ${signedYuan(revision.netDelta)}。</div></div>`;

  const summary = `
    <div class="rev-summary">
      <div class="rev-cell">
        <div class="label">旧报表（已发布，不改写）</div>
        <div class="value">${yuan(published.totals.net)}</div>
        <div class="sub">${modeName} · 截止 ${shortTime(report.publishedAt)}</div>
      </div>
      <div class="rev-cell">
        <div class="label">新报表（当前账本）</div>
        <div class="value">${yuan(current.totals.net)}</div>
        <div class="sub">${modeName} · 截止 ${shortTime(report.currentAsOf)}</div>
      </div>
      <div class="rev-cell">
        <div class="label">逐笔差额</div>
        <div class="value ${revision.netDelta < 0 ? 'delta-down' : revision.netDelta > 0 ? 'delta-up' : ''}">${signedYuan(revision.netDelta)}</div>
        <div class="sub">${changedFlavors.length === 0 ? '各口味净额未变' : changedFlavors.map(([f, v]) => `${f} ${signedYuan(v)}`).join(' · ')}</div>
      </div>
    </div>`;

  let list = '';
  if (revision.deltas.length > 0) {
    list = `
      <h3 class="subhead">逐笔说明：钱从哪笔复购回了头</h3>
      <ul class="revision-list">
        ${revision.deltas.map((d) => `
          <li class="revision-item">
            <span class="tag">${escapeHtml(d.change)}</span>
            <span class="detail">
              <strong>${escapeHtml(d.person)}</strong> 的订单 <code>${escapeHtml(d.orderId)}</code>
              归给「${escapeHtml(d.attributedFlavor)}」
              ${d.beforeFlavor && d.beforeFlavor !== d.attributedFlavor ? `<span class="muted">（旧报表归给「${escapeHtml(d.beforeFlavor)}」）</span>` : ''}
              <span class="muted">旧 ${yuan(d.beforeNet)} → 新 ${yuan(d.afterNet)}</span>
            </span>
            <span class="amount ${d.delta < 0 ? 'delta-down' : 'delta-up'}">${signedYuan(d.delta)}</span>
          </li>`).join('')}
      </ul>`;
  }

  revisionBody.innerHTML = `${summary}${callout}${list}`;
}

/* ---------------- anomaly panel ---------------- */
function renderAnomalies(report) {
  const mode = report.modes[state.mode];
  const items = [];

  const duplicateCount = report.dedupe.length;
  if (duplicateCount > 0) {
    const rows = report.dedupe.map((d) => `
      <tr>
        <td><code>${escapeHtml(d.id)}</code></td>
        <td>${escapeHtml(d.person)}</td>
        <td>${escapeHtml(d.kind === 'sample' ? '试吃' : d.kind === 'purchase' ? '购买' : '退单')}</td>
        <td>${escapeHtml(d.flavor)}</td>
        <td>${shortTime(d.occurredAt)}</td>
        <td class="muted">与 <code>${escapeHtml(d.duplicateOf)}</code> 重复，按规则保留第一条</td>
      </tr>`).join('');
    items.push(`
      <h3 class="subhead">去重：${duplicateCount} 条重复录入被合并</h3>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>编号</th><th>人</th><th>类型</th><th>口味</th><th>业务时间</th><th>处置</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`);
  }

  if (mode.rejectedRefunds.length > 0) {
    const rows = mode.rejectedRefunds.map((r) => `
      <tr class="is-flagged">
        <td><code>${escapeHtml(r.id)}</code></td>
        <td>${escapeHtml(r.person)}</td>
        <td><code>${escapeHtml(r.reference)}</code></td>
        <td>${shortTime(r.occurredAt)}</td>
        <td>${escapeHtml(r.reason)}</td>
      </tr>`).join('');
    items.push(`
      <h3 class="subhead">拒收退单：${mode.rejectedRefunds.length} 张没有冲减任何金额</h3>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>退单号</th><th>退单人</th><th>原订单</th><th>业务时间</th><th>拒收原因</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`);
  }

  if (mode.unattributed.length > 0) {
    const rows = mode.unattributed.map((u) => `
      <tr>
        <td><code>${escapeHtml(u.orderId)}</code></td>
        <td>${escapeHtml(u.person)}</td>
        <td>${escapeHtml(u.purchaseFlavor)}</td>
        <td class="num">${yuan(u.amount)}</td>
        <td>${dayOf(u.windowStart)} → ${dayOf(u.occurredAt)}</td>
        <td class="muted">${escapeHtml(u.reason)}</td>
      </tr>`).join('');
    items.push(`
      <h3 class="subhead">未归因购买：${mode.unattributed.length} 笔没有可用的在先试吃</h3>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>订单</th><th>人</th><th>购买口味</th><th class="num">金额</th><th>窗口</th><th>原因</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="empty-state">这些钱不在归因净额里，但仍在总购买中；KPI 的「未归因」按金额单列。</p>
      </div>`);
  }

  anomalyBody.innerHTML = items.length > 0
    ? items.join('')
    : '<p class="empty-state">没有触发任何异常规则。</p>';
}

/* ---------------- comparison panel ---------------- */
function renderComparison(compare) {
  comparePanel.hidden = false;
  compareSub.textContent = `同一份账本快照，按两种口径各算一遍 · 生成于 ${shortTime(compare.generatedAt)} · 窗口 ${compare.windowDays} 天`;

  const max = Math.max(1, ...compare.flavors.flatMap((f) => [Math.abs(f.firstNet), Math.abs(f.sequenceNet)]));
  const ambiguous = compare.totals.ambiguousOrders;
  compareChip.className = `chip ${ambiguous > 0 ? 'warn' : 'good'}`;
  compareChip.textContent = ambiguous > 0 ? `${ambiguous} 笔订单两种口径归属不同` : '两种口径归属完全一致';

  const rows = compare.flavors.map((f) => {
    const firstPct = (Math.abs(f.firstNet) / max) * 100;
    const seqPct = (Math.abs(f.sequenceNet) / max) * 100;
    const tip = `<strong>${escapeHtml(f.flavor)}</strong><br>首次试吃 ${yuan(f.firstNet)}（${f.firstPurchases} 单）<br>按顺序分配 ${yuan(f.sequenceNet)}（${f.sequencePurchases} 单）<br>差额 ${signedYuan(f.delta)}`;
    return `
      <div class="bar-row" data-tip="${escapeHtml(tip)}" tabindex="0">
        <div class="bar-label">${escapeHtml(f.flavor)}<span class="sub">首次 ${f.firstPurchases} 单 · 顺序 ${f.sequencePurchases} 单</span></div>
        <div class="bar-pair">
          <div class="bar-track"><div class="bar-fill pos" style="width:${firstPct}%"></div></div>
          <div class="bar-track"><div class="bar-fill neg" style="width:${seqPct}%"></div></div>
        </div>
        <div class="bar-value">${yuan(f.firstNet)}<span class="muted" style="font-weight:400"> / ${yuan(f.sequenceNet)}</span></div>
      </div>`;
  }).join('');

  const reassigned = compare.reassigned.length === 0
    ? '<p class="empty-state">两种口径下没有订单换口味。</p>'
    : `
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>订单</th><th>人</th><th>购买口味</th><th>首次试吃</th><th>按顺序分配</th><th class="num">净额</th><th>单次</th></tr></thead>
          <tbody>
            ${compare.reassigned.map((r) => `
              <tr>
                <td><code>${escapeHtml(r.orderId)}</code></td>
                <td class="person">${escapeHtml(r.person)}</td>
                <td>${escapeHtml(r.purchaseFlavor)}</td>
                <td>${escapeHtml(r.firstFlavor)}</td>
                <td>${escapeHtml(r.sequenceFlavor)}</td>
                <td class="num">${yuan(r.net)}</td>
                <td>${r.isRepeat ? '复购' : '首购'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

  const tableRows = compare.flavors.map((f) => `
    <tr>
      <td>${escapeHtml(f.flavor)}</td>
      <td class="num">${yuan(f.firstNet)}</td>
      <td class="num">${yuan(f.sequenceNet)}</td>
      <td class="num ${f.delta > 0 ? 'delta-up' : f.delta < 0 ? 'delta-down' : 'delta-flat'}">${signedYuan(f.delta)}</td>
    </tr>`).join('');

  compareBody.innerHTML = `
    <div class="legend">
      <span class="legend-item"><span class="legend-swatch" style="background:var(--series-1)"></span>首次试吃（上条）</span>
      <span class="legend-item"><span class="legend-swatch" style="background:var(--series-2)"></span>按顺序分配（下条）</span>
      <span class="legend-item muted">条长按同一口味两种口径的最大值等比</span>
    </div>
    <div class="compare-grid">
      <div>
        <h3 class="subhead">各口味净额：两种口径并排</h3>
        <div class="bar-chart">${rows}</div>
        <p class="empty-state">总净额 ${yuan(compare.totals.firstNet)}（首次）对 ${yuan(compare.totals.sequenceNet)}（顺序）；总量相同，差别只在口味之间的分配。</p>
      </div>
      <div>
        <h3 class="subhead">两种口径下换了口味的订单</h3>
        ${reassigned}
        <button class="table-toggle" type="button" id="compare-table-toggle" aria-expanded="true" aria-controls="compare-table">收起数据表</button>
        <div class="table-view" id="compare-table">
          <table class="data">
            <thead><tr><th>口味</th><th class="num">首次试吃</th><th class="num">按顺序分配</th><th class="num">差额</th></tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="rev-callout" style="margin-top:16px">
      <span aria-hidden="true">i</span>
      <div><strong>差额不是增量。</strong>两种口径用的是同一批订单和同一批样品，只是分配规则不同；它说明「换一种固定口径，口味排名会变」，不能说明哪种口味更受欢迎，更不能读成样品派发带来的复购增量。</div>
    </div>`;

  const toggle = document.getElementById('compare-table-toggle');
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    document.getElementById('compare-table').hidden = open;
    toggle.textContent = open ? '展开数据表' : '收起数据表';
  });

  bindTooltip(compareBody);
}

/* ---------------- detail panel ---------------- */
function renderDetail(detail) {
  detailPanel.hidden = false;
  const modeName = detail.mode === 'first' ? '首次试吃' : '按顺序分配';
  detailSub.textContent = `${modeName} · 窗口 ${detail.windowDays} 天 · 新报表截止 ${shortTime(detail.currentAsOf)}`;
  detailChip.className = 'chip neutral';
  detailChip.textContent = `${detail.rows.length} 笔已归因`;

  const rows = detail.rows.map((r) => {
    const flags = [];
    if (r.isRepeat) flags.push('复购');
    if (r.refundId) flags.push('已退');
    if (!r.sameFlavor) flags.push('跨口味');
    return `
      <tr class="${r.refundId ? 'is-flagged' : ''}">
        <td><code>${escapeHtml(r.orderId)}</code></td>
        <td class="person">${escapeHtml(r.person)}</td>
        <td>${escapeHtml(r.purchaseFlavor)}</td>
        <td>${escapeHtml(r.attributedFlavor)}${r.sameFlavor ? '' : ' <span class="muted">跨口味</span>'}</td>
        <td><code>${escapeHtml(r.sampleId)}</code> <span class="muted">${shortTime(r.sampleAt)}</span></td>
        <td>${dayOf(r.windowStart)} → ${shortTime(r.occurredAt)}</td>
        <td class="num">${yuan(r.amount)}</td>
        <td class="num">${r.refundedAmount > 0 ? `−${yuan(r.refundedAmount)}` : '—'}</td>
        <td class="num">${yuan(r.net)}</td>
        <td>${flags.length ? flags.join(' · ') : '<span class="muted">首购</span>'}</td>
      </tr>`;
  }).join('');

  const refundRows = detail.refunds.length === 0
    ? '<p class="empty-state">本版没有已入账的退单。</p>'
    : `
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>退单</th><th>原订单</th><th>人</th><th>归因口味</th><th class="num">冲减</th><th>业务时间</th><th>录入时间</th><th>说明</th></tr></thead>
          <tbody>
            ${detail.refunds.map((r) => `
              <tr>
                <td><code>${escapeHtml(r.refundId)}</code></td>
                <td><code>${escapeHtml(r.orderId)}</code></td>
                <td>${escapeHtml(r.person)}</td>
                <td>${escapeHtml(r.attributedFlavor)}</td>
                <td class="num">−${yuan(r.refundedAmount)}</td>
                <td>${shortTime(r.occurredAt)}</td>
                <td>${shortTime(r.recordedAt)}${r.recordedLate ? ' <span class="muted">迟到</span>' : ''}</td>
                <td class="muted">${escapeHtml(r.reason)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

  const unattributedRows = detail.unattributed.length === 0
    ? '<p class="empty-state">没有未归因的购买。</p>'
    : `
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>订单</th><th>人</th><th>购买口味</th><th class="num">金额</th><th class="num">净额</th><th>窗口起点</th><th>原因</th></tr></thead>
          <tbody>
            ${detail.unattributed.map((u) => `
              <tr>
                <td><code>${escapeHtml(u.orderId)}</code></td>
                <td>${escapeHtml(u.person)}</td>
                <td>${escapeHtml(u.purchaseFlavor)}</td>
                <td class="num">${yuan(u.amount)}</td>
                <td class="num">${yuan(u.net)}</td>
                <td>${dayOf(u.windowStart)}</td>
                <td class="muted">${escapeHtml(u.reason)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

  detailBody.innerHTML = `
    <h3 class="subhead">已归因订单</h3>
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>订单</th><th>人</th><th>购买口味</th><th>归因口味</th><th>试吃来源</th><th>窗口</th>
            <th class="num">金额</th><th class="num">已退</th><th class="num">净额</th><th>标记</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <h3 class="subhead" style="margin-top:18px">已入账退单</h3>
    ${refundRows}
    <h3 class="subhead" style="margin-top:18px">未归因购买</h3>
    ${unattributedRows}
    <p class="empty-state" style="margin-top:12px">${escapeHtml(detail.disclaimer)}</p>`;
}

/* ---------------- evidence attributes ---------------- */
function publishEvidence(report) {
  const first = report.modes.first;
  const sequence = report.modes.sequence;
  const comparisonOrders = state.compare ? state.compare.totals.ambiguousOrders : '';

  resultsEl.dataset.evidenceState = state.compare && state.detail ? 'compared+detail'
    : state.compare ? 'compared'
      : state.detail ? 'detail'
        : 'loaded';
  resultsEl.dataset.evidencePublishedAt = report.publishedAt;
  resultsEl.dataset.evidenceCurrentAsOf = report.currentAsOf;
  resultsEl.dataset.evidenceSubmittedRefunds = String(report.session.lateRefundsSubmitted);
  resultsEl.dataset.evidenceNetFirst = String(first.current.totals.net);
  resultsEl.dataset.evidenceNetSequence = String(sequence.current.totals.net);
  resultsEl.dataset.evidenceNetFirstPublished = String(first.published.totals.net);
  resultsEl.dataset.evidenceNetSequencePublished = String(sequence.published.totals.net);
  resultsEl.dataset.evidenceRevisionNetFirst = String(first.revision ? first.revision.netDelta : 0);
  resultsEl.dataset.evidenceRevisionNetSequence = String(sequence.revision ? sequence.revision.netDelta : 0);
  resultsEl.dataset.evidenceAttributedFirst = String(first.current.totals.attributed);
  resultsEl.dataset.evidenceAttributedSequence = String(sequence.current.totals.attributed);
  resultsEl.dataset.evidenceUnattributedFirst = String(first.current.totals.unattributed);
  resultsEl.dataset.evidenceUnattributedSequence = String(sequence.current.totals.unattributed);
  resultsEl.dataset.evidenceRejectedRefunds = String(first.rejectedRefunds.length);
  resultsEl.dataset.evidenceDedupe = String(report.dedupe.length);
  resultsEl.dataset.evidenceComparisonOrders = String(comparisonOrders);
  resultsEl.dataset.evidenceDetailMode = state.detail ? state.detail.mode : '';
  resultsEl.dataset.evidenceRefundButton = report.session.lateRefundsRemaining > 0 ? 'available' : 'exhausted';
}

/* ---------------- render root ---------------- */
function renderAll() {
  const report = state.report;
  if (!report) return;
  renderKpis(report);
  renderRevision(report);
  renderAnomalies(report);
  if (state.compare) renderComparison(state.compare);
  if (state.detail) renderDetail(state.detail);
  publishEvidence(report);

  btnRefund.disabled = report.session.lateRefundsRemaining === 0;
  btnRefund.textContent = report.session.lateRefundsRemaining === 0
    ? '演示退单已补完'
    : `补交一张退单（剩 ${report.session.lateRefundsRemaining}）`;

  document.querySelectorAll('.mode-tab').forEach((tab) => {
    const active = tab.dataset.mode === state.mode;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
}

async function loadReport() {
  const report = await getJson('/api/report');
  state.report = report;
  renderAll();
  return report;
}

function failed(error) {
  setStatus(error.message, 'error');
  if (state.report) renderAll();
}

/* ---------------- events ---------------- */
btnCompare.addEventListener('click', async () => {
  busy(btnCompare, true);
  setStatus('正在按两种口径重算同一批订单…');
  try {
    const comparison = await postJson('/api/comparison');
    state.compare = comparison;
    renderComparison(comparison);
    publishEvidence(state.report);
    setStatus(`比较完成：${comparison.totals.ambiguousOrders} 笔订单在两种口径下归属不同（只是关联，不是因果）。`, 'good');
  } catch (error) {
    failed(error);
  } finally {
    busy(btnCompare, false);
  }
});

btnRefund.addEventListener('click', async () => {
  busy(btnRefund, true);
  setStatus('正在补交下一张迟到退单…');
  try {
    const result = await postJson('/api/refunds');
    await loadReport();
    if (state.compare) {
      state.compare = await postJson('/api/comparison');
      renderComparison(state.compare);
    }
    if (state.detail) {
      state.detail = await getJson(`/api/detail?mode=${state.detail.mode}`);
      renderDetail(state.detail);
    }
    publishEvidence(state.report);
    const { submitted } = result;
    setStatus(
      `已补交 ${submitted.refundId}：冲减 ${submitted.person} 的订单 ${submitted.orderId}（业务 ${dayOf(submitted.occurredAt)}，录入 ${dayOf(submitted.recordedAt)}，迟到 ${submitted.lateByDays} 天）。旧报表不变，新报表已逐笔列出。`,
      'good',
    );
  } catch (error) {
    failed(error);
  } finally {
    renderAll();
    busy(btnRefund, false);
  }
});

btnDetail.addEventListener('click', async () => {
  busy(btnDetail, true);
  setStatus('正在读取归因明细…');
  try {
    const detail = await getJson(`/api/detail?mode=${state.mode}`);
    state.detail = detail;
    renderDetail(detail);
    publishEvidence(state.report);
    detailPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setStatus(`已载入 ${detail.rows.length} 笔归因明细（${state.mode === 'first' ? '首次试吃' : '按顺序分配'}）。`, 'good');
  } catch (error) {
    failed(error);
  } finally {
    busy(btnDetail, false);
  }
});

document.querySelectorAll('.mode-tab').forEach((tab) => {
  tab.addEventListener('click', async () => {
    if (tab.dataset.mode === state.mode) return;
    state.mode = tab.dataset.mode;
    renderAll();
    setStatus(`已切换到「${state.mode === 'first' ? '首次试吃' : '按顺序分配'}」口径。`);
    if (state.detail) {
      state.detail = await getJson(`/api/detail?mode=${state.mode}`).catch(() => state.detail);
      if (state.detail) renderDetail(state.detail);
      publishEvidence(state.report);
    }
  });
});

document.getElementById('theme-toggle').addEventListener('click', (event) => {
  const root = document.documentElement;
  const isDark = root.getAttribute('data-theme') === 'dark'
    || (!root.hasAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.setAttribute('data-theme', isDark ? 'light' : 'dark');
  event.currentTarget.setAttribute('aria-pressed', String(!isDark));
  event.currentTarget.textContent = isDark ? '深色' : '浅色';
});

loadReport()
  .then(() => setStatus('报表就绪。可以生成比较、补交退单，或查看逐笔归因。'))
  .catch((error) => {
    resultsEl.dataset.evidenceState = 'error';
    setStatus(`载入失败：${error.message}`, 'error');
  });
