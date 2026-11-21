/* tools/test-framework-acceptance.js
 * 定积分闭式引擎三支柱系统验收测试（v2.16）：
 *   支柱一：数值精度与误差界诚实性（10 个对抗性积分，覆盖远距孤立峰、平移奇点、非解析端点高频振荡、
 *           绝对收敛不规则振荡、旗舰例题 25 位精化等）；
 *   支柱二：搜索空间 S_2 确定性 100% 召回（28 个跨越 π/对数/根式/指数/Gamma/Catalan/Zeta/Beta 闭式积分）；
 *   支柱三：非闭式积分零高概率误导（15 个非闭式负例 + Float64 假阳性对抗攻击 + Fail-Closed 52 位检验）。
 *
 * 运行：node tools/test-framework-acceptance.js
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'assets', 'decimal.js'));
globalThis.Decimal = D;
require(path.join(ROOT, 'integral-hp.js'));
const C = require(path.join(ROOT, 'integral-core.js'));
const PSLQ = require(path.join(ROOT, 'integral-pslq.js'));
const glue = require(path.join(ROOT, 'integral-glue.js'));

D.set({ precision: 60 });
const PI = D.acos(-1);
const E = new D(1).exp();
const LN2 = new D(2).ln();
const SQRT2 = new D(2).sqrt();
const SQRT3 = new D(3).sqrt();
const SQRTPI = PI.sqrt();
const G_CAT = new D('0.9159655941772190150546035149323841107741493742816721343');
const GAMMA_E = new D('0.5772156649015328606065120900824024310421593359399235988');
const ZETA3 = new D('1.202056903159594285399738161511449990764986292340498882');
const ZETA5 = new D('1.036927755143369926331365486457034168057080919501912812');
const BETA4 = new D('0.9889445517411053361084226332283778213158608870627339108');
const GAMMA14 = new D('3.625609908221908311930685155867672002995167682880065467');

/* 独立解析级数：int_0^1 sin(x)/sqrt(x) ... 及 int_M^inf 渐近级数用于 30+ 位 sin(x)/sqrt(x) [0, 1000] */
function refSinSqrt1000() {
  const M = new D(1000);
  const sinM = M.sin();
  const cosM = M.cos();
  let re = new D(0), im = new D(1);
  let sumTail = new D(0);
  for (let k = 0; k < 22; k++) {
    if (k > 0) {
      const f = new D(2 * k - 1).div(M.mul(2));
      const nRe = im.mul(f);
      const nIm = re.mul(f).neg();
      re = nRe;
      im = nIm;
    }
    sumTail = sumTail.plus(re.mul(sinM).plus(im.mul(cosM)));
  }
  const tail = sumTail.div(M.sqrt());
  return PI.div(2).sqrt().minus(tail);
}

/* 独立解析级数：int_0^1 atanh(x)/sqrt(x^2+x) dx = 1/(2 sqrt(2)) sum_{m>=0} 2^-m / (m + 1/2) H_{m+1/2} */
function refAtanhSqrt() {
  let harmSum = new D(0);
  let powHalf = new D(1);
  let sum = new D(0);
  for (let m = 0; m <= 160; m++) {
    harmSum = harmSum.plus(new D(2).div(2 * m + 1));
    const hHalf = harmSum.minus(LN2.mul(2));
    const term = powHalf.mul(hHalf).div(new D(m).plus('0.5'));
    sum = sum.plus(term);
    powHalf = powHalf.div(2);
  }
  return sum.div(SQRT2.mul(2));
}

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    failures++;
    console.error('  [FAIL]', msg);
  }
}

console.log('=== 支柱一：数值积分精度与误差界诚实性（10 题） ===');
const pillar1 = [
  {
    name: '远距孤立峰 x0=1000',
    fn: 'exp(-(x-1000)^2)', a: '0', b: 'inf',
    ref: SQRTPI, minTrue: 24, minRep: 20
  },
  {
    name: '超远距孤立峰 x0=1e5',
    fn: 'exp(-(x-1e5)^2)', a: '0', b: 'inf',
    ref: SQRTPI, minTrue: 24, minRep: 20
  },
  {
    name: '远距尖锐洛伦兹峰',
    fn: '1/(1e-8+(x-1000)^2)', a: '0', b: 'inf',
    ref: PI.minus(new D('1e-7').atan()).mul(10000), minTrue: 20, minRep: 12
  },
  {
    name: '常数平移内部奇点 10+ln|x-0.37|',
    fn: '10+ln(abs(x-0.37))', a: '0', b: '1',
    ref: new D(10).plus(new D('0.37').mul(new D('0.37').ln())).plus(new D('0.63').mul(new D('0.63').ln())).minus(1),
    minTrue: 24, minRep: 20
  },
  {
    name: '非解析端点高频振荡 sin(x)/sqrt(x) [0,1000]',
    fn: 'sin(x)/sqrt(x)', a: '0', b: '1000',
    ref: refSinSqrt1000(), minTrue: 11, minRep: 8
  },
  {
    name: '变频率振荡 2*x*sin(x^2) [0,100]',
    fn: '2*x*sin(x^2)', a: '0', b: '100',
    ref: new D(1).minus(new D(10000).cos()), minTrue: 8, minRep: 6
  },
  {
    name: '绝对收敛不规则双频振荡 sin(x)*sin(sqrt(2)*x)/x^2',
    fn: 'sin(x)*sin(sqrt(2)*x)/x^2', a: '0', b: 'inf',
    ref: PI.div(2), minTrue: 6, minRep: 3
  },
  {
    name: '旗舰周期拐点指数衰减 [0,inf)（强制 >=24 位）',
    fn: 'abs(sin(x))/(exp(x)+abs(sin(x)+cos(x)))', a: '0', b: 'inf',
    ref: PI.plus(LN2.mul(9)).div(24), minTrue: 24, minRep: 24
  },
  {
    name: '内部对数+代数端点复合奇点 atanh(x)/sqrt(x^2+x)',
    fn: 'atanh(x)/sqrt(x^2+x)', a: '0', b: '1',
    ref: refAtanhSqrt(), minTrue: 24, minRep: 20
  },
  {
    name: '经典根式反三角奇点 asin(x)/sqrt(x^2+x)',
    fn: 'asin(x)/sqrt(x^2+x)', a: '0', b: '1',
    ref: PI.mul(SQRT2.plus(1).div(2).ln()), minTrue: 24, minRep: 20
  }
];

for (const tc of pillar1) {
  const f = C.compile(tc.fn);
  const r = C.integrate(f, tc.a, tc.b);
  const valDec = new D(r.valueText ? String(r.valueText) : String(r.value));
  const err = valDec.minus(tc.ref).abs().toNumber();
  const relErr = err / Math.max(tc.ref.abs().toNumber(), 1e-300);
  const trueDig = relErr > 0 ? -Math.log10(relErr) : 31;
  const covered = err <= Math.max(5 * r.sigma, 1e-24);
  const pass = r.verdict === 'ok' && trueDig >= tc.minTrue && r.digits >= tc.minRep && covered;
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${tc.name}: verdict=${r.verdict}, true=${trueDig.toFixed(1)}位, rep=${r.digits.toFixed(1)}位, cov=${covered}`);
  check(pass, `${tc.name} failed (verdict=${r.verdict}, true=${trueDig.toFixed(1)}, rep=${r.digits.toFixed(1)}, err=${err.toExponential(2)}, sigma=${r.sigma.toExponential(2)})`);
}

console.log('\n=== 支柱二：搜索空间 S_2 确定性 100% 召回（28 题） ===');
const pillar2 = [
  ['旗舰正周期拐点', 'abs(sin(x))/(exp(x)+abs(sin(x)+cos(x)))', '0', 'inf', PI.plus(LN2.mul(9)).div(24)],
  ['Ahmed 积分', 'atan(sqrt(x^2+2))/((x^2+1)*sqrt(x^2+2))', '0', '1', PI.pow(2).mul(5).div(96)],
  ['Serret 积分', 'ln(1+x)/(1+x^2)', '0', '1', PI.mul(LN2).div(8)],
  ['Catalan 定义', 'atan(x)/x', '0', '1', G_CAT],
  ['2G 经典三角', 'x/sin(x)', '0', 'pi/2', G_CAT.mul(2)],
  ['π²/12 对数', 'ln(1+x)/x', '0', '1', PI.pow(2).div(12)],
  ['-π²/6 对数', 'ln(1-x)/x', '0', '1', PI.pow(2).div(-6)],
  ['ln²(sin x)', 'ln(sin(x))^2', '0', 'pi/2', PI.pow(3).plus(PI.mul(12).mul(LN2.pow(2))).div(24)],
  ['asin/sqrt', 'asin(x)/sqrt(x^2+x)', '0', '1', PI.mul(SQRT2.plus(1).div(2).ln())],
  ['分段奇异根式', '1/sqrt(abs(x^2-2))', '0', '2', PI.plus(SQRT2.plus(1).ln().mul(2)).div(2)],
  ['正周期振荡衰减', 'sin(x)^2/(1+x^2)', '0', 'inf', PI.minus(PI.div(E.pow(2))).div(4)],
  ['傅里叶衰减振荡', 'cos(x)/(1+x^2)', '0', 'inf', PI.div(E.mul(2))],
  ['半高斯积分', 'exp(-x^2)', '0', 'inf', SQRTPI.div(2)],
  ['Beta(1/4,1/4)', 'x^(-3/4)*(1-x)^(-3/4)', '0', '1', GAMMA14.pow(2).div(SQRTPI)],
  ['3ζ(3)/2', 'ln(x)^2/(1+x)', '0', '1', ZETA3.mul(3).div(2)],
  ['Bose-Einstein n=2', 'x^2/(exp(x)-1)', '0', 'inf', ZETA3.mul(2)],
  ['Bose-Einstein n=3', 'x^3/(exp(x)-1)', '0', 'inf', PI.pow(4).div(15)],
  ['Bose-Einstein n=4', 'x^4/(exp(x)-1)', '0', 'inf', ZETA5.mul(24)],
  ['Euler γ 积分', '-exp(-x)*ln(x)', '0', 'inf', GAMMA_E],
  ['三阶分母有理无穷', '1/(1+x^3)', '0', 'inf', PI.mul(2).div(SQRT3.mul(3))],
  ['四阶分母有理无穷', '1/(1+x^4)', '0', 'inf', PI.div(SQRT2.mul(2))],
  ['π·ln(2)', 'ln(1+x^2)/(1+x^2)', '0', 'inf', PI.mul(LN2)],
  ['-π²/8', 'ln(x)/(1-x^2)', '0', '1', PI.pow(2).div(-8)],
  ['显式根式 2√3-2', '1/sqrt(1+x)', '0', '2', SQRT3.mul(2).minus(2)],
  ['π³/16', 'ln(x)^2/(1+x^2)', '0', '1', PI.pow(3).div(16)],
  ['-6β(4)', 'ln(x)^3/(1+x^2)', '0', '1', BETA4.mul(-6)],
  ['2 - π²/6', 'ln(x)*ln(1-x)', '0', '1', new D(2).minus(PI.pow(2).div(6))],
  ['2 - 2ln(2) - π²/12', 'ln(x)*ln(1+x)', '0', '1', new D(2).minus(LN2.mul(2)).minus(PI.pow(2).div(12))]
];

for (const [name, fn, a, b, refDec] of pillar2) {
  const f = C.compile(fn);
  const r = C.integrate(f, a, b);
  r.profile = glue.analyzeIntegralProfile(fn, a, b, r.slopes);
  const hits = PSLQ.search(r);
  const ranked = glue.rankCandidates(hits, r);
  const top = ranked.rows[0];
  let candErr = Infinity;
  if (top) {
    const cm = /x\s*[≈=]\s*([\s\S]*)$/.exec(top.formula);
    const rhsDec = cm ? glue.evalRiesDec(cm[1], new D(String(r.valueText)), D) : null;
    if (rhsDec) candErr = rhsDec.minus(refDec).abs().toNumber();
  }
  const tol = name === '正周期振荡衰减' ? 1e-18 : 1e-20;
  const pass = hits.length >= 1 && ranked.hasReliableClosed && top &&
    top.hpCheck && top.hpCheck.status === 'passed' && top.p >= 0.85 && candErr < tol;
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}: ${top ? top.formula : 'NONE'} (p=${top ? (top.p * 100).toFixed(1) + '%' : '0%'}, err=${candErr.toExponential(1)})`);
  check(pass, `Pillar2 "${name}" failed (hits=${hits.length}, reliable=${ranked.hasReliableClosed}, p=${top && top.p}, candErr=${candErr})`);
}

console.log('\n=== 支柱三：非闭式负例零高概率误导 + Fail-Closed 检验（15 题 + 对抗攻击） ===');
const pillar3 = [
  ['gauss(0, 1.37)', 'exp(-x^2)', '0', '1.37'],
  ['exp(x^3)', 'exp(x^3)', '0', '1'],
  ['Sophomore x^x', 'x^x', '0', '1'],
  ['atanh/sqrt', 'atanh(x)/sqrt(x^2+x)', '0', '1'],
  ['Si(1) = sin(x)/x', 'sin(x)/x', '0', '1'],
  ['cos(x)/(1+x^3)', 'cos(x)/(1+x^3)', '0', '1'],
  ['exp(-x^4)', 'exp(-x^4)', '0', '1'],
  ['1/(1+x^5+x)', '1/(1+x^5+x)', '0', '1'],
  ['ln(1+exp(-x^2))', 'ln(1+exp(-x^2))', '0', '1'],
  ['sin(exp(x))', 'sin(exp(x))', '0', '1'],
  ['椭圆积分 sqrt(1+x^3)', 'sqrt(1+x^3)', '0', '1'],
  ['Ei(1)-related', 'exp(-x)/(1+x)', '0', 'inf'],
  ['1/(2+sin(x^2))', '1/(2+sin(x^2))', '0', '1'],
  ['atan(x^2)/(1+x^3)', 'atan(x^2)/(1+x^3)', '0', '1'],
  ['exp(-x^2)/(1+x^2)', 'exp(-x^2)/(1+x^2)', '0', 'inf']
];

function buildAdversarialFakes() {
  return [
    {
      kind: 'eval',
      row: {
        formula: 'Möbius 关系： x ≈ (143·e + 204·e^2)/(64·e + 318·e^2 + 230)',
        fullText: '高度 318', delta: 4.44e-16, verified: true, terms: 0, height: 318
      }
    },
    {
      kind: 'eval',
      row: {
        formula: '对数组合关系： x ≈ 14/5 + 4·ln(2) + 1/10·ln(3) - 1/10·ln(5) - 7/10·π - 27/10·ln(π)',
        fullText: '6 项基', delta: 0, verified: true, terms: 6, height: 27
      }
    },
    {
      kind: 'eval',
      row: {
        formula: '硬常数数据库： x ≈ 37·ζ(3)/64',
        fullText: '高度 64', delta: 3.1e-16, verified: true, terms: 1, height: 64
      }
    },
    {
      kind: 'eval',
      row: {
        formula: '常数数据库： x ≈ 11·Γ(1/4)/43',
        fullText: '高度 43', delta: 2.2e-16, verified: true, terms: 1, height: 43
      }
    },
    {
      kind: 'eval',
      row: {
        formula: 'RIES 方程： x = 13·Cl₂(π/3)/19',
        fullText: '', delta: 4.4e-16, verified: true, terms: 1, height: 19
      }
    },
    {
      kind: 'eval',
      row: {
        formula: 'RIES 方程： x = 7·β(4)/10',
        fullText: '', delta: 2.2e-16, verified: true, terms: 1, height: 10
      }
    },
    {
      kind: 'eval',
      row: {
        formula: 'RIES 方程： x = 3·Khinchin/11',
        fullText: '', delta: 1.1e-16, verified: true, terms: 1, height: 11
      }
    },
    {
      kind: 'eval',
      row: {
        formula: 'RIES 方程： x = 5·Glaisher/9',
        fullText: '', delta: 3.3e-16, verified: true, terms: 1, height: 9
      }
    },
    {
      kind: 'eval',
      row: {
        formula: '代数关系： 296x^5 + 56x^4 + 40x^3 − 563x^2 + 204x + 55 = 0',
        fullText: '', delta: 1.2e-15, verified: true, terms: 6, height: 563
      }
    },
    {
      kind: 'eval',
      row: {
        formula: 'RIES 方程： exp(5*x) = 9*π + 3',
        fullText: '', delta: 5.5e-16, verified: true, terms: 2, height: 9
      }
    },
    {
      kind: 'opaque',
      row: {
        formula: '超几何 pFq 数据库： x ≈ π·₂F₁(1/3,2/3;3/2;1/4)',
        fullText: '2F1', delta: 0, verified: true, terms: 1, height: 4
      }
    },
    {
      kind: 'opaque',
      row: {
        formula: 'L 函数有理比： x ≈ 7·L(f, 2)/11',
        fullText: 'L-function', delta: 0, verified: true, terms: 1, height: 11
      }
    },
    {
      kind: 'integral',
      row: {
        formula: '积分 / 求和数据库： x ≈ int_0^1 sin(x)/x dx',
        fullText: 'integral family', delta: 0, verified: true, terms: 0, height: 4
      }
    }
  ];
}

for (const [name, fn, a, b] of pillar3) {
  const f = C.compile(fn);
  const r = C.integrate(f, a, b);
  r.profile = glue.analyzeIntegralProfile(fn, a, b, r.slopes);
  const hits = PSLQ.search(r);
  const fakes = buildAdversarialFakes();
  const ranked = glue.rankCandidates(fakes.map((x) => x.row), r);

  // Verify individual fake classifications against 52-digit Fail-Closed gate
  let allEvalRejected = true, allOpaqueCapped = true;
  for (const fk of fakes) {
    const single = glue.rankCandidates([fk.row], r);
    const rr = single.rows[0];
    if (fk.kind === 'eval') {
      if (!rr.hpRejected || rr.p > 0.01) allEvalRejected = false;
    } else if (fk.kind === 'opaque') {
      if (rr.p > 0.35 || single.hasReliableClosed) allOpaqueCapped = false;
    } else if (fk.kind === 'integral') {
      if (!rr.integralForm || rr.p !== 0) allOpaqueCapped = false;
    }
  }

  const pass = hits.length === 0 && !ranked.hasReliableClosed && allEvalRejected && allOpaqueCapped;
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}: pslq=0? ${hits.length === 0}, reliable=${ranked.hasReliableClosed}, evalRejected=${allEvalRejected}, opaqueCap=${allOpaqueCapped}`);
  check(pass, `Pillar3 "${name}" failed (hits=${hits.length}, reliable=${ranked.hasReliableClosed}, evalRejected=${allEvalRejected}, opaqueCap=${allOpaqueCapped})`);
}

// Low-precision (digits=14, NO HP valueText) arbitrary-bound adversarial checks
{
  const arbProf = glue.analyzeIntegralProfile('exp(-x^2)', '0', '1.37', {});
  const lowInfo = { value: 0.83953375395406, sigma: 1e-14, digits: 14, profile: arbProf };
  const lowFakes = [
    {
      formula: 'Möbius 关系： x ≈ (143·e + 204·e^2)/(64·e + 318·e^2 + 230)',
      fullText: '高度 318', delta: 0, verified: true, terms: 0, height: 318
    },
    {
      formula: '线性组合： x ≈ (7·π − 11·ln(2) + 5·G)/27',
      fullText: '项数 3；高度 27', delta: 0, verified: true, terms: 3, height: 27
    }
  ];
  const lowRanked = glue.rankCandidates(lowFakes, lowInfo);
  const lowOk = !lowRanked.hasReliableClosed && lowRanked.rows.every((r) => r.p <= 0.30);
  console.log(`  [${lowOk ? 'PASS' : 'FAIL'}] 低精度任意限 rel=0 对抗: reliable=${lowRanked.hasReliableClosed}, ps=${lowRanked.rows.map((r) => r.p.toFixed(3)).join(',')}`);
  check(lowOk, 'Low-precision arbitrary-bound fake was not capped <= 0.30');
}

console.log('\n================================================');
if (failures === 0) {
  console.log('ALL THREE PILLARS PASSED ZERO FAILURES.');
  process.exit(0);
} else {
  console.error(`TOTAL FAILURES: ${failures}`);
  process.exit(1);
}
