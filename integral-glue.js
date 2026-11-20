/* integral-glue.js — 把「定积分数值层」接到原版 RIES 闭式搜索上。
 * 不修改 ries-script.js 任何一行；只通过 DOM 交互与结果观察接入。
 *
 * v2 变化：
 *  1. 整数模式的误差列是字面 "exact"，v1 解析不出残差 → 全部候选判 1.0%。
 *     现在把 exact 当 0 残差，整数题（∫sin x=2 这类）能正常评分。
 *  2. 过滤「恒等式包装」：((x+8)-8) = π/4 这种左端恒等于 x 的行只是把答案重写一遍，
 *     却占满前几名。用表达式求值判定，命中就丢弃。
 *  3. 精度 → 搜索宽度联动：数值层位数不足时，自动关掉高自由度模块
 *     （Möbius / 常数库 / 硬常数库 / 超几何 / 积分求和 / L 函数），
 *     避免用 6 位数据去拟合 10 个自由度的模型。
 *  4. 概率上限受输入位数约束：候选不能比喂进去的数更可信。
 *  5. 振荡未收敛（oscillatory）时明确拒绝给数，不再冒充发散或硬凑闭式。
 */
(function (global) {
  'use strict';
  var isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
  var C = (isBrowser ? window.IntegralCore : global.IntegralCore) || null;
  if (isBrowser && !C) { console.error('IntegralCore 未加载'); return; }
  var $ = function (id) { return isBrowser ? document.getElementById(id) : null; };
  var el = isBrowser ? {
    f: $('igF'), a: $('igA'), b: $('igB'), run: $('igRun'),
    status: $('igStatus'), result: $('igResult'), out: $('igOut'),
    cand: $('igCandidates'), candBody: $('igCandBody'),
    exPlus: $('igExPlus'), exMinus: $('igExMinus'), exSimple: $('igExSimple'),
    sym: $('igSymbolic'), symEq: $('igSymEq'), symValue: $('igSymValue'), symFoot: $('igSymFoot')
  } : {};
  var last = null;
  var riesTarget = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function setStatus(text, kind) {
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

  /* 经验置信度：用相对残差（匹配位数）、公式长度、候选基规模做 logistic 映射。
     离线标定：σ≈1e-10、基 K=3 时真关系命中 100%/伪关系 0%；K 增大时假阳性显著上升。
     这是启发式估计，不是数学证明，也不是严格后验概率。
     inputDigits：喂进 RIES 的那个数本身有几位可信。
     候选比「数据的精度」还吻合的部分不算证据 —— 那是在拟合数值误差，不是在发现结构。
     注意这只是给候选降权，不改变搜索范围：搜不搜和信不信是两件事。 */
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

  /* 48 位高精度 Decimal 独立复核：
     RIES 内部只吃 17 位 Float64，高自由度 Möbius / log|c| / 对数组合极易在 16 位上撞出 0.00e+0 伪巧合。
     当定积分数值层已算出 >= 17.5 位高精度 valueText 时，用 48 位 Decimal 直接把候选公式代回去复算：
     若偏差远超 σ（例如在 25 位真值下第 17 位即崩坏），立即数学证伪为「浮点巧合」，彻底杜绝误导。 */
  function evalRiesDec(exprStr, xDec, D) {
    var s = String(exprStr || '').trim();
    if (!s) return null;
    /* 处理 RIES 的 log|log|x||、log|x| 绝对值记法以及 log(log π) / log(log 2) 等空格参数记法 */
    s = s.replace(/log\|log\|([^|]+)\|\|/gi, 'ln(abs(ln(abs($1))))')
         .replace(/log\|([^|]+)\|/gi, 'ln(abs($1))')
         .replace(/ln\|([^|]+)\|/gi, 'ln(abs($1))')
         .replace(/\b(log|ln)\s+(√(?:\d+|[πeφγ])|π|pi|e|φ|γ|G|\d+(?:\.\d+)?)(?![a-zA-Z0-9_πφγ])/gi, '$1($2)');
    if (/[|]|∫|∑|α|₂F|₃F|ζ|Γ|Cl₂|Ti₂|Li₂/.test(s) || /int_|sum_|\\alpha|log_|_?[123]F[012]\b|\bLi_?\d/i.test(s)) return null;

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
          /* √2、√π、√e 等无括号根号 */
          var mRad = /^(?:\d+\.?\d*|[a-zA-Zπφγ]+)/.exec(s.slice(i));
          if (!mRad) return null;
          ts.push({ t: 'id', v: 'sqrt' }, { t: 'lp' });
          if (/^\d/.test(mRad[0])) ts.push({ t: 'num', v: mRad[0] });
          else ts.push({ t: 'id', v: mRad[0] });
          ts.push({ t: 'rp' });
          i += mRad[0].length;
        }
        continue;
      }
      if (c === 'π' || c === 'φ' || c === 'γ') { ts.push({ t: 'id', v: c }); i++; continue; }
      if (/[a-zA-Z]/.test(c)) {
        var m2 = /^[a-zA-Z][a-zA-Z0-9π]*/.exec(s.slice(i));
        ts.push({ t: 'id', v: m2[0] }); i += m2[0].length; continue;
      }
      if (c === '*' && s[i + 1] === '*') { ts.push({ t: 'op', v: '^' }); i += 2; continue; }
      if ('+-*/^'.indexOf(c) >= 0) { ts.push({ t: 'op', v: c }); i++; continue; }
      if (c === '−' || c === '–') { ts.push({ t: 'op', v: '-' }); i++; continue; }
      if (c === '·' || c === '×') { ts.push({ t: 'op', v: '*' }); i++; continue; }
      if (c === '²') { ts.push({ t: 'op', v: '^' }, { t: 'num', v: '2' }); i++; continue; }
      if (c === '³') { ts.push({ t: 'op', v: '^' }, { t: 'num', v: '3' }); i++; continue; }
      if (c === '(') { ts.push({ t: 'lp' }); i++; continue; }
      if (c === ')') { ts.push({ t: 'rp' }); i++; continue; }
      if (c === ',') { ts.push({ t: 'comma' }); i++; continue; }
      return null;
    }

    var FN_NAMES = {
      sin: 1, cos: 1, tan: 1, asin: 1, acos: 1, atan: 1,
      sinh: 1, cosh: 1, tanh: 1, asinh: 1, acosh: 1, atanh: 1,
      sinpi: 1, cospi: 1, tanpi: 1, 'sinπ': 1, 'cosπ': 1, 'tanπ': 1,
      exp: 1, ln: 1, log: 1, sqrt: 1, cbrt: 1, abs: 1, root: 1, pow: 1
    };
    var toks = [];
    for (var k = 0; k < ts.length; k++) {
      var prev = toks.length ? toks[toks.length - 1] : null;
      var cur = ts[k];
      if (prev && (prev.t === 'num' || prev.t === 'rp' || (prev.t === 'id' && !FN_NAMES[prev.v.toLowerCase()])) &&
          (cur.t === 'id' || cur.t === 'lp' || cur.t === 'num')) {
        toks.push({ t: 'op', v: '*' });
      }
      toks.push(cur);
    }

    var PI = D.acos(-1);
    var E_CONST = new D(1).exp();
    var PHI = new D(5).sqrt().plus(1).div(2);
    var GAMMA = new D('0.577215664901532860606512090082402431042159335939923598805767');
    var CATALAN = new D('0.915965594177219015054603514932384110774149374281672134266498');

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
          if (!FN_NAMES[low]) return null;
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
            if (low === 'sin') return u.sin();
            if (low === 'cos') return u.cos();
            if (low === 'tan') return u.tan();
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
        if (raw === 'G') return CATALAN;
        if (low === 'pi' || raw === 'π') return PI;
        if (low === 'e') return E_CONST;
        if (low === 'phi' || raw === 'φ') return PHI;
        if (low === 'gamma' || raw === 'γ') return GAMMA;
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
    D.set({ precision: 48 });
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
      var matched = hpErr > 0 ? Math.max(0, -Math.log10(hpErr / absVal)) : Math.min(lastInfo.digits, 30);
      if (hpErr > tol) return { status: 'rejected', err: hpErr, matchedDigits: matched };
      return { status: 'passed', err: hpErr, matchedDigits: matched };
    } catch (e) {
      return null;
    } finally {
      D.set({ precision: oldPrec });
    }
  }

  function guessProbability(rel, formula, sigma, value, verified, terms, parametric, height, inputDigits, integralForm, hpCheck) {
    if (integralForm) return 0;
    if (hpCheck && hpCheck.status === 'rejected') return 0.01;
    if (!verified || !isFinite(rel) || !isFinite(value) || value === 0) return 0.01;
    var digits = -Math.log10(Math.max(rel, 1e-17));
    var usable = Math.min(digits, Math.max(0, isFinite(inputDigits) ? inputDigits : 17));
    /* 整数模式下 RIES 直接判 exact（残差 0），这是算术上的精确相等，
       不该被数值层的位数折减，否则「integer factorization」会因公式更短
       把带数值的「fallback power-ratio: 2」挤下去，表头看起来像没结果。 */
    if (rel === 0) usable = 17;
    var rho = Math.max(rel * Math.abs(value) / Math.max(sigma, 1e-15), 1e-12);
    var K = 11;
    /* 复杂度只看「等号右边的公式本体」。模块前缀（"Möbius 关系: x ≈ " 16 字符、
       "hypergeometric database: x ≈ " 30 字符）不该参与判断 ——
       否则 4·G/π 这种极简答案会被前缀拖成中等长度。 */
    var cm = /x\s*[≈=]\s*([\s\S]*)$/.exec(formula);
    var core = (cm ? cm[1] : formula).replace(/复制|copy/ig, '').trim();
    var coreLen = core.replace(/\s+/g, '').length;
    /* 公式里出现的整数个数：4·G/π 只有 1 个（系数 4），
       而 (-15e+57πe)/(902e+21πe-47) 有 5 个 —— 后者是典型的 Möbius 拟合。 */
    var intCount = (core.match(/\d+/g) || []).length;
    /* 异域函数与高自由度数据库：模块前缀从 formula 判，异域符号从 core 判（Möbius 仅按 height > 40 罚，不误伤 4·G/π）。 */
    var exoticModule = /对数组合关系|log-combination|log\|c\||硬常数数据库|hard constant|积分\s*\/\s*求和数据库|integral\s*\/\s*sum|L 函数有理比|L-rational|常数数据库|constant database|代数关系|algebraic relation|超几何|hypergeometric/i.test(formula);
    var exoticSymbol = /Cl₂|Clausen|Khinchin|Γ\(|Gamma\(|ζ\(|zeta|Ti₂|Bi\(|L\(f,|Glaisher|Apery|log Γ|_?[123]F[012]\b|₂F₂|₂F₁|₃F₂/i.test(core);
    var exotic = exoticModule || exoticSymbol;
    var isMobiusOrComb = /Möbius 关系|Möbius relation|对数组合关系|log-combination|log\|c\|/i.test(formula);
    var highFree = isMobiusOrComb && (height || 0) > 40;
    var z = 1.15 * (usable - 8)
          - (parametric ? 0 : 0.045 * coreLen)
          - 1.10 * Math.log10(1 + K / 3)
          - 0.35 * Math.log10(1 + rho)
          - 0.35 * Math.max(0, (terms || 0) - 3)
          - ((height || 0) > 30 ? 1.5 * Math.log10(1 + (height - 30) / 12) : 0)
          - (highFree ? 1.7 : 0)
          - (exotic ? 2.5 : 0)
          - 0.45 * Math.max(0, intCount - 1);
    var p = Math.min(0.99, Math.max(0.01, sigmoid(z)));
    /* 高高度 Möbius / 对数组合（height > 60）在 16 位 Float64 下搜索空间极大，除非通过 20+ 位高精度复核，否则封顶 30% */
    if (isMobiusOrComb && (height || 0) > 60 && !(hpCheck && hpCheck.status === 'passed')) {
      p = Math.min(p, 0.30);
    }
    return parametric ? Math.min(p, 0.30) : p;
  }

  function rankCandidates(rawRows, lastInfo) {
    var inputDigits = lastInfo.digits;
    var rows = rawRows.slice(0, 80).map(function (r) {
      var integralForm = typeof r.integralForm === 'boolean' ? r.integralForm : isIntegralOrSumForm(r.formula, r.fullText);
      var parametric = typeof r.parametric === 'boolean' ? r.parametric : isParametricForm(r.formula, r.fullText);
      var hpCheck = (!integralForm && !parametric && r.verified) ? hpVerifyCandidate(r.formula, lastInfo) : null;
      var hpRejected = !!(hpCheck && hpCheck.status === 'rejected');
      var nonClosed = parametric || integralForm || hpRejected;
      var rel = isFinite(r.delta) ? r.delta / Math.max(Math.abs(lastInfo.value), 1e-300) : NaN;
      var p = guessProbability(rel, r.formula, lastInfo.sigma, lastInfo.value,
                               r.verified, r.terms, parametric, r.height, inputDigits, integralForm, hpCheck);
      return {
        formula: r.formula, valueText: r.valueText, errText: r.errText,
        delta: r.delta, verified: r.verified, terms: r.terms, height: r.height,
        parametric: parametric, integralForm: integralForm,
        hpCheck: hpCheck, hpRejected: hpRejected, nonClosed: nonClosed,
        rel: rel, p: p
      };
    });
    /* 通过复核的排前面；真闭式优先于等价积分变形、高精度否决项与参数化拟合；同组内按置信度降序 */
    rows.sort(function (a, b) {
      if (a.verified !== b.verified) return a.verified ? -1 : 1;
      if (a.nonClosed !== b.nonClosed) return a.nonClosed ? 1 : -1;
      if (a.nonClosed && a.hpRejected !== b.hpRejected) return a.hpRejected ? 1 : -1;
      if (a.nonClosed && a.integralForm !== b.integralForm) return a.integralForm ? -1 : 1;
      return (b.p || 0) - (a.p || 0);
    });
    var closed = rows.filter(function (r) { return !r.nonClosed; });
    var hasReliableClosed = closed.some(function (r) { return r.verified && r.p >= 0.50; });
    var good = closed.slice(0, 12);
    var equivInt = rows.filter(function (r) { return r.integralForm; }).slice(0, 2);
    var allRejected = rows.filter(function (r) { return r.hpRejected && !r.integralForm && !r.parametric; });
    var rejected = allRejected.slice(0, 3);
    var param = rows.filter(function (r) { return r.parametric && !r.integralForm; }).slice(0, 3);
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

  function renderNumeric(r) {    var badge = r.verdict === 'ok' ? '可积'
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
      : isZeroVal
      ? '数值在当前精度内为 0（已跳过闭式搜索，不把浮点噪声送入 RIES）。'
      : '送入闭式搜索的是 ' + feedDigits +
        ' 位有效数字（RIES 内部按双精度搜索），σ 是保守误差界，两者口径不同。';
    el.out.innerHTML =
      '<div class="ig-grid">' +
        '<div class="ig-cell"><span>数值结果</span><strong' + (noNumber ? ' class="ig-bad"' : '') + '>' + numText + '</strong></div>' +
        '<div class="ig-cell"><span>误差范围 ±σ</span><strong>' + sigText + '</strong></div>' +
        '<div class="ig-cell"><span>保守有效位</span><strong>' + digText + ' </strong></div>' +
        '<div class="ig-cell"><span>判定</span><strong class="ig-' + cls + '">' + badge + '</strong></div>' +
      '</div>' +
      '<p class="subtle-note">方法：' + esc(r.method || '—') + '。误差类型：' + esc(r.errorType) + '。' + feedNote +
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
    var inputDigits = last.digits;
    var ranked = rankCandidates(readRiesRows(), last);
    var rows = ranked.rows;
    var stopBtn = $('stopBtn');
    var riesDone = !!(stopBtn && stopBtn.disabled);
    if (!rows.length) {
      el.cand.hidden = true;
      if (riesDone) {
        setStatus('闭式搜索完成：未找到可靠闭式结果，请以高精度数值结果为准。', 'warn');
      }
      return;
    }
    el.cand.hidden = false;
    var banner = '';
    if (!ranked.hasReliableClosed) {
      var reasonParts = [];
      if (ranked.hpRejectedCount > 0) reasonParts.push('高精度复核已否决 ' + ranked.hpRejectedCount + ' 项 16 位浮点巧合');
      if (ranked.equivIntCount > 0) reasonParts.push('等价积分/级数变形不计为闭式');
      var reason = reasonParts.length
        ? '（' + reasonParts.join('；') + '）'
        : '（仅检出低置信度巧合拟合）';
      banner = '<tr><td colspan="4" class="ig-warn"><strong>未找到可靠闭式结果</strong>' + reason + '，以下条目仅供参考，请以高精度数值结果为准。</td></tr>';
    }
    el.candBody.innerHTML = banner + rows.map(function (r) {
      var prob = r.integralForm ? '非闭式' : r.hpRejected ? '已否决' : (r.p * 100).toFixed(1) + '%';
      var level = r.integralForm ? 'ig-warn' : r.hpRejected ? 'ig-bad' : (r.p >= 0.8 ? 'ig-ok' : r.p >= 0.45 ? 'ig-warn' : 'ig-bad');
      var check;
      if (r.integralForm) check = '等价积分/级数变形，非闭式（原积分换元形式，不计入闭式排名）';
      else if (r.hpRejected) check = '高精度复核未通过（偏差 ' + r.hpCheck.err.toExponential(2) + '，远超 σ，确认为浮点巧合）';
      else if (!r.verified) check = '未取到可信残差，不评分';
      else if (r.parametric) check = '参数化拟合（含自由参数 α 或整系数多项式），非闭式';
      else if (r.hpCheck && r.hpCheck.status === 'passed') check = '高精度复核通过（匹配约 ' + r.hpCheck.matchedDigits.toFixed(1) + ' 位）';
      else if (r.rel <= 1e-10) check = (isFinite(inputDigits) && inputDigits < 9.5)
        ? '匹配 ≥10 位，但数值本身仅 ' + inputDigits.toFixed(1) + ' 位，超出部分不计'
        : '匹配 ≥10 位，通过';
      else if (r.rel <= 1e-7) check = '匹配约 ' + (-Math.log10(r.rel)).toFixed(1) + ' 位，供参考';
      else check = '仅 ' + (-Math.log10(r.rel)).toFixed(1) + ' 位，疑似巧合';
      return '<tr><td><code>' + esc(r.formula) + '</code></td>' +
             '<td>' + (isFinite(r.delta) ? r.delta.toExponential(2) : '—') + '</td>' +
             '<td class="' + level + '">' + prob + '</td>' +
             '<td>' + esc(check) + '</td></tr>';
    }).join('');
    if (riesDone) {
      if (ranked.hasReliableClosed) {
        setStatus('闭式搜索完成：已找到高置信度闭式候选（请优先核对「独立复核」列）。', 'ok');
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

  /* 走「数值 + RIES」老路：把小数交给原版 RIES 去猜闭式 */
  function runRies(r, note) {
    if (r.verdict === 'ok' && (r.value === 0 || r.isNearZero)) {
      setStatus((note || '') + '积分数值在当前精度内为 0，无需进行闭式搜索。', 'ok');
      el.cand.hidden = true;
      return;
    }
    // 精度提示：只提示，不改变搜索范围（关模块会让正确答案一起消失）
    var policyNote = precisionNotice(r.digits);

    var target = $('target'), maxRel = $('maxRelError'), runBtn = $('runBtn');
    /* 喂给 RIES 的位数按实际有效位取，在 [6, 17] 间对齐（RIES 内部用双精度搜索） */
    var feedDigits = Math.max(6, Math.min(17, Math.floor(r.digits) + 1));
    var feed = r.value.toPrecision(feedDigits);
    target.value = feed;
    try { target.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    if (maxRel) {
      var rel = Math.min(1e-4, Math.max(1e-10, 10 * r.sigma / Math.max(Math.abs(r.value), 1e-300)));
      maxRel.value = String(rel);
    }
    setStatus((note || '') + '数值 ' + feed + '（' + feedDigits + ' 位，保守 σ=' + r.sigma.toExponential(2) +
      '）已送入 RIES，正在搜索闭式候选…' + policyNote, 'searching');
    el.cand.hidden = true;
    riesTarget = r;
    try { runBtn.click(); } catch (e) { setStatus('RIES 启动失败：' + e.message, 'bad'); }
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
    riesTarget = null;
    clearTimeout(scheduleCandidateRender.t);
    el.cand.hidden = true;
    el.candBody.innerHTML = '';
    var stopBtn = $('stopBtn');
    if (stopBtn && !stopBtn.disabled) {
      try { stopBtn.click(); } catch (e) {}
    }
    clearSymbolic();
    var f, r;
    try { f = C.compile(src); } catch (e) { setStatus('表达式错误：' + e.message, 'bad'); return; }
    try { r = C.integrate(f, el.a.value, el.b.value); }
    catch (e) { setStatus('积分失败：' + e.message, 'bad'); return; }
    last = r;
    renderNumeric(r);

    if (r.verdict === 'divergent') {
      setStatus('判定为发散：已拒绝把数值送入闭式搜索（标准 MC 会给出看似正常的假答案）。', 'bad');
      el.cand.hidden = true;
      return;
    }
    if (r.verdict === 'oscillatory') {
      setStatus('判定为振荡型积分且加速未收敛：本方法不适用，已拒绝给数，避免把误差当成信号。', 'bad');
      el.cand.hidden = true;
      return;
    }

    /* 符号优先：符号引擎跑在 Worker 里，卡住就超时杀掉，主线程不会冻结。
       拿到反导数后由主线程做双重验证；通过且能化成常数形式就直接给答案，不必让 RIES 去猜。 */
    var aRaw = el.a.value, bRaw = el.b.value;
    if (!window.IntegralSymbolic) {
      runRies(r, '符号层未加载（integral-symbolic.js 缺失或版本过旧）；');
      return;
    }

    setStatus('数值已算出，正在尝试符号解…', 'searching');
    window.IntegralSymbolic.solveAsync(src, aRaw, bRaw, r.value, 2500).then(function (res) {
      if (last !== r) return;                     /* 期间用户又点了计算，放弃这次结果 */
      if (res && res.status === 'ok' && res.sym) {
        renderSymbolic(res.sym, aRaw, bRaw);
        if (res.sym.exact && !res.sym.exactIsNumeric) {
          var pretty = res.sym.exact.replace(/\blog\(/g, 'ln(');
          setStatus('符号解已求得并通过双重验证：定积分 = ' + pretty +
            '。已跳过闭式搜索（不需要猜）。', 'ok');
          el.cand.hidden = true;
          return;
        }
      }
      var symNote = (res && res.status === 'ok' && res.sym && res.sym.exactIsNumeric)
        ? '符号层仅求出反导数（代入界限未得精确闭式）；'
        : symbolicNote(res);
      runRies(r, symNote);
    }).catch(function (e) {
      if (last === r) runRies(r, '符号层异常（' + (e && e.message || e) + '）；');
    });
  }

  function loadExample(f, a, b) {
    el.f.value = f; el.a.value = a; el.b.value = b;
    setStatus('已载入例题，点「计算并求闭式」运行。');
  }

  var helpers = {
    isIntegralOrSumForm: isIntegralOrSumForm,
    isParametricForm: isParametricForm,
    hpVerifyCandidate: hpVerifyCandidate,
    guessProbability: guessProbability,
    rankCandidates: rankCandidates
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (isBrowser) {
    window.IntegralGlueHelpers = helpers;
    el.run.addEventListener('click', solve);
    el.f.addEventListener('keydown', function (e) { if (e.key === 'Enter') solve(); });
    el.exPlus.addEventListener('click', function () {
      loadExample('abs(sin(x))/(exp(x)+abs(sin(x)+cos(x)))', '0', 'inf');
    });
    el.exMinus.addEventListener('click', function () {
      loadExample('abs(sin(x))/(exp(x)-abs(sin(x)+cos(x)))', '0', 'inf');
    });
    el.exSimple.addEventListener('click', function () {
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
    setStatus('就绪（积分层 v2.13）。支持 + - * / ^、abs/sin/cos/exp/log/sqrt/atanh/arctanh 等；变量只能写 x。');
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
