/* tools/test-weak-spots.js
 * 定积分引擎 v2.12 薄弱点定向压力测试与诊断套件（7 大类，共 58 项）
 *
 * 特性：
 *   1. 使用 65 位 Decimal 独立计算闭式/级数真值（不依赖被测积分器，含 Γ 函数自检）
 *   2. 使用常驻 Worker 线程逐题执行并强制单题超时上限（默认 5000ms），
 *      超时即 terminate() 并标记为 [HANG]，既防整套测试卡死，又能直接暴露
 *      会让真实浏览器标签冻结的递归/精度失控缺陷。
 *   3. 支持按组过滤：node tools/test-weak-spots.js --group=W1,W3 --timeout=5000
 *
 * 运行：node tools/test-weak-spots.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Worker, isMainThread, parentPort } = require('worker_threads');

const ROOT = path.resolve(__dirname, '..');

/* ======================== Worker 侧：执行单题积分/符号测试 ======================== */
if (!isMainThread) {
  const D = require(path.join(ROOT, 'assets', 'decimal.js'));
  globalThis.Decimal = D;
  require(path.join(ROOT, 'integral-hp.js'));
  const C = require(path.join(ROOT, 'integral-core.js'));

  let Sym = null;
  function getSymbolic() {
    if (Sym) return Sym;
    const inlineSrc = fs.readFileSync(path.join(ROOT, 'assets', 'nerdamer-inline.js'), 'utf8');
    const tmpCtx = { self: null, window: null, globalThis: null };
    tmpCtx.self = tmpCtx.window = tmpCtx.globalThis = tmpCtx;
    vm.runInNewContext(inlineSrc, tmpCtx);
    const nerdCtx = { self: null, window: null, globalThis: null };
    nerdCtx.self = nerdCtx.window = nerdCtx.globalThis = nerdCtx;
    vm.runInNewContext(tmpCtx.__NERDAMER_SRC__, nerdCtx);
    globalThis.nerdamer = nerdCtx.nerdamer;
    require(path.join(ROOT, 'integral-symbolic.js'));
    Sym = globalThis.IntegralSymbolic;
    return Sym;
  }

  parentPort.on('message', (msg) => {
    const t0 = Date.now();
    try {
      if (msg.mode === 'numeric') {
        const r = C.integrate(C.compile(msg.expr), msg.a, msg.b);
        const dt = Date.now() - t0;
        parentPort.postMessage({
          id: msg.id,
          ok: true,
          dt,
          result: {
            verdict: r.verdict,
            value: r.value,
            valueText: r.valueText || null,
            sigma: r.sigma,
            digits: r.digits,
            method: r.method,
            evals: r.evals,
            notes: r.notes || []
          }
        });
      } else if (msg.mode === 'symbolic') {
        const numRes = C.integrate(C.compile(msg.expr), msg.a, msg.b);
        const sym = getSymbolic().solve(msg.expr, msg.a, msg.b, numRes.value);
        const dt = Date.now() - t0;
        parentPort.postMessage({
          id: msg.id,
          ok: true,
          dt,
          num: {
            verdict: numRes.verdict,
            value: numRes.value,
            valueText: numRes.valueText || null,
            method: numRes.method
          },
          sym: sym ? {
            exact: sym.exact,
            exactIsNumeric: sym.exactIsNumeric,
            value: sym.value,
            antiderivative: sym.antiderivative
          } : null
        });
      }
    } catch (e) {
      parentPort.postMessage({
        id: msg.id,
        ok: false,
        dt: Date.now() - t0,
        error: String(e && e.message || e)
      });
    }
  });
  return;
}

/* ======================== 主线程：独立真值与调度 ======================== */
const D = require(path.join(ROOT, 'assets', 'decimal.js'));
D.set({ precision: 65 });
const PI = D.acos(-1);
const E = new D(1).exp();
const LN2 = new D(2).ln();
const EULER_GAMMA = new D('0.577215664901532860606512090082402431042159335939923598805767');

function computeBernoulliEven(maxK) {
  const N = 2 * maxK;
  const A = [];
  const B = [];
  for (let m = 0; m <= N; m++) {
    A[m] = new D(1).div(m + 1);
    for (let j = m; j >= 1; j--) {
      A[j - 1] = new D(j).mul(A[j - 1].minus(A[j]));
    }
    B[m] = A[0];
  }
  const out = [];
  for (let k = 1; k <= maxK; k++) out.push(B[2 * k]);
  return out;
}
const BERNOULLI_EVEN = computeBernoulliEven(18);

function decGamma(zDec) {
  const N = 50;
  let shiftProd = new D(1);
  for (let j = 0; j < N; j++) shiftProd = shiftProd.mul(zDec.plus(j));
  const w = zDec.plus(N);
  let lnG = w.minus('0.5').mul(w.ln()).minus(w).plus(PI.mul(2).ln().div(2));
  const invW2 = new D(1).div(w.mul(w));
  let invPow = new D(1).div(w);
  for (let k = 1; k <= BERNOULLI_EVEN.length; k++) {
    const term = BERNOULLI_EVEN[k - 1].mul(invPow).div((2 * k) * (2 * k - 1));
    lnG = lnG.plus(term);
    invPow = invPow.mul(invW2);
  }
  return lnG.exp().div(shiftProd);
}

(function selfCheckGamma() {
  const err = decGamma(new D('0.5')).minus(PI.sqrt()).abs();
  if (err.gt('1e-50')) throw new Error('decGamma self-check failed: ' + err.toString());
})();

function decCi(zDec) {
  let sum = EULER_GAMMA.plus(zDec.ln());
  let term = new D(1), z2 = zDec.mul(zDec);
  for (let k = 1; k <= 45; k++) {
    term = term.mul(z2).neg().div((2 * k - 1) * (2 * k));
    const add = term.div(2 * k);
    sum = sum.plus(add);
    if (add.abs().lt('1e-60')) break;
  }
  return sum;
}

function decExpMinus1MinusXOverX2() {
  let sum = new D(0), fact = new D(1);
  for (let n = 2; n <= 55; n++) {
    fact = fact.mul(n);
    const term = new D(1).div(fact.mul(n - 1));
    sum = sum.plus(term);
    if (term.lt('1e-60')) break;
  }
  return sum;
}

/* 解析 CLI 参数 */
let filterGroups = null;
let HARD_TIMEOUT_MS = 5000;
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--group=')) {
    filterGroups = new Set(arg.slice(8).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
  } else if (arg.startsWith('--timeout=')) {
    const v = Number(arg.slice(10));
    if (v >= 500) HARD_TIMEOUT_MS = v;
  }
}

/* 常驻 Worker 管理器 */
let activeWorker = null;
let msgSeq = 0;

function getWorker() {
  if (!activeWorker) activeWorker = new Worker(__filename);
  return activeWorker;
}

async function killWorker() {
  if (!activeWorker) return;
  const w = activeWorker;
  activeWorker = null;
  try { await w.terminate(); } catch {}
}

function runInWorker(payload, timeoutMs) {
  return new Promise((resolve) => {
    const w = getWorker();
    const id = ++msgSeq;
    let done = false;

    const cleanup = () => {
      w.off('message', onMsg);
      w.off('error', onErr);
      clearTimeout(timer);
    };

    const onMsg = (m) => {
      if (!m || m.id !== id || done) return;
      done = true;
      cleanup();
      resolve(m);
    };

    const onErr = (err) => {
      if (done) return;
      done = true;
      cleanup();
      killWorker().then(() => resolve({ id, ok: false, dt: timeoutMs, error: String(err && err.message || err) }));
    };

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      killWorker().then(() => resolve({ id, ok: false, timedOut: true, dt: timeoutMs }));
    }, timeoutMs);

    w.on('message', onMsg);
    w.on('error', onErr);
    w.postMessage(Object.assign({ id }, payload));
  });
}

/* ---------- 构造 7 大类共 58 道定向弱点用例 ---------- */
const beta01 = decGamma(new D('0.1')).pow(2).div(decGamma(new D('0.2')));

const GROUPS = [
  {
    id: 'W1',
    title: 'W1. 强端点奇点与非零端点奇点（p ∈ (-1, -0.85]、非零端点、双端强奇点）',
    cases: [
      { kind: 'conv', label: 'x^(-0.9) [0,1]', expr: 'x^(-0.9)', a: '0', b: '1', truth: new D(10), minDigits: 24 },
      { kind: 'conv', label: '(1-x)^(-0.9) [0,1]', expr: '(1-x)^(-0.9)', a: '0', b: '1', truth: new D(10), minDigits: 24 },
      { kind: 'conv', label: 'x^(-0.95) [0,1]', expr: 'x^(-0.95)', a: '0', b: '1', truth: new D(20), minDigits: 20 },
      { kind: 'conv', label: '(1-x)^(-0.95) [0,1]', expr: '(1-x)^(-0.95)', a: '0', b: '1', truth: new D(20), minDigits: 20 },
      { kind: 'conv', label: '(x-1)^(-0.9) [1,2]', expr: '(x-1)^(-0.9)', a: '1', b: '2', truth: new D(10), minDigits: 20 },
      { kind: 'conv', label: '双端强奇点 x^(-0.9)(1-x)^(-0.9)', expr: 'x^(-0.9)*(1-x)^(-0.9)', a: '0', b: '1', truth: beta01, minDigits: 20 },
      { kind: 'conv', label: '非零端点对数奇点 ln(x-1) [1,2]', expr: 'ln(x-1)', a: '1', b: '2', truth: new D(-1), minDigits: 24 },
      { kind: 'conv', label: '非零端点平方根 1/√(x-1) [1,5]', expr: '1/sqrt(x-1)', a: '1', b: '5', truth: new D(4), minDigits: 24 },
    ]
  },
  {
    id: 'W2',
    title: 'W2. 极窄尖峰、无穷远端局域峰与严重相消',
    cases: [
      { kind: 'conv', label: '半无穷远端峰 exp(-(x-50)²) [0,∞)', expr: 'exp(-(x-50)^2)', a: '0', b: 'inf', truth: PI.sqrt(), minDigits: 20 },
      { kind: 'conv', label: '双无穷远端峰 exp(-(x-50)²) (-∞,∞)', expr: 'exp(-(x-50)^2)', a: '-inf', b: 'inf', truth: PI.sqrt(), minDigits: 20 },
      { kind: 'conv', label: '窄洛伦兹峰 1/(1e-8+(x-0.37)²) [0,1]', expr: '1/(1e-8+(x-0.37)^2)', a: '0', b: '1', truth: new D(1e4).mul(new D(6300).atan().plus(new D(3700).atan())), minDigits: 14 },
      { kind: 'conv', label: '极窄高斯峰 exp(-1e6(x-0.3)²) [0,1]', expr: 'exp(-1e6*(x-0.3)^2)', a: '0', b: '1', truth: PI.sqrt().div(1000), minDigits: 14 },
      { kind: 'conv', label: '极端相消 x+1e-7·x² [-1,1]', expr: 'x+1e-7*x^2', a: '-1', b: '1', truth: new D('2e-7').div(3), minDigits: 18 },
      { kind: 'conv', label: '0/0高阶相消 (e^x-1-x)/x² [0,1]', expr: '(exp(x)-1-x)/x^2', a: '0', b: '1', truth: decExpMinus1MinusXOverX2(), minDigits: 24 },
    ]
  },
  {
    id: 'W3',
    title: 'W3. 内部奇点/折点/阶跃盲区与隐蔽极点',
    cases: [
      { kind: 'conv', label: '无理内部奇点 1/√|x²-2| [0,2]', expr: '1/sqrt(abs(x^2-2))', a: '0', b: '2', truth: PI.div(2).plus(new D(2).sqrt().plus(1).ln()), minDigits: 20 },
      { kind: 'conv', label: '隐式折点 sqrt((x-1)²) [0,2]', expr: 'sqrt((x-1)^2)', a: '0', b: '2', truth: new D(1), minDigits: 20 },
      { kind: 'conv', label: '隐式多折点 sqrt(1-cos(2x)) [0,2π]', expr: 'sqrt(1-cos(2*x))', a: '0', b: '2*pi', truth: new D(2).sqrt().mul(4), minDigits: 20 },
      { kind: 'conv', label: '阶跃函数 floor(x) [0,3]', expr: 'floor(x)', a: '0', b: '3', truth: new D(3), minDigits: 14 },
      { kind: 'conv', label: '非对齐阶跃 sign(x-0.37) [0,1]', expr: 'sign(x-0.37)', a: '0', b: '1', truth: new D('0.26'), minDigits: 14 },
      { kind: 'conv', label: '锯齿波 x-floor(x) [0,4]', expr: 'x-floor(x)', a: '0', b: '4', truth: new D(2), minDigits: 14 },
      { kind: 'conv', label: '超16折点 |sin(20x)| [0,π]', expr: 'abs(sin(20*x))', a: '0', b: 'pi', truth: new D(2), minDigits: 12 },
      { kind: 'conv', label: '内部奇点 1/cbrt(x-1)² [0,2]', expr: '1/cbrt(x-1)^2', a: '0', b: '2', truth: new D(6), minDigits: 20 },
      { kind: 'div', label: '无理内部极点 1/(x-1/√2) [0,1]', expr: '1/(x-1/sqrt(2))', a: '0', b: '1', allowed: ['divergent'] },
      { kind: 'div', label: '无理内部极点 1/(x²-2) [0,2]', expr: '1/(x^2-2)', a: '0', b: '2', allowed: ['divergent'] },
      { kind: 'div', label: '半无穷远端极点 1/(x-100)² [0,∞)', expr: '1/(x-100)^2', a: '0', b: 'inf', allowed: ['divergent'] },
      { kind: 'div', label: '贴近双极点 1/(x²-0.0001) [-1,1]', expr: '1/(x^2-0.0001)', a: '-1', b: '1', allowed: ['divergent'] },
    ]
  },
  {
    id: 'W4',
    title: 'W4. 振荡积分盲区（相位偏移/双无穷/正项/双端/有限高频/发散陷阱）',
    cases: [
      { kind: 'conv', label: '相位偏移 chirp sin(x²+1) [0,∞)', expr: 'sin(x^2+1)', a: '0', b: 'inf', truth: PI.div(8).sqrt().mul(new D(1).cos().plus(new D(1).sin())), minDigits: 20 },
      { kind: 'conv', label: '双无穷 sinc sin(x)/x (-∞,∞)', expr: 'sin(x)/x', a: '-inf', b: 'inf', truth: PI, minDigits: 24 },
      { kind: 'conv', label: '双无穷通用 cos(x)/(1+x²) (-∞,∞)', expr: 'cos(x)/(1+x^2)', a: '-inf', b: 'inf', truth: PI.div(E), minDigits: 20 },
      { kind: 'conv', label: '双无穷正项 sin²(x)/x² (-∞,∞)', expr: 'sin(x)^2/x^2', a: '-inf', b: 'inf', truth: PI, minDigits: 18 },
      { kind: 'conv', label: '正项非幂包络 sin²(x)/(1+x²) [0,∞)', expr: 'sin(x)^2/(1+x^2)', a: '0', b: 'inf', truth: PI.div(4).mul(new D(1).minus(new D(-2).exp())), minDigits: 18 },
      { kind: 'conv', label: '高次正项 Borwein sin⁴x/x⁴ [0,∞)', expr: 'sin(x)^4/x^4', a: '0', b: 'inf', truth: PI.div(3), minDigits: 18 },
      { kind: 'conv', label: '极慢交替 sin(x)/x^0.2 [0,∞)', expr: 'sin(x)/x^0.2', a: '0', b: 'inf', truth: decGamma(new D('0.8')).mul(PI.mul(2).div(5).sin()), minDigits: 18 },
      { kind: 'conv', label: '弱指数阻尼 e^(-0.01x)sin(x) [0,∞)', expr: 'exp(-0.01*x)*sin(x)', a: '0', b: 'inf', truth: new D(10000).div(10001), minDigits: 16 },
      { kind: 'conv', label: '双端振荡奇点 sin(1/x)+sin(1/(1-x))', expr: 'sin(1/x)+sin(1/(1-x))', a: '0', b: '1', truth: new D(1).sin().minus(decCi(new D(1))).mul(2), minDigits: 18 },
      { kind: 'conv', label: '有限超高频 sin(1000x) [0,1]', expr: 'sin(1000*x)', a: '0', b: '1', truth: new D(1).minus(new D(1000).cos()).div(1000), minDigits: 10 },
      { kind: 'conv', label: '有限区间 chirp 2x·sin(x²) [0,30]', expr: '2*x*sin(x^2)', a: '0', b: '30', truth: new D(1).minus(new D(900).cos()), minDigits: 10 },
      { kind: 'div', label: '振荡发散陷阱 x·sin(x²) [0,∞)', expr: 'x*sin(x^2)', a: '0', b: 'inf', allowed: ['divergent', 'oscillatory'] },
      { kind: 'div', label: '增长振荡 √x·sin(x) [0,∞)', expr: 'sqrt(x)*sin(x)', a: '0', b: 'inf', allowed: ['divergent', 'oscillatory'] },
      { kind: 'div', label: '有限端振荡发散 sin(1/x)/x² [0,1]', expr: 'sin(1/x)/x^2', a: '0', b: '1', allowed: ['divergent', 'oscillatory'] },
      { kind: 'div', label: '正项对数发散 sin²(x)/(x ln x) [2,∞)', expr: 'sin(x)^2/(x*ln(x))', a: '2', b: 'inf', allowed: ['divergent'] },
    ]
  },
  {
    id: 'W5',
    title: 'W5. 临界收敛与临界发散边界（近 -1 幂次与迭代对数）',
    cases: [
      { kind: 'conv', label: '近临界收敛 1/x^1.02 [1,∞)', expr: '1/x^1.02', a: '1', b: 'inf', truth: new D(50), minDigits: 12 },
      { kind: 'conv', label: '对数收敛 1/(x ln^1.5 x) [2,∞)', expr: '1/(x*ln(x)^1.5)', a: '2', b: 'inf', truth: new D(2).div(LN2.sqrt()), minDigits: 7 },
      { kind: 'conv', label: '有限端对数收敛 1/(x ln²(1/x)) [0,0.5]', expr: '1/(x*ln(1/x)^2)', a: '0', b: '0.5', truth: new D(1).div(LN2), minDigits: 12 },
      { kind: 'conv', label: '迭代对数收敛 1/(x ln x (ln ln x)²) [3,∞)', expr: '1/(x*ln(x)*ln(ln(x))^2)', a: '3', b: 'inf', truth: new D(1).div(new D(3).ln().ln()), minDigits: 6 },
      { kind: 'div', label: '近临界发散 1/x^0.99 [1,∞)', expr: '1/x^0.99', a: '1', b: 'inf', allowed: ['divergent'] },
      { kind: 'div', label: '有限端近临界发散 1/x^1.01 [0,1]', expr: '1/x^1.01', a: '0', b: '1', allowed: ['divergent'] },
      { kind: 'div', label: '迭代对数发散 1/(x ln x ln ln x) [3,∞)', expr: '1/(x*ln(x)*ln(ln(x)))', a: '3', b: 'inf', allowed: ['divergent'] },
      { kind: 'div', label: '非零端点对数发散 1/((x-1)ln(1/(x-1)))', expr: '1/((x-1)*ln(1/(x-1)))', a: '1', b: '1.5', allowed: ['divergent'] },
    ]
  },
  {
    id: 'W6',
    title: 'W6. 定义域缺失、复数域与半区间无定义守卫',
    cases: [
      { kind: 'div', label: '全域无定义 sqrt(-x²-1) [0,1]', expr: 'sqrt(-x^2-1)', a: '0', b: '1', allowed: ['divergent', 'uncertain'] },
      { kind: 'div', label: '全域无定义 ln(-x) [1,2]', expr: 'ln(-x)', a: '1', b: '2', allowed: ['divergent', 'uncertain'] },
      { kind: 'div', label: '半区间无定义 sqrt(x-0.5) [0,1]', expr: 'sqrt(x-0.5)', a: '0', b: '1', allowed: ['divergent', 'uncertain'] },
      { kind: 'div', label: '半区间无定义+奇点 1/√(x-0.5) [0,1]', expr: '1/sqrt(x-0.5)', a: '0', b: '1', allowed: ['divergent', 'uncertain'] },
      { kind: 'div', label: '半周期无定义 ln(sin x) [0,2π]', expr: 'ln(sin(x))', a: '0', b: '2*pi', allowed: ['divergent', 'uncertain'] },
    ]
  },
  {
    id: 'W7',
    title: 'W7. 符号层分支切割陷阱、反向区间与 Unicode 语法一致性',
    cases: [
      { kind: 'sym-weier', label: 'Weierstrass 分支跳跃 1/(2+cos x) [0,2π]', expr: '1/(2+cos(x))', a: '0', b: '2*pi', truth: PI.mul(2).div(new D(3).sqrt()) },
      { kind: 'sym-weier', label: 'Weierstrass 分支跳跃 1/(5+3cos x) [0,2π]', expr: '1/(5+3*cos(x))', a: '0', b: '2*pi', truth: PI.div(2) },
      { kind: 'sym-weier', label: '周期分支跳跃 1/(1+sin²x) [0,π]', expr: '1/(1+sin(x)^2)', a: '0', b: 'pi', truth: PI.div(new D(2).sqrt()) },
      { kind: 'sym-expect', label: '符号层反向区间 x² [1,0]', expr: 'x^2', a: '1', b: '0', truth: new D(-1).div(3), defectHint: 'Symbolic 拒绝反向积分区间 a > b（返回 null）' },
      { kind: 'sym-expect', label: '符号层 Unicode 上标 x² [0,1]', expr: 'x²', a: '0', b: '1', truth: new D(1).div(3), defectHint: 'Symbolic toEngine 未规范化 Unicode ²/³' },
      { kind: 'sym-expect', label: '符号层 Unicode 常数 2πx [0,1]', expr: '2πx', a: '0', b: '1', truth: PI, defectHint: 'Symbolic toEngine 未规范化 Unicode π 或隐式乘法' },
    ]
  }
];

async function main() {
  const groupStats = Object.create(null);
  const allFindings = [];

  function record(group, label, pass, summary, defect) {
    if (!groupStats[group]) groupStats[group] = { pass: 0, fail: 0 };
    if (pass) groupStats[group].pass++;
    else {
      groupStats[group].fail++;
      allFindings.push({ group, label, defect });
    }
    console.log(`[${pass ? 'PASS' : 'WEAK'}] ${label.padEnd(40)} ${summary}`);
  }

  for (const grp of GROUPS) {
    if (filterGroups && !filterGroups.has(grp.id)) continue;
    console.log(`\n=== ${grp.title} ===\n`);

    for (const tc of grp.cases) {
      const mode = tc.kind.startsWith('sym-') ? 'symbolic' : 'numeric';
      const resp = await runInWorker({ mode, expr: tc.expr, a: tc.a, b: tc.b }, HARD_TIMEOUT_MS);

      if (resp.timedOut) {
        record(grp.id, tc.label, false, `HANG > ${HARD_TIMEOUT_MS}ms (已强制终止 Worker)`, `卡死超时 > ${HARD_TIMEOUT_MS}ms（主线程会冻结）`);
        continue;
      }
      if (!resp.ok) {
        record(grp.id, tc.label, false, `THROW (${resp.dt}ms): ${resp.error}`, `抛出异常: ${resp.error}`);
        continue;
      }

      if (tc.kind === 'conv') {
        const r = resp.result;
        D.set({ precision: 65 });
        const gotDec = r.valueText ? new D(r.valueText) : new D(r.value);
        const absErrDec = gotDec.minus(tc.truth).abs();
        const absErr = absErrDec.toNumber();
        const scaleDec = tc.truth.isZero() ? new D(1) : tc.truth.abs();
        const relErr = absErrDec.div(scaleDec).toNumber();
        const actualDig = relErr === 0 ? 40 : Math.max(0, -Math.log10(relErr));
        const sigCover = isFinite(r.sigma) && absErr <= Math.max(r.sigma * 1.05, 1e-25 * scaleDec.toNumber());
        const limitMs = tc.maxMs || 2500;
        const timeOk = resp.dt <= limitMs;
        const ok = r.verdict === 'ok' && actualDig >= tc.minDigits && sigCover && timeOk;

        const reasons = [];
        if (r.verdict !== 'ok') reasons.push(`verdict=${r.verdict}`);
        if (actualDig < tc.minDigits) reasons.push(`真值仅 ${actualDig.toFixed(1)} 位(要求 ${tc.minDigits})`);
        if (!sigCover) reasons.push(`σ 未覆盖真实误差(err=${absErr.toExponential(2)}, σ=${r.sigma.toExponential(2)})`);
        if (!timeOk) reasons.push(`耗时 ${resp.dt}ms > ${limitMs}ms`);

        const summary =
          `判定=${r.verdict.padEnd(10)} 真值=${actualDig.toFixed(1).padStart(4)}/${String(tc.minDigits).padEnd(2)} ` +
          `自报=${(r.digits || 0).toFixed(1).padStart(4)} σ覆盖=${sigCover ? 'y' : 'N'} ${String(resp.dt + 'ms').padStart(6)}  ${r.method}`;
        record(grp.id, tc.label, ok, summary, reasons.join('; '));
      } else if (tc.kind === 'div') {
        const r = resp.result;
        const limitMs = tc.maxMs || 2500;
        const ok = tc.allowed.includes(r.verdict) && resp.dt <= limitMs;
        const reasons = [];
        if (!tc.allowed.includes(r.verdict)) {
          reasons.push(`期望 ${tc.allowed.join('/')}，实得 ${r.verdict} (val=${r.valueText || r.value}, 自报=${(r.digits || 0).toFixed(1)}位)`);
        }
        if (resp.dt > limitMs) reasons.push(`耗时 ${resp.dt}ms > ${limitMs}ms`);
        const summary = `判定=${r.verdict.padEnd(11)} val=${String(r.valueText || r.value).slice(0, 14).padEnd(14)} ${String(resp.dt + 'ms').padStart(6)}  ${r.method}`;
        record(grp.id, tc.label, ok, summary, reasons.join('; '));
      } else if (tc.kind === 'sym-weier') {
        const num = resp.num, sym = resp.sym;
        const truthNum = tc.truth.toNumber();
        const numErr = Math.abs(num.value - truthNum) / Math.max(1, Math.abs(truthNum));
        const symWrong = sym && sym.value !== null && Math.abs(sym.value - truthNum) > 1e-6;
        const ok = !symWrong && num.verdict === 'ok' && numErr < 1e-12;
        const summary = `sym=${sym ? (sym.exact || 'val=' + sym.value) : 'null(已拦)'}  numErr=${numErr.toExponential(2)} ${resp.dt}ms (${num.method})`;
        const defect = symWrong ? `符号层给出了错误的分支切割值 ${sym.value}` : `数值层偏差 ${numErr.toExponential(2)}`;
        record(grp.id, tc.label, ok, summary, defect);
      } else if (tc.kind === 'sym-expect') {
        const sym = resp.sym;
        const truthNum = tc.truth.toNumber();
        const ok = !!(sym && sym.exact && sym.value !== null && Math.abs(sym.value - truthNum) < 1e-10);
        const summary = `sym=${sym ? `${sym.exact} (val=${sym.value})` : 'null'}  ${resp.dt}ms`;
        record(grp.id, tc.label, ok, summary, tc.defectHint);
      }
    }
  }

  await killWorker();

  console.log('\n==================== 薄弱点定向测试汇总 ====================');
  let grandPass = 0, grandTotal = 0;
  for (const [g, st] of Object.entries(groupStats)) {
    const tot = st.pass + st.fail;
    grandPass += st.pass;
    grandTotal += tot;
    console.log(`  ${g}: ${String(st.pass).padStart(2)}/${String(tot).padEnd(2)} 通过  (${st.fail} 项暴露弱点)`);
  }
  console.log(`  总计: ${grandPass}/${grandTotal} 通过，共暴露 ${allFindings.length} 项薄弱点`);

  if (allFindings.length) {
    console.log('\n暴露的薄弱点明细：');
    allFindings.forEach((f, idx) => {
      console.log(`  ${String(idx + 1).padStart(2)}. [${f.group}] ${f.label} -> ${f.defect}`);
    });
  }
  process.exit(allFindings.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await killWorker();
  process.exit(2);
});
