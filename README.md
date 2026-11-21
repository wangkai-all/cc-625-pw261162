# 样品试吃归因台（本地演示）

样品派发、正式购买、退单分开记账；同一人可以先后试两种口味。分析端固定归因窗口和去重规则，
并排比较「首次试吃」和「按顺序分配」两种口径。迟到的退单不改写已发布报表，而是在新报表里
逐笔说明哪些复购回了头。（数据全部虚构。）

所有数字都只是**关联**：窗口、去重、口径都是人事先固定的，没有对照组，不能读成样品派发
带来的因果增量。页面上每处比较都带着这句话。

## 运行

```bash
node server.js            # 默认 8080
PORT=3000 node server.js  # 读 PORT
```

服务只绑定 `127.0.0.1`，打开终端里打印的地址即可。只用 Node.js 内置模块，无第三方依赖。

## 测试

```bash
node --test
```

覆盖正常结果与异常结果：窗口边界、严格先后、两种口径的重新分配、去重、退单整单冲减、
五种拒收退单、迟录退单的两版快照、补交退单后的逐笔回转、接口状态码与会话隔离。

## 三条规则

1. **固定窗口** — 订单前 30 天，起点按 UTC 自然日对齐，左闭右开；样品必须严格早于订单。
2. **去重** — 同人、同类型、同口味、同一 UTC 分钟的非退单事件只保留最早录入的一条。
   退单不按分钟合并，交给「一单最多冲一次」拒收重复退单。
3. **退单** — 只冲 `reference` 指向的那笔购买（整单退）；原单不存在、退单人与购买人
   或口味不一致、时间倒置，一律拒收并列出原因。

## 两种口径

| 口径 | 规则 | 读法 |
|---|---|---|
| 首次试吃 `first` | 窗口内最早一次在先试吃拿走到期订单的全部归因额 | 回答「先试的这个口味」 |
| 按顺序分配 `sequence` | 每次购买领取一个尚未用过的在先试吃，按派发顺序；窗口内用完后归给最近一次 | 回答「第 n 次试吃对应第 n 次购买」 |

同一批订单、同一批样品，两种口径的**总净额相同**，差别只在口味之间怎么分。
演示数据里有 2 笔订单在两种口径下换了归属。

## 退单迟到与报表版本

每条事件有 `occurredAt`（业务时间）和 `recordedAt`（录入时间），缺省相同。
「迟到」= 业务时间早于上一版报表截止、录入时间却晚于它。

- 旧报表（`published`）永远保留发布时的可见集合，不被改写；
- 新报表（`current`）按当前可见账本重算，`revision.deltas` 逐笔给出
  `旧净额 → 新净额`、差额、以及 `复购回转 / 首购回转 / 新入账 / 移出归因` 的分类。

演示页「补交一张退单」会依次补三张迟到退单（R10 → O02、R11 → O04、R12 → O08）。
补完后归因净额从 ¥974 降到 ¥590，旧报表列仍是 ¥974。

## 页面上的核对点

业务结果区是 `<main data-evidence-result …>`，操作结果同步写到 `data-evidence-*` 属性上，
可在 DevTools 或测试里直接比对操作前后：

| 属性 | 含义 |
|---|---|
| `data-evidence-state` | `loaded` / `compared` / `detail` / `compared+detail` / `error` |
| `data-evidence-submitted-refunds` | 已补交的退单张数 |
| `data-evidence-net-first` / `-net-sequence` | 两种口径的新报表归因净额 |
| `data-evidence-net-first-published` / `-net-sequence-published` | 旧报表净额（不变） |
| `data-evidence-revision-net-first` / `-net-sequence` | 新报表相对旧报表的逐笔差额 |
| `data-evidence-comparison-orders` | 两种口径下归属不同的订单数 |
| `data-evidence-detail-mode` | 当前明细所用口径 |
| `data-evidence-attributed-*` / `-unattributed-*` | 已归因 / 未归因订单数 |
| `data-evidence-rejected-refunds` / `-dedupe` | 拒收退单数 / 去重条数 |

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/report` | 两版快照（published / current）× 两种口径 + 会话状态 |
| POST | `/api/comparison` | 生成「首次试吃 vs 按顺序分配」比较 |
| POST | `/api/refunds` | 补交下一张迟到退单（201；补完返回 409 `NO_MORE_REFUNDS`） |
| GET | `/api/detail?mode=first\|sequence` | 逐笔归因、退单、拒收、未归因、去重 |

状态保存在进程内，重启即重置；不写磁盘。

## 文件

```
server.js              PORT 解析、只绑 127.0.0.1
lib/rules.js           常量、输入校验、去重、窗口起点
lib/attribution.js     两种口径、退单挂接、两版快照差额
lib/dataset.js         虚构账本与三张可补交的迟到退单
lib/report.js          会话状态与页面负载
lib/app.js             HTTP 路由、静态白名单
public/                index.html / styles.css / app.js
test/                  node:test 用例
```

## 演示数据里的异常（都能在页面上找到）

- S03D：同人同口味同分钟重复录入，被去重合并。
- R03：退单人是唐屿，原订单属于许知遥 —— 拒收。
- R04：`reference` 指向不存在的 O999 —— 拒收。
- O05：陈澈的样品在 30 天窗口外 —— 购买未归因，金额单列。
- 韩沐：只试吃、没购买 —— 计入派发，不产生归因。
- 罗青：全额退在旧报表里就已入账 —— 净额本来就是 0，不是回转。
