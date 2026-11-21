/* integral-glue.js — 把「定积分数值层」「符号层」「确定性高精度 PSLQ 引擎」「原版 RIES 12.0.2」接入三支柱理论框架。
 * 不修改 ries-script.js 任何一行；只通过 DOM 交互与结果观察接入。
 *
 * v2.17 架构升级：
 *  1. 数值积分 + 确定性 PSLQ 迁入独立后台 Web Worker（integral-worker.js），彻底解除主线程阻塞并支持随时停止，
 *     使手机与低配电脑可无损跑完与桌面端完全一致的计算预算；Worker 受限时自动优雅降级回主线程。
 *  2. 暴露用户可调数值精度（12 / 18 / 25 / 35 位）与「闭式搜索」总开关（纯数值模式 / 闭式模式），
 *     并在交互前后明确说明精度与开关对 Fail-Closed 门槛、PSLQ 召回及耗时的后果。
 *  3. RIES 方程同构重复行（如 ±x/x+0 变形）去重折叠与异常中断快照识别。
 */
(function (global) {
  'use strict';
  var isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
  var C = (isBrowser ? window.IntegralCore : global.IntegralCore) || null;
  if (isBrowser && !C) { console.error('IntegralCore 未加载'); return; }
  function tryRequirePslq() {
    if (typeof require !== 'function') return null;
    try { return require('./integral-pslq.js'); } catch (e) { return null; }
  }
  var PSLQ = (isBrowser ? window.IntegralPSLQ : (global.IntegralPSLQ || tryRequirePslq())) || null;
  var $ = function (id) { return isBrowser ? document.getElementById(id) : null; };
  var el = isBrowser ? {
    f: $('igF'), a: $('igA'), b: $('igB'), run: $('igRun'), stop: $('igStop'),
    precGroup: $('igPrecGroup'), closedToggle: $('igClosedToggle'), guide: $('igGuide'),
    status: $('igStatus'), result: $('igResult'), out: $('igOut'),
    cand: $('igCandidates'), candBody: $('igCandBody'),
    exPlus: $('igExPlus'), exMinus: $('igExMinus'), exSimple: $('igExSimple'),
    sym: $('igSymbolic'), symEq: $('igSymEq'), symValue: $('igSymValue'), symFoot: $('igSymFoot'),
    riesSection: $('riesSection')
  } : {};
  var last = null;
  var lastClosedEnabled = true;
  var riesTarget = null;
  var pslqRows = [];
  var targetDigitsPref = 25;
  var closedEnabledPref = true;
  var numWorker = null;
  var workerDisabled = false;
  var activeJobId = 0;
  var workerPending = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function setStatus(text, kind) {
    if (!el.status) return;
    el.status.textContent = text;
    el.status.className = 'notice status-line' + (kind ? ' ' + kind : '');
  }
  function firstNumber(text) {
    var t = String(text || '').replace(/copy/ig, '').replace(/×/g, '*')
              .replace(/−/g, '-').replace(/⋅/g, '*');
    var m = /([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)/.exec(t);
    if (!m) return NaN;
    var v = parseFloat(m[1]), rest = t.slice(m.index + m[0].length);
    var sci = /^\s*\*\s*10\s*\^\s*([+-]?\d+)/.exec(rest);
    if (sci) v *= Math.pow(10, parseFloat(sci[1]));
    return v;
  }
  function cleanText(node) {
    if (!node) return '';
    var clone = node.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('button'), function (b) { b.remove(); });
    return clone.textContent.trim();
  }
  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

  /* 引擎误差列才是候选与目标的真实差距。
     支持「5.54*10^-13」「1 part in 1527」「relative residual 8.95*10^-9」，
     以及整数模式的字面 "exact"（残差为 0）。 */
  function parseErr(errText, value) {
    if (!errText) return NaN;
    var t = String(errText).replace(/复制|copy/ig, '').replace(/−/g, '-')
              .replace(/×/g, '*').replace(/⋅/g, '*').trim();
    if (/^exact$/i.test(t) || /^精确$/.test(t)) return 0;
    var m = /1\s*part\s*in\s*([\d.]+)/i.exec(t);
    if (m) { var n = parseFloat(m[1]); return n > 0 ? Math.abs(value) / n : NaN; }
    var isRel = /相对残差|relative residual|相对误差/i.test(t);
    var v = firstNumber(t);
    if (!isFinite(v)) return NaN;
    return isRel ? v * Math.abs(value) : v;
  }

  /* 候选自带的预测值在「预测/比值/乘积/右端」之后；
     行首的「x ≈ 0.3908…」是目标本身，绝不能当预测值（这正是旧版的 bug）。
     整数模式的行形如「exact = 2」「2 = 2 (1 ms)」，单独兜住。 */
  function candidatePredicted(text) {
    var t = String(text || '').replace(/−/g, '-');
    var pats = [
      /预测\s*x\s*≈\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)/,
      /predicted\s*x\s*≈\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)/i,
      /比值\s*=\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)/,
      /ratio\s*=\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)/i,
      /乘积\s*=\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)/,
      /product\s*=\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)/i,
      /右端\s*=\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)/,
      /rhs\s*=\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)/i,
      /^\s*exact\s*=\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)/i,
      /^\s*[+-]?\d*\.?\d+\s*=\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)/,
      /^\s*x\s*=\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)/
    ];
    for (var i = 0; i < pats.length; i++) {
      var m = pats[i].exec(t);
      if (m) { var v = parseFloat(m[1]); if (isFinite(v)) return v; }
    }
    return NaN;
  }

  /* 「零技巧」右端：sinπ(整数) 恒等于 0，整行于是退化成「左端 = 0」。
     这类行本身没错，但同一个左端会配不同的整数凑出好几行（sinπ(81)、sinπ(49)…），
     内容完全重复。识别出来用于去重，只留第一条。 */
  function zeroTrickRhs(formula) {
    var s = String(formula).replace(/复制|copy/ig, '');
    var ci = s.indexOf('：');
    if (ci >= 0) s = s.slice(ci + 1);
    var eq = s.indexOf('=');
    if (eq < 0) return false;
    var rhs = s.slice(eq + 1).replace(/\s+/g, '');
    if (/^\(?-?0\)?$/.test(rhs)) return true;

    function norm(x) {
      return x.replace(/²/g, '^2').replace(/³/g, '^3')
              .replace(/·/g, '*').replace(/×/g, '*');
    }
    function isIntArg(a) {
      var n = norm(a);
      if (!/^[0-9+\-*/^().]+$/.test(n)) return null;
      try {
        var v = C.compile(n)(0);
        return (isFinite(v) && Math.abs(v - Math.round(v)) < 1e-12) ? true : null;
      } catch (e) { return null; }
    }

    /* 把「sinπ(整数)」逐个替换成 0，剩下的式子若求值为 0，整行就是零技巧 */
    var touched = false;
    var replaced = rhs.replace(/sinπ\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, function (m, arg) {
      if (isIntArg(arg)) { touched = true; return '0'; }
      return m;
    });
    if (!touched) return false;
    var rest = norm(replaced);
    if (!/^[0-9+\-*/^().]+$/.test(rest)) return false;
    try {
      var v2 = C.compile(rest)(0);
      return isFinite(v2) && Math.abs(v2) < 1e-12;
    } catch (e) { return false; }
  }

  /* 取出公式左端（"RIES 方程： ((x+8)-8) = (π/4)" → "((x+8)-8)"） */
  function lhsOf(formula) {
    var s = String(formula || '').replace(/复制|copy/ig, '');
    var i = s.indexOf('：');
    if (i >= 0) s = s.slice(i + 1);
    var j = s.indexOf('=');
    if (j < 0) return '';
    return s.slice(0, j).trim();
  }

  /* 恒等式包装：左端恒等于 c·x（c 为常数），整行只是把右端换个写法。
     例如 ((x+8)-8)、7-(x+7) —— 加个 8 再减个 8，没有新信息，却因为「公式短」抢到高分。
     返回 c（±1 才算包装），无法求值的写法（含 sinπ/ln）安全跳过返回 null。
     注意：只认 ±x。x/π 这类缩放不拆 —— 它本身就是「x = 右端×π」的答案写法。 */
  function tautologyCoefficient(formula) {
    var lhs = lhsOf(formula);
    if (!lhs) return null;
    var bare = lhs.replace(/[()\s]/g, '');
    if (!bare || bare === 'x' || bare.indexOf('x') < 0) return null;
    if (!/^[xe0-9π+\-*/^().\s]+$/.test(lhs)) return null;
    try {
      var f = C.compile(lhs);
      var p = 1.2345678901, q = 7.8901234567;
      var fp = f(p), fq = f(q);
      if (!isFinite(fp) || !isFinite(fq)) return null;
      var cp = fp / p, cq = fq / q;
      if (Math.abs(cp - cq) > 1e-9 * Math.max(1, Math.abs(cp))) return null;
      if (Math.abs(cp - 1) <= 1e-9) return 1;
      if (Math.abs(cp + 1) <= 1e-9) return -1;
      return null;
    } catch (e) { return null; }
  }

  /* 把「c·x = 右端」改写成「x ≈ 右端/c」。保留答案，丢掉包装。 */
  function unwrapFormula(formula, c) {
    var s = String(formula).replace(/复制|copy/ig, '');
    var ci = s.indexOf('：');
    var label = ci >= 0 ? s.slice(0, ci + 1) + ' ' : '';
    var body = ci >= 0 ? s.slice(ci + 1) : s;
    var eq = body.indexOf('=');
    if (eq < 0) return null;
    var rhs = body.slice(eq + 1).trim();
    if (c < 0) rhs = rhs.charAt(0) === '-' ? rhs.slice(1) : '-' + rhs;
    rhs = rhs.replace(/^\(\((.*)\)\)$/, '($1)');
    return label + 'x ≈ ' + rhs;
  }

  /* ---------- 55 位独立验算常数兜底（与 integral-pslq.js 严格同源） ---------- */
  var VERIFIED_FALLBACK = {
    gamma:    '0.5772156649015328606065120900824024310421593359399235988',
    G:        '0.9159655941772190150546035149323841107741493742816721343',
    zeta3:    '1.202056903159594285399738161511449990764986292340498882',
    zeta5:    '1.036927755143369926331365486457034168057080919501912812',
    zeta7:    '1.008349277381922826839797549849796759599863560565238706',
    beta4:    '0.9889445517411053361084226332283778213158608870627339108',
    gamma14:  '3.625609908221908311930685155867672002995167682880065467',
    gamma13:  '2.678938534707747633655692940974677644128689377957301101',
    gamma16:  '5.566316001780235204250096895207726111398799114872853462',
    cl2pi3:   '1.014941606409653625021202554274520285941689307530299792',
    glaisher: '1.282427129100622636875342568869791727767688927325001334',
    khinchin: '2.685452001065306445309714835481795693820382293816600717'
  };
  var BERNOULLI_EVEN = [
    [1, 6], [-1, 30], [1, 42], [-1, 30], [5, 66], [-691, 2730],
    [7, 6], [-3617, 510], [43867, 798], [-174611, 330], [854513, 138], [-236364091, 2730]
  ];
  function fallbackDecGamma(zDec, D) {
    if (!zDec || !zDec.isFinite() || (zDec.isInteger() && zDec.lte(0)) || zDec.abs().gt(100)) return null;
    var PI = D.acos(-1);
    if (zDec.lt('0.5')) {
      var s = PI.mul(zDec).sin();
      if (s.isZero()) return null;
      var gRef = fallbackDecGamma(new D(1).minus(zDec), D);
      return gRef ? PI.div(s.mul(gRef)) : null;
    }
    var N = 36, shift = new D(1);
    for (var j = 0; j < N; j++) shift = shift.mul(zDec.plus(j));
    var w = zDec.plus(N);
    var lnG = w.minus('0.5').mul(w.ln()).minus(w).plus(PI.mul(2).ln().div(2));
    var invW2 = new D(1).div(w.mul(w)), invPow = new D(1).div(w);
    for (var k = 1; k <= BERNOULLI_EVEN.length; k++) {
      var bp = BERNOULLI_EVEN[k - 1];
      lnG = lnG.plus(new D(bp[0]).div(bp[1]).mul(invPow).div((2 * k) * (2 * k - 1)));
      invPow = invPow.mul(invW2);
    }
    return lnG.exp().div(shift);
  }

  /* 等价积分 / 未求值级数变形判定：
     对定积分题目而言，返回另一个未求值的定积分（int_0^1 ... dx、∫）或无穷级数（sum_...、∑）
     只是换元或级数重写，并非闭式结果，绝不能以高置信度冒充闭式误导用户。 */
  function isIntegralOrSumForm(formula, fullText) {
    var f = String(formula || '');
    var t = String(fullText || '');
    if (/\bint(?:_|\s*\^|\s*0|\s*-inf|\s*\\limits)/i.test(f) || /∫/.test(f)) return true;
    if (/\bsum(?:_|\s*\^|\s*\()/i.test(f) || /∑/.test(f)) return true;
    if (/积分\s*\/\s*求和数据库|integral\s*\/\s*sum/i.test(f) &&
        (/\bd[xtuv]\b|∫|∑|\bint\b|\bsum\b/i.test(f) || /integral|sum family/i.test(t))) {
      return true;
    }
    return false;
  }

  function isParametricForm(formula, fullText) {
    var f = String(formula || '');
    var t = String(fullText || '');
    return /α|\\alpha|三次有理比|degree-3 ratio|α 满足|α satisfies|α 为以下方程的根|α root of/i.test(t) ||
      /常数数据库|constant database|代数关系|algebraic relation/i.test(f) ||
      /=\s*0\s*$/.test(f.replace(/复制|copy/ig, '').trim());
  }

  function extractPolyInfo(formula) {
    var s = String(formula || '').replace(/复制|copy/ig, '').trim();
    var ci = s.indexOf('：');
    if (ci >= 0) s = s.slice(ci + 1).trim();
    else {
      var ci2 = s.indexOf(':');
      if (ci2 >= 0) s = s.slice(ci2 + 1).trim();
    }
    if (!/=\s*0\s*$/.test(s)) return { isPoly: false, deg: 0, maxCoeff: 0 };
    var lhs = s.replace(/=\s*0\s*$/, '');
    var maxDeg = 0;
    lhs.replace(/x\s*(?:\^\s*(\d+)|([²³⁴⁵⁶]))?/g, function (_m, d1, sup) {
      var d = d1 ? parseInt(d1, 10) : (sup ? ({ '²': 2, '³': 3, '⁴': 4, '⁵': 5, '⁶': 6 }[sup] || 1) : 1);
      if (d > maxDeg) maxDeg = d;
      return '';
    });
    var stripped = lhs.replace(/\^\s*\d+/g, '').replace(/[²³⁴⁵⁶]/g, '');
    var maxCoeff = 0;
    var ints = stripped.match(/\d+/g) || [];
    for (var i = 0; i < ints.length; i++) {
      var v = parseInt(ints[i], 10);
      if (v > maxCoeff) maxCoeff = v;
    }
    return { isPoly: true, deg: maxDeg || 1, maxCoeff: maxCoeff };
  }

  /* 52 位 Fail-Closed 高精度 Decimal 独立复核：
     覆盖 40+ 经典常数与任意 Γ(u)、sec/csc/cot、log₂/log₁₀/log_b、Cl₂(π/3)、Li₂、Ti₂ 与多项式根。
     任何在 >= 17.5 位下无法通过该复核的候选（含不透明超几何/L函数）一律 Fail-Closed 封顶 <= 35%；
     能算出但残差超 tol 者直接 1.0% 数学证伪。 */
  function evalRiesDec(exprStr, xDec, D) {
    var s = String(exprStr || '').trim();
    if (!s) return null;
    /* 处理 RIES 的 log|log|x||、log|x| 绝对值记法、空格参数、对数底与常用特殊常数下标记法 */
    s = s.replace(/log\|log\|([^|]+)\|\|/gi, 'ln(abs(ln(abs($1))))')
         .replace(/log\|([^|]+)\|/gi, 'ln(abs($1))')
         .replace(/ln\|([^|]+)\|/gi, 'ln(abs($1))')
         .replace(/\b(log|ln)\s+(√(?:\d+|[πeφγ])|π|pi|e|φ|γ|G|\d+(?:\.\d+)?)(?![a-zA-Z0-9_πφγ])/gi, '$1($2)')
         .replace(/Cl(?:₂|_?2)(?![a-zA-Z0-9_])/gi, 'cl2')
         .replace(/Li(?:₂|_?2)(?![a-zA-Z0-9_])/gi, 'li2')
         .replace(/Ti(?:₂|_?2)(?![a-zA-Z0-9_])/gi, 'ti2')
         .replace(/K(?:₀|_?0)(?![a-zA-Z0-9_])/g, 'khinchin')
         .replace(/log(?:₂|_2)(?![a-zA-Z0-9_])/gi, 'log2')
         .replace(/log(?:₁₀|_10)(?![a-zA-Z0-9_])/gi, 'log10')
         .replace(/\blog_?\{?(\d+)\}?\(([^()]+)\)/gi, '(ln($2)/ln($1))')
         .replace(/([ζβ])_?([2-7])/g, '$1($2)')
         .replace(/([ζβ])([₂₃₄₅₆₇])/g, function (_m, f, sub) {
           return f + '(' + ({ '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7' }[sub]) + ')';
         });
    if (/[|]|∫|∑|α|₂F|₃F|₄F|₅F/.test(s) || /int_|sum_|\\alpha|_?[1-9]F[0-9]\b|\bL\s*\(\s*f\s*,|\b[AB]i\s*\(/i.test(s)) return null;

    var ts = [], i = 0;
    while (i < s.length) {
      var c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c)) {
        var m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
        if (!m) return null;
        ts.push({ t: 'num', v: m[0] }); i += m[0].length; continue;
      }
      if (c === '√') {
        i++;
        while (i < s.length && /\s/.test(s[i])) i++;
        if (s[i] === '(') {
          ts.push({ t: 'id', v: 'sqrt' });
        } else {
          /* √2、√π、√e 等无括号根号（数字和单字母π/φ/γ止，避免把 √2π 当成 √(2π)） */
          var mRad = /^(?:\d+\.?\d*|phi|pi|gamma|Catalan|[πφγe])/i.exec(s.slice(i));
          if (!mRad) return null;
          ts.push({ t: 'id', v: 'sqrt' }, { t: 'lp' });
          if (/^\d/.test(mRad[0])) ts.push({ t: 'num', v: mRad[0] });
          else ts.push({ t: 'id', v: mRad[0] });
          ts.push({ t: 'rp' });
          i += mRad[0].length;
        }
        continue;
      }
      if ('πφγζβΓϖ'.indexOf(c) >= 0) { ts.push({ t: 'id', v: c }); i++; continue; }
      if (/^(?:sinπ|cosπ|tanπ)/i.test(s.slice(i))) {
        ts.push({ t: 'id', v: s.slice(i, i + 4) }); i += 4; continue;
      }
      if (/[a-zA-Z]/.test(c)) {
        var m2 = /^[a-zA-Z][a-zA-Z0-9_]*/.exec(s.slice(i));
        ts.push({ t: 'id', v: m2[0] }); i += m2[0].length; continue;
      }
      if (c === '*' && s[i + 1] === '*') { ts.push({ t: 'op', v: '^' }); i += 2; continue; }
      if ('+-*/^'.indexOf(c) >= 0) { ts.push({ t: 'op', v: c }); i++; continue; }
      if (c === '−' || c === '–') { ts.push({ t: 'op', v: '-' }); i++; continue; }
      if (c === '·' || c === '×') { ts.push({ t: 'op', v: '*' }); i++; continue; }
      if (c === '²' || c === '³' || c === '⁴' || c === '⁵' || c === '⁶') {
        ts.push({ t: 'op', v: '^' }, { t: 'num', v: ({ '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6' })[c] });
        i++; continue;
      }
      if (c === '(') { ts.push({ t: 'lp' }); i++; continue; }
      if (c === ')') { ts.push({ t: 'rp' }); i++; continue; }
      if (c === ',') { ts.push({ t: 'comma' }); i++; continue; }
      return null;
    }

    var FN_NAMES = {
      sin: 1, cos: 1, tan: 1, sec: 1, csc: 1, cot: 1,
      asin: 1, acos: 1, atan: 1,
      sinh: 1, cosh: 1, tanh: 1, asinh: 1, acosh: 1, atanh: 1,
      sinpi: 1, cospi: 1, tanpi: 1, 'sinπ': 1, 'cosπ': 1, 'tanπ': 1,
      exp: 1, ln: 1, log: 1, log2: 1, log10: 1,
      sqrt: 1, cbrt: 1, abs: 1, root: 1, pow: 1,
      zeta: 1, 'ζ': 1, beta: 1, 'β': 1, gamma: 1, 'Γ': 1,
      cl2: 1, li2: 1, ti2: 1
    };
    function isFnTok(v) { return !!(FN_NAMES[v] || FN_NAMES[v.toLowerCase()]); }
    var toks = [];
    for (var k = 0; k < ts.length; k++) {
      var prev = toks.length ? toks[toks.length - 1] : null;
      var cur = ts[k];
      if (prev && (prev.t === 'num' || prev.t === 'rp' || (prev.t === 'id' && !isFnTok(prev.v))) &&
          (cur.t === 'id' || cur.t === 'lp' || cur.t === 'num')) {
        toks.push({ t: 'op', v: '*' });
      }
      toks.push(cur);
    }

    var C55 = (PSLQ && typeof PSLQ.getConstants === 'function') ? PSLQ.getConstants(D) : null;
    var PI = C55 ? C55.pi : D.acos(-1);
    var E_CONST = C55 ? C55.e : new D(1).exp();
    var PHI = C55 ? C55.phi : new D(5).sqrt().plus(1).div(2);
    var GAMMA = C55 ? C55.gamma : new D(VERIFIED_FALLBACK.gamma);
    var CATALAN = C55 ? C55.G : new D(VERIFIED_FALLBACK.G);
    var ZETA2 = C55 ? C55.zeta2 : PI.pow(2).div(6);
    var ZETA3 = C55 ? C55.zeta3 : new D(VERIFIED_FALLBACK.zeta3);
    var ZETA4 = C55 ? C55.zeta4 : PI.pow(4).div(90);
    var ZETA5 = C55 ? C55.zeta5 : new D(VERIFIED_FALLBACK.zeta5);
    var ZETA6 = C55 ? C55.zeta6 : PI.pow(6).div(945);
    var ZETA7 = C55 ? C55.zeta7 : new D(VERIFIED_FALLBACK.zeta7);
    var BETA3 = C55 ? C55.beta3 : PI.pow(3).div(32);
    var BETA4 = C55 ? C55.beta4 : new D(VERIFIED_FALLBACK.beta4);
    var BETA5 = C55 ? C55.beta5 : PI.pow(5).mul(5).div(1536);
    var CL2_PI3 = C55 ? C55.cl2pi3 : new D(VERIFIED_FALLBACK.cl2pi3);
    var LI2_HALF = C55 ? C55.li2half : ZETA2.div(2).minus(new D(2).ln().pow(2).div(2));
    var GLAISHER = C55 ? C55.glaisher : new D(VERIFIED_FALLBACK.glaisher);
    var KHINCHIN = C55 ? C55.khinchin : new D(VERIFIED_FALLBACK.khinchin);
    var LEMNISCATE = C55 ? C55.lemniscate : new D(VERIFIED_FALLBACK.gamma14).pow(2).div(PI.mul(2).sqrt().mul(2));
    var LN2 = C55 ? C55.ln2 : new D(2).ln();
    var LN10 = C55 ? C55.ln10 : new D(10).ln();

    var pos = 0;
    function peek() { return toks[pos]; }
    function parseExpr() {
      var v = parseTerm();
      if (!v) return null;
      while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
        var op = toks[pos++].v;
        var r = parseTerm();
        if (!r) return null;
        v = op === '+' ? v.plus(r) : v.minus(r);
      }
      return v;
    }
    function parseTerm() {
      var v = parseUnary();
      if (!v) return null;
      while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
        var op = toks[pos++].v;
        var r = parseUnary();
        if (!r) return null;
        if (op === '/' && r.isZero()) return null;
        v = op === '*' ? v.mul(r) : v.div(r);
      }
      return v;
    }
    function parseUnary() {
      if (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
        var op = toks[pos++].v;
        var u = parseUnary();
        if (!u) return null;
        return op === '-' ? u.neg() : u;
      }
      return parsePow();
    }
    function parsePow() {
      var base = parseAtom();
      if (!base) return null;
      if (peek() && peek().t === 'op' && peek().v === '^') {
        pos++;
        var ex = parseUnary();
        if (!ex) return null;
        if (base.isNeg() && !ex.isInteger()) return null;
        return base.pow(ex);
      }
      return base;
    }
    function parseAtom() {
      var tk = peek();
      if (!tk) return null;
      if (tk.t === 'num') { pos++; return new D(tk.v); }
      if (tk.t === 'lp') {
        pos++;
        var inner = parseExpr();
        if (!inner || !peek() || peek().t !== 'rp') return null;
        pos++;
        return inner;
      }
      if (tk.t === 'id') {
        pos++;
        var raw = tk.v, low = raw.toLowerCase();
        if (peek() && peek().t === 'lp') {
          if (!isFnTok(raw)) return null;
          pos++;
          var args = [];
          if (!(peek() && peek().t === 'rp')) {
            var a0 = parseExpr(); if (!a0) return null; args.push(a0);
            while (peek() && peek().t === 'comma') {
              pos++;
              var ai = parseExpr(); if (!ai) return null; args.push(ai);
            }
          }
          if (!peek() || peek().t !== 'rp') return null;
          pos++;
          if (args.length === 1) {
            var u = args[0];
            if (low === 'sqrt') return u.isNeg() ? null : u.sqrt();
            if (low === 'cbrt') return u.cbrt();
            if (low === 'abs') return u.abs();
            if (low === 'exp') return u.abs().gt(1e4) ? null : u.exp();
            if (low === 'ln' || low === 'log') return u.lte(0) ? null : u.ln();
            if (low === 'log2') return u.lte(0) ? null : u.ln().div(LN2);
            if (low === 'log10') return u.lte(0) ? null : u.ln().div(LN10);
            if (low === 'sin') return u.sin();
            if (low === 'cos') return u.cos();
            if (low === 'tan') return u.tan();
            if (low === 'sec') { var c1 = u.cos(); return c1.isZero() ? null : new D(1).div(c1); }
            if (low === 'csc') { var s1 = u.sin(); return s1.isZero() ? null : new D(1).div(s1); }
            if (low === 'cot') { var s2 = u.sin(); return s2.isZero() ? null : u.cos().div(s2); }
            if (low === 'sinpi' || low === 'sinπ') return u.mul(PI).sin();
            if (low === 'cospi' || low === 'cosπ') return u.mul(PI).cos();
            if (low === 'tanpi' || low === 'tanπ') return u.mul(PI).tan();
            if (low === 'asin') return u.abs().gt(1) ? null : u.asin();
            if (low === 'acos') return u.abs().gt(1) ? null : u.acos();
            if (low === 'atan') return u.atan();
            if (low === 'sinh') return u.sinh();
            if (low === 'cosh') return u.cosh();
            if (low === 'tanh') return u.tanh();
            if (low === 'asinh') return u.asinh();
            if (low === 'acosh') return u.lt(1) ? null : u.acosh();
            if (low === 'atanh') return u.abs().gte(1) ? null : u.atanh();
            if (low === 'zeta' || raw === 'ζ') {
              var zn = Math.round(u.toNumber());
              if (!u.minus(zn).abs().lt('1e-40')) return null;
              return ({ 2: ZETA2, 3: ZETA3, 4: ZETA4, 5: ZETA5, 6: ZETA6, 7: ZETA7 })[zn] || null;
            }
            if (low === 'beta' || raw === 'β') {
              var bn = Math.round(u.toNumber());
              if (!u.minus(bn).abs().lt('1e-40')) return null;
              return ({ 2: CATALAN, 3: BETA3, 4: BETA4, 5: BETA5 })[bn] || null;
            }
            if (raw === 'Γ' || low === 'gamma') {
              return (PSLQ && PSLQ.decGamma) ? PSLQ.decGamma(u, D) : fallbackDecGamma(u, D);
            }
            if (low === 'cl2') {
              if (u.isZero()) return new D(0);
              if (u.minus(PI.div(3)).abs().lt('1e-40')) return CL2_PI3;
              if (u.plus(PI.div(3)).abs().lt('1e-40')) return CL2_PI3.neg();
              if (u.minus(PI.div(2)).abs().lt('1e-40')) return CATALAN;
              if (u.plus(PI.div(2)).abs().lt('1e-40')) return CATALAN.neg();
              return null;
            }
            if (low === 'li2') {
              if (u.isZero()) return new D(0);
              if (u.minus(1).abs().lt('1e-40')) return ZETA2;
              if (u.plus(1).abs().lt('1e-40')) return ZETA2.div(-2);
              if (u.minus('0.5').abs().lt('1e-40')) return LI2_HALF;
              if (u.abs().lte('0.65')) {
                var sumL = new D(0), powL = u;
                for (var lk = 1; lk <= 240; lk++) {
                  var termL = powL.div(lk * lk);
                  sumL = sumL.plus(termL);
                  if (termL.abs().lt('1e-53')) break;
                  powL = powL.mul(u);
                }
                return sumL;
              }
              return null;
            }
            if (low === 'ti2') {
              if (u.isZero()) return new D(0);
              if (u.minus(1).abs().lt('1e-40')) return CATALAN;
              if (u.plus(1).abs().lt('1e-40')) return CATALAN.neg();
              if (u.abs().lte('0.65')) {
                var sumT = new D(0), powT = u, u2 = u.mul(u).neg();
                for (var tk2 = 0; tk2 <= 140; tk2++) {
                  var odd = 2 * tk2 + 1;
                  var termT = powT.div(odd * odd);
                  sumT = sumT.plus(termT);
                  if (termT.abs().lt('1e-53')) break;
                  powT = powT.mul(u2);
                }
                return sumT;
              }
              return null;
            }
            return null;
          }
          if (args.length === 2) {
            if (low === 'root') {
              /* RIES 中 root(a, b) 定义为 a^(1/b) */
              if (args[1].isZero()) return null;
              var invB = new D(1).div(args[1]);
              if (args[0].isNeg()) return null;
              return args[0].pow(invB);
            }
            if (low === 'pow') {
              if (args[0].isNeg() && !args[1].isInteger()) return null;
              return args[0].pow(args[1]);
            }
          }
          return null;
        }
        if (raw === 'x') return xDec;
        if (raw === 'G' || low === 'catalan') return CATALAN;
        if (low === 'pi' || raw === 'π') return PI;
        if (low === 'e') return E_CONST;
        if (low === 'phi' || raw === 'φ') return PHI;
        if (low === 'gamma' || raw === 'γ') return GAMMA;
        if (low === 'glaisher') return GLAISHER;
        if (low === 'khinchin') return KHINCHIN;
        if (low === 'lemniscate' || raw === 'ϖ') return LEMNISCATE;
        if (low === 'apery' || low === 'apéry') return ZETA3;
        return null;
      }
      return null;
    }

    try {
      var res = parseExpr();
      if (!res || pos !== toks.length || !res.isFinite()) return null;
      return res;
    } catch (e) {
      return null;
    }
  }

  function hpVerifyCandidate(formula, lastInfo) {
    var D = (typeof Decimal !== 'undefined' ? Decimal : (global && global.Decimal)) || null;
    if (!D || !lastInfo || !lastInfo.valueText || !(lastInfo.digits >= 17.5)) return null;
    var s = String(formula || '').replace(/复制|copy/ig, '').trim();
    var ci = s.indexOf('：');
    if (ci >= 0) s = s.slice(ci + 1).trim();
    else {
      var ci2 = s.indexOf(':');
      if (ci2 >= 0) s = s.slice(ci2 + 1).trim();
    }
    var eqIdx = s.indexOf('≈');
    if (eqIdx < 0) eqIdx = s.indexOf('=');
    if (eqIdx < 0) return null;
    var lhsStr = s.slice(0, eqIdx).trim();
    var rhsStr = s.slice(eqIdx + 1).trim();
    if (!lhsStr || !rhsStr || /[=≈]/.test(rhsStr)) return null;

    var oldPrec = D.precision;
    D.set({ precision: 52 });
    try {
      var xDec = new D(String(lastInfo.valueText));
      if (!xDec.isFinite()) return null;
      var absVal = Math.max(Math.abs(lastInfo.value), 1e-300);
      var hpErr = null;
      if (lhsStr.replace(/[()\s]/g, '') === 'x') {
        var rVal = evalRiesDec(rhsStr, xDec, D);
        if (!rVal) return null;
        hpErr = xDec.minus(rVal).abs().toNumber();
      } else {
        var l0 = evalRiesDec(lhsStr, xDec, D);
        var r0 = evalRiesDec(rhsStr, xDec, D);
        if (!l0 || !r0) return null;
        var res0 = l0.minus(r0).abs();
        var h = D.max(xDec.abs(), new D(1)).mul('1e-20');
        var lp = evalRiesDec(lhsStr, xDec.plus(h), D);
        var rp = evalRiesDec(rhsStr, xDec.plus(h), D);
        var lm = evalRiesDec(lhsStr, xDec.minus(h), D);
        var rm = evalRiesDec(rhsStr, xDec.minus(h), D);
        if (!lp || !rp || !lm || !rm) return null;
        var deriv = lp.minus(rp).minus(lm.minus(rm)).div(h.mul(2)).abs();
        if (deriv.lte('1e-12')) {
          if (res0.isZero()) hpErr = 0;
          else return null;
        } else {
          hpErr = res0.div(deriv).toNumber();
        }
      }
      if (!isFinite(hpErr)) return null;
      var sigEff = Math.max(lastInfo.sigma || 0, absVal * Math.pow(10, -Math.min(lastInfo.digits, 25)));
      var tol = Math.max(1e3 * sigEff, absVal * Math.pow(10, -Math.min(lastInfo.digits - 2, 22)));
      var matched = hpErr > 0 ? Math.max(0, -Math.log10(hpErr / absVal)) : Math.min(lastInfo.digits, 31);
      if (hpErr > tol) return { status: 'rejected', err: hpErr, matchedDigits: matched };
      return { status: 'passed', err: hpErr, matchedDigits: matched };
    } catch (e) {
      return null;
    } finally {
      D.set({ precision: oldPrec });
    }
  }

  /* ---------- 积分数学结构特征画像（先验约束 + 软过滤） ---------- */
  function isCanonicalBound(raw) {
    var s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/\s+/g, '');
    if (!s) return false;
    if (/^[+-]?(?:inf|infinity|∞)$/.test(s)) return true;
    if (/^[+-]?\d+$/.test(s)) return Math.abs(parseInt(s, 10)) <= 12;
    var mFrac = /^([+-]?\d+)\/(\d+)$/.exec(s);
    if (mFrac) return Math.abs(parseInt(mFrac[1], 10)) <= 12 && parseInt(mFrac[2], 10) >= 1 && parseInt(mFrac[2], 10) <= 12;
    if (/^[+-]?(?:0\.5|0\.25|0\.75|1\.5|2\.5)$/.test(s)) return true;
    return /^[+-]?(?:(?:2\*?|3\*?)?(?:pi|π)|(?:pi|π)\/[2346]|3\*?(?:pi|π)\/2|e|1\/e|e\^-1|ln\(2\)|log\(2\)|ln2|log2|sqrt\(2\)|sqrt\(3\)|√2|√3|phi|φ)$/.test(s);
  }

  function analyzeIntegralProfile(src, aRaw, bRaw, slopes) {
    var s = String(src || '');
    var aClean = String(aRaw == null ? '' : aRaw), bClean = String(bRaw == null ? '' : bRaw);
    var boundsCanonical = isCanonicalBound(aClean) && isCanonicalBound(bClean);
    var floats = s.match(/\d+\.\d+/g) || [];
    var hasArbitraryCoeff = floats.some(function (tok) {
      return !/^(?:0\.5|0\.25|0\.75|1\.5|2\.5)$/.test(tok);
    });
    var sNoSci = s.replace(/\d+(?:\.\d+)?[eE][+-]?\d+/g, '0');
    var hasExp = /\bexp\s*\(|(?:^|[^0-9a-zA-Z.])e(?:\s*\^|(?![a-zA-Z0-9_]))/i.test(sNoSci);
    var hasLog = /\b(?:ln|log|log10|log2)\s*\(/i.test(s);
    var hasNestedLog = /(?:ln|log)\s*\([^)]*(?:ln|log|sin|cos|tan|1\s*\+|1\s*-|abs)/i.test(s);
    var hasTrig = /\b(?:sin|cos|tan|sec|csc|cot)\s*\(/i.test(s);
    var hasInvTrig = /\b(?:asin|acos|atan|asinh|acosh|atanh|sinh|cosh|tanh|arcsin|arccos|arctan|arctanh)\s*\(/i.test(s);
    var hasKink = /\b(?:abs|sign|min|max|floor|ceil)\s*\(/i.test(s);
    var hasInfBound = /inf|∞/i.test(aClean + ' ' + bClean);
    var hasFracPow = /\bsqrt\s*\(|\^\s*\(?\s*-?\s*\d+\s*\/\s*\d+|\^\s*\(?\s*-?\s*0\.\d+/i.test(s);
    if (slopes && ((slopes.lo && slopes.lo < -0.05) || (slopes.hi && slopes.hi < -0.05))) hasFracPow = true;
    var isPureRational = !hasExp && !hasLog && !hasTrig && !hasInvTrig && !hasKink && !hasFracPow;
    return {
      boundsCanonical: boundsCanonical,
      hasArbitraryCoeff: hasArbitraryCoeff,
      explicitConsts: {
        pi: /(?:^|[^a-zA-Z])(?:pi|π)(?![a-zA-Z])/i.test(s),
        e: hasExp,
        ln2: /\b(?:ln|log)\s*\(\s*2\s*\)/.test(s),
        sqrt2: /sqrt\s*\(\s*2\s*\)|√2/i.test(s),
        sqrt3: /sqrt\s*\(\s*3\s*\)|√3/i.test(s),
        sqrt5: /sqrt\s*\(\s*5\s*\)|√5/i.test(s),
        phi: /(?:^|[^a-zA-Z])(?:phi|φ)(?![a-zA-Z])/i.test(s),
        has5OrPhi: /\b5\b|sqrt\s*\(\s*5\s*\)|phi|φ/i.test(s)
      },
      hasExp: hasExp,
      hasLog: hasLog,
      hasNestedLog: hasNestedLog,
      hasTrig: hasTrig,
      hasInvTrig: hasInvTrig,
      hasKink: hasKink,
      hasInfBound: hasInfBound,
      hasFracPow: hasFracPow,
      isPureRational: isPureRational
    };
  }

  function extractFormulaBodyAndCore(formula) {
    var body = String(formula || '').replace(/复制|copy/ig, '').trim();
    var ci = body.indexOf('：');
    if (ci >= 0) body = body.slice(ci + 1).trim();
    else {
      var ci2 = body.indexOf(':');
      if (ci2 >= 0) body = body.slice(ci2 + 1).trim();
    }
    var cm = /^\s*x\s*[≈=]\s*([\s\S]*)$/.exec(body);
    var core = (cm ? cm[1] : body).trim();
    return { body: body, core: core };
  }

  function structDelta(formula, profile, hpPassed) {
    if (!profile) return 0;
    var parts = extractFormulaBodyAndCore(formula);
    var body = parts.body;
    /* 去除科学记数法与函数名中的 'e'，仅保留真正出现的自然常数 e */
    var strippedE = body.replace(/\d+(?:\.\d+)?[eE][+-]?\d+/g, '')
                        .replace(/\b(?:exp|sec|zeta|beta|glaisher|khinchin|lemniscate|apery)\b/gi, '');
    var hasEConst = /(?:^|[^a-zA-Z0-9_])e(?![a-zA-Z0-9_])/.test(strippedE);
    var strippedGammaFn = body.replace(/Γ\s*\([^)]*\)/g, '').replace(/\bgamma\s*\(/gi, '');
    var hasEulerGamma = /γ|\bgamma\b/i.test(strippedGammaFn);
    var hasPhi = /φ|\bphi\b/i.test(body);
    var hasGZetaCl = /\bG\b|Catalan|ζ\s*\(|zeta\s*\(|Cl(?:₂|_?2)|Li(?:₂|_?2)|β\s*\(|beta\s*\(/i.test(body);
    var hasGammaFn = /Γ\s*\(|Gamma\s*\(/i.test(body);
    var hasRare = /Glaisher|Khinchin|K(?:₀|_?0)|lemniscate|ϖ|₂F|₃F|_?[1-9]F[0-9]\b|L\s*\(\s*f\s*,|[AB]i\s*\(/i.test(body);
    var hasPi = /π|\bpi\b/i.test(body);
    var hasLn = /\b(?:ln|log)\b/i.test(body);

    var pen = 0, bonus = 0;
    if (hasEConst && !(profile.hasExp || (profile.hasTrig && profile.hasInfBound))) pen += 1.2;
    if (hasEulerGamma && !(profile.hasExp || profile.hasLog || profile.hasInfBound)) pen += 1.5;
    if (hasPhi && !(profile.explicitConsts && profile.explicitConsts.has5OrPhi)) pen += 1.5;
    if (hasGZetaCl && profile.isPureRational) pen += 1.4;
    if (hasGammaFn && !(profile.hasFracPow || profile.hasExp || profile.hasInfBound || profile.hasTrig)) pen += 1.2;
    if (hasRare && !hpPassed) pen += 1.5;

    if (hasPi && (profile.hasTrig || profile.hasInvTrig || (profile.explicitConsts && profile.explicitConsts.pi) || profile.hasInfBound || profile.hasFracPow)) bonus += 0.35;
    if (hasLn && (profile.hasLog || profile.hasKink || profile.hasExp || profile.hasInvTrig)) bonus += 0.25;
    if (hasEConst && profile.hasExp) bonus += 0.25;
    if (hasGZetaCl && (profile.hasLog || profile.hasInvTrig || profile.hasTrig)) bonus += 0.20;
    bonus = Math.min(0.8, bonus);

    var effPen = hpPassed ? 0.4 * pen : pen;
    return Math.max(-3.0, Math.min(0.8, bonus - effPen));
  }

  /* ---------- 统一 MDL（最小描述长度）+ 贝叶斯后验评分 ---------- */
  function modelComplexityDigits(formula, terms, height, source) {
    var f = String(formula || '');
    var parts = extractFormulaBodyAndCore(f);
    var core = parts.core;
    var coreClean = core
      .replace(/Cl(?:₂|_?2)|Li(?:₂|_?2)|Ti(?:₂|_?2)|K(?:₀|_?0)/gi, 'Cconst')
      .replace(/log(?:₂|_2|₁₀|_10)/gi, 'logFn')
      .replace(/[ζβ][₂₃₄₅₆₇]/g, 'Zconst');
    /* 1. 整数描述长度 ∑ log10(2|n|+1) + 高度下界 */
    var intCost = 0;
    var intMatches = coreClean.match(/\d+/g) || [];
    for (var i = 0; i < intMatches.length; i++) {
      var n = parseInt(intMatches[i], 10);
      if (isFinite(n) && n >= 0) intCost += Math.log10(2 * n + 1);
    }
    if ((height || 0) > 1) {
      intCost = Math.max(intCost, Math.log10(2 * height + 1));
    }

    /* 2. 常数词汇表代价 */
    var vocabCost = 0;
    if (/π|\bpi\b/i.test(core)) vocabCost += 1.0;
    var coreNoSci = core.replace(/\d+(?:\.\d+)?[eE][+-]?\d+/g, '')
                        .replace(/\b(?:exp|sec|zeta|beta|glaisher|khinchin|lemniscate|apery)\b/gi, '');
    if (/(?:^|[^a-zA-Z0-9_])e(?![a-zA-Z0-9_])/.test(coreNoSci)) vocabCost += 1.2;
    if (/φ|\bphi\b/i.test(core)) vocabCost += 1.3;
    var coreNoGammaFn = core.replace(/Γ\s*\([^)]*\)/g, '').replace(/\bgamma\s*\(/gi, '');
    if (/γ|\bgamma\b/i.test(coreNoGammaFn)) vocabCost += 1.6;
    if (/\bG\b|Catalan/i.test(core)) vocabCost += 1.7;
    if (/ζ|zeta\(/i.test(core)) vocabCost += 1.8;
    if (/β|beta\(/i.test(core)) vocabCost += 2.0;
    if (/Γ\(|Gamma\(/i.test(core)) vocabCost += 1.9;
    if (/Cl₂|Clausen|Li₂|Ti₂|cl2|li2|ti2/i.test(core)) vocabCost += 2.2;
    if (/Glaisher|Khinchin|K₀|lemniscate|ϖ|₂F|₃F|_?[1-9]F[0-9]\b|L\s*\(\s*f\s*,|[AB]i\s*\(/i.test(core)) vocabCost += 3.2;

    /* 3. 运算符 / 超越函数与公式长度代价 */
    var fnMatches = core.match(/\b(?:sinpi|cospi|tanpi|sinπ|cosπ|tanπ|asinh|acosh|atanh|sinh|cosh|tanh|asin|acos|atan|sin|cos|tan|sec|csc|cot|exp|ln|log|log2|log10|sqrt|cbrt|root|pow)\b|√/gi) || [];
    var supMatches = core.match(/[²³⁴⁵⁶]/g) || [];
    var opCost = 0.75 * fnMatches.length + 0.4 * supMatches.length + 0.5 * Math.max(0, (terms || 1) - 1);
    var lenNoSpace = core.replace(/\s+/g, '').length;
    if (lenNoSpace > 16) opCost += 0.03 * (lenNoSpace - 16);

    /* 4. 搜索空间多重性折减（依来源与模块自由度标定） */
    var modCost = 2.5;
    if (source === 'pslq' || /^高精度\s*(?:PSLQ|代数关系)/.test(f)) {
      var polyInfo = extractPolyInfo(f);
      if (polyInfo.isPoly) modCost = 1.5 + 1.0 * Math.max(0, polyInfo.deg - 1);
      else modCost = 1.0 + 0.5 * Math.max(0, (terms || 1) - 1);
    } else if (/对数组合关系|log-combination|log\|c\|/i.test(f)) {
      modCost = 3.5 + 0.7 * Math.max(0, (terms || 2) - 2);
    } else if (/Möbius 关系|Möbius relation/i.test(f)) {
      modCost = 3.5 + ((height || 0) > 40 ? 1.0 : 0);
    } else if (/线性组合|linear combo/i.test(f)) {
      modCost = 1.5 + 0.8 * Math.max(0, (terms || 1) - 1);
    } else if (/常数数据库|硬常数数据库|超几何|L 函数有理比|constant database|hard constant|hypergeometric|L-rational/i.test(f)) {
      modCost = 4.0;
    } else if (/代数关系|algebraic relation/i.test(f) || extractPolyInfo(f).isPoly) {
      var pInfo = extractPolyInfo(f);
      modCost = 1.8 + 1.0 * Math.max(0, pInfo.deg - 1);
    }

    return intCost + vocabCost + opCost + modCost;
  }

  function parseSimpleRational(coreStr) {
    var t = String(coreStr || '').replace(/−/g, '-').replace(/\s+/g, '');
    var m = /^([+-]?\d+)(?:\/(\d+))?$/.exec(t);
    if (!m) return NaN;
    var num = parseInt(m[1], 10);
    var den = m[2] ? parseInt(m[2], 10) : 1;
    if (!isFinite(num) || !isFinite(den) || den <= 0) return NaN;
    return num / den;
  }

  function scoreCandidateDetailed(rel, formula, sigma, value, verified, terms, parametric, height, inputDigits, integralForm, hpCheck, profile, source) {
    var cModel = modelComplexityDigits(formula, terms, height, source);
    if (integralForm) return { p: 0, surplus: -99, mdlCost: cModel, deltaStruct: 0, dEff: 0 };
    if (hpCheck && hpCheck.status === 'rejected') return { p: 0.01, surplus: -99, mdlCost: cModel, deltaStruct: 0, dEff: 0 };
    if (!verified || !isFinite(rel) || !isFinite(value) || value === 0) return { p: 0.01, surplus: -99, mdlCost: cModel, deltaStruct: 0, dEff: 0 };

    var inDig = isFinite(inputDigits) ? Math.max(0, inputDigits) : 17;
    var hpPassed = !!(hpCheck && hpCheck.status === 'passed');
    var parts = extractFormulaBodyAndCore(formula);
    var ratVal = parseSimpleRational(parts.core);
    var isExactRationalMatch = (rel === 0) && isFinite(ratVal) &&
      Math.abs(ratVal - value) <= Math.max(2 * Math.max(sigma || 0, 0), 1e-12 * Math.abs(value));

    var dEff;
    if (hpPassed) {
      dEff = Math.min(hpCheck.matchedDigits, Math.max(inDig, 15));
    } else if (isExactRationalMatch) {
      dEff = Math.max(inDig, 17);
    } else {
      dEff = Math.min(-Math.log10(Math.max(rel, 1e-16)), inDig, 15.5);
    }

    var effErr = hpPassed ? Math.max(hpCheck.err || 0, 0) : Math.max(rel * Math.abs(value), 0);
    var rho = Math.max(effErr / Math.max(sigma || 0, 1e-30), 1e-12);
    var deltaStruct = structDelta(formula, profile, hpPassed);
    var b0 = 2.0 +
      (profile && profile.boundsCanonical === false ? 2.5 : 0) +
      (profile && profile.hasArbitraryCoeff ? 1.5 : 0);

    var surplus = dEff - cModel + deltaStruct - b0 - 0.25 * Math.log10(1 + rho);
    var p = Math.min(0.99, Math.max(0.01, sigmoid(1.15 * (surplus - 2.5))));

    /* Fail-Closed 安全封顶，绝不靠高概率误导用户 */
    var isMobiusOrComb = /Möbius 关系|Möbius relation|对数组合关系|log-combination|log\|c\|/i.test(formula);
    if (surplus <= 0) p = Math.min(p, 0.20);
    if (inDig >= 17.5 && !hpPassed) p = Math.min(p, 0.35);
    if (isMobiusOrComb && (height || 0) > 60 && !hpPassed) p = Math.min(p, 0.30);
    if (parametric) p = Math.min(p, 0.25);

    return { p: p, surplus: surplus, mdlCost: cModel, deltaStruct: deltaStruct, dEff: dEff };
  }

  function guessProbability(rel, formula, sigma, value, verified, terms, parametric, height, inputDigits, integralForm, hpCheck, profile, source) {
    return scoreCandidateDetailed(
      rel, formula, sigma, value, verified, terms, parametric, height, inputDigits, integralForm, hpCheck, profile, source
    ).p;
  }

  function candidateCanonKey(formula) {
    var parts = extractFormulaBodyAndCore(formula);
    return parts.core.replace(/\s+/g, '').replace(/·/g, '*').replace(/−/g, '-').replace(/log\(/gi, 'ln(');
  }

  /* 折叠 RIES 方程平凡变形重复行（如 (9/x)=(7e+4)、(9/(x+0))=(7e+4)、-((9/x))=-(7e+4)、(9/-(x))=-(7e+4)） */
  function riesEqDedupKey(formula, delta) {
    var f = String(formula || '');
    if (!/^RIES\s*(?:方程|equation)/i.test(f) || !isFinite(delta)) return null;
    var body = extractFormulaBodyAndCore(f).body
      .replace(/−/g, '-')
      .replace(/log\(/gi, 'ln(')
      .replace(/\b(x|0)\+0\b|\b0\+(x)\b|\b(x)-0\b/g, '$1$2$3')
      .replace(/[\s()+\-·*]+/g, '');
    var dTag = delta === 0 ? '0' : delta.toPrecision(7);
    return 'REQ:' + body + '|' + dTag;
  }

  function rankCandidates(rawRows, lastInfo) {
    var inputDigits = lastInfo.digits;
    var profile = lastInfo.profile || null;
    var rows = rawRows.slice(0, 250).map(function (r) {
      var source = r.source || 'ries';
      var integralForm = typeof r.integralForm === 'boolean' ? r.integralForm : isIntegralOrSumForm(r.formula, r.fullText);
      var polyInfo = extractPolyInfo(r.formula);
      var parametric = typeof r.parametric === 'boolean' ? r.parametric : isParametricForm(r.formula, r.fullText);
      var hpCheck = r.hpCheck || ((!integralForm && r.verified) ? hpVerifyCandidate(r.formula, lastInfo) : null);
      var hpRejected = !!(hpCheck && hpCheck.status === 'rejected');
      var rel = isFinite(r.delta) ? r.delta / Math.max(Math.abs(lastInfo.value), 1e-300) : NaN;
      var sc = scoreCandidateDetailed(
        rel, r.formula, lastInfo.sigma, lastInfo.value,
        r.verified, r.terms, parametric, r.height, inputDigits, integralForm, hpCheck, profile, source
      );
      /* 若低次（deg<=4, maxCoeff<=100）整系数多项式方程通过 52 位独立复核且 MDL 净压缩 >= 6 位，升级为真代数闭式 */
      if (!integralForm && !hpRejected && polyInfo.isPoly && hpCheck && hpCheck.status === 'passed' &&
          (r.algebraicClosed || (polyInfo.deg <= 4 && polyInfo.maxCoeff <= 100))) {
        var scNoParam = scoreCandidateDetailed(
          rel, r.formula, lastInfo.sigma, lastInfo.value,
          r.verified, r.terms, false, r.height, inputDigits, integralForm, hpCheck, profile, source
        );
        if (scNoParam.surplus >= 6.0) {
          parametric = false;
          sc = scNoParam;
        }
      }
      var nonClosed = parametric || integralForm || hpRejected;
      return {
        formula: r.formula, valueText: r.valueText, errText: r.errText,
        delta: r.delta, verified: r.verified, terms: r.terms, height: r.height,
        source: source, parametric: parametric, integralForm: integralForm,
        hpCheck: hpCheck, hpRejected: hpRejected, nonClosed: nonClosed,
        rel: rel, p: sc.p, surplus: sc.surplus, mdlCost: sc.mdlCost
      };
    });
    /* 通过复核的排前面；真闭式优先于等价积分变形、高精度否决项与参数化拟合；同组内 hpPassed 优先，再按概率降序、MDL 复杂度升序 */
    rows.sort(function (a, b) {
      if (a.verified !== b.verified) return a.verified ? -1 : 1;
      if (a.nonClosed !== b.nonClosed) return a.nonClosed ? 1 : -1;
      if (!a.nonClosed && inputDigits >= 17.5) {
        var aPass = !!(a.hpCheck && a.hpCheck.status === 'passed');
        var bPass = !!(b.hpCheck && b.hpCheck.status === 'passed');
        if (aPass !== bPass) return aPass ? -1 : 1;
      }
      if (a.nonClosed && a.hpRejected !== b.hpRejected) return a.hpRejected ? 1 : -1;
      if (a.nonClosed && a.integralForm !== b.integralForm) return a.integralForm ? -1 : 1;
      if (Math.abs((b.p || 0) - (a.p || 0)) > 1e-4) return (b.p || 0) - (a.p || 0);
      if (Math.abs((a.mdlCost || 0) - (b.mdlCost || 0)) > 0.25) return (a.mdlCost || 0) - (b.mdlCost || 0);
      if (Math.abs((a.delta || 0) - (b.delta || 0)) > 1e-15) return (a.delta || 0) - (b.delta || 0);
      return a.formula.length - b.formula.length;
    });
    /* PSLQ 与 RIES 同构去重，以及 RIES 方程平凡变形（-(-(x)) / x+0）去重 */
    var seenCanon = Object.create(null);
    var deduped = [];
    for (var ri = 0; ri < rows.length; ri++) {
      var row = rows[ri];
      var cKey = (row.nonClosed ? 'N:' : 'C:') + candidateCanonKey(row.formula);
      if (seenCanon[cKey]) continue;
      var rKey = riesEqDedupKey(row.formula, row.delta);
      if (rKey) {
        rKey = (row.nonClosed ? 'N:' : 'C:') + rKey;
        if (seenCanon[rKey]) continue;
        seenCanon[rKey] = true;
      }
      seenCanon[cKey] = true;
      deduped.push(row);
    }
    var closed = deduped.filter(function (r) { return !r.nonClosed; });
    var hasReliableClosed = closed.some(function (r) {
      return r.verified && r.p >= 0.65 && (inputDigits < 17.5 || (r.hpCheck && r.hpCheck.status === 'passed'));
    });
    var good = closed.slice(0, 12);
    var equivInt = deduped.filter(function (r) { return r.integralForm; }).slice(0, 2);
    var allRejected = deduped.filter(function (r) { return r.hpRejected && !r.integralForm; });
    var rejected = allRejected.slice(0, 3);
    var param = deduped.filter(function (r) { return r.parametric && !r.integralForm && !r.hpRejected; }).slice(0, 3);
    return {
      rows: good.concat(equivInt, rejected, param),
      hasReliableClosed: hasReliableClosed,
      closedCount: closed.length,
      equivIntCount: equivInt.length,
      hpRejectedCount: allRejected.length
    };
  }

  /* 依据本次数值的有效位数，调整哪些模块参与搜索。
     注意：只做提示，不真的关模块。早期版本在位数 <8 时把线性组合也关掉，
     结果旗舰例题 (π + 9·ln2)/24 直接消失 —— 位数低只说明「不能确信」，
     不说明「不该去搜」，搜不搜和信不信是两件事。 */
  function precisionNotice(digits) {
    if (!isFinite(digits)) return '';
    if (digits >= 12) return '';
    if (digits >= 8) return '；本次数值约 ' + digits.toFixed(1) + ' 位，闭式结论按该精度打折看待';
    return '；本次数值仅 ' + digits.toFixed(1) + ' 位，闭式候选可能是巧合，请优先看「独立复核」列';
  }

  function describeSettingsEffect(targetDigits, closedEnabled) {
    var raw = Number(targetDigits);
    var td = (raw === 12 || raw === 18 || raw === 25 || raw === 35) ? raw : 25;
    var closed = closedEnabled !== false;
    var buttonText = closed ? '计算并求闭式' : '计算定积分';
    if (!closed) {
      var speedDesc = td <= 12 ? '极快响应（通常 < 30 ms），适合快速预览。'
                    : td <= 18 ? '速度较快，约双精度上限。'
                    : td <= 25 ? '平衡精度与速度，结果约 25 位有效数字。'
                    : '超深求积（可达约 35 位高精度展示），后台运行耗时明显增加，可随时停止。';
      return {
        targetDigits: td,
        closedEnabled: false,
        level: 'info',
        buttonText: buttonText,
        summary: '纯数值模式 · 目标 ' + td + ' 位（闭式搜索已关闭）',
        details: '只计算定积分数值、保守误差 ±σ 与发散/振荡诊断；跳过符号反导数、确定性 PSLQ 与 RIES，不再给出闭式猜想或「推测概率」。' + speedDesc
      };
    }
    if (td <= 12) {
      return {
        targetDigits: td,
        closedEnabled: true,
        level: 'warn',
        buttonText: buttonText,
        summary: '低精度警告 · 仅 RIES 双精度猜想（确定性 PSLQ 已禁用）',
        details: '12 位目标低于 14.5 位门槛：确定性 BigInt PSLQ 不会启动（高系数线性组合如 (π+9·ln2)/24 极可能漏检）；52 位 Fail-Closed 强复核亦难拦截低位巧合，结果仅供参考。'
      };
    }
    if (td <= 18) {
      return {
        targetDigits: td,
        closedEnabled: true,
        level: 'info',
        buttonText: buttonText,
        summary: '较快闭式档 · 18 位数值 + 基础 PSLQ + RIES',
        details: '速度快且开启 PSLQ 与 RIES；但相对 25 位少 7 位冗余，接近 17.5 位 Fail-Closed 阈值边界且 PSLQ 可用定标较浅（≤14 位），复杂线性组合可能漏检，推荐常规使用 25 位。'
      };
    }
    if (td <= 25) {
      return {
        targetDigits: td,
        closedEnabled: true,
        level: 'ok',
        buttonText: buttonText,
        summary: '推荐平衡档 · 25 位数值 + 三支柱全开（PSLQ + 52 位 Fail-Closed）',
        details: '默认推荐：在后台 Worker 跑完与桌面一致的高精度预算（不卡顿主界面），满足 PSLQ 深定标与 ≥17.5 位 52 位独立复核硬门槛，兼顾召回率与防误导。'
      };
    }
    return {
      targetDigits: td,
      closedEnabled: true,
      level: 'info',
      buttonText: buttonText,
      summary: '超高精度档 · 35 位数值 + 深度 PSLQ（耗时显著增加）',
      details: '开启超深求积级数与高精度工作区（结果最高展示 35 位），PSLQ 定标上限提升至 34 位以冲击高难度常数组合；手机或奇异/振荡函数可能需要数秒至十余秒，可随时点击「停止计算」。'
    };
  }

  /* ---------- 符号层展示 ---------- */

  function texBound(raw) {
    var s = String(raw).trim().toLowerCase().replace(/\s/g, '');
    if (s === 'inf' || s === '+inf' || s === 'infinity' || s === '∞' || s === '+∞') return '\\infty';
    if (s === '-inf' || s === '-infinity' || s === '-∞') return '-\\infty';
    if (s === 'pi' || s === 'π') return '\\pi';
    if (s === '-pi' || s === '-π') return '-\\pi';
    var m = /^(-?)pi\/(\d+)$/.exec(s);
    if (m) return (m[1] ? '-' : '') + '\\frac{\\pi}{' + m[2] + '}';
    m = /^(-?\d*\.?\d*)\*?pi$/.exec(s);
    if (m) return (m[1] === '' || m[1] === '1' ? '' : m[1]) + '\\pi';
    return s.replace(/π/g, '\\pi').replace(/\*/g, '\\cdot ');
  }

  function typeset(node) {
    var MJ = window.MathJax;
    if (!MJ) return;
    var run = function () {
      try { MJ.typesetPromise([node]).catch(function () {}); } catch (e) {}
    };
    if (MJ.startup && MJ.startup.promise) MJ.startup.promise.then(run); else run();
  }

  function renderSymbolic(sym, aRaw, bRaw) {
    if (!el.sym) return;
    var head = '\\int_{' + texBound(aRaw) + '}^{' + texBound(bRaw) + '} ' +
               (sym.integrandTeX || 'f(x)') + '\\,dx';
    /* exact 只是数值马甲时，别把十几位的分数画上去，直接显示小数 */
    if (sym.exactTeX && !sym.exactIsNumeric) head += ' = ' + sym.exactTeX;
    else if (sym.valueText) head += ' \\approx ' + sym.valueText;
    el.symEq.innerHTML = '\\(' + head + '\\)';
    /* 渲染成 SVG 后分数横线不进 textContent，留一份原始 TeX 便于断言与复制 */
    el.symEq.setAttribute('data-tex', head);
    el.symValue.textContent = sym.valueText ? '= ' + sym.valueText : '';

    var foot = [];
    if (sym.antiderivativeTeX) {
      foot.push('<div><b>F(x)</b> = \\(' + sym.antiderivativeTeX + '\\)</div>');
    }
    foot.push('<div>验证一：F′(x) 与 f(x) 在 9 个采样点上最大相对偏差 ' +
      sym.derivativeError.toExponential(1) + '，说明反导数正确。</div>');
    if (sym.crossError !== null) {
      foot.push('<div>验证二：与数值积分相差 ' + sym.crossError.toExponential(1) +
        '，两条独立路径一致。</div>');
    }
    if (!sym.exact) {
      foot.push('<div>定积分值未能化成符号闭式，下面仍走「数值 + 闭式搜索」。</div>');
    } else if (sym.exactIsNumeric) {
      foot.push('<div>定积分代入上下限后仅得到浮点近似值（符号引擎未化出精确闭式），下面仍走「数值 + 闭式搜索」。</div>');
    }
    el.symFoot.innerHTML = foot.join('');
    el.sym.hidden = false;
    typeset(el.sym);
  }

  function clearSymbolic() {
    if (!el.sym) return;
    el.sym.hidden = true;
    el.symEq.innerHTML = '';
    el.symValue.textContent = '';
    el.symFoot.innerHTML = '';
  }

  function renderNumeric(r, closedEnabled) {
    var closed = closedEnabled !== false;
    var badge = r.verdict === 'ok' ? '可积'
              : r.verdict === 'divergent' ? '疑似发散'
              : r.verdict === 'oscillatory' ? '振荡·不给数'
              : '不确定';
    var cls = r.verdict === 'ok' ? 'ok' : r.verdict === 'divergent' ? 'bad' : 'warn';
    var notes = r.notes.length
      ? '<ul class="ig-notes">' + r.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' : '';
    var noNumber = r.verdict === 'divergent' || r.verdict === 'oscillatory';
    var isZeroVal = !noNumber && (r.value === 0 || r.isNearZero);
    var numText = r.verdict === 'divergent' ? '拒绝给数（发散）'
                : r.verdict === 'oscillatory' ? '拒绝给数（振荡未收敛）'
                : isZeroVal ? '0'
                : esc(C.formatValue(r.value, r.sigma, r.valueText));
    var sigText = noNumber ? '不适用' : r.sigma.toExponential(3);
    var digText = noNumber ? '不适用' : r.digits.toFixed(1) + ' 位';
    var feedDigits = Math.max(6, Math.min(17, Math.floor(r.digits) + 1));
    var feedNote = r.verdict === 'divergent'
      ? '已跳过闭式搜索：对发散积分给小数是误导性的。'
      : r.verdict === 'oscillatory'
      ? '已跳过闭式搜索：振荡积分尚未收敛，给数会把误差当成信号喂给 RIES。'
      : !closed
      ? '纯数值模式：已按开关关闭闭式搜索，未调用符号层 / PSLQ / RIES。'
      : isZeroVal
      ? '数值在当前精度内为 0（已跳过闭式搜索，不把浮点噪声送入 RIES）。'
      : '送入闭式搜索的是 ' + feedDigits +
        ' 位有效数字（RIES 内部按双精度搜索），σ 是保守误差界，两者口径不同。';
    var metaParts = [];
    if (isFinite(r.targetDigits)) metaParts.push('目标 ' + r.targetDigits + ' 位');
    if (isFinite(r.elapsedMs)) metaParts.push('耗时 ' + r.elapsedMs + ' ms');
    var extraMeta = metaParts.length ? '（' + metaParts.join('，') + '）' : '';
    el.out.innerHTML =
      '<div class="ig-grid">' +
        '<div class="ig-cell"><span>数值结果</span><strong' + (noNumber ? ' class="ig-bad"' : '') + '>' + numText + '</strong></div>' +
        '<div class="ig-cell"><span>误差范围 ±σ</span><strong>' + sigText + '</strong></div>' +
        '<div class="ig-cell"><span>保守有效位</span><strong>' + digText + ' </strong></div>' +
        '<div class="ig-cell"><span>判定</span><strong class="ig-' + cls + '">' + badge + '</strong></div>' +
      '</div>' +
      '<p class="subtle-note">方法：' + esc(r.method || '—') + extraMeta + '。误差类型：' + esc(r.errorType) + '。' + feedNote +
      ' 区间映射：' + esc(r.transformLabel) +
      (r.valueText ? '；高精度层单独求值，见下方说明。' : '；函数求值 ' + r.evals + ' 次，分 ' + r.segments + ' 段。') +
      '</p>' + notes;
    el.result.hidden = false;
  }

  function readRiesRows() {
    var body = $('resultBody');
    if (!body) return [];
    var out = [];
    var seen = {};
    Array.prototype.forEach.call(body.querySelectorAll('tr'), function (tr) {
      var tds = tr.querySelectorAll('td');
      if (tds.length < 2) return;
      var formula = cleanText(tds[0].querySelector('code') || tds[0]);
      if (!formula || /输入目标数值|没有闭式候选|Enter a target|No RIES|colspan/i.test(formula)) return;
      /* 恒等式包装：拆掉「±x 的加加减减」，把答案本身留下来。
         直接丢弃会让 π/2 这类只被包装写法表示过的答案整个消失。 */
      var wrapC = tautologyCoefficient(formula);
      if (wrapC !== null) {
        var plain = unwrapFormula(formula, wrapC);
        if (plain) formula = plain;
      }
      /* 拆包装后可能与别的行重复，只留第一条 */
      var dedupKey = formula.replace(/\s+/g, '');
      if (seen[dedupKey]) return;
      seen[dedupKey] = true;
      /* 零技巧行（sinπ(整数) = 0）同一个左端只留一条，避免换个数就重复一行 */
      if (zeroTrickRhs(formula)) {
        var rootKey = 'root:' + lhsOf(formula).replace(/[()\s]/g, '');
        if (seen[rootKey]) return;
        seen[rootKey] = true;
      }
      var valueText = cleanText(tds[1].querySelector('.result-value-main') || tds[1]);
      var fullText = cleanText(tds[1]);   // 含折叠说明：α 的方程、c 的定义都在这里
      var errText = tds.length > 2 ? cleanText(tds[2]) : '';
      // 主来源：RIES 自己的误差列。旧版取 valueText 的第一个数字，
      // 而 Möbius / log|c| / 对数组合行首位是「目标 x 本身」→ 残差恒为机器精度 → 全部误判 99%。
      var delta = last ? parseErr(errText, last.value) : NaN;
      var predicted = candidatePredicted(valueText);
      var predDelta = (last && isFinite(predicted)) ? Math.abs(predicted - last.value) : NaN;
      var verified = isFinite(delta) && delta >= 0;
      // 交叉校验：候选自带预测值算出的差距若与误差列严重不符，判为不可信
      if (verified && isFinite(predDelta) && predDelta > Math.max(delta * 50, 1e-9)) verified = false;
      if (!isFinite(delta) && isFinite(predDelta)) { delta = predDelta; verified = true; }
      if (!verified && !isFinite(delta)) delta = NaN;
      var tm = /项数\s*(\d+)|terms\s*(\d+)/i.exec(fullText);
      var terms = tm ? parseInt(tm[1] || tm[2], 10) : 0;
      var hm = /高度\s*(\d+)|height\s*(\d+)/i.exec(fullText);
      var height = hm ? parseInt(hm[1] || hm[2], 10) : 0;
      // 参数化拟合：公式里藏了自由参数（α 由某个小系数多项式隐式定义、
      // c 从常数库挑），或整行只是一个整系数多项式 = 0 的根。
      // 这类行看着极短，实际自由度极高，12 位输入上凑出 13 位吻合很容易。
      // 注意：β(数字)/beta(数字) 不是自由参数 —— 引擎里它恒指 Dirichlet beta 常数值
      // （基底含 β(3)…β(6)，Catalan G 的释义就是 "Dirichlet beta beta(2)"）。
      // 早先把它当参数化特征，会把含 Catalan G 的真闭式 (π/2)ln2−G 误判成非闭式并封顶 30%。
      // 真正的自由参数一律用 α，由下面的 α / α-根语言 / 模块名 / 整系数多项式=0 兜住。
      var integralForm = isIntegralOrSumForm(formula, fullText);
      var parametric = isParametricForm(formula, fullText);
      out.push({ formula: formula, valueText: valueText, fullText: fullText, errText: errText,
                 delta: delta, verified: verified, terms: terms, height: height,
                 parametric: parametric, integralForm: integralForm });
    });
    return out;
  }

  function renderCandidates() {
    if (!last || riesTarget !== last || last.verdict === 'divergent' || last.verdict === 'oscillatory') return;
    if (!lastClosedEnabled) return;
    var inputDigits = last.digits;
    var ranked = rankCandidates(pslqRows.concat(readRiesRows()), last);
    var rows = ranked.rows;
    var stopBtn = $('stopBtn');
    var riesDone = !!(stopBtn && stopBtn.disabled);
    var toolsNode = $('resultTools');
    var riesAbortedEarly = !!(riesDone && toolsNode && toolsNode.hidden && rows.length > 0 && !pslqRows.length);
    if (!rows.length) {
      el.cand.hidden = true;
      if (riesDone) {
        setBusy(false);
        setStatus('闭式搜索完成：未找到可靠闭式结果，请以高精度数值结果为准。', 'warn');
      }
      return;
    }
    el.cand.hidden = false;
    var banner = '';
    if (!ranked.hasReliableClosed) {
      var reasonParts = [];
      if (riesAbortedEarly) reasonParts.push('RIES 阶段超时提前结束，当前仅保留早期低精度快照');
      if (ranked.hpRejectedCount > 0) reasonParts.push('52 位高精度复核已否决 ' + ranked.hpRejectedCount + ' 项 Float64 浮点巧合');
      if (ranked.equivIntCount > 0) reasonParts.push('等价积分/级数变形不计为闭式');
      var reason = reasonParts.length
        ? '（' + reasonParts.join('；') + '）'
        : '（未满足 MDL 净信息压缩阈值或 Fail-Closed 高精度复核门槛）';
      banner = '<tr><td colspan="4" class="ig-warn"><strong>未找到可靠闭式结果</strong>' + reason + '，以下条目仅供参考，请以高精度数值结果为准。</td></tr>';
    }
    el.candBody.innerHTML = banner + rows.map(function (r) {
      var prob = r.integralForm ? '非闭式' : r.hpRejected ? '已否决' : (r.p * 100).toFixed(1) + '%';
      var level = r.integralForm ? 'ig-warn' : r.hpRejected ? 'ig-bad' : (r.p >= 0.8 ? 'ig-ok' : r.p >= 0.45 ? 'ig-warn' : 'ig-bad');
      var check;
      if (r.integralForm) check = '等价积分/级数变形，非闭式（原积分换元形式，不计入闭式排名）';
      else if (r.hpRejected) check = '52 位复核否决（偏差 ' + r.hpCheck.err.toExponential(2) + '，远超 σ，确认为浮点巧合）';
      else if (!r.verified) check = '未取到可信残差，不评分';
      else if (r.parametric) check = '参数化拟合（含自由参数 α 或高次/高高度多项式），非闭式';
      else if (r.hpCheck && r.hpCheck.status === 'passed') {
        var surTxt = isFinite(r.surplus) ? ((r.surplus >= 0 ? '+' : '') + r.surplus.toFixed(1)) : '—';
        check = '52 位复核通过（匹配 ' + r.hpCheck.matchedDigits.toFixed(1) + ' 位，MDL 净压缩 ' + surTxt + ' 位）';
      } else if (isFinite(inputDigits) && inputDigits >= 17.5) {
        check = '未能进行 52 位独立复核（含未知函数或超范围表达式，Fail-Closed 已封顶 ≤35%）';
      } else if (r.rel <= 1e-10) {
        check = (isFinite(inputDigits) && inputDigits < 9.5)
          ? '匹配 ≥10 位，但数值仅 ' + inputDigits.toFixed(1) + ' 位，超出部分不计'
          : '匹配 ≥10 位（受低精度输入与 MDL 复杂度约束）';
      } else if (r.rel <= 1e-7) check = '匹配约 ' + (-Math.log10(r.rel)).toFixed(1) + ' 位，供参考';
      else check = '仅 ' + (-Math.log10(r.rel)).toFixed(1) + ' 位，疑似巧合';
      return '<tr><td><code>' + esc(r.formula) + '</code></td>' +
             '<td>' + (isFinite(r.delta) ? r.delta.toExponential(2) : '—') + '</td>' +
             '<td class="' + level + '">' + prob + '</td>' +
             '<td>' + esc(check) + '</td></tr>';
    }).join('');
    if (riesDone) {
      setBusy(false);
      if (ranked.hasReliableClosed) {
        setStatus('闭式搜索完成：已找到通过验证的高置信度闭式候选（请优先核对「独立复核」列）。', 'ok');
      } else if (riesAbortedEarly) {
        setStatus('RIES 阶段超时提前结束（仅保留早期低精度快照），未找到可靠闭式结果；建议提高数值精度依赖 PSLQ，或以高精度数值结果为准。', 'warn');
      } else {
        setStatus('闭式搜索完成：未找到可靠闭式结果（等价积分变形与低置信度拟合不计为闭式），请以高精度数值结果为准。', 'warn');
      }
    }
  }

  // 节流而非防抖：RIES 增量重绘极频繁，纯防抖会让面板一直停在早期快照
  var lastRenderAt = 0;
  function scheduleCandidateRender() {
    clearTimeout(scheduleCandidateRender.t);
    var wait = Math.max(0, 260 - (Date.now() - lastRenderAt));
    scheduleCandidateRender.t = setTimeout(function () {
      lastRenderAt = Date.now();
      renderCandidates();
    }, wait);
  }

  /* 走「高精度确定性 PSLQ + RIES」并轨路径 */
  function runRies(r, note, precomputedPslq) {
    if (r.verdict === 'ok' && (r.value === 0 || r.isNearZero)) {
      setStatus((note || '') + '积分数值在当前精度内为 0，无需进行闭式搜索。', 'ok');
      el.cand.hidden = true;
      setBusy(false);
      return;
    }
    var policyNote = precisionNotice(r.digits);
    var pslqMod = PSLQ || (isBrowser ? window.IntegralPSLQ : global.IntegralPSLQ);
    pslqRows = Array.isArray(precomputedPslq)
      ? precomputedPslq
      : ((pslqMod && r.valueText && r.digits >= 14.5) ? pslqMod.search(r) : []);

    var target = $('target'), maxRel = $('maxRelError'), runBtn = $('runBtn');
    /* 保护原版 RIES 召回率：放宽每模块显示条数（防止真解被前 5 个浮点巧合挤出）与阶段预算 */
    ['limit', 'riesLimit', 'linearComboLimit', 'mobiusLimit', 'logLimit', 'constantDbLimit', 'lfuncLimit'].forEach(function (id) {
      var node = $(id);
      if (node && parseInt(node.value, 10) < 15) {
        node.value = '15';
        try {
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {}
      }
    });
    var budgetNode = $('linearComboBudgetMs');
    if (budgetNode && !pslqRows.length && parseInt(budgetNode.value, 10) < 6000) {
      budgetNode.value = '6000';
      try {
        budgetNode.dispatchEvent(new Event('input', { bubbles: true }));
        budgetNode.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) {}
    }

    /* 喂给 RIES 的位数按实际有效位取，在 [6, 17] 间对齐（RIES 内部按双精度搜索） */
    var feedDigits = Math.max(6, Math.min(17, Math.floor(r.digits) + 1));
    var feed = r.value.toPrecision(feedDigits);
    target.value = feed;
    try { target.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    if (maxRel) {
      var rel = Math.min(1e-3, Math.max(1e-7, 100 * r.sigma / Math.max(Math.abs(r.value), 1e-300)));
      maxRel.value = String(rel);
      try { maxRel.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    }
    var pslqHint = pslqRows.length ? ('；高精度 PSLQ 已先行命中有望候选 ' + pslqRows.length + ' 项') : '';
    setStatus((note || '') + '数值 ' + feed + '（' + feedDigits + ' 位，保守 σ=' + r.sigma.toExponential(2) +
      '）已送入确定性 PSLQ 与 RIES 同步搜索' + pslqHint + '…' + policyNote, 'searching');
    riesTarget = r;
    if (pslqRows.length) renderCandidates();
    else el.cand.hidden = true;
    try {
      runBtn.click();
      setTimeout(function () {
        var sb = $('stopBtn');
        if (riesTarget === r && (!sb || sb.disabled)) {
          renderCandidates();
          setBusy(false);
        }
      }, 120);
    } catch (e) {
      setBusy(false);
      setStatus('RIES 启动失败：' + e.message, 'bad');
    }
  }

  var workerReady = false;

  function terminateWorker() {
    if (numWorker) {
      try { numWorker.terminate(); } catch (e) {}
      numWorker = null;
    }
    workerReady = false;
  }

  function setBusy(busy) {
    if (el.stop) {
      el.stop.hidden = !busy;
      el.stop.disabled = !busy;
    }
  }

  function cancelActiveComputation(userInitiated) {
    activeJobId++;
    if (workerPending) {
      var pending = workerPending;
      workerPending = null;
      terminateWorker();
      try { pending.resolve({ cancelled: true }); } catch (e) {}
    }
    clearTimeout(scheduleCandidateRender.t);
    riesTarget = null;
    var stopBtn = $('stopBtn');
    if (stopBtn && !stopBtn.disabled) {
      try { stopBtn.click(); } catch (e) {}
    }
    if (userInitiated) {
      setBusy(false);
      setStatus('已停止当前计算。已有结果保留在下方；可调整精度或修改表达式后重新计算。', 'warn');
    }
  }

  function updateControlsUI() {
    if (!isBrowser) return;
    if (el.precGroup) {
      Array.prototype.forEach.call(el.precGroup.querySelectorAll('[data-prec]'), function (btn) {
        var v = parseInt(btn.getAttribute('data-prec'), 10);
        var active = v === targetDigitsPref;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }
    if (el.closedToggle) el.closedToggle.checked = closedEnabledPref;
    var info = describeSettingsEffect(targetDigitsPref, closedEnabledPref);
    if (el.run) el.run.textContent = info.buttonText;
    if (el.guide) {
      el.guide.className = 'ig-guide ' + info.level;
      el.guide.innerHTML = '<strong>' + esc(info.summary) + '</strong><span>' + esc(info.details) + '</span>';
    }
    if (el.riesSection) el.riesSection.hidden = !closedEnabledPref;
    if (!closedEnabledPref) {
      if (el.cand) el.cand.hidden = true;
      clearSymbolic();
    }
  }

  function runNumericFallback(src, aRaw, bRaw, opt, runPslq, jobId, onProgress) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (jobId !== activeJobId) { resolve({ cancelled: true }); return; }
        if (onProgress) onProgress('integrate');
        setTimeout(function () {
          if (jobId !== activeJobId) { resolve({ cancelled: true }); return; }
          var t0 = Date.now();
          try {
            var f = C.compile(src);
            var r = C.integrate(f, aRaw, bRaw, opt || {});
            var pslq = [];
            var pslqMod = PSLQ || (isBrowser ? window.IntegralPSLQ : global.IntegralPSLQ);
            if (runPslq && r && r.verdict === 'ok' && !r.isNearZero && r.value !== 0 &&
                r.valueText && r.digits >= 14.5 && pslqMod && pslqMod.search) {
              if (onProgress) onProgress('pslq');
              pslq = pslqMod.search(r);
            }
            resolve({ result: r, pslqRows: pslq, elapsedMs: Date.now() - t0, fromWorker: false });
          } catch (err) {
            reject(err);
          }
        }, 0);
      }, 16);
    });
  }

  function runNumericAsync(src, aRaw, bRaw, opt, runPslq, jobId, onProgress) {
    if (workerDisabled || !isBrowser || typeof window.Worker !== 'function') {
      return runNumericFallback(src, aRaw, bRaw, opt, runPslq, jobId, onProgress);
    }
    if (!numWorker) {
      try {
        numWorker = new window.Worker('integral-worker.js?v=2.17');
        workerReady = false;
      } catch (e) {
        workerDisabled = true;
        numWorker = null;
        return runNumericFallback(src, aRaw, bRaw, opt, runPslq, jobId, onProgress);
      }
      numWorker.onmessage = function (ev) {
        var d = ev && ev.data ? ev.data : {};
        var p = workerPending;
        if (!p || d.id !== p.jobId) return;
        if (d.type === 'progress') {
          workerReady = true;
          if (p.onProgress) p.onProgress(d.phase);
          return;
        }
        workerPending = null;
        if (d.type === 'done') {
          workerReady = true;
          p.resolve({
            result: d.result,
            pslqRows: d.pslqRows || [],
            elapsedMs: d.elapsedMs,
            fromWorker: true
          });
          return;
        }
        if (d.type === 'error') {
          var msg = String(d.message || '后台计算错误');
          if (!workerReady && /后台计算线程初始化失败/.test(msg)) {
            workerDisabled = true;
            terminateWorker();
            runNumericFallback(p.src, p.aRaw, p.bRaw, p.opt, p.runPslq, p.jobId, p.onProgress)
              .then(p.resolve, p.reject);
            return;
          }
          workerReady = true;
          p.reject(new Error(msg));
        }
      };
      numWorker.onerror = function () {
        var p = workerPending;
        workerPending = null;
        var wasReady = workerReady;
        terminateWorker();
        if (!wasReady) workerDisabled = true;
        if (p) {
          if (!wasReady) {
            runNumericFallback(p.src, p.aRaw, p.bRaw, p.opt, p.runPslq, p.jobId, p.onProgress)
              .then(p.resolve, p.reject);
          } else {
            p.reject(new Error('后台计算 Worker 异常中止'));
          }
        }
      };
    }

    return new Promise(function (resolve, reject) {
      workerPending = {
        jobId: jobId,
        src: src,
        aRaw: aRaw,
        bRaw: bRaw,
        opt: opt,
        runPslq: runPslq,
        onProgress: onProgress,
        resolve: resolve,
        reject: reject
      };
      try {
        numWorker.postMessage({
          id: jobId,
          src: src,
          aRaw: aRaw,
          bRaw: bRaw,
          opt: opt || {},
          runPslq: !!runPslq
        });
      } catch (e) {
        workerPending = null;
        workerDisabled = true;
        terminateWorker();
        runNumericFallback(src, aRaw, bRaw, opt, runPslq, jobId, onProgress).then(resolve, reject);
      }
    });
  }

  /* 符号层没给出结果时，把原因写在状态栏最前面 —— 静默回退会让人以为功能没做 */
  function symbolicNote(res) {
    if (!res) return '符号层未运行（脚本未加载？）；';
    switch (res.status) {
      case 'none': return '符号层：未找到初等反导数；';
      case 'rejected': return '符号层：反导数未通过数值验证，已丢弃；';
      case 'timeout': return '符号层：2.5 秒内未算完，已终止；';
      case 'unavailable': return '符号层不可用（' + (res.why || '未知原因') + '）；';
      case 'skipped': return '';
      default: return '';
    }
  }

  function solve() {
    var src = el.f.value.trim();
    if (!src) { setStatus('请先输入 f(x)。', 'bad'); return; }
    try { C.compile(src); } catch (e) { setStatus('表达式错误：' + e.message, 'bad'); return; }

    cancelActiveComputation(false);
    var jobId = activeJobId;
    var td = targetDigitsPref;
    var closed = closedEnabledPref;
    var aRaw = el.a.value, bRaw = el.b.value;

    lastClosedEnabled = closed;
    pslqRows = [];
    clearTimeout(scheduleCandidateRender.t);
    el.cand.hidden = true;
    el.candBody.innerHTML = '';
    clearSymbolic();
    setBusy(true);
    setStatus('正在后台计算高精度数值积分（目标 ' + td + ' 位）…', 'searching');

    runNumericAsync(src, aRaw, bRaw, { targetDigits: td }, closed, jobId, function (phase) {
      if (jobId !== activeJobId) return;
      if (phase === 'pslq') {
        setStatus('数值已完成，正在后台运行确定性 PSLQ 搜索…', 'searching');
      }
    }).then(function (payload) {
      if (!payload || payload.cancelled || jobId !== activeJobId) return;
      var r = payload.result;
      var workerPslq = payload.pslqRows || [];
      r.profile = analyzeIntegralProfile(src, aRaw, bRaw, r.slopes);
      r.targetDigits = td;
      r.elapsedMs = payload.elapsedMs;
      last = r;
      renderNumeric(r, closed);

      if (r.verdict === 'divergent') {
        setBusy(false);
        setStatus('判定为发散：已拒绝把数值送入闭式搜索（标准 MC 会给出看似正常的假答案）。', 'bad');
        el.cand.hidden = true;
        return;
      }
      if (r.verdict === 'oscillatory') {
        setBusy(false);
        setStatus('判定为振荡型积分且加速未收敛：本方法不适用，已拒绝给数，避免把误差当成信号。', 'bad');
        el.cand.hidden = true;
        return;
      }
      if (!closed) {
        setBusy(false);
        el.cand.hidden = true;
        setStatus('数值计算完成（纯数值模式，目标 ' + td + ' 位，耗时 ' + r.elapsedMs + ' ms；已按开关关闭闭式搜索）。', 'ok');
        return;
      }
      if (r.value === 0 || r.isNearZero) {
        setBusy(false);
        el.cand.hidden = true;
        setStatus('积分数值在当前精度内为 0，已跳过闭式搜索。', 'ok');
        return;
      }

      /* 符号优先：符号引擎跑在 Worker 里，卡住就超时杀掉，主线程不会冻结。
         拿到反导数后由主线程做双重验证；通过且能化成常数形式就直接给答案，不必让 RIES 去猜。 */
      if (!window.IntegralSymbolic) {
        runRies(r, '符号层未加载（integral-symbolic.js 缺失或版本过旧）；', workerPslq);
        return;
      }

      setStatus('数值已算出（' + td + ' 位档，耗时 ' + r.elapsedMs + ' ms），正在尝试符号解…', 'searching');
      window.IntegralSymbolic.solveAsync(src, aRaw, bRaw, r.value, 2500).then(function (res) {
        if (jobId !== activeJobId || last !== r) return;
        if (res && res.status === 'ok' && res.sym) {
          renderSymbolic(res.sym, aRaw, bRaw);
          if (res.sym.exact && !res.sym.exactIsNumeric) {
            var pretty = res.sym.exact.replace(/\blog\(/g, 'ln(');
            setBusy(false);
            setStatus('符号解已求得并通过双重验证：定积分 = ' + pretty +
              '。已跳过闭式搜索（不需要猜）。', 'ok');
            el.cand.hidden = true;
            return;
          }
        }
        var symNote = (res && res.status === 'ok' && res.sym && res.sym.exactIsNumeric)
          ? '符号层仅求出反导数（代入界限未得精确闭式）；'
          : symbolicNote(res);
        runRies(r, symNote, workerPslq);
      }).catch(function (e) {
        if (jobId === activeJobId && last === r) {
          runRies(r, '符号层异常（' + (e && e.message || e) + '）；', workerPslq);
        }
      });
    }).catch(function (e) {
      if (jobId !== activeJobId) return;
      setBusy(false);
      setStatus('积分失败：' + (e && e.message || e), 'bad');
    });
  }

  function loadExample(f, a, b) {
    el.f.value = f; el.a.value = a; el.b.value = b;
    var btnText = describeSettingsEffect(targetDigitsPref, closedEnabledPref).buttonText;
    setStatus('已载入例题，点「' + btnText + '」运行。');
  }

  var helpers = {
    isIntegralOrSumForm: isIntegralOrSumForm,
    isParametricForm: isParametricForm,
    evalRiesDec: evalRiesDec,
    hpVerifyCandidate: hpVerifyCandidate,
    analyzeIntegralProfile: analyzeIntegralProfile,
    structDelta: structDelta,
    modelComplexityDigits: modelComplexityDigits,
    guessProbability: guessProbability,
    rankCandidates: rankCandidates,
    describeSettingsEffect: describeSettingsEffect,
    riesEqDedupKey: riesEqDedupKey
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (isBrowser) {
    window.IntegralGlueHelpers = helpers;
    el.run.addEventListener('click', solve);
    el.f.addEventListener('keydown', function (e) { if (e.key === 'Enter') solve(); });
    if (el.a) el.a.addEventListener('keydown', function (e) { if (e.key === 'Enter') solve(); });
    if (el.b) el.b.addEventListener('keydown', function (e) { if (e.key === 'Enter') solve(); });
    if (el.precGroup) {
      el.precGroup.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-prec]') : null;
        if (!btn) return;
        var v = parseInt(btn.getAttribute('data-prec'), 10);
        if (v === 12 || v === 18 || v === 25 || v === 35) {
          targetDigitsPref = v;
          updateControlsUI();
        }
      });
    }
    if (el.closedToggle) {
      el.closedToggle.addEventListener('change', function () {
        closedEnabledPref = !!el.closedToggle.checked;
        updateControlsUI();
      });
    }
    if (el.stop) {
      el.stop.addEventListener('click', function () {
        cancelActiveComputation(true);
      });
    }
    if (el.exPlus) el.exPlus.addEventListener('click', function () {
      loadExample('abs(sin(x))/(exp(x)+abs(sin(x)+cos(x)))', '0', 'inf');
    });
    if (el.exMinus) el.exMinus.addEventListener('click', function () {
      loadExample('abs(sin(x))/(exp(x)-abs(sin(x)+cos(x)))', '0', 'inf');
    });
    if (el.exSimple) el.exSimple.addEventListener('click', function () {
      loadExample('exp(-x^2)', '-inf', 'inf');
    });

    var body = $('resultBody');
    if (body && window.MutationObserver) {
      var obs = new MutationObserver(scheduleCandidateRender);
      obs.observe(body, { childList: true, subtree: true, characterData: true });
    }
    var stopBtnEl = $('stopBtn');
    if (stopBtnEl && window.MutationObserver) {
      var stopObs = new MutationObserver(scheduleCandidateRender);
      stopObs.observe(stopBtnEl, { attributes: true, attributeFilter: ['disabled'] });
    }
    updateControlsUI();
    setBusy(false);
    setStatus('就绪（积分层 v2.17 · 后台 Worker + 可选精度/闭式开关）。支持 + - * / ^、abs/sin/cos/exp/log/sqrt/atanh/arctanh 等；变量只能写 x。');
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
