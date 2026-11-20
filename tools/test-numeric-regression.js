/* tools/test-numeric-regression.js
 * 定积分数值层 v2.12 全量回归测试（6 大类，覆盖全部历史题与本次修复边界）
 * 运行：node tools/test-numeric-regression.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'assets', 'decimal.js'));
globalThis.Decimal = D;
require(path.join(ROOT, 'integral-hp.js'));
const C = require(path.join(ROOT, 'integral-core.js'));

/* 独立加载 nerdamer + integral-symbolic.js 用于符号层内部奇点守卫测试 */
function loadSymbolic() {
  const inlineSrc = fs.readFileSync(path.join(ROOT, 'assets', 'nerdamer-inline.js'), 'utf8');
  const tmpCtx = { self: null, window: null, globalThis: null };
  tmpCtx.self = tmpCtx.window = tmpCtx.globalThis = tmpCtx;
  vm.runInNewContext(inlineSrc, tmpCtx);
  const nerdCtx = { self: null, window: null, globalThis: null };
  nerdCtx.self = nerdCtx.window = nerdCtx.globalThis = nerdCtx;
  vm.runInNewContext(tmpCtx.__NERDAMER_SRC__, nerdCtx);
  globalThis.nerdamer = nerdCtx.nerdamer;
  require(path.join(ROOT, 'integral-symbolic.js'));
  return globalThis.IntegralSymbolic;
}

/* ---------- 40+ 位 Decimal 独立真值常数与级数辅助 ---------- */
D.set({ precision: 60 });
const PI = D.acos(-1);
const E = new D(1).exp();
const LN2 = new D(2).ln();
const G_CATALAN = new D('0.91596559417721901505460351493238411077414937428167');
const EULER_GAMMA = new D('0.57721566490153286060651209008240243104215933593992');
const ZETA3 = new D('1.20205690315959428539973816151144999076498629234050');
const GAMMA_1_4 = new D('3.62560990822190831193068515586767200299516768288007');
const GAMMA_1_3 = new D('2.67893853470774763365569294097467764412868937795730');
const GAMMA_4_3 = GAMMA_1_3.div(3);

function decSi(zDec) {
  let term = zDec, sum = zDec, z2 = zDec.mul(zDec);
  for (let k = 1; k <= 40; k++) {
    term = term.mul(z2).neg().div((2 * k) * (2 * k + 1));
    const add = term.div(2 * k + 1);
    sum = sum.plus(add);
    if (add.abs().lt('1e-55')) break;
  }
  return sum;
}

function decCi(zDec) {
  let sum = EULER_GAMMA.plus(zDec.ln());
  let term = new D(1), z2 = zDec.mul(zDec);
  for (let k = 1; k <= 40; k++) {
    term = term.mul(z2).neg().div((2 * k - 1) * (2 * k));
    const add = term.div(2 * k);
    sum = sum.plus(add);
    if (add.abs().lt('1e-55')) break;
  }
  return sum;
}

function decSinPowInt0toA(aDec, p) {
  /* ∫₀^a sin(x^p) dx = Σ (-1)^k a^((2k+1)p+1) / ((2k+1)! ((2k+1)p+1)) */
  let sum = new D(0), fact = new D(1);
  for (let k = 0; k <= 35; k++) {
    if (k > 0) fact = fact.mul(2 * k).mul(2 * k + 1);
    const exp = (2 * k + 1) * p + 1;
    let term = aDec.pow(exp).div(fact.mul(exp));
    if (k % 2 === 1) term = term.neg();
    sum = sum.plus(term);
    if (term.abs().lt('1e-55')) break;
  }
  return sum;
}

/* 独立 50 位半周期面板 + CVZ 算 ∫₀^∞ sin(20x)/(1+x²) dx 作为参考真值 */
function decSinAxOver1PlusX2(aVal) {
  D.set({ precision: 60 });
  const HP = globalThis.IntegralHP;
  const f = C.compile('sin(' + aVal + '*x)/(1+x^2)');
  const zeros = [];
  for (let k = 1; k <= 52; k++) zeros.push((k * Math.PI) / aVal);
  const res = HP.integrateOscGeneral(f, '0', 'inf', zeros, { digits: 30 });
  return new D(res.valueText);
}

/* ---------- 断言辅助 ---------- */
let totalPass = 0, totalFail = 0;
const failures = [];

function checkValueCase(group, label, expr, a, b, truthDec, minDigits, maxMs) {
  const limitMs = maxMs || 2500;
  const t0 = Date.now();
  let r;
  try {
    r = C.integrate(C.compile(expr), a, b);
  } catch (e) {
    totalFail++;
    failures.push(`[${group}] ${label}: THROW ${e.message}`);
    console.log(`[FAIL] ${label.padEnd(36)} THROW: ${e.message}`);
    return;
  }
  const dt = Date.now() - t0;
  D.set({ precision: 60 });
  const truthNum = truthDec.toNumber();
  const gotDec = r.valueText ? new D(r.valueText) : new D(r.value);
  const absErrDec = gotDec.minus(truthDec).abs();
  const absErr = absErrDec.toNumber();
  const isZero = truthDec.isZero();
  const scaleDec = isZero ? new D(1) : truthDec.abs();
  const relErr = absErrDec.div(scaleDec).toNumber();
  const actualDigits = relErr === 0 ? 40 : Math.max(0, -Math.log10(relErr));
  const sigCover = absErr <= Math.max(r.sigma * 1.05, 1e-25 * scaleDec.toNumber());
  const ok = r.verdict === 'ok' && actualDigits >= minDigits && sigCover && dt <= limitMs &&
             (!isZero || r.value === 0);

  if (ok) totalPass++;
  else {
    totalFail++;
    failures.push(`[${group}] ${label}: verdict=${r.verdict}, actualDig=${actualDigits.toFixed(1)} (need ${minDigits}), sigCov=${sigCover}, dt=${dt}ms, val=${r.valueText || r.value}`);
  }
  console.log(
    `[${ok ? 'PASS' : 'FAIL'}] ${label.padEnd(36)} ` +
    `真值位数=${actualDigits.toFixed(1).padStart(4)}/${String(minDigits).padEnd(2)} ` +
    `自报=${r.digits.toFixed(1).padStart(4)} ` +
    `σ覆盖=${sigCover ? 'y' : 'N'} ${String(dt + 'ms').padStart(6)}  ${r.method}`
  );
}

function checkDivergentCase(group, label, expr, a, b, maxMs) {
  const limitMs = maxMs || 2000;
  const t0 = Date.now();
  let r;
  try {
    r = C.integrate(C.compile(expr), a, b);
  } catch (e) {
    totalFail++;
    failures.push(`[${group}] ${label}: THROW ${e.message}`);
    console.log(`[FAIL] ${label.padEnd(36)} THROW: ${e.message}`);
    return;
  }
  const dt = Date.now() - t0;
  const ok = r.verdict === 'divergent' && dt <= limitMs;
  if (ok) totalPass++;
  else {
    totalFail++;
    failures.push(`[${group}] ${label}: expected divergent, got ${r.verdict} (v=${r.value}, ${dt}ms)`);
  }
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label.padEnd(36)} 判定=${r.verdict.padEnd(11)} ${String(dt + 'ms').padStart(5)}  ${r.method}`);
}

/* ======================== A. 历史 22 道经典闭式回归 ======================== */
console.log('\n=== A. 历史 22 道经典闭式回归（HP 开启） ===\n');
const catA = [
  ['∫₀^π sin x', 'sin(x)', '0', 'pi', new D(2), 24],
  ['∫₀^1 x²', 'x^2', '0', '1', new D(1).div(3), 24],
  ['∫₀^1 1/(1+x²)', '1/(1+x^2)', '0', '1', PI.div(4), 24],
  ['∫₀^∞ 1/(1+x²)', '1/(1+x^2)', '0', 'inf', PI.div(2), 24],
  ['∫₀^π sin²x', 'sin(x)^2', '0', 'pi', PI.div(2), 24],
  ['∫₀^∞ e^(-x²)', 'exp(-x^2)', '0', 'inf', PI.sqrt().div(2), 24],
  ['∫₀^1 ln x', 'log(x)', '0', '1', new D(-1), 24],
  ['∫₀^∞ e^(-x)', 'exp(-x)', '0', 'inf', new D(1), 24],
  ['∫₀^1 √(1-x²)', 'sqrt(1-x^2)', '0', '1', PI.div(4), 24],
  ['∫₀^∞ x²e^(-x)', 'x^2*exp(-x)', '0', 'inf', new D(2), 24],
  ['∫₀^(π/2) ln cos x', 'log(cos(x))', '0', 'pi/2', PI.mul(LN2).div(-2), 24],
  ['∫₀^1 x^x', 'x^x', '0', '1', new D('0.78343051071213440705926438652697546940768199014693'), 24],
  ['∫₀^π x sin x', 'x*sin(x)', '0', 'pi', PI, 24],
  ['∫₀^1 1/√x', '1/sqrt(x)', '0', '1', new D(2), 24],
  ['∫₀^1 ln²x', 'log(x)^2', '0', '1', new D(2), 24],
  ['∫₀^∞ x²e^(-x²)', 'x^2*exp(-x^2)', '0', 'inf', PI.sqrt().div(4), 24],
  ['∫₀^1 ln(1+x)/x', 'log(1+x)/x', '0', '1', PI.pow(2).div(12), 24],
  ['∫₀^1 atan x', 'atan(x)', '0', '1', PI.div(4).minus(LN2.div(2)), 24],
  ['∫₀^1 x/(1+x)', 'x/(1+x)', '0', '1', new D(1).minus(LN2), 24],
  ['∫₋∞^∞ e^(-x²)', 'exp(-x^2)', '-inf', 'inf', PI.sqrt(), 24],
  ['∫₀^1 1/√(x(1-x))', '1/sqrt(x*(1-x))', '0', '1', PI, 24],
  ['∫₀^∞ e^(-x)sin x', 'exp(-x)*sin(x)', '0', 'inf', new D('0.5'), 24],
];
for (const [l, e, a, b, t, d] of catA) checkValueCase('A', l, e, a, b, t, d);

/* ======================== B. v2.5-v2.11 高难度与旗舰回归 ======================== */
console.log('\n=== B. v2.5-v2.11 高难度与旗舰回归 ===\n');
const catB = [
  ['旗舰加号例题', 'abs(sin(x))/(exp(x)+abs(sin(x)+cos(x)))', '0', 'inf', PI.plus(LN2.mul(9)).div(24), 11],
  ['sinh/(x cosh²x) [0,∞)', 'sinh(x)/(x*cosh(x)^2)', '0', 'inf', G_CATALAN.mul(4).div(PI), 24],
  ['sinh/(x cosh²x) (-∞,0]', 'sinh(x)/(x*cosh(x)^2)', '-inf', '0', G_CATALAN.mul(4).div(PI), 24],
  ['sinh/(x cosh²x) (-∞,∞)', 'sinh(x)/(x*cosh(x)^2)', '-inf', 'inf', G_CATALAN.mul(8).div(PI), 24],
  ['exp(x)/(1+exp(2x)) (-∞,∞)', 'exp(x)/(1+exp(2*x))', '-inf', 'inf', PI.div(2), 24],
  ['1/(e^x+e^-x) [0,∞)', '1/(exp(x)+exp(-x))', '0', 'inf', PI.div(4), 24],
  ['v2.8 无理上限奇点', 'ln(x)/((x-1)*sqrt(x^2-2(15+8sqrt(3))x+1))', '0', '1-2/(sqrt(6)-sqrt(2)+1)', new D(2).div(3).mul(new D(2).minus(new D(3).sqrt())).mul(G_CATALAN), 24],
  ['ln(x)*ln(1-x) [0,1]', 'ln(x)*ln(1-x)', '0', '1', new D(2).minus(PI.pow(2).div(6)), 24],
  ['ln(-ln x) [0,1]', 'ln(-ln(x))', '0', '1', EULER_GAMMA.neg(), 24],
  ['Serret ∫₀¹ ln(1+x²)/(1+x²)', 'ln(1+x^2)/(1+x^2)', '0', '1', PI.mul(LN2).div(2).minus(G_CATALAN), 24],
  ['Ahmed 积分 [0,1]', 'atan(sqrt(2+x^2))/((1+x^2)*sqrt(2+x^2))', '0', '1', PI.pow(2).mul(5).div(96), 24],
  ['∫₀¹ ln(x)/(1+x²)', 'ln(x)/(1+x^2)', '0', '1', G_CATALAN.neg(), 24],
  ['∫₀^(π/2) x/sin x', 'x/sin(x)', '0', 'pi/2', G_CATALAN.mul(2), 24],
  ['∫₀¹ ln x·ln(1+x)/x', 'ln(x)*ln(1+x)/x', '0', '1', ZETA3.mul(-3).div(4), 24],
  ['∫₀^(π/4) ln(1+tan x)', 'ln(1+tan(x))', '0', 'pi/4', PI.mul(LN2).div(8), 24],
  ['∫₀^(π/2) ln²(sin x)', 'ln(sin(x))^2', '0', 'pi/2', PI.pow(3).div(24).plus(PI.mul(LN2.pow(2)).div(2)), 24],
  ['∫₀¹ x^(1/3)(1-x)^(2/3)', 'x^(1/3)*(1-x)^(2/3)', '0', '1', PI.mul(2).div(new D(9).mul(new D(3).sqrt())), 24],
  ['∫₀^∞ x/(e^x-1)', 'x/(exp(x)-1)', '0', 'inf', PI.pow(2).div(6), 24],
];
for (const [l, e, a, b, t, d] of catB) checkValueCase('B', l, e, a, b, t, d);

/* ======================== C. 发散判定双向测试 ======================== */
console.log('\n=== C1. 曾误判发散的可积题（必须判 ok 且高精度） ===\n');
const catC_ok = [
  ['x^(-0.9) [0,1]', 'x^(-0.9)', '0', '1', new D(10), 24],
  ['(1-x)^(-0.9) [0,1]', '(1-x)^(-0.9)', '0', '1', new D(10), 24],
  ['Beta(1/4,1/4) [0,1]', 'x^(-3/4)*(1-x)^(-3/4)', '0', '1', GAMMA_1_4.pow(2).div(PI.sqrt()), 24],
  ['x^(-1.1) [1,∞)', 'x^(-1.1)', '1', 'inf', new D(10), 24],
  ['1/(x ln²x) [2,∞)', '1/(x*ln(x)^2)', '2', 'inf', new D(1).div(LN2), 7],
  ['x^(-2/3)/(1+x) [0,∞)', 'x^(-2/3)/(1+x)', '0', 'inf', PI.mul(2).div(new D(3).sqrt()), 24],
  ['sin(x)/x (-∞,0]', 'sin(x)/x', '-inf', '0', PI.div(2), 24],
  ['sin(x)/x (-∞,-1]', 'sin(x)/x', '-inf', '-1', PI.div(2).minus(decSi(new D(1))), 24],
];
for (const [l, e, a, b, t, d] of catC_ok) checkValueCase('C1', l, e, a, b, t, d);

console.log('\n=== C2. 全部发散守卫（含对数临界、超指数溢出、内部极点、正项发散） ===\n');
const catC_div = [
  ['减号例题', 'abs(sin(x))/(exp(x)-abs(sin(x)+cos(x)))', '0', 'inf'],
  ['1/x [0,1]', '1/x', '0', '1'],
  ['1/x [1,∞)', '1/x', '1', 'inf'],
  ['1/x² [0,1]', '1/x^2', '0', '1'],
  ['1/√x [0,∞)', '1/sqrt(x)', '0', 'inf'],
  ['sin x [0,∞)', 'sin(x)', '0', 'inf'],
  ['1 [0,∞)', '1', '0', 'inf'],
  ['exp(x) [0,∞)', 'exp(x)', '0', 'inf'],
  ['x (-∞,∞)', 'x', '-inf', 'inf'],
  ['cos(x²)/x [0,∞)', 'cos(x^2)/x', '0', 'inf'],
  ['sin(x²)/x³ [0,∞)', 'sin(x^2)/x^3', '0', 'inf'],
  ['cos(x²)/x² [0,∞)', 'cos(x^2)/x^2', '0', 'inf'],
  ['cos(2^x) (-∞,∞)', 'cos(2^x)', '-inf', 'inf'],
  ['tanh(x)/x [0,∞)', 'tanh(x)/x', '0', 'inf'],
  ['对数临界 1/(x ln x) [2,∞)', '1/(x*ln(x))', '2', 'inf'],
  ['对数临界 1/(x ln(1/x)) [0,0.5]', '1/(x*ln(1/x))', '0', '0.5'],
  ['奇对称对数发散 (-∞,∞)', 'x/((1+x^2)*ln(2+x^2))', '-inf', 'inf'],
  ['超指数溢出 exp(x²) [0,∞)', 'exp(x^2)', '0', 'inf'],
  ['超指数溢出 exp(exp(x)) [0,∞)', 'exp(exp(x))', '0', 'inf'],
  ['振荡溢出 exp(x)sin(x) [0,∞)', 'exp(x)*sin(x)', '0', 'inf'],
  ['内部极点 1/x [-1,1]', '1/x', '-1', '1'],
  ['内部极点 1/x² [-1,1]', '1/x^2', '-1', '1'],
  ['内部极点 1/x³ [-1,1]', '1/x^3', '-1', '1'],
  ['内部极点 1/(x-1)² [0,2]', '1/(x-1)^2', '0', '2'],
  ['内部极点 tan(x) [0,π]', 'tan(x)', '0', 'pi'],
  ['内部极点 1/(3x-1) [0,1]', '1/(3*x-1)', '0', '1'],
  ['正项发散 sin²(x)/x [0,∞)', 'sin(x)^2/x', '0', 'inf'],
];
for (const [l, e, a, b] of catC_div) checkDivergentCase('C2', l, e, a, b);

console.log('\n=== C3. 符号层守卫与伪闭式拦截验证 ===\n');
const Sym = loadSymbolic();
const symPole3 = Sym.solve('1/x^3', '-1', '1', 0);
const symPole2 = Sym.solve('1/(x-1)^2', '0', '2', 0);
const symOk = Sym.solve('x^2', '0', '1', 1 / 3);
const symErf137 = Sym.solve('exp(-x^2)', '0', '1.37', C.integrate(C.compile('exp(-x^2)'), '0', '1.37').value);
const symErf1 = Sym.solve('exp(-x^2)', '0', '1', C.integrate(C.compile('exp(-x^2)'), '0', '1').value);
const symErf05 = Sym.solve('exp(-x^2)', '0', '0.5', C.integrate(C.compile('exp(-x^2)'), '0', '0.5').value);
const symSin137 = Sym.solve('sin(x)', '0', '1.37', C.integrate(C.compile('sin(x)'), '0', '1.37').value);
const symAtan1 = Sym.solve('1/(1+x^2)', '0', '1', C.integrate(C.compile('1/(1+x^2)'), '0', '1').value);
const symOk1 = symPole3 === null;
const symOk2 = symPole2 === null;
const symOk3 = symOk && symOk.exact === '1/3';
const symOk4 = !!(symErf137 && symErf137.exactIsNumeric === true);
const symOk5 = !!(symErf1 && symErf1.exactIsNumeric === true);
const symOk6 = !!(symErf05 && symErf05.exactIsNumeric === true);
const symOk7 = !!(symSin137 && symSin137.exactIsNumeric === false);
const symOk8 = !!(symAtan1 && symAtan1.exactIsNumeric === false);
for (const [lbl, passFlag] of [
  ['Symbolic 拦截 ∫₋₁¹ 1/x³', symOk1],
  ['Symbolic 拦截 ∫₀² 1/(x-1)²', symOk2],
  ['Symbolic 正常通过 ∫₀¹ x² = 1/3', !!symOk3],
  ['Symbolic 拦截伪闭式 ∫₀^1.37 exp(-x²)', symOk4],
  ['Symbolic 拦截伪闭式 ∫₀¹ exp(-x²)', symOk5],
  ['Symbolic 拦截伪闭式 ∫₀^0.5 exp(-x²)', symOk6],
  ['Symbolic 放行真闭式 ∫₀^1.37 sin(x)', symOk7],
  ['Symbolic 放行真闭式 ∫₀¹ 1/(1+x²)', symOk8],
]) {
  if (passFlag) totalPass++; else { totalFail++; failures.push('[C3] ' + lbl); }
  console.log(`[${passFlag ? 'PASS' : 'FAIL'}] ${lbl}`);
}

/* ======================== D. 无穷/左无穷/内部奇点/折点/零值/反向 ======================== */
console.log('\n=== D. 左无穷、非对称双无穷、内部奇点/折点、零值与反向区间 ===\n');
const catD = [
  ['exp(x) (-∞,0]', 'exp(x)', '-inf', '0', new D(1), 24],
  ['exp(x/5) (-∞,0]', 'exp(x/5)', '-inf', '0', new D(5), 24],
  ['非对称双无穷 1/(e^x+e^(-x/5))', '1/(exp(x)+exp(-x/5))', '-inf', 'inf', PI.mul(5).div(3), 20],
  ['有限负区间 exp(x/10) [-100,-10]', 'exp(x/10)', '-100', '-10', new D(-1).exp().minus(new D(-10).exp()).mul(10), 24],
  ['内部可积奇点 1/√|x-1| [0,2]', '1/sqrt(abs(x-1))', '0', '2', new D(4), 24],
  ['内部可积奇点 ln|x-1| [0,2]', 'ln(abs(x-1))', '0', '2', new D(-2), 24],
  ['内部折点 |x-1| [0,2]', 'abs(x-1)', '0', '2', new D(1), 24],
  ['内部折点 |sin x| [0,2π]', 'abs(sin(x))', '0', '2*pi', new D(4), 24],
  ['真值为零 ln(x)/(1+x²) [0,∞)', 'ln(x)/(1+x^2)', '0', 'inf', new D(0), 24],
  ['对称抵消早停 x+0.001x² [-1,1]', 'x+0.001*x^2', '-1', '1', new D('0.002').div(3), 24],
  ['0/0 抵消修复 (1-cos x)/x² [0,1]', '(1-cos(x))/x^2', '0', '1', new D(1).cos().minus(1).plus(decSi(new D(1))), 24],
  ['反向区间 x² [1,0]', 'x^2', '1', '0', new D(-1).div(3), 24],
  ['零宽度区间 sin(x) [1,1]', 'sin(x)', '1', '1', new D(0), 24],
];
for (const [l, e, a, b, t, d] of catD) checkValueCase('D', l, e, a, b, t, d);

/* ======================== E. 振荡积分全集 ======================== */
console.log('\n=== E. 振荡积分全集（chirp/包络/a<0/通用交替/正项/有限高频） ===\n');
const catE = [
  ['chirp 边界修复 sin(x²) [-1,∞)', 'sin(x^2)', '-1', 'inf', PI.div(8).sqrt().plus(decSinPowInt0toA(new D(1), 2)), 24],
  ['chirp 边界修复 sin(x³) [-1,∞)', 'sin(x^3)', '-1', 'inf', GAMMA_4_3.div(2).minus(decSinPowInt0toA(new D(1), 3)), 24],
  ['chirp 左半轴 sin(x²) (-∞,0]', 'sin(x^2)', '-inf', '0', PI.div(8).sqrt(), 24],
  ['分数下限 sin(x²) [1/3,∞)', 'sin(x^2)', '1/3', 'inf', PI.div(8).sqrt().minus(decSinPowInt0toA(new D(1).div(3), 2)), 24],
  ['无理下限 sin(e^x) [π/4,∞)', 'sin(exp(x))', 'pi/4', 'inf', PI.div(2).minus(decSi(PI.div(4).exp())), 24],
  ['a>0 曾误拒 cos(x)/x [1,∞)', 'cos(x)/x', '1', 'inf', decCi(new D(1)).neg(), 24],
  ['a>0 曾误拒 sin(x)/x² [1,∞)', 'sin(x)/x^2', '1', 'inf', new D(1).sin().minus(decCi(new D(1))), 24],
  ['Fresnel sin(x²) [0,∞)', 'sin(x^2)', '0', 'inf', PI.div(8).sqrt(), 24],
  ['Fresnel cos(x²) [0,∞)', 'cos(x^2)', '0', 'inf', PI.div(8).sqrt(), 24],
  ['sin(x³) [0,∞)', 'sin(x^3)', '0', 'inf', GAMMA_4_3.div(2), 24],
  ['sin(x²)/x [0,∞)', 'sin(x^2)/x', '0', 'inf', PI.div(4), 24],
  ['sin(x²)/x² [0,∞)', 'sin(x^2)/x^2', '0', 'inf', PI.div(2).sqrt(), 24],
  ['sinc sin(x)/x [0,∞)', 'sin(x)/x', '0', 'inf', PI.div(2), 24],
  ['sqrt 包络 sin(x)/√x [0,∞)', 'sin(x)/sqrt(x)', '0', 'inf', PI.div(2).sqrt(), 24],
  ['sqrt 包络 cos(x)/√x [0,∞)', 'cos(x)/sqrt(x)', '0', 'inf', PI.div(2).sqrt(), 24],
  ['sin(√x)/x [0,∞)', 'sin(sqrt(x))/x', '0', 'inf', PI, 17],
  ['sin(2^x) (-∞,∞)', 'sin(2^x)', '-inf', 'inf', PI.div(LN2.mul(2)), 24],
  ['sin(2^x) (-∞,0]', 'sin(2^x)', '-inf', '0', decSi(new D(1)).div(LN2), 24],
  ['sin(2^(-x)) [0,∞)', 'sin(2^(-x))', '0', 'inf', decSi(new D(1)).div(LN2), 24],
  ['通用交替 sin(x)/(1+x) [0,∞)', 'sin(x)/(1+x)', '0', 'inf', new D(1).cos().mul(PI.div(2).minus(decSi(new D(1)))).plus(new D(1).sin().mul(decCi(new D(1)))), 22],
  ['通用交替 cos(x)/(1+x²) [0,∞)', 'cos(x)/(1+x^2)', '0', 'inf', PI.div(E.mul(2)), 22],
  ['高频零点 sin(10x)/x [0,∞)', 'sin(10*x)/x', '0', 'inf', PI.div(2), 24],
  ['高频衰减 sin(20x)/(1+x²) [0,∞)', 'sin(20*x)/(1+x^2)', '0', 'inf', decSinAxOver1PlusX2(20), 22],
  ['Borwein sin³x/x³ [0,∞)', 'sin(x)^3/x^3', '0', 'inf', PI.mul(3).div(8), 22],
  ['正项振荡 sin²x/x² [0,∞)', 'sin(x)^2/x^2', '0', 'inf', PI.div(2), 20],
  ['正项振荡 (1-cos x)/x² [0,∞)', '(1-cos(x))/x^2', '0', 'inf', PI.div(2), 20],
  ['有限端振荡 sin(1/x)/x [0,1]', 'sin(1/x)/x', '0', '1', PI.div(2).minus(decSi(new D(1))), 22],
  ['有限端振荡 sin(1/x) [0,1]', 'sin(1/x)', '0', '1', new D(1).sin().minus(decCi(new D(1))), 22],
  ['有限高频 sin(x) [0,500]', 'sin(x)', '0', '500', new D(1).minus(new D(500).cos()), 12],
];
for (const [l, e, a, b, t, d] of catE) checkValueCase('E', l, e, a, b, t, d);

/* ======================== F. 词法与函数一致性测试 ======================== */
console.log('\n=== F. 词法与函数表一致性（Core vs HP） ===\n');
const HP = globalThis.IntegralHP;
const lexCases = [
  ['tau + phi + ln2 + ln10', 0.5],
  ['log10(x+1) + log2(x+2)', 1.5],
  ['cbrt(x) + asinh(x) + acosh(x+2) + atanh(x*0.5)', 0.6],
  ['atan2(x, 1) + hypot(x, 2)', 0.7],
  ['sign(0) + sign(-x) + sign(x)', 0.5],
  ['2πx + x² - x³ + 2**3', 0.4],
  ['3·x − x×2', 1.2],
];
for (const [expr, xv] of lexCases) {
  let ok = false, detail = '';
  try {
    D.set({ precision: 55 });
    const vNum = C.compile(expr)(xv);
    const vDec = HP.compile(expr)(new D(xv)).toNumber();
    const diff = Math.abs(vNum - vDec);
    ok = isFinite(vNum) && isFinite(vDec) && diff <= 1e-13 * Math.max(1, Math.abs(vNum));
    detail = `core=${vNum.toPrecision(12)}, hp=${vDec.toPrecision(12)}, diff=${diff.toExponential(2)}`;
  } catch (e) {
    detail = 'ERR: ' + e.message;
  }
  if (ok) totalPass++; else { totalFail++; failures.push('[F] ' + expr + ': ' + detail); }
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${expr.padEnd(46)} ${detail}`);
}

console.log(`\n==================== 汇总：${totalPass}/${totalPass + totalFail} 通过 ====================`);
if (failures.length) {
  console.log('\n失败详情：');
  failures.forEach(f => console.log('  - ' + f));
}
process.exit(totalFail > 0 ? 1 : 0);
