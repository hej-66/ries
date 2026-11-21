/* integral-hp.js —— 任意精度求积层（v2.12）
 *
 * 目标：把定积分的有效位数从双精度的 12~13 位提到 25 位以上。
 *
 * 做法：
 *   1. 表达式编译成 Decimal 版本（与 integral-core 统一词法与函数表）
 *   2. 有限区间：互补距离 tanh-sinh（消除端点 1−x 消去，独立双端停止，复用偶数节点）
 *   3. 无穷区间：原生 exp-sinh（半无穷）与 sinh-sinh（全轴），配合单向对数尾探测
 *   4. 振荡积分：
 *      - 已知 chirp（含幂次/sqrt 包络、a<0 拆分、任意精确下限）：换元 + 半周期 GL + CVZ
 *      - 通用交替振荡：Decimal 零点精化 + 变步 GL 面板 + CVZ / 对角 Wynn 双自检
 *      - 正项衰减振荡（如 sin²x/x²）：Decimal 极值分片 + Levin u-transform
 */
(function (global) {
  'use strict';

  var D = global.Decimal;
  if (!D) return;

  /* 常数缓存必须跟着精度走：RIES 会把 Decimal.precision 临时调低，
     若此时算过一次 π，缓存就永久停在低精度，之后所有高精度求积全部被拖死。 */
  var CONST_CACHE = {};
  function cachedConst(key, computeFn) {
    var cur = CONST_CACHE[key];
    if (!cur || cur.prec < D.precision) {
      CONST_CACHE[key] = { prec: D.precision, val: computeFn() };
    }
    return CONST_CACHE[key].val;
  }
  function decPI() { return cachedConst('pi', function () { return D.acos(-1); }); }
  function decTAU() { return cachedConst('tau', function () { return decPI().mul(2); }); }
  function decE() { return cachedConst('e', function () { return new D(1).exp(); }); }
  function decPHI() { return cachedConst('phi', function () { return new D(5).sqrt().plus(1).div(2); }); }
  function decLN2() { return cachedConst('ln2', function () { return new D(2).ln(); }); }
  function decLN10() { return cachedConst('ln10', function () { return new D(10).ln(); }); }

  var DCONSTS = {
    pi: decPI,
    tau: decTAU,
    e: decE,
    phi: decPHI,
    ln2: decLN2,
    ln10: decLN10,
    inf: function () { return new D(Infinity); },
    infinity: function () { return new D(Infinity); }
  };

  /* ---------- 词法 ---------- */
  function tokenize(src) {
    var out = [], i = 0, s = String(src);
    var isDigit = function (c) { return c >= '0' && c <= '9'; };
    var isAlpha = function (c) { return /[a-zA-Z_]/.test(c); };
    while (i < s.length) {
      var c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if (isDigit(c) || (c === '.' && isDigit(s[i + 1]))) {
        var j = i;
        while (j < s.length && (isDigit(s[j]) || s[j] === '.')) j++;
        if (s[j] === 'e' || s[j] === 'E') {
          var k = j + 1;
          if (s[k] === '+' || s[k] === '-') k++;
          if (isDigit(s[k])) { while (k < s.length && isDigit(s[k])) k++; j = k; }
        }
        out.push({ t: 'num', v: s.slice(i, j) });
        i = j;
        continue;
      }
      if (isAlpha(c)) {
        var k2 = i;
        while (k2 < s.length && (isAlpha(s[k2]) || isDigit(s[k2]))) k2++;
        out.push({ t: 'id', v: s.slice(i, k2) });
        i = k2;
        continue;
      }
      if (c === '*' && s[i + 1] === '*') { out.push({ t: 'op', v: '^' }); i += 2; continue; }
      if ('+-*/^'.indexOf(c) >= 0) { out.push({ t: 'op', v: c }); i++; continue; }
      if (c === '−') { out.push({ t: 'op', v: '-' }); i++; continue; }
      if (c === '·' || c === '×') { out.push({ t: 'op', v: '*' }); i++; continue; }
      if (c === '²') { out.push({ t: 'op', v: '^' }, { t: 'num', v: '2' }); i++; continue; }
      if (c === '³') { out.push({ t: 'op', v: '^' }, { t: 'num', v: '3' }); i++; continue; }
      if (c === '(') { out.push({ t: 'lp' }); i++; continue; }
      if (c === ')') { out.push({ t: 'rp' }); i++; continue; }
      if (c === ',') { out.push({ t: 'comma' }); i++; continue; }
      if (c === 'π') { out.push({ t: 'id', v: 'pi' }); i++; continue; }
      if (c === '∞') { out.push({ t: 'id', v: 'inf' }); i++; continue; }
      throw new Error('无法识别的字符「' + c + '」');
    }
    return out;
  }

  /* 隐式乘法：两个操作数相邻时补 '*'；函数名 + '(' 是调用，不补 */
  function insertImplicit(ts) {
    var out = [];
    for (var i = 0; i < ts.length; i++) {
      var cur = ts[i];
      if (i > 0) {
        var prev = ts[i - 1];
        var prevEnds = prev.t === 'num' || prev.t === 'id' || prev.t === 'rp';
        var curStarts = cur.t === 'num' || cur.t === 'id' || cur.t === 'lp';
        var isCall = prev.t === 'id' && cur.t === 'lp' && !!DFUNCS[prev.v.toLowerCase()];
        if (prevEnds && curStarts && !isCall) out.push({ t: 'op', v: '*' });
      }
      out.push(cur);
    }
    return out;
  }

  function safePow(a, b) {
    if (!a.isFinite() || !b.isFinite()) return a.pow(b);
    if (a.gt(0)) {
      var lnA = a.ln();
      var mag = b.mul(lnA);
      if (mag.gt(1e13)) return new D(Infinity);
      if (mag.lt(-1e13)) return new D(0);
    }
    return a.pow(b);
  }

  var DFUNCS = {
    sin: function (x) {
      if (!x.isFinite() || x.abs().gt(1e100)) return new D(NaN);
      try { return x.sin(); } catch (e) { return new D(NaN); }
    },
    cos: function (x) {
      if (!x.isFinite() || x.abs().gt(1e100)) return new D(NaN);
      try { return x.cos(); } catch (e) { return new D(NaN); }
    },
    tan: function (x) {
      if (!x.isFinite() || x.abs().gt(1e100)) return new D(NaN);
      try { return x.tan(); } catch (e) { return new D(NaN); }
    },
    asin: function (x) { return x.asin(); },
    acos: function (x) { return x.acos(); },
    atan: function (x) { return x.atan(); },
    atan2: function (y, x) { return D.atan2(y, x); },
    sinh: function (x) {
      if (!x.isFinite()) return new D(NaN);
      if (x.abs().gt(1e13)) return new D(x.s < 0 ? -Infinity : Infinity);
      if (x.abs().gt(D.precision * 2 + 20)) {
        var e = x.abs().exp().div(2);
        return x.s < 0 ? e.neg() : e;
      }
      return x.sinh();
    },
    cosh: function (x) {
      if (!x.isFinite()) return new D(NaN);
      if (x.abs().gt(1e13)) return new D(Infinity);
      if (x.abs().gt(D.precision * 2 + 20)) return x.abs().exp().div(2);
      return x.cosh();
    },
    tanh: function (x) {
      if (x.isNaN()) return new D(NaN);
      if (x.abs().gt(D.precision * 2 + 20)) return new D(x.s);
      return x.tanh();
    },
    asinh: function (x) { return x.asinh(); },
    acosh: function (x) { return x.acosh(); },
    atanh: function (x) { return x.atanh(); },
    arcsin: function (x) { return x.asin(); },
    arccos: function (x) { return x.acos(); },
    arctan: function (x) { return x.atan(); },
    arcsinh: function (x) { return x.asinh(); },
    arccosh: function (x) { return x.acosh(); },
    arctanh: function (x) { return x.atanh(); },
    arsinh: function (x) { return x.asinh(); },
    arcosh: function (x) { return x.acosh(); },
    artanh: function (x) { return x.atanh(); },
    exp: function (x) {
      if (x.isNaN()) return new D(NaN);
      if (x.lt(-1e13)) return new D(0);
      if (x.gt(1e13)) return new D(Infinity);
      return x.exp();
    },
    ln: function (x) { return x.ln(); },
    log: function (x) { return x.ln(); },
    log10: function (x) { return D.log10(x); },
    log2: function (x) { return D.log2(x); },
    sqrt: function (x) { return x.sqrt(); },
    cbrt: function (x) { return x.cbrt(); },
    abs: function (x) { return x.abs(); },
    pow: function (a, b) { return safePow(a, b); },
    hypot: function (a, b) { return D.hypot(a, b); },
    floor: function (x) { return x.floor(); },
    ceil: function (x) { return x.ceil(); },
    round: function (x) { return x.round(); },
    sign: function (x) { return x.isZero() ? new D(0) : new D(x.s); },
    min: function (a, b) { return a.lt(b) ? a : b; },
    max: function (a, b) { return a.gt(b) ? a : b; }
  };

  /* ---------- 语法 → 闭包 ---------- */
  function compileDec(src) {
    var ts = insertImplicit(tokenize(src)), pos = 0;
    function peek() { return ts[pos]; }
    function eat(t) { var k = ts[pos]; if (!k || k.t !== t) throw new Error('表达式语法错误'); pos++; return k; }

    function atom() {
      var k = peek();
      if (!k) throw new Error('表达式意外结束');
      if (k.t === 'num') { pos++; var lit = k.v; return function () { return new D(lit); }; }
      if (k.t === 'id') {
        pos++;
        var name = k.v.toLowerCase();
        if (name === 'x') return function (x) { return x; };
        if (Object.prototype.hasOwnProperty.call(DCONSTS, name)) {
          var cfn = DCONSTS[name];
          return function () { return cfn(); };
        }
        if (peek() && peek().t === 'lp') {
          pos++;
          var args = [];
          if (!(peek() && peek().t === 'rp')) {
            args.push(expr());
            while (peek() && peek().t === 'comma') { pos++; args.push(expr()); }
          }
          eat('rp');
          var fn = DFUNCS[name];
          if (!fn) throw new Error('未知函数「' + name + '」');
          var A = args.slice();
          return function (x) {
            var vs = A.map(function (f) { return f(x); });
            return fn.apply(null, vs);
          };
        }
        throw new Error('未知标识符「' + name + '」');
      }
      if (k.t === 'lp') {
        pos++;
        var inner = expr();
        eat('rp');
        return inner;
      }
      if (k.t === 'op' && (k.v === '-' || k.v === '+')) {
        pos++;
        var u = unary();
        return k.v === '-' ? function (x) { return u(x).neg(); } : u;
      }
      throw new Error('表达式语法错误：位置 ' + pos + ' 附近是「' + k.v + '」');
    }

    function power() {
      var base = atom();
      if (peek() && peek().t === 'op' && peek().v === '^') {
        pos++;
        var ex = unary();
        return function (x) { return safePow(base(x), ex(x)); };
      }
      return base;
    }

    function unary() {
      var k = peek();
      if (k && k.t === 'op' && (k.v === '-' || k.v === '+')) {
        pos++;
        var u = unary();
        return k.v === '-' ? function (x) { return u(x).neg(); } : u;
      }
      return power();
    }

    /* 工厂函数：绝不能在循环里 var L = left 再闭包捕获 ——
       所有闭包会共享同一个绑定，三项以上的表达式直接无限递归。 */
    function binop(op, L, R) {
      if (op === '*') return function (x) { return L(x).mul(R(x)); };
      if (op === '/') return function (x) { return L(x).div(R(x)); };
      if (op === '+') return function (x) { return L(x).plus(R(x)); };
      return function (x) { return L(x).minus(R(x)); };
    }

    function term() {
      var left = unary();
      while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
        left = binop(ts[pos++].v, left, unary());
      }
      return left;
    }

    function expr() {
      var left = term();
      while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
        left = binop(ts[pos++].v, left, term());
      }
      return left;
    }

    var fn = expr();
    if (pos !== ts.length) throw new Error('表达式语法错误：位置 ' + pos + ' 起有多余内容');
    return fn;
  }

  /* 安全求值包装 */
  function evalDec(g, x) {
    try { return g(x); } catch (e) { return new D(NaN); }
  }

  /* ---------- Split-Decimal (base + delta) 精确端点消去编译器 ----------
     在端点 x = anchor + off（off 极小如 1e-600）求值时，把每个中间量表示为
     { b, d }（语义为 b + d），从而 1 - (1, -off) = (0, +off) 零有效位损失，
     无须把 Decimal 工作精度拉高到 300+ 位即可高精度处理任意强端点奇点。 */
  function compileSplitDec(src) {
    var ts = insertImplicit(tokenize(src)), pos = 0;
    var ZERO = new D(0), TWO = new D(2);
    function peek() { return ts[pos]; }
    function eat(t) { var k = ts[pos]; if (!k || k.t !== t) throw new Error('表达式语法错误'); pos++; return k; }

    function sdAdd(L, R) { return { b: L.b.plus(R.b), d: L.d.plus(R.d) }; }
    function sdSub(L, R) { return { b: L.b.minus(R.b), d: L.d.minus(R.d) }; }
    function sdMul(L, R) {
      return {
        b: L.b.mul(R.b),
        d: L.b.mul(R.d).plus(L.d.mul(R.b)).plus(L.d.mul(R.d))
      };
    }
    function sdDiv(L, R) {
      if (!R.b.isFinite() || !R.d.isFinite()) return { b: ZERO, d: L.b.plus(L.d).div(R.b.plus(R.d)) };
      if (R.b.isZero()) return { b: ZERO, d: L.b.plus(L.d).div(R.d) };
      if (R.d.isZero()) return { b: L.b.div(R.b), d: L.d.div(R.b) };
      if (L.b.isZero()) return { b: ZERO, d: L.d.div(R.b.plus(R.d)) };
      var q = L.b.div(R.b);
      var den = R.b.plus(R.d);
      if (den.isZero()) return { b: ZERO, d: new D(NaN) };
      return { b: q, d: L.d.minus(q.mul(R.d)).div(den) };
    }
    function sdPow(L, R) {
      var eVal = R.b.plus(R.d);
      if (L.b.isZero()) return { b: ZERO, d: safePow(L.d, eVal) };
      if (L.d.isZero() && R.d.isZero()) return { b: safePow(L.b, eVal), d: ZERO };
      if (R.d.isZero() && eVal.isInteger()) {
        if (eVal.eq(2)) return sdMul(L, L);
        if (eVal.eq(3)) return sdMul(sdMul(L, L), L);
      }
      var baseP = safePow(L.b, eVal);
      if (!baseP.isFinite()) return { b: ZERO, d: safePow(L.b.plus(L.d), eVal) };
      var fullP = safePow(L.b.plus(L.d), eVal);
      if (fullP.eq(baseP) && !L.d.isZero() && !L.b.isZero() && R.d.isZero()) {
        return { b: baseP, d: baseP.mul(eVal).mul(L.d).div(L.b) };
      }
      return { b: baseP, d: fullP.minus(baseP) };
    }
    var ONE = new D(1), HALF = new D('0.5'), SMALL_TH = new D('0.05');
    function expm1Taylor(d) {
      var term = d, sum = d, tol = d.abs().mul(new D(10).pow(-(D.precision + 4)));
      for (var k = 2; k <= 80; k++) {
        term = term.mul(d).div(k);
        sum = sum.plus(term);
        if (term.abs().lte(tol)) break;
      }
      return sum;
    }
    function cosm1Taylor(d) {
      var d2 = d.mul(d), term = d2.neg().div(TWO), sum = term;
      var tol = term.abs().mul(new D(10).pow(-(D.precision + 4)));
      for (var k = 4; k <= 80; k += 2) {
        term = term.mul(d2).neg().div((k - 1) * k);
        sum = sum.plus(term);
        if (term.abs().lte(tol)) break;
      }
      return sum;
    }
    function log1pTaylor(d) {
      var p = d, sum = d, tol = d.abs().mul(new D(10).pow(-(D.precision + 4)));
      for (var k = 2; k <= 120; k++) {
        p = p.mul(d).neg();
        var term = p.div(k);
        sum = sum.plus(term);
        if (term.abs().lte(tol)) break;
      }
      return sum;
    }
    function sdCall1(name, fn, A) {
      var canon = name;
      if (canon === 'arctanh' || canon === 'artanh') canon = 'atanh';
      else if (canon === 'arcsinh' || canon === 'arsinh') canon = 'asinh';
      else if (canon === 'arccosh' || canon === 'arcosh') canon = 'acosh';
      else if (canon === 'arcsin') canon = 'asin';
      else if (canon === 'arccos') canon = 'acos';
      else if (canon === 'arctan') canon = 'atan';

      if (A.b.isZero()) {
        if (!A.d.isZero() && A.d.isFinite() && A.d.abs().lt(SMALL_TH)) {
          if (canon === 'exp') return { b: ONE, d: expm1Taylor(A.d) };
          if (canon === 'cos') return { b: ONE, d: cosm1Taylor(A.d) };
        }
        return { b: ZERO, d: fn(A.d) };
      }
      if (A.d.isZero()) return { b: fn(A.b), d: ZERO };
      if ((canon === 'ln' || canon === 'log') && A.b.eq(ONE) && A.d.isFinite() && A.d.abs().lt(SMALL_TH)) {
        return { b: ZERO, d: log1pTaylor(A.d) };
      }
      /* 反双曲 / 反三角函数在分支点 ±1 处精确防相消：即使 |d| < 10^-workPrec 也能避免 1+d 舍入为 1 导致 Inf/NaN */
      if (canon === 'atanh' && A.d.isFinite() && A.d.abs().lt(ONE)) {
        if (A.b.eq(ONE) && A.d.s < 0) {
          var negD = A.d.neg();
          return { b: ZERO, d: TWO.plus(A.d).ln().minus(negD.ln()).mul(HALF) };
        }
        if (A.b.eq(ONE.neg()) && A.d.s > 0) {
          return { b: ZERO, d: A.d.ln().minus(TWO.minus(A.d).ln()).mul(HALF) };
        }
      }
      if (canon === 'acosh' && A.b.eq(ONE) && A.d.isFinite() && A.d.s > 0 && A.d.lt(ONE)) {
        var sqAc = A.d.mul(TWO.plus(A.d)).sqrt();
        return { b: ZERO, d: ONE.plus(A.d).plus(sqAc).ln() };
      }
      if ((canon === 'acos' || canon === 'asin') && A.d.isFinite() && A.d.abs().lt(ONE)) {
        if (A.b.eq(ONE) && A.d.s < 0) {
          var ang1 = A.d.neg().mul(HALF).sqrt().asin().mul(TWO);
          if (canon === 'acos') return { b: ZERO, d: ang1 };
          return { b: D.acos(ZERO), d: ang1.neg() };
        }
        if (A.b.eq(ONE.neg()) && A.d.s > 0) {
          var ang2 = A.d.mul(HALF).sqrt().asin().mul(TWO);
          if (canon === 'acos') return { b: D.acos(ONE.neg()), d: ang2.neg() };
          return { b: D.acos(ZERO).neg(), d: ang2 };
        }
      }
      if ((canon === 'floor' || canon === 'ceil' || canon === 'round' || canon === 'sign') &&
          A.b.isFinite() && A.d.isFinite()) {
        if (canon === 'sign') {
          if (A.b.isZero()) return { b: new D(A.d.s), d: ZERO };
          if (A.d.abs().lt(A.b.abs())) return { b: new D(A.b.s), d: ZERO };
        } else if (A.b.isInteger() && A.d.abs().lt(ONE)) {
          if (canon === 'floor') return { b: A.d.s < 0 ? A.b.minus(ONE) : A.b, d: ZERO };
          if (canon === 'ceil') return { b: A.d.s > 0 ? A.b.plus(ONE) : A.b, d: ZERO };
          if (canon === 'round' && A.d.abs().lt(HALF)) return { b: A.b, d: ZERO };
        }
      }
      var vBase = fn(A.b);
      if (!vBase.isFinite()) return { b: ZERO, d: fn(A.b.plus(A.d)) };
      var vFull = fn(A.b.plus(A.d));
      if (vFull.eq(vBase)) {
        if (canon === 'sin') return { b: vBase, d: DFUNCS.cos(A.b).mul(A.d).minus(HALF.mul(vBase).mul(A.d).mul(A.d)) };
        if (canon === 'cos') return { b: vBase, d: DFUNCS.sin(A.b).neg().mul(A.d).minus(HALF.mul(vBase).mul(A.d).mul(A.d)) };
        if (canon === 'exp') return { b: vBase, d: vBase.mul(A.d) };
        if (canon === 'ln' || canon === 'log') return { b: vBase, d: A.d.div(A.b) };
        if (canon === 'sqrt' && !vBase.isZero()) return { b: vBase, d: A.d.div(vBase.mul(TWO)) };
      }
      return { b: vBase, d: vFull.minus(vBase) };
    }

    function atom() {
      var k = peek();
      if (!k) throw new Error('表达式意外结束');
      if (k.t === 'num') { pos++; var lit = k.v; return function () { return { b: new D(lit), d: ZERO }; }; }
      if (k.t === 'id') {
        pos++;
        var name = k.v.toLowerCase();
        if (name === 'x') return function (anc, off) { return { b: anc, d: off }; };
        if (Object.prototype.hasOwnProperty.call(DCONSTS, name)) {
          var cfn = DCONSTS[name];
          return function () { return { b: cfn(), d: ZERO }; };
        }
        if (peek() && peek().t === 'lp') {
          pos++;
          var args = [];
          if (!(peek() && peek().t === 'rp')) {
            args.push(expr());
            while (peek() && peek().t === 'comma') { pos++; args.push(expr()); }
          }
          eat('rp');
          var fn = DFUNCS[name];
          if (!fn) throw new Error('未知函数「' + name + '」');
          var A = args.slice();
          if (A.length === 1) {
            var a0 = A[0];
            return function (anc, off) { return sdCall1(name, fn, a0(anc, off)); };
          }
          if (name === 'pow' && A.length === 2) {
            return function (anc, off) { return sdPow(A[0](anc, off), A[1](anc, off)); };
          }
          return function (anc, off) {
            var vs = A.map(function (f) { var r = f(anc, off); return r.b.plus(r.d); });
            return { b: ZERO, d: fn.apply(null, vs) };
          };
        }
        throw new Error('未知标识符「' + name + '」');
      }
      if (k.t === 'lp') {
        pos++;
        var inner = expr();
        eat('rp');
        return inner;
      }
      if (k.t === 'op' && (k.v === '-' || k.v === '+')) {
        pos++;
        var u = unary();
        return k.v === '-' ? function (anc, off) { var r = u(anc, off); return { b: r.b.neg(), d: r.d.neg() }; } : u;
      }
      throw new Error('表达式语法错误');
    }

    function power() {
      var base = atom();
      if (peek() && peek().t === 'op' && peek().v === '^') {
        pos++;
        var ex = unary();
        return function (anc, off) { return sdPow(base(anc, off), ex(anc, off)); };
      }
      return base;
    }

    function unary() {
      var k = peek();
      if (k && k.t === 'op' && (k.v === '-' || k.v === '+')) {
        pos++;
        var u = unary();
        return k.v === '-' ? function (anc, off) { var r = u(anc, off); return { b: r.b.neg(), d: r.d.neg() }; } : u;
      }
      return power();
    }

    function binop(op, L, R) {
      if (op === '*') return function (anc, off) { return sdMul(L(anc, off), R(anc, off)); };
      if (op === '/') return function (anc, off) { return sdDiv(L(anc, off), R(anc, off)); };
      if (op === '+') return function (anc, off) { return sdAdd(L(anc, off), R(anc, off)); };
      return function (anc, off) { return sdSub(L(anc, off), R(anc, off)); };
    }

    function term() {
      var left = unary();
      while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
        left = binop(ts[pos++].v, left, unary());
      }
      return left;
    }

    function expr() {
      var left = term();
      while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
        left = binop(ts[pos++].v, left, term());
      }
      return left;
    }

    var fn = expr();
    if (pos !== ts.length) throw new Error('表达式语法错误');
    return fn;
  }

  function evalSplitDec(gSplit, anchor, off) {
    try {
      var r = gSplit(anchor, off);
      return r.b.plus(r.d);
    } catch (e) { return new D(NaN); }
  }

  /* ---------- 互补距离 tanh-sinh（有限区间，Split-Decimal 零端点消去 + 独立双翼停止） ---------- */
  function tanhSinh(g, a, b, opt) {
    var o = opt || {};
    var targetDigits = o.digits || 26;
    var maxLevel = o.maxLevel || 6;
    var maxMs = o.maxMs || 2500;
    var gSplit = o.gSplit || null;
    var deadline = Date.now() + maxMs;
    var stopDiff = new D(10).pow(-(targetDigits + 2));
    var c = a.plus(b).div(2), d = b.minus(a).div(2);
    var PI = decPI(), HP = PI.div(2);
    var one = new D(1), two = new D(2);
    var expFull = new D(10).pow(D.precision + 5);
    var expAsymp = D.precision * 3 + 25;
    /* tailTol 绑定目标位数而非 D.precision，防止 0/0 抵消类在极深端点处精度耗尽爆噪 */
    var tailTol = new D(10).pow(-(targetDigits + 7));
    var nearA = D.max(a.abs(), one).mul(new D(10).pow(-(Math.max(10, D.precision - 3))));
    var nearB = D.max(b.abs(), one).mul(new D(10).pow(-(Math.max(10, D.precision - 3))));

    var rawSum = new D(0), absRawSum = new D(0);
    var prev = null, best = null, totalEvals = 0;

    var g0 = evalDec(g, c);
    totalEvals++;
    if (!g0.isFinite()) {
      return { value: new D(NaN), prev: null, absInt: new D(NaN), level: 0, evals: totalEvals, converged: false, aborted: true };
    }
    var w0 = HP.mul(g0);
    rawSum = w0;
    absRawSum = w0.abs();

    var noiseCut = new D(10).pow(-(Math.max(12, Math.floor(D.precision / 2) - 5)));
    for (var L = 1; L <= maxLevel; L++) {
      var h = two.pow(-L);
      var step = L === 1 ? 1 : 2;
      var aborted = false;
      var doneL = false, doneR = false;
      var smallL = 0, smallR = 0;
      var lastVR = null, prevLastVR = null, prevAR = null;
      var lastVL = null, prevLastVL = null, prevAL = null;

      for (var k = 1; k < 400000; k += step) {
        if ((k & 31) === 1 && Date.now() > deadline) { aborted = true; break; }
        var t = h.mul(k);
        var tNum = t.toNumber();
        var sh = t.sinh(), ch = t.cosh();
        var u = HP.mul(sh);
        var u2 = u.mul(2);
        if (u2.gt(1e12)) break;

        var delta, frac;
        if (u2.gt(expAsymp)) {
          delta = two.mul(u2.neg().exp());
          frac = one;
        } else {
          var e2u = u2.exp();
          delta = two.div(e2u.plus(one));
          frac = e2u.gt(expFull) ? one : e2u.div(e2u.plus(one));
        }
        var off = d.mul(delta);
        if (off.isZero()) break;
        var w = PI.mul(ch).mul(delta).mul(frac);

        var xp = null, xm = null;
        if (!gSplit) {
          xp = b.minus(off);
          xm = a.plus(off);
          if (!doneR && xp.gte(b)) doneR = true;
          if (!doneL && xm.lte(a)) doneL = true;
          if (doneL && doneR) break;
        }

        if (!doneR) {
          var v1 = gSplit ? evalSplitDec(gSplit, b, off.neg()) : evalDec(g, xp);
          totalEvals++;
          if (!v1.isFinite()) {
            if (off.lte(nearB) && k > 3) doneR = true;
            else { aborted = true; break; }
          } else {
            var v1Abs = v1.abs();
            /* 仅当此前函数幅值有界（非奇点增长）且上一项已衰减至 tailTol 量级，却在极深处突现 1e10 倍爆噪，才判为 0/0 舍入尖刺 */
            if (tNum >= 2.5 && off.lt(noiseCut) && lastVR && prevLastVR && prevAR && !absRawSum.isZero() &&
                lastVR.lte(prevLastVR.mul(two).plus(one)) &&
                prevAR.lte(absRawSum.mul(tailTol).mul('1e4')) &&
                v1Abs.gt(lastVR.plus(one).mul('1e10'))) {
              doneR = true;
            } else {
              var t1 = w.mul(v1);
              if (!t1.isFinite()) { aborted = true; break; }
              rawSum = rawSum.plus(t1);
              var a1 = t1.abs();
              absRawSum = absRawSum.plus(a1);
              prevLastVR = lastVR; lastVR = v1Abs; prevAR = a1;
              if (tNum >= 1.5) {
                if (a1.isZero() && tNum >= 2.5) {
                  if (++smallR >= 2) doneR = true;
                } else if (!absRawSum.isZero() && a1.lte(absRawSum.mul(tailTol))) {
                  if (++smallR >= 3) doneR = true;
                } else {
                  smallR = 0;
                }
              }
            }
          }
        }
        if (!doneL) {
          var v2 = gSplit ? evalSplitDec(gSplit, a, off) : evalDec(g, xm);
          totalEvals++;
          if (!v2.isFinite()) {
            if (off.lte(nearA) && k > 3) doneL = true;
            else { aborted = true; break; }
          } else {
            var v2Abs = v2.abs();
            if (tNum >= 2.5 && off.lt(noiseCut) && lastVL && prevLastVL && prevAL && !absRawSum.isZero() &&
                lastVL.lte(prevLastVL.mul(two).plus(one)) &&
                prevAL.lte(absRawSum.mul(tailTol).mul('1e4')) &&
                v2Abs.gt(lastVL.plus(one).mul('1e10'))) {
              doneL = true;
            } else {
              var t2 = w.mul(v2);
              if (!t2.isFinite()) { aborted = true; break; }
              rawSum = rawSum.plus(t2);
              var a2 = t2.abs();
              absRawSum = absRawSum.plus(a2);
              prevLastVL = lastVL; lastVL = v2Abs; prevAL = a2;
              if (tNum >= 1.5) {
                if (a2.isZero() && tNum >= 2.5) {
                  if (++smallL >= 2) doneL = true;
                } else if (!absRawSum.isZero() && a2.lte(absRawSum.mul(tailTol))) {
                  if (++smallL >= 3) doneL = true;
                } else {
                  smallL = 0;
                }
              }
            }
          }
        }
        if (doneL && doneR) break;
      }

      var v = rawSum.mul(h).mul(d);
      var absInt = absRawSum.mul(h).mul(d);
      if (!v.isFinite()) aborted = true;
      best = { value: v, prev: prev ? prev.value : null, absInt: absInt, level: L, evals: totalEvals, aborted: aborted, converged: false };
      if (aborted) break;

      if (prev && (L >= 3 || maxLevel < 3)) {
        var refScale = D.max(v.abs(), absInt, new D('1e-300'));
        if (v.minus(prev.value).abs().lt(stopDiff.mul(refScale))) {
          best.converged = true;
          break;
        }
      }
      prev = best;
    }
    return best;
  }

  /* ---------- 单向对数尾部探测（仅用于无穷方向） ---------- */
  function probeInfiniteTail(fNum, startX, dir) {
    if (!fNum || !isFinite(startX)) return { cutoff: null, divergentOverflow: false };
    var N = 80;
    var xs = [], vs = [], peak = 0;
    var firstNonFinAfterFin = -1, seenFin = false;
    var lastFinIdx = -1;

    for (var k = 0; k <= N; k++) {
      var x = startX + dir * (Math.pow(2, k * 0.5) - 1);
      var v;
      try { v = fNum(x); } catch (e) { v = NaN; }
      xs.push(x);
      vs.push(v);
      if (isFinite(v)) {
        seenFin = true;
        lastFinIdx = k;
        firstNonFinAfterFin = -1;
        if (Math.abs(v) > peak) peak = Math.abs(v);
      } else if (seenFin && firstNonFinAfterFin < 0) {
        firstNonFinAfterFin = k;
      }
    }

    if (!seenFin || peak === 0) return { cutoff: null, divergentOverflow: false };

    /* 1. 后缀溢出检查：lastFinIdx < N 且从 lastFinIdx+1 到 N 全部非有限 */
    if (lastFinIdx < N && firstNonFinAfterFin === lastFinIdx + 1) {
      var lo = xs[lastFinIdx], hi = xs[lastFinIdx + 1];
      var vEdge = vs[lastFinIdx], xEdge = lo;
      for (var it = 0; it < 30; it++) {
        var mid = (lo + hi) / 2, fm;
        try { fm = fNum(mid); } catch (e) { fm = NaN; }
        if (isFinite(fm)) { lo = mid; vEdge = fm; xEdge = mid; }
        else hi = mid;
      }
      if (Math.abs(vEdge) <= 1e-12 * peak) {
        /* 良性溢出（sinh/cosh 在 |x|>710 变成 ∞/∞）：向起点方向找衰减至 1e-100*peak 处 */
        var x100 = xEdge;
        var thresh100 = 1e-100 * peak;
        for (var j = lastFinIdx; j >= 0; j--) {
          if (isFinite(vs[j]) && Math.abs(vs[j]) > thresh100) {
            x100 = xs[Math.min(lastFinIdx, j + 1)];
            break;
          }
        }
        return { cutoff: Math.abs(x100 - startX) * 1.5 + 30, divergentOverflow: false };
      }
      return { cutoff: null, divergentOverflow: true };
    }

    /* 2. 全程有限：找从某点起连续 >=12 个点都 <= 1e-120*peak 的指数衰减尾部 */
    var thresh120 = 1e-120 * peak;
    var tailRun = 0, tailStart = -1;
    for (var m = N; m >= 0; m--) {
      if (isFinite(vs[m]) && Math.abs(vs[m]) <= thresh120) {
        tailRun++;
        tailStart = m;
      } else {
        break;
      }
    }
    if (tailRun >= 12 && tailStart > 0) {
      return { cutoff: Math.abs(xs[tailStart] - startX) * 1.5 + 30, divergentOverflow: false };
    }
    return { cutoff: null, divergentOverflow: false };
  }

  /* ---------- 原生 exp-sinh（半无穷区间 [a,+∞) 或 (-∞,a]） ---------- */
  function expSinh(gDec, aDec, dir, cutDist, opt) {
    var o = opt || {};
    var targetDigits = o.digits || 26;
    var maxLevel = o.maxLevel || 6;
    var maxMs = o.maxMs || 2500;
    var gSplit = o.gSplit || null;
    var deadline = Date.now() + maxMs;
    var stopDiff = new D(10).pow(-(targetDigits + 2));
    var PI = decPI(), HP = PI.div(2);
    var two = new D(2), one = new D(1);
    var dirDec = new D(dir);
    var tailTol = new D(10).pow(-(targetDigits + 7));
    var nearA = D.max(aDec.abs(), one).mul(new D(10).pow(-(Math.max(10, D.precision / 2))));
    var cutDec = cutDist !== null ? new D(cutDist) : null;
    var cutLogLim = cutDist !== null ? Math.log(cutDist) + 4 : null;

    var rawSum = new D(0), absRawSum = new D(0);
    var prev = null, best = null, totalEvals = 0;

    var g0 = evalDec(gDec, aDec.plus(dirDec));
    totalEvals++;
    if (!g0.isFinite()) {
      return { value: new D(NaN), prev: null, absInt: new D(NaN), level: 0, evals: totalEvals, converged: false, aborted: true };
    }
    var w0 = HP.mul(g0);
    rawSum = w0;
    absRawSum = w0.abs();

    for (var L = 1; L <= maxLevel; L++) {
      var h = two.pow(-L);
      var step = L === 1 ? 1 : 2;
      var aborted = false;
      var donePos = false, doneNeg = false;
      var smallPos = 0, smallNeg = 0;
      var tailTrunc = new D(0);

      for (var k = 1; k < 400000; k += step) {
        if ((k & 31) === 1 && Date.now() > deadline) { aborted = true; break; }
        var t = h.mul(k);
        var tNum = t.toNumber();
        var sh = t.sinh(), ch = t.cosh();
        var u = HP.mul(sh);

        /* 正翼 t > 0：走向无穷远 */
        if (!donePos) {
          if (cutLogLim !== null && u.gt(cutLogLim)) {
            donePos = true;
          } else if (u.gt(1e12)) {
            donePos = true;
          } else {
            var rp = u.exp();
            if (cutDec !== null && rp.gt(cutDec)) {
              donePos = true;
            } else {
              var xp = aDec.plus(rp.mul(dirDec));
              var vp = evalDec(gDec, xp);
              totalEvals++;
              if (!vp.isFinite()) {
                aborted = true; break;
              }
              var tp = HP.mul(ch).mul(rp).mul(vp);
              if (!tp.isFinite()) { aborted = true; break; }
              rawSum = rawSum.plus(tp);
              var ap = tp.abs();
              absRawSum = absRawSum.plus(ap);
              if (u.gt(1e11) && !absRawSum.isZero() && ap.gt(absRawSum.mul(tailTol))) {
                tailTrunc = D.max(tailTrunc, tp.abs().mul(two));
              }
              if (tNum >= 1.5 && !absRawSum.isZero()) {
                if (ap.lte(absRawSum.mul(tailTol))) {
                  if (++smallPos >= 3) donePos = true;
                } else {
                  smallPos = 0;
                }
              }
            }
          }
        }

        /* 负翼 -t < 0：走向有限端点 aDec */
        if (!doneNeg) {
          if (u.gt(1e12)) {
            doneNeg = true;
          } else {
            var rn = u.neg().exp();
            if (rn.isZero()) {
              doneNeg = true;
            } else {
              var xm = gSplit ? null : aDec.plus(rn.mul(dirDec));
              if (!gSplit && !aDec.isZero() && xm.eq(aDec)) {
                doneNeg = true;
              } else {
                var vm = gSplit ? evalSplitDec(gSplit, aDec, rn.mul(dirDec)) : evalDec(gDec, xm);
                totalEvals++;
                if (!vm.isFinite()) {
                  if (rn.lte(nearA) && k > 2) doneNeg = true;
                  else { aborted = true; break; }
                } else {
                  var tm = HP.mul(ch).mul(rn).mul(vm);
                  if (!tm.isFinite()) { aborted = true; break; }
                  rawSum = rawSum.plus(tm);
                  var am = tm.abs();
                  absRawSum = absRawSum.plus(am);
                  if (tNum >= 1.5 && !absRawSum.isZero()) {
                    if (am.lte(absRawSum.mul(tailTol))) {
                      if (++smallNeg >= 3) doneNeg = true;
                    } else {
                      smallNeg = 0;
                    }
                  }
                }
              }
            }
          }
        }

        if (donePos && doneNeg) break;
      }

      var v = rawSum.mul(h);
      var absInt = absRawSum.mul(h);
      if (!v.isFinite()) aborted = true;
      best = { value: v, prev: prev ? prev.value : null, absInt: absInt, tailTrunc: tailTrunc, level: L, evals: totalEvals, aborted: aborted, converged: false };
      if (aborted) break;

      if (prev && (L >= 3 || maxLevel < 3)) {
        var refScale = D.max(v.abs(), absInt, new D('1e-300'));
        if (v.minus(prev.value).abs().lt(stopDiff.mul(refScale))) {
          best.converged = true;
          break;
        }
      }
      prev = best;
    }
    return best;
  }

  /* ---------- 原生 sinh-sinh（双无穷区间 (-∞,+∞)） ---------- */
  function sinhSinh(gDec, cutPos, cutNeg, opt) {
    var o = opt || {};
    var targetDigits = o.digits || 26;
    var maxLevel = o.maxLevel || 6;
    var maxMs = o.maxMs || 2500;
    var deadline = Date.now() + maxMs;
    var stopDiff = new D(10).pow(-(targetDigits + 2));
    var PI = decPI(), HP = PI.div(2);
    var two = new D(2), one = new D(1);
    var tailTol = new D(10).pow(-(targetDigits + 7));
    var cutPDec = cutPos !== null ? new D(cutPos) : null;
    var cutNDec = cutNeg !== null ? new D(cutNeg) : null;
    var cutPLog = cutPos !== null ? Math.log(cutPos) + 4 : null;
    var cutNLog = cutNeg !== null ? Math.log(cutNeg) + 4 : null;

    var rawSum = new D(0), absRawSum = new D(0);
    var prev = null, best = null, totalEvals = 0;

    var g0 = evalDec(gDec, new D(0));
    totalEvals++;
    if (!g0.isFinite()) {
      return { value: new D(NaN), prev: null, absInt: new D(NaN), level: 0, evals: totalEvals, converged: false, aborted: true };
    }
    var w0 = HP.mul(g0);
    rawSum = w0;
    absRawSum = w0.abs();

    for (var L = 1; L <= maxLevel; L++) {
      var h = two.pow(-L);
      var step = L === 1 ? 1 : 2;
      var aborted = false;
      var donePos = false, doneNeg = false;
      var smallPos = 0, smallNeg = 0;

      for (var k = 1; k < 400000; k += step) {
        if ((k & 31) === 1 && Date.now() > deadline) { aborted = true; break; }
        var t = h.mul(k);
        var tNum = t.toNumber();
        var sh = t.sinh(), ch = t.cosh();
        var u = HP.mul(sh);
        if (u.gt(1e12)) break;

        if (cutPLog !== null && u.gt(cutPLog)) donePos = true;
        if (cutNLog !== null && u.gt(cutNLog)) doneNeg = true;
        if (donePos && doneNeg) break;

        var eu = u.exp(), em = one.div(eu);
        var xMag = eu.minus(em).div(two);
        var coshU = eu.plus(em).div(two);
        var w = HP.mul(ch).mul(coshU);

        if (!donePos && cutPDec !== null && xMag.gt(cutPDec)) donePos = true;
        if (!doneNeg && cutNDec !== null && xMag.gt(cutNDec)) doneNeg = true;
        if (donePos && doneNeg) break;

        if (!donePos) {
          var vp = evalDec(gDec, xMag);
          totalEvals++;
          if (!vp.isFinite()) { aborted = true; break; }
          var tp = w.mul(vp);
          if (!tp.isFinite()) { aborted = true; break; }
          rawSum = rawSum.plus(tp);
          var ap = tp.abs();
          absRawSum = absRawSum.plus(ap);
          if (tNum >= 1.5 && !absRawSum.isZero()) {
            if (ap.lte(absRawSum.mul(tailTol))) {
              if (++smallPos >= 3) donePos = true;
            } else {
              smallPos = 0;
            }
          }
        }

        if (!doneNeg) {
          var vn = evalDec(gDec, xMag.neg());
          totalEvals++;
          if (!vn.isFinite()) { aborted = true; break; }
          var tn = w.mul(vn);
          if (!tn.isFinite()) { aborted = true; break; }
          rawSum = rawSum.plus(tn);
          var an = tn.abs();
          absRawSum = absRawSum.plus(an);
          if (tNum >= 1.5 && !absRawSum.isZero()) {
            if (an.lte(absRawSum.mul(tailTol))) {
              if (++smallNeg >= 3) doneNeg = true;
            } else {
              smallNeg = 0;
            }
          }
        }

        if (donePos && doneNeg) break;
      }

      var v = rawSum.mul(h);
      var absInt = absRawSum.mul(h);
      if (!v.isFinite()) aborted = true;
      best = { value: v, prev: prev ? prev.value : null, absInt: absInt, level: L, evals: totalEvals, aborted: aborted, converged: false };
      if (aborted) break;

      if (prev && (L >= 3 || maxLevel < 3)) {
        var refScale = D.max(v.abs(), absInt, new D('1e-300'));
        if (v.minus(prev.value).abs().lt(stopDiff.mul(refScale))) {
          best.converged = true;
          break;
        }
      }
      prev = best;
    }
    return best;
  }

  /* ---------- 主入口 ---------- */
  function parseBoundDec(raw) {
    if (typeof raw === 'number') return { num: raw, dec: isFinite(raw) ? new D(raw) : null };
    var s = String(raw).trim().toLowerCase().replace(/\s/g, '');
    if (s === 'inf' || s === '+inf' || s === 'infinity' || s === '+infinity' || s === '∞' || s === '+∞') return { num: Infinity, dec: null };
    if (s === '-inf' || s === '-infinity' || s === '-∞') return { num: -Infinity, dec: null };
    try {
      var d = compileDec(String(raw))(new D(0));
      return { num: d.toNumber(), dec: d.isFinite() ? d : null };
    } catch (e) { return { num: NaN, dec: null }; }
  }

  function integrateHP(fNum, aRaw, bRaw, opt) {
    var o = opt || {};
    if (!fNum || !fNum.src) return null;
    var targetDigits = o.digits || 25;
    var maxLevel = o.maxLevel || 6;
    var oldPrec = D.precision;

    /* Split-Decimal 已彻底消除端点 1−x 与 (e^x-1-x)/x² 抵消；多分段场景允许 fastPrec 降低工作精度提速 */
    var workPrec = o.fastPrec ? Math.max(targetDigits + 18, 38) : Math.max(targetDigits + 52, 82);

    D.set({ precision: workPrec });
    try {
      var A = parseBoundDec(aRaw), B = parseBoundDec(bRaw);
      if (!(B.num > A.num)) return null;
      var a = A.num, b = B.num;

      var gDec, gSplit = null;
      try { gDec = compileDec(fNum.src); } catch (e) { return null; }
      try { gSplit = compileSplitDec(fNum.src); } catch (e) { gSplit = null; }

      var res = null, label = '';
      var tailBound = null;

      if (isFinite(a) && isFinite(b)) {
        label = '有限区间互补 tanh-sinh';
        /* 有限区间允许在未收敛且预算充足时走 L=7（如极窄高斯峰 exp(-1e6(x-0.3)²)） */
        var finMaxLv = o.maxLevel ? Math.max(maxLevel, o.fastPrec ? maxLevel : 7) : 7;
        res = tanhSinh(gDec, A.dec, B.dec, { digits: targetDigits, maxLevel: finMaxLv, maxMs: o.maxMs || 2500, gSplit: gSplit });
      } else if (isFinite(a) && b === Infinity) {
        label = 'exp-sinh（[a, ∞)）';
        var pR = probeInfiniteTail(fNum, a, 1);
        if (pR.divergentOverflow) return null;
        tailBound = pR.cutoff;
        res = expSinh(gDec, A.dec, 1, pR.cutoff, { digits: targetDigits, maxLevel: maxLevel, maxMs: o.maxMs || 2500, gSplit: gSplit });
      } else if (a === -Infinity && isFinite(b)) {
        label = 'exp-sinh（(−∞, b]）';
        var pL = probeInfiniteTail(fNum, b, -1);
        if (pL.divergentOverflow) return null;
        tailBound = pL.cutoff;
        res = expSinh(gDec, B.dec, -1, pL.cutoff, { digits: targetDigits, maxLevel: maxLevel, maxMs: o.maxMs || 2500, gSplit: gSplit });
      } else if (a === -Infinity && b === Infinity) {
        label = 'sinh-sinh（(−∞, ∞)）';
        var pPos = probeInfiniteTail(fNum, 0, 1);
        var pNeg = probeInfiniteTail(fNum, 0, -1);
        if (pPos.divergentOverflow || pNeg.divergentOverflow) return null;
        tailBound = { pos: pPos.cutoff, neg: pNeg.cutoff };
        /* 若 x=0 处恰好不可直接求值（可去奇点 0/0 如 sinh x/(x cosh²x)），拆两半轴用 exp-sinh */
        var gZero = evalDec(gDec, new D(0));
        if (!gZero.isFinite()) {
          var gP = evalDec(gDec, new D('0.01')), gM = evalDec(gDec, new D('-0.01'));
          if (!gP.isFinite() || !gM.isFinite()) return null;
          var rPos = expSinh(gDec, new D(0), 1, pPos.cutoff, { digits: targetDigits, maxLevel: maxLevel, maxMs: o.maxMs || 1800, gSplit: gSplit });
          var rNeg = expSinh(gDec, new D(0), -1, pNeg.cutoff, { digits: targetDigits, maxLevel: maxLevel, maxMs: o.maxMs || 1800, gSplit: gSplit });
          if (!rPos || !rPos.value || !rPos.value.isFinite() || rPos.aborted ||
              !rNeg || !rNeg.value || !rNeg.value.isFinite() || rNeg.aborted) return null;
          var sumV = rPos.value.plus(rNeg.value);
          var prevSum = (rPos.prev && rNeg.prev) ? rPos.prev.plus(rNeg.prev) : null;
          res = {
            value: sumV,
            prev: prevSum,
            absInt: rPos.absInt.plus(rNeg.absInt),
            level: Math.max(rPos.level, rNeg.level),
            evals: rPos.evals + rNeg.evals,
            converged: rPos.converged && rNeg.converged,
            aborted: false
          };
          label = '双翼 exp-sinh（0 处可去奇点拆分）';
        } else {
          res = sinhSinh(gDec, pPos.cutoff, pNeg.cutoff, { digits: targetDigits, maxLevel: maxLevel, maxMs: o.maxMs || 2500 });
        }
      }

      if (!res || !res.value || !res.value.isFinite() || res.aborted) return null;
      if (!res.converged && res.prev) {
        var ref0 = D.max(res.value.abs(), res.absInt || new D(0), new D('1e-300'));
        var allowDiff = D.max(ref0.mul('1e-12'), res.tailTrunc || new D(0));
        if (res.value.minus(res.prev).abs().gt(allowDiff)) return null;
      }

      var v = res.value;
      var absInt = res.absInt && res.absInt.isFinite() ? res.absInt : v.abs();
      var refScale = D.max(v.abs(), absInt, new D('1e-300'));
      var sigma = res.prev ? v.minus(res.prev).abs() : new D(0);
      if (res.tailTrunc && res.tailTrunc.gt(sigma)) sigma = res.tailTrunc;
      var floor = refScale.mul(new D(10).pow(-targetDigits));
      if (sigma.lt(floor)) sigma = floor;
      if (sigma.isZero()) sigma = new D(10).pow(-targetDigits);

      var digits = sigma.div(refScale).ln().div(new D(10).ln()).neg().toNumber();
      digits = Math.max(0, Math.min(40, isFinite(digits) ? digits : targetDigits));
      var isNearZero = v.abs().lte(sigma) && sigma.lt(refScale.mul('1e-12'));
      var valText = isNearZero ? '0' : v.toSignificantDigits(targetDigits + 6).toFixed();

      return {
        value: isNearZero ? 0 : v.toNumber(),
        valueText: valText,
        sigma: sigma.toNumber(),
        digits: digits,
        absInt: absInt.toNumber(),
        isNearZero: isNearZero,
        level: res.level,
        evals: res.evals,
        converged: !!res.converged,
        transformLabel: label,
        overflowBound: tailBound
      };
    } finally {
      D.set({ precision: oldPrec });
    }
  }

  /* ---------- 高精度 Gauss-Legendre 规则缓存 ---------- */
  var GL_SIN_CACHE = null, GL_SIN_PREC = -1;
  var GL_STD_CACHE = {};
  function computeLegendreNodes(n, prec) {
    var old = D.precision;
    D.set({ precision: prec });
    try {
      var PI = decPI(), xs = [], ws = [];
      for (var i = 1; i <= n; i++) {
        var x = PI.mul(i - 0.25).div(n + 0.5).cos(), p0, p1, p2, j, dp;
        for (var it = 0; it < 28; it++) {
          p0 = new D(1); p1 = x;
          for (j = 2; j <= n; j++) {
            p2 = x.mul(p1).mul(2 * j - 1).minus(p0.mul(j - 1)).div(j);
            p0 = p1; p1 = p2;
          }
          dp = p1.mul(x).minus(p0).mul(n).div(x.mul(x).minus(1));
          var dx = p1.div(dp);
          x = x.minus(dx);
          if (dx.abs().lt(new D(10).pow(-(prec + 2)))) break;
        }
        p0 = new D(1); p1 = x;
        for (j = 2; j <= n; j++) {
          p2 = x.mul(p1).mul(2 * j - 1).minus(p0.mul(j - 1)).div(j);
          p0 = p1; p1 = p2;
        }
        dp = p1.mul(x).minus(p0).mul(n).div(x.mul(x).minus(1));
        var w = new D(2).div(new D(1).minus(x.mul(x)).mul(dp.mul(dp)));
        xs.push(x);
        ws.push(w);
      }
      return { xs: xs, ws: ws };
    } finally { D.set({ precision: old }); }
  }

  function glPanelRule(n) {
    var prec = D.precision + 10;
    if (GL_SIN_CACHE && GL_SIN_PREC >= prec && GL_SIN_CACHE.n === n) return GL_SIN_CACHE;
    var old = D.precision;
    D.set({ precision: prec });
    try {
      var raw = computeLegendreNodes(n, prec);
      var PI = decPI(), ts = [], wsin = [];
      for (var i = 0; i < n; i++) {
        var t = PI.mul(raw.xs[i].plus(1)).div(2);
        ts.push(t);
        wsin.push(raw.ws[i].mul(PI).div(2).mul(t.sin()));
      }
      GL_SIN_CACHE = { n: n, ts: ts, wsin: wsin };
      GL_SIN_PREC = prec;
      return GL_SIN_CACHE;
    } finally { D.set({ precision: old }); }
  }

  function glStdRule(n) {
    var prec = D.precision + 10;
    var cur = GL_STD_CACHE[n];
    if (cur && cur.prec >= prec) return cur;
    var raw = computeLegendreNodes(n, prec);
    var us = [], ws = [];
    for (var i = 0; i < n; i++) {
      us.push(raw.xs[i].plus(1).div(2));
      ws.push(raw.ws[i].div(2));
    }
    cur = { n: n, prec: prec, us: us, ws: ws };
    GL_STD_CACHE[n] = cur;
    return cur;
  }

  function glIntegratePanel(gDec, aDec, bDec, rule) {
    var W = bDec.minus(aDec), s = new D(0);
    for (var i = 0; i < rule.us.length; i++) {
      var x = aDec.plus(W.mul(rule.us[i]));
      var v = evalDec(gDec, x);
      if (!v.isFinite()) return new D(NaN);
      s = s.plus(rule.ws[i].mul(v));
    }
    return s.mul(W);
  }

  function glIntegrateAdaptive(gDec, aDec, bDec, tol, depth, rule32, rule16, counter) {
    var v32 = glIntegratePanel(gDec, aDec, bDec, rule32);
    counter.n += rule32.n;
    if (!v32.isFinite()) return new D(NaN);
    if (depth >= 4) return v32;
    var v16 = glIntegratePanel(gDec, aDec, bDec, rule16);
    counter.n += rule16.n;
    if (!v16.isFinite()) return v32;
    if (v32.minus(v16).abs().lte(tol.mul(D.max(v32.abs(), new D(1))))) return v32;
    var mid = aDec.plus(bDec).div(2);
    var L = glIntegrateAdaptive(gDec, aDec, mid, tol, depth + 1, rule32, rule16, counter);
    var R = glIntegrateAdaptive(gDec, mid, bDec, tol, depth + 1, rule32, rule16, counter);
    return L.plus(R);
  }

  /* ---------- 振荡积分 1：chirp 换元 + 半周期面板 + CVZ 加速 ---------- */
  function stripWrap(s) {
    while (s.length > 1 && s.charAt(0) === '(' && s.charAt(s.length - 1) === ')') {
      var depth = 0, wraps = false;
      for (var i = 0; i < s.length; i++) {
        if (s.charAt(i) === '(') depth++;
        else if (s.charAt(i) === ')') { depth--; if (depth === 0) { wraps = (i === s.length - 1); break; } }
      }
      if (!wraps) break;
      s = s.slice(1, -1);
    }
    return s;
  }

  function constNum(str) {
    if (str === 'pi') return Math.PI;
    if (str === 'e') return Math.E;
    return parseFloat(str);
  }
  function decConst(str) {
    if (str === 'pi') return decPI();
    if (str === 'e') return decE();
    return new D(str);
  }

  function parseOscSrc(src) {
    var s = String(src).toLowerCase().replace(/\s+/g, '')
      .replace(/[·×]/g, '*').replace(/−/g, '-').replace(/π/g, 'pi').replace(/\*\*/g, '^')
      .replace(/²/g, '^2').replace(/³/g, '^3')
      .replace(/sqrt\(x\)/g, 'x^(1/2)');
    var NUM = '(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?';
    var Q = '(?:\\(-?' + NUM + '(?:\\/' + NUM + ')?\\)|-?' + NUM + '(?:\\/' + NUM + ')?)';
    function parseQ(t) {
      var parts = t.replace(/[()]/g, '').split('/');
      return parseFloat(parts[0]) / (parts[1] ? parseFloat(parts[1]) : 1);
    }
    function negQ(t) {
      t = t.replace(/[()]/g, '');
      return t.charAt(0) === '-' ? t.slice(1) : '-' + t;
    }
    var qNum = 0, qStr = '0', envNeg = false, core = s, em;
    if ((em = s.match(new RegExp('^(.*)\\/x\\^(' + Q + ')$')))) { core = em[1]; qStr = negQ(em[2]); }
    else if ((em = s.match(/^(.*)\/x$/))) { core = em[1]; qStr = '-1'; }
    else if ((em = s.match(new RegExp('^(.*)\\*x\\^(' + Q + ')$')))) { core = em[1]; qStr = em[2].replace(/[()]/g, ''); }
    else if ((em = s.match(/^(.*)\*x$/))) { core = em[1]; qStr = '1'; }
    else if ((em = s.match(new RegExp('^(-?)x\\^(' + Q + ')\\*(.*)$')))) { envNeg = em[1] === '-'; core = em[3]; qStr = em[2].replace(/[()]/g, ''); }
    else if ((em = s.match(/^(-?)x\*(.*)$/))) { envNeg = em[1] === '-'; core = em[2]; qStr = '1'; }
    qNum = parseQ(qStr);
    core = stripWrap(core);
    var m = core.match(new RegExp('^([+-]?(?:(?:' + NUM + '|pi|e)(?:\\*?(?:pi|e))?)?\\*?)(sin|cos)\\((.*)\\)$'));
    if (!m) return null;
    var mStr = m[1].replace(/\*$/, ''), trig = m[2], inner = stripWrap(m[3]);
    if (mStr === '' || mStr === '+') mStr = '1';
    else if (mStr === '-') mStr = '-1';
    if (envNeg) mStr = mStr.charAt(0) === '-' ? mStr.slice(1) : '-' + mStr;

    var multVal;
    try {
      multVal = compileDec(mStr)(new D(0)).toNumber();
    } catch (e) { return null; }
    if (!isFinite(multVal) || multVal === 0) return null;

    function linX(e) {
      e = stripWrap(e);
      var m1 = e.match(new RegExp('^([+-]?)(' + NUM + ')?\\*?x$'));
      if (m1) {
        var kv = m1[2] ? parseFloat(m1[2]) : 1;
        if (!(kv > 0)) return null;
        return { num: m1[1] === '-' ? -kv : kv, str: (m1[1] === '-' ? '-' : '') + (m1[2] || '1') };
      }
      var m2 = e.match(new RegExp('^x\\*(' + NUM + ')$'));
      if (m2) return { num: parseFloat(m2[1]), str: m2[1] };
      return null;
    }

    var pm = inner.match(new RegExp('^(?:(' + NUM + '|pi|e)\\*?)?x\\^(.+)$'));
    var px = pm ? null : inner.match(new RegExp('^(?:(' + NUM + '|pi|e)\\*?)?x$'));
    if (pm || px) {
      var cStr = '1', pStr = '1', p = 1;
      if (pm) {
        cStr = pm[1] || '1';
        pStr = stripWrap(pm[2]);
        var pp = pStr.match(new RegExp('^(' + NUM + ')(?:\\/(' + NUM + '))?$'));
        if (!pp) return null;
        p = parseFloat(pp[1]) / (pp[2] ? parseFloat(pp[2]) : 1);
      } else {
        cStr = px[1] || '1';
      }
      var c = constNum(cStr);
      if (!(c > 0) || !(p > 0) || !isFinite(p)) return null;
      var originOk = trig === 'sin' ? p + qNum > -1 : qNum > -1;
      if (!(qNum + 1 < p)) return null;
      return { kind: 'power', trig: trig, cStr: cStr, pStr: pStr, mStr: mStr, multVal: multVal,
               cNum: c, pNum: p, qNum: qNum, qStr: qStr, originOk: originOk };
    }

    var bStr = null, cStr2 = '1', expo = null;
    var e1 = inner.match(new RegExp('^(' + NUM + '|e|pi)\\^(.+)$'));
    var e2 = inner.match(new RegExp('^(' + NUM + '|pi|e)\\*(' + NUM + '|e|pi)\\^(.+)$'));
    var e3 = inner.match(new RegExp('^(' + NUM + ')(e|pi)\\^(.+)$'));
    var e4 = inner.match(new RegExp('^(?:(' + NUM + '|pi|e)\\*?)?exp\\((.*)\\)$'));
    if (e1) { bStr = e1[1]; expo = e1[2]; }
    else if (e2) { cStr2 = e2[1]; bStr = e2[2]; expo = e2[3]; }
    else if (e3) { cStr2 = e3[1]; bStr = e3[2]; expo = e3[3]; }
    else if (e4) { cStr2 = e4[1] || '1'; bStr = 'e'; expo = e4[2]; }
    if (bStr !== null) {
      if (qNum !== 0) return null;
      var base = constNum(bStr), c2 = constNum(cStr2);
      var kk = linX(expo);
      if (!(base > 1) || !(c2 > 0) || !kk || kk.num === 0) return null;
      return { kind: 'exp', trig: trig, cStr: cStr2, bStr: bStr, kStr: kk.str, mStr: mStr, multVal: multVal,
               cNum: c2, bNum: base, kNum: kk.num, qNum: 0, qStr: '0', originOk: trig === 'sin' };
    }
    return null;
  }

  function checkOscIdentity(fNum, hint, a, b) {
    var xs, lo;
    if (hint.kind === 'power') {
      lo = isFinite(a) ? Math.max(a, 0) : 0;
      if (isFinite(b) && lo >= b) lo = a;
      xs = [lo + 0.37, lo + 0.91, lo + 1.73, lo + 2.95];
    } else {
      lo = isFinite(a) ? a : Math.min(-2, (isFinite(b) ? b : 0) - 3);
      xs = [lo + 0.31, lo + 0.83, lo + 1.47, lo + 2.13];
    }
    var mult = hint.multVal;
    for (var i = 0; i < xs.length; i++) {
      var x = xs[i];
      if (isFinite(b) && x >= b) continue;
      if (hint.kind === 'power' && x < 0) continue;
      var u = hint.kind === 'power'
        ? hint.cNum * Math.pow(x, hint.pNum)
        : hint.cNum * Math.pow(hint.bNum, hint.kNum * x);
      var pred = mult * Math.pow(x, hint.qNum || 0) * (hint.trig === 'sin' ? Math.sin(u) : Math.cos(u));
      var act;
      try { act = fNum(x); } catch (e) { return false; }
      if (!isFinite(act) || !isFinite(pred)) return false;
      var scale = Math.max(Math.abs(act), Math.abs(pred), 1e-12);
      if (Math.abs(act - pred) > 1e-8 * scale) return false;
    }
    return true;
  }

  function cvzAccel(terms, n) {
    var d = new D(3).plus(new D(8).sqrt()).pow(n);
    d = d.plus(new D(1).div(d)).div(2);
    var b = new D(-1), c = d.neg(), s = new D(0);
    for (var k = 0; k < n; k++) {
      c = b.minus(c);
      s = s.plus(c.mul(terms[k]));
      b = b.mul(k + n).mul(k - n).div((k + 0.5) * (k + 1));
    }
    return s.div(d);
  }

  function integrateOsc(fNum, aRaw, bRaw, opt) {
    var o = opt || {};
    if (!fNum || !fNum.src) return null;
    var hint;
    try { hint = parseOscSrc(fNum.src); } catch (e) { return null; }
    if (!hint) return null;
    var digits = o.digits || 25;
    var oldPrec = D.precision;
    D.set({ precision: digits + 18 });
    try {
      var A = parseBoundDec(aRaw), B = parseBoundDec(bRaw);
      if (!(B.num > A.num)) return null;
      var a = A.num, b = B.num;
      if (!checkOscIdentity(fNum, hint, a, b)) return null;

      var PI = decPI();
      var mult = compileDec(hint.mStr)(new D(0));

      if (hint.kind === 'power') {
        var c = decConst(hint.cStr);
        var pParts = hint.pStr.split('/');
        var p = new D(pParts[0]);
        if (pParts[1]) p = p.div(pParts[1]);
        var pNum = hint.pNum;
        var qNum = hint.qNum || 0;
        var qParts = String(hint.qStr || '0').replace(/[()]/g, '').split('/');
        var qDec = new D(qParts[0]);
        if (qParts[1]) qDec = qDec.div(qParts[1]);

        var beta = qDec.plus(1).div(p).minus(1);
        var gC = new D(1).div(p).mul(c.pow(qDec.plus(1).div(p).neg()));
        var gPower = (pNum === 2 && qNum === 0)
          ? function (u) { return gC.div(u.sqrt()); }
          : beta.eq(-1)
          ? function (u) { return gC.div(u); }
          : function (u) { return gC.mul(u.pow(beta)); };
        var trigFn = hint.trig === 'sin' ? function (z) { return z.sin(); } : function (z) { return z.cos(); };
        var initGPower = function (x) {
          var ang = pNum === 2 ? c.mul(x.mul(x)) : c.mul(x.pow(p));
          var tv = trigFn(ang);
          return qNum === 0 ? tv : tv.mul(x.pow(qDec));
        };
        var subLabel = 'u = ' + (hint.cStr === '1' ? '' : hint.cStr + '·') + 'x^' + hint.pStr +
          (qNum !== 0 ? '（包络 x^' + String(hint.qStr).replace(/[()]/g, '') + ' → 振幅 u^' + beta.toFixed(4) + '）' : '');

        /* 求解 [aDec, ∞)（要求 aDec >= 0）返回 { J, sigma, evals, panels, gap, K0 } */
        var solveHalfPower = function (aDec) {
          var aNum = aDec.toNumber();
          if (aNum === 0 && !hint.originOk) return null;
          if (aNum > 0 && pNum * Math.log10(aNum) + Math.log10(hint.cNum) > 10) return null;
          var uLo = aNum === 0 ? new D(0) : c.mul(aDec.pow(p));
          if (uLo.gt('1e10')) return null;

          var uLoNum = uLo.toNumber();
          var K0 = hint.trig === 'sin'
            ? Math.max(1, Math.ceil(uLoNum / Math.PI))
            : Math.max(1, Math.ceil(uLoNum / Math.PI + 0.5));
          var u0 = hint.trig === 'sin' ? PI.mul(K0) : PI.mul(K0 - 0.5);
          while (u0.lt(uLo)) {
            K0++;
            u0 = hint.trig === 'sin' ? PI.mul(K0) : PI.mul(K0 - 0.5);
          }
          var x0 = u0.div(c).pow(new D(1).div(p));

          var initVal = new D(0), initEvals = 0, initDiff = new D(0);
          if (aDec.lt(x0)) {
            var r0 = tanhSinh(initGPower, aDec, x0, { digits: digits + 2, maxLevel: 8 });
            if (!r0 || !r0.value || !r0.value.isFinite() || r0.aborted) return null;
            initVal = r0.value; initEvals = r0.evals;
            if (r0.prev) initDiff = r0.value.minus(r0.prev).abs();
            if (!r0.converged) {
              if (initDiff.gt(initVal.abs().plus(1e-300).mul('1e-15'))) return null;
              var gam = 0;
              if (aNum === 0) gam = hint.trig === 'sin' ? pNum + qNum : qNum;
              if (gam < 0) {
                var trunc = initVal.abs().plus(1).mul(new D(10).pow(-(digits + 18) * (1 + gam)));
                if (trunc.gt(initDiff)) initDiff = trunc;
              }
            }
          }

          var rule = glPanelRule(32);
          var n1 = 36, n2 = 44, terms = [];
          for (var kk = K0; kk < K0 + n2; kk++) {
            var shift = hint.trig === 'sin' ? PI.mul(kk) : PI.mul(kk - 0.5);
            var sk = new D(0);
            for (var ii = 0; ii < rule.ts.length; ii++) sk = sk.plus(rule.wsin[ii].mul(gPower(shift.plus(rule.ts[ii]))));
            terms.push(sk);
          }
          for (var mm = 0; mm < terms.length; mm++) {
            if (!(terms[mm].gt(0))) return null;
            if (mm > 0 && !terms[mm].lt(terms[mm - 1])) return null;
          }
          var S1 = cvzAccel(terms, n1), S2 = cvzAccel(terms, n2);
          var gap = S1.minus(S2).abs();
          var J = initVal.plus(K0 % 2 === 0 ? S2 : S2.neg());
          if (!J.isFinite()) return null;
          if (gap.gt(J.abs().plus(1e-300).mul(new D(10).pow(-(digits - 3))))) return null;

          var theory = new D(8).mul(new D(3).plus(new D(8).sqrt()).pow(-n1)).mul(terms[0]);
          var sig = D.max(gap.mul(10), theory, initDiff.mul(10));
          return { J: J, sigma: sig, evals: initEvals + n2 * rule.ts.length, panels: n2, gap: gap, K0: K0 };
        };

        var mirrorSign = 1;
        if (a < 0) {
          if (Math.abs(pNum - Math.round(pNum)) > 1e-12) return null;
          if (Math.abs(qNum - Math.round(qNum)) > 1e-12) return null;
          mirrorSign = (Math.round(qNum) % 2 === 0 ? 1 : -1) *
            ((Math.round(pNum) % 2 !== 0 && hint.trig === 'sin') ? -1 : 1);
        }

        var Jtotal = null, sigTotal = null, evalsTotal = 0, panelsTotal = 0, gapTotal = 0, k0Total = 1;

        if (a === -Infinity && b === Infinity) {
          if (!hint.originOk) return null;
          if (mirrorSign === -1) {
            return {
              value: 0, valueText: '0', sigma: 0, digits: 40, panels: 0, evals: 0,
              gap: 0, consistent: true, zeroBySymmetry: true, chirp: true, subLabel: subLabel
            };
          }
          var h0 = solveHalfPower(new D(0));
          if (!h0) return null;
          Jtotal = h0.J.mul(2); sigTotal = h0.sigma.mul(2);
          evalsTotal = h0.evals; panelsTotal = h0.panels; gapTotal = h0.gap.toNumber(); k0Total = h0.K0;
        } else if (a === -Infinity && isFinite(b)) {
          if (b <= 0) {
            var hNeg = solveHalfPower(B.dec.neg());
            if (!hNeg) return null;
            Jtotal = hNeg.J.mul(mirrorSign); sigTotal = hNeg.sigma;
            evalsTotal = hNeg.evals; panelsTotal = hNeg.panels; gapTotal = hNeg.gap.toNumber(); k0Total = hNeg.K0;
          } else {
            if (!hint.originOk) return null;
            if (mirrorSign === -1) {
              var hB = solveHalfPower(B.dec);
              if (!hB) return null;
              Jtotal = hB.J.neg(); sigTotal = hB.sigma;
              evalsTotal = hB.evals; panelsTotal = hB.panels; gapTotal = hB.gap.toNumber(); k0Total = hB.K0;
            } else {
              var hZero = solveHalfPower(new D(0));
              if (!hZero) return null;
              var uB = hint.cNum * Math.pow(b, pNum);
              if (uB <= 60) {
                var rMid = tanhSinh(initGPower, new D(0), B.dec, { digits: digits + 2, maxLevel: 8 });
                if (!rMid || !rMid.value || !rMid.value.isFinite() || rMid.aborted || !rMid.converged) return null;
                Jtotal = hZero.J.plus(rMid.value);
                var mDiff = rMid.prev ? rMid.value.minus(rMid.prev).abs().mul(10) : new D(0);
                sigTotal = hZero.sigma.plus(mDiff);
                evalsTotal = hZero.evals + rMid.evals; panelsTotal = hZero.panels; gapTotal = hZero.gap.toNumber(); k0Total = hZero.K0;
              } else {
                var hB2 = solveHalfPower(B.dec);
                if (!hB2) return null;
                Jtotal = hZero.J.mul(2).minus(hB2.J);
                sigTotal = hZero.sigma.mul(2).plus(hB2.sigma);
                evalsTotal = hZero.evals + hB2.evals; panelsTotal = hZero.panels + hB2.panels;
                gapTotal = Math.max(hZero.gap.toNumber(), hB2.gap.toNumber()); k0Total = hZero.K0;
              }
            }
          }
        } else if (isFinite(a) && b === Infinity) {
          if (a >= 0) {
            var hA = solveHalfPower(A.dec);
            if (!hA) return null;
            Jtotal = hA.J; sigTotal = hA.sigma;
            evalsTotal = hA.evals; panelsTotal = hA.panels; gapTotal = hA.gap.toNumber(); k0Total = hA.K0;
          } else {
            if (!hint.originOk) return null;
            if (mirrorSign === -1) {
              /* ∫_a^∞ = ∫_a^{-a} (=0) + ∫_{-a}^∞ */
              var hMir = solveHalfPower(A.dec.neg());
              if (!hMir) return null;
              Jtotal = hMir.J; sigTotal = hMir.sigma;
              evalsTotal = hMir.evals; panelsTotal = hMir.panels; gapTotal = hMir.gap.toNumber(); k0Total = hMir.K0;
            } else {
              var hZero2 = solveHalfPower(new D(0));
              if (!hZero2) return null;
              var aAbs = A.dec.neg();
              var uA = hint.cNum * Math.pow(-a, pNum);
              if (uA <= 60) {
                var rLeft = tanhSinh(initGPower, new D(0), aAbs, { digits: digits + 2, maxLevel: 8 });
                if (!rLeft || !rLeft.value || !rLeft.value.isFinite() || rLeft.aborted || !rLeft.converged) return null;
                Jtotal = hZero2.J.plus(rLeft.value);
                var lDiff = rLeft.prev ? rLeft.value.minus(rLeft.prev).abs().mul(10) : new D(0);
                sigTotal = hZero2.sigma.plus(lDiff);
                evalsTotal = hZero2.evals + rLeft.evals; panelsTotal = hZero2.panels; gapTotal = hZero2.gap.toNumber(); k0Total = hZero2.K0;
              } else {
                var hAbs = solveHalfPower(aAbs);
                if (!hAbs) return null;
                Jtotal = hZero2.J.mul(2).minus(hAbs.J);
                sigTotal = hZero2.sigma.mul(2).plus(hAbs.sigma);
                evalsTotal = hZero2.evals + hAbs.evals; panelsTotal = hZero2.panels + hAbs.panels;
                gapTotal = Math.max(hZero2.gap.toNumber(), hAbs.gap.toNumber()); k0Total = hZero2.K0;
              }
            }
          }
        } else {
          return null;
        }

        var totalP = mult.mul(Jtotal);
        var sigmaP = sigTotal.mul(mult.abs());
        var floorP = totalP.abs().mul(new D(10).pow(-(digits + 2)));
        if (floorP.gt(sigmaP)) sigmaP = floorP;
        if (sigmaP.isZero()) sigmaP = new D(10).pow(-(digits + 2));
        var digP = Math.min(40, sigmaP.div(totalP.abs().plus(1e-300)).ln().div(new D(10).ln()).neg().toNumber());
        return {
          value: totalP.toNumber(), valueText: totalP.toSignificantDigits(digits + 6).toFixed(),
          sigma: sigmaP.toNumber(), digits: Math.max(0, digP),
          panels: panelsTotal, evals: evalsTotal,
          gap: gapTotal, consistent: true,
          chirp: pNum > 1, subLabel: subLabel, trig: hint.trig, K0: k0Total
        };
      }

      /* 指数型 u = c·b^(k·x) */
      var c2 = decConst(hint.cStr), base = decConst(hint.bStr), kDec = new D(hint.kStr);
      var lnB = base.ln();
      var gC2 = new D(1).div(kDec.abs().mul(lnB));
      var gExp = function (u) { return gC2.div(u); };
      var subLabel2 = 'u = ' + (hint.cStr === '1' ? '' : hint.cStr + '·') + hint.bStr + '^(' + hint.kStr + '·x)';

      function uDecOf(boundObj, xn) {
        if (!isFinite(xn)) {
          var grows = hint.kNum > 0 ? xn > 0 : xn < 0;
          return grows ? { kind: 'inf', num: Infinity } : { kind: 'zero', num: 0, dec: new D(0) };
        }
        var eApprox = hint.kNum * xn * Math.log(hint.bNum) + Math.log(hint.cNum);
        if (eApprox > 23) return { kind: 'inf', num: Infinity };
        if (eApprox < -2000) return { kind: 'zero', num: 0, dec: new D(0) };
        var ud = c2.mul(base.pow(kDec.mul(boundObj.dec)));
        return { kind: 'fin', num: ud.toNumber(), dec: ud };
      }

      var ua = uDecOf(A, a), ub = uDecOf(B, b);
      var loObj, hiObj;
      if (ua.num <= ub.num) { loObj = ua; hiObj = ub; }
      else { loObj = ub; hiObj = ua; }

      if (hint.trig === 'cos' && loObj.num === 0) return null;
      var initGExp = hint.trig === 'sin'
        ? function (u) { return u.sin().mul(gExp(u)); }
        : function (u) { return u.cos().mul(gExp(u)); };

      if (hiObj.kind !== 'inf') {
        if (hiObj.num - loObj.num > 60 || hiObj.num > 1e10) return null;
        var rF = tanhSinh(initGExp, loObj.dec, hiObj.dec, { digits: digits + 2, maxLevel: 8 });
        if (!rF || !rF.value || !rF.value.isFinite() || rF.aborted || !rF.converged) return null;
        var vF = mult.mul(rF.value);
        var diffF = rF.prev ? rF.value.minus(rF.prev).abs() : new D(0);
        var sigF = diffF.mul(10).mul(mult.abs());
        var floorF = vF.abs().mul(new D(10).pow(-(digits + 2)));
        if (floorF.gt(sigF)) sigF = floorF;
        if (sigF.isZero()) sigF = new D(10).pow(-(digits + 2));
        var digF = Math.min(40, sigF.div(vF.abs().plus(1e-300)).ln().div(new D(10).ln()).neg().toNumber());
        return {
          value: vF.toNumber(), valueText: vF.toSignificantDigits(digits + 6).toFixed(),
          sigma: sigF.toNumber(), digits: Math.max(0, digF),
          panels: 0, evals: rF.evals, gap: 0, consistent: true,
          subLabel: subLabel2, finiteRange: true
        };
      }

      var uLo2 = loObj.dec;
      if (!uLo2 || uLo2.gt('1e10')) return null;
      var uLoNum2 = uLo2.toNumber();
      var K02 = hint.trig === 'sin'
        ? Math.max(1, Math.ceil(uLoNum2 / Math.PI))
        : Math.max(1, Math.ceil(uLoNum2 / Math.PI + 0.5));
      var u02 = hint.trig === 'sin' ? PI.mul(K02) : PI.mul(K02 - 0.5);
      while (u02.lt(uLo2)) {
        K02++;
        u02 = hint.trig === 'sin' ? PI.mul(K02) : PI.mul(K02 - 0.5);
      }

      var initVal2 = new D(0), initEvals2 = 0, initDiff2 = new D(0);
      if (uLo2.lt(u02)) {
        var r02 = tanhSinh(initGExp, uLo2, u02, { digits: digits + 2, maxLevel: 8 });
        if (!r02 || !r02.value || !r02.value.isFinite() || r02.aborted || !r02.converged) return null;
        initVal2 = r02.value; initEvals2 = r02.evals;
        if (r02.prev) initDiff2 = r02.value.minus(r02.prev).abs();
      }
      var rule2 = glPanelRule(32);
      var n12 = 36, n22 = 44, terms2 = [];
      for (var kk2 = K02; kk2 < K02 + n22; kk2++) {
        var shift2 = hint.trig === 'sin' ? PI.mul(kk2) : PI.mul(kk2 - 0.5);
        var sk2 = new D(0);
        for (var ii2 = 0; ii2 < rule2.ts.length; ii2++) sk2 = sk2.plus(rule2.wsin[ii2].mul(gExp(shift2.plus(rule2.ts[ii2]))));
        terms2.push(sk2);
      }
      for (var mm2 = 0; mm2 < terms2.length; mm2++) {
        if (!(terms2[mm2].gt(0))) return null;
        if (mm2 > 0 && !terms2[mm2].lt(terms2[mm2 - 1])) return null;
      }
      var S12 = cvzAccel(terms2, n12), S22 = cvzAccel(terms2, n22);
      var gap2 = S12.minus(S22).abs();
      var J2 = initVal2.plus(K02 % 2 === 0 ? S22 : S22.neg());
      var total2 = mult.mul(J2);
      if (!total2.isFinite()) return null;
      if (gap2.gt(J2.abs().plus(1e-300).mul(new D(10).pow(-(digits - 3))))) return null;

      var theory2 = new D(8).mul(new D(3).plus(new D(8).sqrt()).pow(-n12)).mul(terms2[0]).mul(mult.abs());
      var sigma2 = D.max(gap2.mul(10).mul(mult.abs()), theory2, initDiff2.mul(10).mul(mult.abs()));
      var floor2 = total2.abs().mul(new D(10).pow(-(digits + 2)));
      if (floor2.gt(sigma2)) sigma2 = floor2;
      if (sigma2.isZero()) sigma2 = new D(10).pow(-(digits + 2));
      var dig2 = Math.min(40, sigma2.div(total2.abs().plus(1e-300)).ln().div(new D(10).ln()).neg().toNumber());
      return {
        value: total2.toNumber(), valueText: total2.toSignificantDigits(digits + 6).toFixed(),
        sigma: sigma2.toNumber(), digits: Math.max(0, dig2),
        panels: n22, evals: initEvals2 + n22 * rule2.ts.length,
        gap: gap2.toNumber(), consistent: true,
        chirp: true, subLabel: subLabel2, trig: hint.trig, K0: K02
      };
    } catch (e) {
      return null;
    } finally {
      D.set({ precision: oldPrec });
    }
  }

  /* ---------- 通用高精度：Decimal 对角 Wynn-ε ---------- */
  function wynnEpsDec(sums) {
    var n = sums.length;
    if (n < 4) return { value: sums[n - 1], err: new D(Infinity) };
    var prev2 = new Array(n), prev1 = sums.slice();
    for (var i = 0; i < n; i++) prev2[i] = new D(0);

    var evenLast = [sums[n - 1]];
    var evenHoriz = [new D(Infinity)];
    var tiny = new D('1e-550');
    for (var k = 0; k < n - 1; k++) {
      var len = n - 1 - k, cur = new Array(len);
      var anyFinite = false;
      for (var j = 0; j < len; j++) {
        var d = prev1[j + 1].minus(prev1[j]);
        if (!d.isFinite() || d.abs().lt(tiny)) {
          cur[j] = new D(NaN);
        } else {
          cur[j] = prev2[j + 1].plus(new D(1).div(d));
          if (cur[j].isFinite()) anyFinite = true;
        }
      }
      prev2 = prev1; prev1 = cur;
      if (!anyFinite) break;
      if ((k + 1) % 2 === 0 && cur[len - 1] && cur[len - 1].isFinite()) {
        evenLast.push(cur[len - 1]);
        var hErr = (len >= 2 && cur[len - 2] && cur[len - 2].isFinite())
          ? cur[len - 1].minus(cur[len - 2]).abs() : new D(Infinity);
        evenHoriz.push(hErr);
      }
    }
    if (evenLast.length < 2) return { value: sums[n - 1], err: new D(Infinity) };
    var bestVal = evenLast[evenLast.length - 1];
    var bestDiff = evenLast[evenLast.length - 1].minus(evenLast[evenLast.length - 2]).abs();
    if (evenHoriz[evenLast.length - 1].lt(bestDiff)) bestDiff = evenHoriz[evenLast.length - 1];
    for (var m = 1; m < evenLast.length; m++) {
      var df = evenLast[m].minus(evenLast[m - 1]).abs();
      if (evenHoriz[m].lt(df)) df = evenHoriz[m];
      if (df.lte(bestDiff)) {
        bestDiff = df;
        bestVal = evenLast[m];
      }
    }
    return { value: bestVal, err: bestDiff };
  }

  /* ---------- 通用高精度：Decimal 零点精化 + 交替振荡加速 ---------- */
  function refineZeroDec(gDec, zApprox, maxHalf, tol) {
    var loNum = zApprox - maxHalf, hiNum = zApprox + maxHalf;
    var a = new D(loNum), b = new D(hiNum);
    var fa = evalDec(gDec, a), fb = evalDec(gDec, b);
    if (!fa.isFinite() || !fb.isFinite() || fa.mul(fb).gt(0)) return null;
    if (fa.isZero()) return a;
    if (fb.isZero()) return b;
    var fTol = new D('1e-40');
    var x0 = a, f0 = fa, x1 = b, f1 = fb;
    for (var it = 0; it < 40; it++) {
      if (b.minus(a).abs().lte(tol)) break;
      var mid = a.plus(b).div(2);
      var c = mid;
      var df = f1.minus(f0);
      if ((it & 3) !== 3 && !df.isZero()) {
        var s = x1.minus(f1.mul(x1.minus(x0)).div(df));
        if (s.gt(a) && s.lt(b)) c = s;
      }
      var fc = evalDec(gDec, c);
      if (!fc.isFinite()) return null;
      if (fc.isZero() || fc.abs().lte(fTol)) return c;
      if (fa.mul(fc).lte(0)) { b = c; fb = fc; }
      else { a = c; fa = fc; }
      x0 = x1; f0 = f1;
      x1 = c; f1 = fc;
    }
    return a.plus(b).div(2);
  }

  function integrateOscGeneral(fNum, aRaw, bRaw, zerosApprox, opt) {
    var o = opt || {};
    if (!fNum || !fNum.src || !Array.isArray(zerosApprox) || zerosApprox.length < 48) return null;
    var digits = o.digits || 25;
    var oldPrec = D.precision;
    D.set({ precision: digits + 25 });
    try {
      var A = parseBoundDec(aRaw), B = parseBoundDec(bRaw);
      var a = A.num, b = B.num;
      var dir, anchorDec;
      if (isFinite(a) && b === Infinity) { dir = 1; anchorDec = A.dec; }
      else if (a === -Infinity && isFinite(b)) { dir = -1; anchorDec = B.dec; }
      else return null;

      var fDec = compileDec(fNum.src);
      var fSplitRaw = null;
      try { fSplitRaw = compileSplitDec(fNum.src); } catch (e) { fSplitRaw = null; }
      var gDec = dir === 1
        ? function (r) { return fDec(anchorDec.plus(r)); }
        : function (r) { return fDec(anchorDec.minus(r)); };
      var gSplitR = fSplitRaw
        ? (dir === 1
            ? function (anc, off) { return fSplitRaw(anchorDec.plus(anc), off); }
            : function (anc, off) { return fSplitRaw(anchorDec.minus(anc), off.neg()); })
        : null;
      var startR = new D(0);

      /* zerosApprox 是 x 域零点，转成 r = dir*(z - anchor) */
      var anchorNum = anchorDec.toNumber();
      var rsApprox = [];
      for (var i = 0; i < zerosApprox.length; i++) {
        var r = dir * (zerosApprox[i] - anchorNum);
        if (r > 0) rsApprox.push(r);
      }
      if (rsApprox.length < 46) return null;

      var zTol = new D(10).pow(-(digits + 14));
      var needZeros = Math.min(rsApprox.length, 46);
      var rZeros = [];
      for (var k = 0; k < needZeros; k++) {
        var prevGap = k === 0 ? rsApprox[0] : (rsApprox[k] - rsApprox[k - 1]);
        var nextGap = k + 1 < rsApprox.length ? (rsApprox[k + 1] - rsApprox[k]) : prevGap;
        var maxHalf = Math.min(Math.min(prevGap, nextGap) * 0.25, Math.max(1e-9 * (1 + rsApprox[k]), 1e-10));
        var rz = refineZeroDec(gDec, rsApprox[k], maxHalf, zTol);
        if (!rz) return null;
        if (rZeros.length && !rz.gt(rZeros[rZeros.length - 1])) return null;
        rZeros.push(rz);
      }

      /* 首段 [0, z_0] 用 tanhSinh */
      var initVal = new D(0), initEvals = 0, initDiff = new D(0);
      if (startR.lt(rZeros[0])) {
        var r0 = tanhSinh(gDec, startR, rZeros[0], { digits: digits + 2, maxLevel: 7, maxMs: 1400, gSplit: gSplitR });
        if (!r0 || !r0.value || !r0.value.isFinite() || r0.aborted) return null;
        if (!r0.converged) {
          var r0Diff = r0.prev ? r0.value.minus(r0.prev).abs() : new D(Infinity);
          if (r0Diff.gt(r0.value.abs().plus(1e-300).mul('1e-15'))) return null;
        }
        initVal = r0.value; initEvals = r0.evals;
        if (r0.prev) initDiff = r0.value.minus(r0.prev).abs();
      }

      /* 用 GL32 vs GL24 检验（避免 sin³x/x³ 等高次谐波被 GL16 误判而整排细分） */
      var rule32 = glStdRule(32), rule24 = glStdRule(24);
      var panelTol = new D(10).pow(-(digits + 6));
      var counter = { n: 0 };
      var panels = [], nPanels = Math.min(44, rZeros.length - 1);
      var needAdaptiveAll = false;
      for (var m = 0; m < nPanels; m++) {
        var pv;
        if (needAdaptiveAll || m < 2 || (m % 8 === 0)) {
          var before = counter.n;
          pv = glIntegrateAdaptive(gDec, rZeros[m], rZeros[m + 1], panelTol, 0, rule32, rule24, counter);
          if (m >= 4 && counter.n - before > rule32.n + rule24.n) needAdaptiveAll = true;
        } else {
          pv = glIntegratePanel(gDec, rZeros[m], rZeros[m + 1], rule32);
          counter.n += rule32.n;
        }
        if (!pv.isFinite()) return null;
        panels.push(pv);
      }

      /* 跳过前几片直到进入严格交替段（最多跳 4 片） */
      var skip = 0;
      while (skip + 36 < panels.length) {
        var okTail = true;
        for (var j = skip + 1; j < panels.length; j++) {
          if (panels[j].mul(panels[j - 1]).gte(0)) { okTail = false; break; }
        }
        if (okTail) break;
        skip++;
      }
      var tailPanels = panels.slice(skip);
      if (tailPanels.length < 34) return null;
      for (var j2 = 1; j2 < tailPanels.length; j2++) {
        if (tailPanels[j2].mul(tailPanels[j2 - 1]).gte(0)) return null;
      }

      var preSum = initVal;
      for (var sIdx = 0; sIdx < skip; sIdx++) preSum = preSum.plus(panels[sIdx]);

      /* 判断是否单调递减，尝试 CVZ、对角 Wynn 以及配对周期 Levin-u（支持带非零均值振荡如 (sin u + c)/u²） */
      var mags = tailPanels.map(function (v) { return v.abs(); });
      var mono = true;
      for (var mm = 1; mm < mags.length; mm++) {
        if (!mags[mm].lt(mags[mm - 1])) { mono = false; break; }
      }

      var n1 = Math.min(34, tailPanels.length - 6);
      var n2 = tailPanels.length;
      if (n1 < 20) return null;

      var bestVal = null, bestGap = null, bestMethod = '';

      if (mono) {
        var c1 = cvzAccel(mags, n1), c2 = cvzAccel(mags, n2);
        var cGap = c1.minus(c2).abs();
        var sgn0 = tailPanels[0].s;
        bestVal = preSum.plus(sgn0 >= 0 ? c2 : c2.neg());
        bestGap = cGap;
        bestMethod = 'CVZ';
      }

      var sums = [], acc = new D(0);
      for (var si = 0; si < tailPanels.length; si++) {
        acc = acc.plus(tailPanels[si]);
        sums.push(acc);
      }
      var w1 = wynnEpsDec(sums.slice(0, n1));
      var w2 = wynnEpsDec(sums.slice(0, n2));
      var wGap = w1.value.minus(w2.value).abs();
      if (w2.err.gt(wGap)) wGap = w2.err;
      if (w2.value.isFinite() && (!bestGap || wGap.lt(bestGap))) {
        bestVal = preSum.plus(w2.value);
        bestGap = wGap;
        bestMethod = 'Decimal Wynn-ε';
      }

      if (!mono && tailPanels.length >= 30) {
        /* 若非单调交替（例如带非零偏置的 (sin u + c)/u²），追加面板至 58 片（29 对）以提升 Levin-u 至 22+ 位 */
        var extraTarget = Math.min(58, rsApprox.length - 1);
        if (extraTarget > nPanels) {
          for (var kx = needZeros; kx <= extraTarget; kx++) {
            var pgX = rsApprox[kx] - rsApprox[kx - 1];
            var ngX = kx + 1 < rsApprox.length ? (rsApprox[kx + 1] - rsApprox[kx]) : pgX;
            var mhX = Math.min(Math.min(pgX, ngX) * 0.25, Math.max(1e-9 * (1 + rsApprox[kx]), 1e-10));
            var rzX = refineZeroDec(gDec, rsApprox[kx], mhX, zTol);
            if (!rzX || !rzX.gt(rZeros[rZeros.length - 1])) break;
            rZeros.push(rzX);
          }
          for (var mx = nPanels; mx + 1 < rZeros.length; mx++) {
            var pvX = glIntegratePanel(gDec, rZeros[mx], rZeros[mx + 1], rule24);
            counter.n += rule24.n;
            if (!pvX.isFinite()) break;
            panels.push(pvX);
          }
          nPanels = panels.length;
          tailPanels = panels.slice(skip);
        }
        var nPairs = Math.floor(tailPanels.length / 2);
        var paired = [];
        for (var pk = 0; pk < nPairs; pk++) {
          paired.push(tailPanels[2 * pk].plus(tailPanels[2 * pk + 1]));
        }
        var pSign = paired[paired.length - 1].s;
        var sameP = pSign !== 0;
        for (var pi2 = 2; pi2 < paired.length; pi2++) {
          if (paired[pi2].isZero() || paired[pi2].s !== pSign) { sameP = false; break; }
        }
        if (sameP && paired.length >= 16) {
          var pPre = preSum.plus(paired[0]).plus(paired[1]);
          var pAbs = paired.slice(2).map(function (v) { return v.abs(); });
          var pOrd2 = pAbs.length - 1;
          var pOrd1 = Math.max(10, pOrd2 - 4);
          var pl1 = levinU(pAbs, 0, pOrd1);
          var pl2 = levinU(pAbs, 0, pOrd2);
          if (pl1.isFinite() && pl2.isFinite()) {
            var pGap = pl1.minus(pl2).abs();
            var pVal = pPre.plus(pSign > 0 ? pl2 : pl2.neg());
            if (!bestGap || pGap.lt(bestGap)) {
              bestVal = pVal;
              bestGap = pGap;
              bestMethod = '配对周期 Levin-u';
            }
          }
        }
      }

      if (!bestVal || !bestVal.isFinite() || !bestGap) return null;
      var refScale = D.max(bestVal.abs(), initVal.abs(), mags[0], new D('1e-300'));
      var reqTol = bestMethod === '配对周期 Levin-u' ? new D('1e-12') : new D(10).pow(-(digits - 7));
      if (bestGap.gt(refScale.mul(reqTol))) return null;

      var sig = D.max(bestGap.mul(10), initDiff.mul(10), refScale.mul(new D(10).pow(-digits)));
      var dig = Math.min(40, sig.div(refScale).ln().div(new D(10).ln()).neg().toNumber());
      return {
        value: bestVal.toNumber(),
        valueText: bestVal.toSignificantDigits(digits + 6).toFixed(),
        sigma: sig.toNumber(),
        digits: Math.max(0, dig),
        panels: nPanels,
        evals: initEvals + counter.n,
        gap: bestGap.toNumber(),
        consistent: true,
        accelMethod: bestMethod
      };
    } catch (e) {
      return null;
    } finally {
      D.set({ precision: oldPrec });
    }
  }

  /* ---------- 正项周期振荡求积（sin²x/x² 一类）：极小值分片 + Decimal Levin u ---------- */
  function refineMinDec(gDec, xApprox, halfSpan, hDiff, tol) {
    var a = new D(xApprox - halfSpan), b = new D(xApprox + halfSpan);
    var two = new D(2);
    function deriv(x) {
      return evalDec(gDec, x.plus(hDiff)).minus(evalDec(gDec, x.minus(hDiff))).div(hDiff.mul(two));
    }
    var fa = deriv(a), fb = deriv(b);
    if (!fa.isFinite() || !fb.isFinite() || fa.mul(fb).gt(0)) {
      /* 回退黄金分割求极小 */
      var phi = decPHI().minus(1);
      var x1 = b.minus(phi.mul(b.minus(a))), x2 = a.plus(phi.mul(b.minus(a)));
      var f1 = evalDec(gDec, x1), f2 = evalDec(gDec, x2);
      if (!f1.isFinite() || !f2.isFinite()) return null;
      for (var it = 0; it < 75; it++) {
        if (b.minus(a).abs().lte(tol)) break;
        if (f1.lt(f2)) {
          b = x2; x2 = x1; f2 = f1;
          x1 = b.minus(phi.mul(b.minus(a)));
          f1 = evalDec(gDec, x1);
        } else {
          a = x1; x1 = x2; f1 = f2;
          x2 = a.plus(phi.mul(b.minus(a)));
          f2 = evalDec(gDec, x2);
        }
        if (!f1.isFinite() || !f2.isFinite()) return null;
      }
      return a.plus(b).div(two);
    }
    var x0 = a, f0 = fa, x1s = b, f1s = fb;
    for (var it2 = 0; it2 < 64; it2++) {
      if (b.minus(a).abs().lte(tol)) break;
      var mid = a.plus(b).div(two), c = mid;
      var df = f1s.minus(f0);
      if ((it2 & 3) !== 3 && !df.isZero()) {
        var s = x1s.minus(f1s.mul(x1s.minus(x0)).div(df));
        if (s.gt(a) && s.lt(b)) c = s;
      }
      var fc = deriv(c);
      if (!fc.isFinite()) return null;
      if (fc.isZero()) return c;
      if (fa.mul(fc).lte(0)) { b = c; fb = fc; }
      else { a = c; fa = fc; }
      x0 = x1s; f0 = f1s; x1s = c; f1s = fc;
    }
    return a.plus(b).div(two);
  }

  function levinU(terms, startIdx, order) {
    /* 使用从 startIdx 起的 order+1 个项计算 Levin u-transform，返回 Tail = Σ_{j=startIdx}^∞ terms[j] */
    var S = [], acc = new D(0);
    for (var j = 0; j <= order; j++) {
      acc = acc.plus(terms[startIdx + j]);
      S.push(acc);
    }
    var num = new D(0), den = new D(0);
    var m = startIdx + 1;
    var normBase = new D(m + order + 1);
    /* 二项式系数 C(order, j) 递推 */
    var binom = new D(1);
    for (var j2 = 0; j2 <= order; j2++) {
      var n = m + j2;
      var ak = terms[startIdx + j2];
      var omega = ak.mul(n);
      if (omega.isZero()) return new D(NaN);
      var ratio = new D(n).div(normBase).pow(order - 1);
      var w = binom.mul(ratio).div(omega);
      if (j2 % 2 === 1) w = w.neg();
      num = num.plus(w.mul(S[j2]));
      den = den.plus(w);
      if (j2 < order) binom = binom.mul(order - j2).div(j2 + 1);
    }
    if (den.isZero() || !num.isFinite() || !den.isFinite()) return new D(NaN);
    return num.div(den);
  }

  function integratePosOsc(fNum, aRaw, bRaw, minimaApprox, opt) {
    var o = opt || {};
    if (!fNum || !fNum.src || !Array.isArray(minimaApprox) || minimaApprox.length < 26) return null;
    var digits = o.digits || 25;
    var oldPrec = D.precision;
    D.set({ precision: digits + 18 });
    try {
      var A = parseBoundDec(aRaw), B = parseBoundDec(bRaw);
      var a = A.num, b = B.num;
      var dir, anchorDec;
      if (isFinite(a) && b === Infinity) { dir = 1; anchorDec = A.dec; }
      else if (a === -Infinity && isFinite(b)) { dir = -1; anchorDec = B.dec; }
      else return null;

      var fDec = compileDec(fNum.src);
      var fSplitRaw = null;
      try { fSplitRaw = compileSplitDec(fNum.src); } catch (e) { fSplitRaw = null; }
      var gDec = dir === 1
        ? function (r) { return fDec(anchorDec.plus(r)); }
        : function (r) { return fDec(anchorDec.minus(r)); };
      var gSplitR = fSplitRaw
        ? (dir === 1
            ? function (anc, off) { return fSplitRaw(anchorDec.plus(anc), off); }
            : function (anc, off) { return fSplitRaw(anchorDec.minus(anc), off.neg()); })
        : null;
      var anchorNum = anchorDec.toNumber();
      var rsApprox = [];
      for (var i = 0; i < minimaApprox.length; i++) {
        var r = dir * (minimaApprox[i] - anchorNum);
        if (r > 0) rsApprox.push(r);
      }
      if (rsApprox.length < 24) return null;

      var need = Math.min(rsApprox.length, 24);
      var hDiff = new D(10).pow(-(Math.floor(D.precision / 3)));
      var tol = new D('1e-18');
      var rCuts = [];
      for (var k = 0; k < need; k++) {
        var g1 = k === 0 ? rsApprox[0] : rsApprox[k] - rsApprox[k - 1];
        var g2 = k + 1 < rsApprox.length ? rsApprox[k + 1] - rsApprox[k] : g1;
        var span = Math.min(g1, g2) * 0.2;
        var rm = refineMinDec(gDec, rsApprox[k], span, hDiff, tol);
        if (!rm) return null;
        if (rCuts.length && !rm.gt(rCuts[rCuts.length - 1])) return null;
        rCuts.push(rm);
      }

      var initVal = new D(0), initEvals = 0, initDiff = new D(0);
      if (rCuts[0].gt(0)) {
        var r0 = tanhSinh(gDec, new D(0), rCuts[0], { digits: digits + 2, maxLevel: 6, maxMs: 1200, gSplit: gSplitR });
        if (!r0 || !r0.value || !r0.value.isFinite() || r0.aborted || !r0.converged) return null;
        initVal = r0.value; initEvals = r0.evals;
        if (r0.prev) initDiff = r0.value.minus(r0.prev).abs();
      }

      /* GL32 vs GL24 检验（避免 sin⁴x/x⁴ 被 GL16 误判而整排细分） */
      var rule32 = glStdRule(32), rule24 = glStdRule(24);
      var panelTol = new D(10).pow(-(digits + 5));
      var counter = { n: 0 }, panels = [];
      var needAdaptiveAll = false;
      for (var m = 0; m + 1 < rCuts.length; m++) {
        var pv;
        if (needAdaptiveAll || m < 2 || m === 12) {
          var before = counter.n;
          pv = glIntegrateAdaptive(gDec, rCuts[m], rCuts[m + 1], panelTol, 0, rule32, rule24, counter);
          if (m >= 4 && counter.n - before > rule32.n + rule24.n) needAdaptiveAll = true;
        } else {
          pv = glIntegratePanel(gDec, rCuts[m], rCuts[m + 1], rule32);
          counter.n += rule32.n;
        }
        if (!pv.isFinite() || pv.lte(0)) return null;
        panels.push(pv);
      }
      if (panels.length < 20) return null;

      /* 发散守卫：尾部对数斜率必须 < -1.08 */
      var half = Math.floor(panels.length / 2);
      var lx = [], ly = [];
      for (var idx = half; idx < panels.length; idx++) {
        lx.push(Math.log(idx + 1));
        ly.push(Math.log(panels[idx].toNumber()));
      }
      var mx = 0, my = 0;
      for (var s = 0; s < lx.length; s++) { mx += lx[s]; my += ly[s]; }
      mx /= lx.length; my /= ly.length;
      var numS = 0, denS = 0;
      for (var s2 = 0; s2 < lx.length; s2++) {
        numS += (lx[s2] - mx) * (ly[s2] - my);
        denS += (lx[s2] - mx) * (lx[s2] - mx);
      }
      var tailSlope = denS > 0 ? numS / denS : 0;
      if (!(tailSlope < -1.08)) return null;

      /* 跳过前 2 片非渐近片，取两档 Levin-u */
      var startIdx = 2;
      var preSum = initVal.plus(panels[0]).plus(panels[1]);
      var maxOrd = panels.length - 1 - startIdx;
      var ord1 = Math.max(12, maxOrd - 5), ord2 = maxOrd;
      var T1 = levinU(panels, startIdx, ord1);
      var T2 = levinU(panels, startIdx, ord2);
      if (!T1.isFinite() || !T2.isFinite()) return null;

      var v1 = preSum.plus(T1), v2 = preSum.plus(T2);
      var gap = v1.minus(v2).abs();
      var refScale = D.max(v2.abs(), new D('1e-300'));
      if (gap.gt(refScale.mul('1e-12'))) return null;

      var sig = D.max(gap.mul(10), initDiff.mul(10), refScale.mul(new D(10).pow(-digits)));
      var dig = Math.min(40, sig.div(refScale).ln().div(new D(10).ln()).neg().toNumber());
      return {
        value: v2.toNumber(),
        valueText: v2.toSignificantDigits(digits + 6).toFixed(),
        sigma: sig.toNumber(),
        digits: Math.max(0, dig),
        panels: panels.length,
        evals: initEvals + counter.n,
        gap: gap.toNumber(),
        consistent: true,
        tailSlope: tailSlope
      };
    } catch (e) {
      return null;
    } finally {
      D.set({ precision: oldPrec });
    }
  }

  /* ---------- 慢衰减/对数尾部：Decimal 倍增对数壳分解 + 迭代对数发散证明 ----------
     支持：
       1. 半无穷慢尾 [a, ∞) / (-∞, b]：换元 x = a ± e^s，壳 [2^k-1, 2^(k+1)-1]
       2. 有限端对数慢奇点（x → a+ 或 x → b-）：换元 x = anchor ± W·e^(-s)（Split-Decimal 零消去）
     若同号壳序列的 Cauchy 凝聚斜率 d(ln|I_k|)/d(ln k) >= -1.06 且非几何衰减 → 证明发散；
     否则几何衰减走 Decimal Wynn-ε，代数衰减走 Levin u-transform，双长度一致性核验。 */
  function integrateLogTailDec(fNum, aRaw, bRaw, opt) {
    var o = opt || {};
    if (!fNum || !fNum.src) return null;
    var digits = o.digits || 25;
    var oldPrec = D.precision;
    D.set({ precision: digits + 18 });
    try {
      var A = parseBoundDec(aRaw), B = parseBoundDec(bRaw);
      if (!(B.num > A.num)) return null;
      var a = A.num, b = B.num;
      var fDec = compileDec(fNum.src);
      var gSplit = compileSplitDec(fNum.src);
      var rule24 = glStdRule(24), rule16 = glStdRule(16);
      var one = new D(1), two = new D(2);

      var mode = null, hFn = null, initVal = new D(0), initDiff = new D(0), initEvals = 0, label = '';
      if (isFinite(a) && b === Infinity) {
        mode = 'inf';
        label = '倍增对数壳 + 外推（[a, ∞)）';
        var r0 = tanhSinh(fDec, A.dec, A.dec.plus(one), { digits: digits + 2, maxLevel: 5, maxMs: 800, gSplit: gSplit });
        if (!r0 || !r0.value || !r0.value.isFinite() || r0.aborted) return null;
        initVal = r0.value; initEvals = r0.evals;
        if (r0.prev) initDiff = r0.value.minus(r0.prev).abs();
        hFn = function (s) {
          var es = s.exp();
          var v = evalDec(fDec, A.dec.plus(es));
          return es.mul(v);
        };
      } else if (a === -Infinity && isFinite(b)) {
        mode = 'inf';
        label = '倍增对数壳 + 外推（(−∞, b]）';
        var r0L = tanhSinh(fDec, B.dec.minus(one), B.dec, { digits: digits + 2, maxLevel: 5, maxMs: 800, gSplit: gSplit });
        if (!r0L || !r0L.value || !r0L.value.isFinite() || r0L.aborted) return null;
        initVal = r0L.value; initEvals = r0L.evals;
        if (r0L.prev) initDiff = r0L.value.minus(r0L.prev).abs();
        hFn = function (s) {
          var es = s.exp();
          var v = evalDec(fDec, B.dec.minus(es));
          return es.mul(v);
        };
      } else if (isFinite(a) && isFinite(b) && (o.side === 'lo' || o.side === 'hi')) {
        mode = 'fin';
        var W = B.dec.minus(A.dec);
        var anc = o.side === 'lo' ? A.dec : B.dec;
        var sgn = o.side === 'lo' ? one : one.neg();
        label = '端点对数壳 + 外推（' + (o.side === 'lo' ? '左端' : '右端') + '）';
        hFn = function (s) {
          var ems = s.neg().exp();
          var off = W.mul(ems);
          var v = evalSplitDec(gSplit, anc, off.mul(sgn));
          return off.mul(v);
        };
      } else {
        return null;
      }

      function checkShellSlope(arr) {
        var nSh0 = arr.length;
        var rL = arr[nSh0 - 1].abs().div(arr[nSh0 - 2].abs()).toNumber();
        var rP = arr[nSh0 - 2].abs().div(arr[nSh0 - 3].abs()).toNumber();
        var lx0 = [], ly0 = [];
        for (var li0 = Math.floor(nSh0 / 2); li0 < nSh0; li0++) {
          var av0 = arr[li0].abs().toNumber();
          if (!(av0 > 0)) return null;
          lx0.push(Math.log(li0 + 1));
          ly0.push(Math.log(av0));
        }
        var mx0 = 0, my0 = 0;
        for (var u10 = 0; u10 < lx0.length; u10++) { mx0 += lx0[u10]; my0 += ly0[u10]; }
        mx0 /= lx0.length; my0 /= ly0.length;
        var num0 = 0, den0 = 0;
        for (var u20 = 0; u20 < lx0.length; u20++) {
          num0 += (lx0[u20] - mx0) * (ly0[u20] - my0);
          den0 += (lx0[u20] - mx0) * (lx0[u20] - mx0);
        }
        return { rLast: rL, rPrev: rP, kSlope: den0 > 0 ? num0 / den0 : 0 };
      }

      /* 先把 s ∈ [0, 1]（两段 24 点 GL）并入 initVal，使后续倍增壳严格为 [2^k, 2^(k+1)]：
         这样 ln(s_k) = k·ln(2) 无 2^(-k) 偏移扰动，几何尾与迭代对数代数尾均可外推至 20+ 位 */
      var evals = initEvals;
      var zero = new D(0), half = new D('0.5');
      var s0a = glIntegratePanel(hFn, zero, half, rule24);
      var s0b = glIntegratePanel(hFn, half, one, rule24);
      evals += 2 * rule24.n;
      if (!s0a.isFinite() || !s0b.isFinite()) return null;
      var s0a16 = glIntegratePanel(hFn, zero, half, rule16);
      var s0b16 = glIntegratePanel(hFn, half, one, rule16);
      evals += 2 * rule16.n;
      if (s0a16.isFinite() && s0b16.isFinite()) {
        initDiff = D.max(initDiff, s0a.minus(s0a16).abs().plus(s0b.minus(s0b16).abs()));
      }
      initVal = initVal.plus(s0a).plus(s0b);

      /* 前 6 个壳用 24 点 GL，其余壳用 16 点 GL；严格 2^k 倍增共 28 壳（k=22 时提前检验发散） */
      var shells = [], shellQuadErr = new D(0);
      var sCur = one, width = one;
      for (var k = 0; k < 28; k++) {
        var sNext = sCur.plus(width);
        var useR = k < 6 ? rule24 : rule16;
        var sk = glIntegratePanel(hFn, sCur, sNext, useR);
        evals += useR.n;
        if (!sk.isFinite()) return null;
        if (k === 5) {
          var sk16 = glIntegratePanel(hFn, sCur, sNext, rule16);
          evals += rule16.n;
          if (sk16.isFinite()) shellQuadErr = sk.minus(sk16).abs();
        }
        shells.push(sk);
        sCur = sNext;
        width = width.mul(two);
        if (k >= 12 && sk.abs().lte(shells[0].abs().plus('1e-300').mul(new D(10).pow(-(digits + 12))))) {
          var fastSum = initVal;
          for (var fi = 0; fi < shells.length; fi++) fastSum = fastSum.plus(shells[fi]);
          var sigF = D.max(sk.abs().mul(10), initDiff.mul(10), shellQuadErr.mul(100), fastSum.abs().plus('1e-300').mul(new D(10).pow(-digits)));
          var digF = Math.min(40, sigF.div(fastSum.abs().plus('1e-300')).ln().div(new D(10).ln()).neg().toNumber());
          return {
            divergent: false, value: fastSum.toNumber(),
            absInt: fastSum.abs().toNumber(),
            valueText: fastSum.toSignificantDigits(digits + 6).toFixed(),
            sigma: sigF.toNumber(), digits: Math.max(0, digF),
            evals: evals, panels: shells.length, transformLabel: label
          };
        }
        if (k === 22) {
          var sSignE = shells[22].s;
          var sameE = sSignE !== 0;
          for (var ei = 10; ei <= 22; ei++) {
            if (shells[ei].isZero() || shells[ei].s !== sSignE) { sameE = false; break; }
          }
          if (sameE) {
            var stE = checkShellSlope(shells);
            if (stE && (stE.rLast >= 0.9999 || (stE.rLast > 0.92 && stE.rLast >= stE.rPrev - 1e-4 && stE.kSlope >= -1.08))) {
              return { divergent: true, slope: stE.kSlope, ratio: stE.rLast, evals: evals, transformLabel: label };
            }
          }
        }
      }

      /* 检查尾段符号一致性与衰减特性 */
      var startCheck = 8;
      var tailSign = shells[shells.length - 1].s;
      var sameSign = tailSign !== 0;
      for (var si = startCheck; si < shells.length; si++) {
        if (shells[si].isZero() || shells[si].s !== tailSign) { sameSign = false; break; }
      }
      if (!sameSign) return null;

      var st = checkShellSlope(shells);
      if (!st) return null;
      var rLast = st.rLast, rPrev = st.rPrev, kSlope = st.kSlope;

      /* 迭代对数发散判定：壳本身增长，或比值趋近 1（非几何衰减）且 log-log 斜率 >= -1.08 */
      if (rLast >= 0.9999 || (rLast > 0.92 && rLast >= rPrev - 1e-4 && kSlope >= -1.08)) {
        return { divergent: true, slope: kSlope, ratio: rLast, evals: evals, transformLabel: label };
      }

      var skipPre = 4;
      var preSum = initVal;
      for (var p0 = 0; p0 < skipPre; p0++) preSum = preSum.plus(shells[p0]);
      var tailSh = shells.slice(skipPre);
      var sums = [], acc = new D(0);
      for (var j = 0; j < tailSh.length; j++) { acc = acc.plus(tailSh[j]); sums.push(acc); }

      var bestVal = null, bestGap = null, bestTag = '';
      var n1 = tailSh.length - 5, n2 = tailSh.length;
      var w1 = wynnEpsDec(sums.slice(0, n1));
      var w2 = wynnEpsDec(sums.slice(0, n2));
      if (w1.value.isFinite() && w2.value.isFinite()) {
        var wg = D.max(w1.value.minus(w2.value).abs(), w2.err);
        bestVal = preSum.plus(w2.value);
        bestGap = wg;
        bestTag = 'Decimal Wynn-ε';
      }

      if (kSlope < -1.12) {
        /* 使用真实倍增壳索引 k（skipL = 8 起，已远离 x = a + e^s 初期偏置）计算双阶 Levin-u */
        var skipL = 8;
        var preSumL = initVal;
        for (var pL = 0; pL < skipL; pL++) preSumL = preSumL.plus(shells[pL]);
        var absAll = shells.map(function (v) { return v.abs(); });
        var ord2 = absAll.length - 1 - skipL;
        var ord1 = Math.max(8, ord2 - 4);
        var l1 = levinU(absAll, skipL, ord1);
        var l2 = levinU(absAll, skipL, ord2);
        if (l1.isFinite() && l2.isFinite()) {
          var lg = l1.minus(l2).abs();
          var lv = preSumL.plus(tailSign > 0 ? l2 : l2.neg());
          if (!bestGap || lg.lt(bestGap)) {
            bestVal = lv;
            bestGap = lg;
            bestTag = 'Decimal Levin-u';
          }
        }
      }

      if (!bestVal || !bestVal.isFinite() || !bestGap) return null;
      var refScale = D.max(bestVal.abs(), initVal.abs(), shells[0].abs(), new D('1e-300'));
      if (bestGap.gt(refScale.mul('1e-6'))) return null;

      /* 将外推误差、首段误差与单壳 GL 求积误差统一纳入保守 σ */
      var sig = D.max(bestGap.mul(16), initDiff.mul(10), shellQuadErr.mul(200), refScale.mul(new D(10).pow(-Math.min(digits, 22))));
      var dig = Math.min(40, sig.div(refScale).ln().div(new D(10).ln()).neg().toNumber());
      return {
        divergent: false,
        value: bestVal.toNumber(),
        absInt: bestVal.abs().toNumber(),
        valueText: bestVal.toSignificantDigits(digits + 6).toFixed(),
        sigma: sig.toNumber(),
        digits: Math.max(0, dig),
        evals: evals,
        panels: shells.length,
        gap: bestGap.toNumber(),
        transformLabel: label + '（' + bestTag + '）'
      };
    } catch (e) {
      return null;
    } finally {
      D.set({ precision: oldPrec });
    }
  }

  /* ---------- 精化内部奇点/折点/阶跃/尖峰（用于分段高精度求积） ---------- */
  function refineSplitDecimal(fSrc, targetNum, kind, aNum, bNum, workPrec) {
    var oldPrec = D.precision;
    var prec = Math.max(workPrec || 60, 88);
    D.set({ precision: prec });
    try {
      var fDec = compileDec(fSrc);
      var PI = decPI();
      function tryAdsorb(numVal, tol) {
        var cands = [];
        for (var q = 1; q <= 24; q++) {
          var p = Math.round(numVal * q);
          if (Math.abs(numVal - p / q) <= tol) cands.push(new D(p).div(q));
          var pPi = Math.round((numVal / Math.PI) * q);
          if (Math.abs(numVal - (pPi * Math.PI) / q) <= tol) cands.push(PI.mul(pPi).div(q));
        }
        for (var ci = 0; ci < cands.length; ci++) {
          var cand = cands[ci];
          var cn = cand.toNumber();
          if (cn > aNum && cn < bNum) {
            if (kind === 'singularity') {
              var vc = evalDec(fDec, cand);
              if (!vc.isFinite() || vc.abs().gt('1e20')) return cand.toString();
            } else if (kind === 'kink') {
              var dkH = new D('1e-8').mul(D.max(new D(1), cand.abs()));
              var vc0 = evalDec(fDec, cand), vcm = evalDec(fDec, cand.minus(dkH)), vcp = evalDec(fDec, cand.plus(dkH));
              var vcm2 = evalDec(fDec, cand.minus(dkH.mul(2))), vcp2 = evalDec(fDec, cand.plus(dkH.mul(2)));
              if (vc0.isFinite() && vcm.isFinite() && vcp.isFinite() && vcm2.isFinite() && vcp2.isFinite()) {
                var sCenter = vcp.minus(vc0.mul(2)).plus(vcm).abs();
                var sLeft = vc0.minus(vcm.mul(2)).plus(vcm2).abs();
                var sRight = vcp2.minus(vcp.mul(2)).plus(vc0).abs();
                if (sCenter.gt(D.max(sLeft, sRight).mul(4))) return cand.toString();
              }
            } else {
              return cand.toString();
            }
          }
        }
        return null;
      }

      /* 1. 快速吸附（若 float64 已经命中精确有理点或 π 有理倍） */
      var fastHit = tryAdsorb(targetNum, 1e-12 * Math.max(1, Math.abs(targetNum)));
      if (fastHit) return fastHit;

      /* 2. 宽窗 Decimal 精化（1e-5 括号，避免 sqrt(1-cos(2x)) 在 float64 中因 h² 下溢偏离 1e-8 而漏括） */
      var span = Math.max(1e-5 * (1 + Math.abs(targetNum)), 1e-6);
      var lo = new D(Math.max(aNum, targetNum - span));
      var hi = new D(Math.min(bNum, targetNum + span));
      var stopW = new D(10).pow(-(Math.max(25, prec - 14))).mul(D.max(new D(1), new D(Math.abs(targetNum))));
      var two = new D(2);
      var refined = null;

      if (kind === 'jump') {
        var floJ = evalDec(fDec, lo), fhiJ = evalDec(fDec, hi);
        if (floJ.isFinite() && fhiJ.isFinite()) {
          for (var sj = 0; sj < 200; sj++) {
            if (hi.minus(lo).lte(stopW)) break;
            var midJ = lo.plus(hi).div(two);
            var fmJ = evalDec(fDec, midJ);
            if (!fmJ.isFinite()) { lo = hi = midJ; break; }
            if (fmJ.minus(floJ).abs().gte(fhiJ.minus(fmJ).abs())) { hi = midJ; fhiJ = fmJ; }
            else { lo = midJ; floJ = fmJ; }
          }
          refined = lo.plus(hi).div(two);
        }
      } else if (kind === 'singularity' || kind === 'peak') {
        var faS = evalDec(fDec, lo), fbS = evalDec(fDec, hi);
        if (kind === 'singularity' && faS.isFinite() && fbS.isFinite() && faS.mul(fbS).lt(0)) {
          for (var sb = 0; sb < 200; sb++) {
            if (hi.minus(lo).lte(stopW)) break;
            var midS = lo.plus(hi).div(two);
            var fmS = evalDec(fDec, midS);
            if (!fmS.isFinite()) { refined = midS; break; }
            if (faS.mul(fmS).gt(0)) { lo = midS; faS = fmS; }
            else { hi = midS; fbS = fmS; }
          }
          if (!refined) refined = lo.plus(hi).div(two);
        } else {
          var phi = decPHI().minus(1);
          var x1 = hi.minus(phi.mul(hi.minus(lo)));
          var x2 = lo.plus(phi.mul(hi.minus(lo)));
          var v1 = evalDec(fDec, x1), v2 = evalDec(fDec, x2);
          var m1s = v1.isFinite() ? v1.abs() : new D(Infinity);
          var m2s = v2.isFinite() ? v2.abs() : new D(Infinity);
          for (var gs = 0; gs < 220; gs++) {
            if (hi.minus(lo).lte(stopW)) break;
            if (!v1.isFinite()) { refined = x1; break; }
            if (!v2.isFinite()) { refined = x2; break; }
            if (m1s.gt(m2s)) {
              hi = x2; x2 = x1; v2 = v1; m2s = m1s;
              x1 = hi.minus(phi.mul(hi.minus(lo)));
              v1 = evalDec(fDec, x1);
              m1s = v1.isFinite() ? v1.abs() : new D(Infinity);
            } else {
              lo = x1; x1 = x2; v1 = v2; m1s = m2s;
              x2 = lo.plus(phi.mul(hi.minus(lo)));
              v2 = evalDec(fDec, x2);
              m2s = v2.isFinite() ? v2.abs() : new D(Infinity);
            }
          }
          if (!refined) refined = lo.plus(hi).div(two);
        }
      } else if (kind === 'kink') {
        for (var step = 0; step < 180; step++) {
          var w = hi.minus(lo);
          if (w.lte(stopW)) break;
          var m1 = lo.plus(w.mul('0.25')), m2 = lo.plus(w.mul('0.5')), m3 = lo.plus(w.mul('0.75'));
          var f0 = evalDec(fDec, lo), f1 = evalDec(fDec, m1), f2 = evalDec(fDec, m2), f3 = evalDec(fDec, m3), f4 = evalDec(fDec, hi);
          if (!f0.isFinite() || !f1.isFinite() || !f2.isFinite() || !f3.isFinite() || !f4.isFinite()) break;
          var dL = f2.minus(f1).minus(f1.minus(f0)).abs();
          var dM = f3.minus(f2).minus(f2.minus(f1)).abs();
          var dR = f4.minus(f3).minus(f3.minus(f2)).abs();
          if (dL.gte(dM) && dL.gte(dR)) hi = m2;
          else if (dR.gte(dM) && dR.gte(dL)) lo = m2;
          else { lo = m1; hi = m3; }
        }
        refined = lo.plus(hi).div(two);
      }

      if (refined && refined.isFinite()) {
        /* 精化后再做精确有理/π倍吸附（Decimal 差 <= 1e-18） */
        var refNum = refined.toNumber();
        var postHit = tryAdsorb(refNum, 1e-13 * Math.max(1, Math.abs(refNum)));
        if (postHit && new D(postHit).minus(refined).abs().lte(new D('1e-18').mul(D.max(new D(1), refined.abs())))) {
          return postHit;
        }
        return refined.toString();
      }
      return String(targetNum);
    } catch (e) {
      return String(targetNum);
    } finally {
      D.set({ precision: oldPrec });
    }
  }

  /* ---------- 周期折点/阶跃指数衰减半无穷求积（旗舰加号例题等 25+ 位通道） ---------- */
  function integratePeriodicKinkExpTail(fNum, aRaw, bRaw, opt) {
    var o = opt || {};
    if (!fNum || !fNum.src) return null;
    var digits = o.digits || 25;
    var maxMs = o.maxMs || 2200;
    var tStart = Date.now();
    var oldPrec = D.precision;
    D.set({ precision: digits + 18 });
    try {
      var A = parseBoundDec(aRaw), B = parseBoundDec(bRaw);
      var a = A.num, b = B.num;
      var dir, anchorDec, anchor;
      if (isFinite(a) && b === Infinity) { dir = 1; anchorDec = A.dec; anchor = a; }
      else if (a === -Infinity && isFinite(b)) { dir = -1; anchorDec = B.dec; anchor = b; }
      else return null;

      var pr = probeInfiniteTail(fNum, anchor, dir);
      if (pr.divergentOverflow || pr.cutoff === null || pr.cutoff > 1000) return null;

      /* 优先从表达式提取 abs/sign/min/max 参数 u_i(x) 零点（无被积函数外层 exp 衰减遮蔽） */
      function extractSwitchArgs(srcStr) {
        var out = [], s = String(srcStr || ''), pos = 0;
        while (pos < s.length) {
          var m = /\b(abs|sign|min|max)\s*\(/i.exec(s.slice(pos));
          if (!m) break;
          var fn = m[1].toLowerCase();
          var start = pos + m.index + m[0].length;
          var dep = 1, j = start, comma = -1;
          while (j < s.length && dep > 0) {
            var ch = s[j];
            if (ch === '(') dep++;
            else if (ch === ')') dep--;
            else if (ch === ',' && dep === 1 && comma < 0) comma = j;
            j++;
          }
          if (dep === 0) {
            if ((fn === 'abs' || fn === 'sign') && comma < 0) {
              out.push(s.slice(start, j - 1));
            } else if ((fn === 'min' || fn === 'max') && comma > start) {
              out.push('(' + s.slice(start, comma) + ')-(' + s.slice(comma + 1, j - 1) + ')');
            }
          }
          pos = pos + m.index + m[1].length;
        }
        return out;
      }

      /* 在双精度下寻找紧凑指数衰减截断点 xCut（|f| <= 1e-32 * peak 连续保持 24 点） */
      var peak = 0, xCut = Math.min(260, Math.max(40, pr.cutoff));
      var scanCap = Math.min(320, Math.max(80, pr.cutoff));
      var quietRun = 0, foundCut = false;
      for (var blk = 0; blk * 4 < scanCap; blk++) {
        for (var sub = 0; sub < 8; sub++) {
          var rTry = blk * 4 + sub * 0.5;
          var xTry = anchor + dir * rTry;
          var vTry;
          try { vTry = fNum(xTry); } catch (e) { vTry = NaN; }
          if (!isFinite(vTry)) return null;
          if (Math.abs(vTry) > peak) peak = Math.abs(vTry);
          if (rTry >= 24 && peak > 0 && Math.abs(vTry) <= 1e-32 * peak) {
            if (++quietRun >= 10) { xCut = rTry + 2; foundCut = true; break; }
          } else {
            quietRun = 0;
          }
        }
        if (foundCut) break;
      }
      if (!foundCut) xCut = Math.min(260, pr.cutoff);
      if (!(peak > 0)) return null;

      var fDec = compileDec(fNum.src);
      var xEndDec = anchorDec.plus(new D(xCut).mul(dir));
      var nodes = [anchorDec];
      var switchArgs = extractSwitchArgs(fNum.src);
      var switchOk = false;

      var coreAPI = global.IntegralCore || (typeof window !== 'undefined' ? window.IntegralCore : null);
      if (switchArgs.length > 0 && coreAPI && coreAPI.compile) {
        switchOk = true;
        var gridN = 2048, drSw = xCut / gridN;
        for (var sai = 0; sai < switchArgs.length; sai++) {
          var uSrc = switchArgs[sai];
          var uNumFn, uDecRaw;
          try { uNumFn = coreAPI.compile(uSrc); uDecRaw = compileDec(uSrc); }
          catch (e) { switchOk = false; break; }
          var uRayDec = dir === 1
            ? (function (fnDec) { return function (rD) { return fnDec(anchorDec.plus(rD)); }; })(uDecRaw)
            : (function (fnDec) { return function (rD) { return fnDec(anchorDec.minus(rD)); }; })(uDecRaw);
          var prevR = 0, prevU = uNumFn(anchor);
          for (var gi = 1; gi <= gridN; gi++) {
            var curR = gi * drSw;
            var curU = uNumFn(anchor + dir * curR);
            if (!isFinite(prevU) || !isFinite(curU)) { prevR = curR; prevU = curU; continue; }
            if (prevU * curU < 0 || (curU === 0 && gi < gridN)) {
              var zApproxR;
              if (curU === 0) {
                zApproxR = curR;
              } else {
                var aa = prevR, bb = curR, faa = prevU;
                for (var bi = 0; bi < 45; bi++) {
                  var mid = (aa + bb) / 2, fm = uNumFn(anchor + dir * mid);
                  if (!isFinite(fm)) break;
                  if (faa * fm <= 0) bb = mid; else { aa = mid; faa = fm; }
                }
                zApproxR = (aa + bb) / 2;
              }
              var spanZ = Math.min(drSw * 0.45, 1e-6 * (1 + zApproxR));
              if (zApproxR - spanZ > 0 && zApproxR + spanZ < xCut) {
                var zDecR = refineZeroDec(uRayDec, zApproxR, spanZ, new D('1e-46'));
                if (!zDecR) zDecR = refineZeroDec(uRayDec, zApproxR, drSw * 0.6, new D('1e-46'));
                if (zDecR && zDecR.gt(0) && zDecR.lt(xCut)) {
                  nodes.push(anchorDec.plus(zDecR.mul(dir)));
                }
              }
            }
            prevR = curR; prevU = curU;
          }
          if (nodes.length > 180) break;
        }
      }

      if (!switchOk || nodes.length <= 1) {
        var N = 4096, dr = xCut / N;
        var rs = [], vs = [];
        for (var k = 0; k <= N; k++) {
          var r = k * dr, v;
          try { v = fNum(anchor + dir * r); } catch (e) { v = NaN; }
          if (!isFinite(v)) return null;
          rs.push(r); vs.push(v);
        }
        function refineKinkR(rL, rR) {
          var aa = rL, bb = rR;
          for (var it = 0; it < 44; it++) {
            var w = bb - aa, m1 = aa + 0.25 * w, m2 = aa + 0.5 * w, m3 = aa + 0.75 * w;
            var f0 = fNum(anchor + dir * aa), f1 = fNum(anchor + dir * m1), f2 = fNum(anchor + dir * m2);
            var f3 = fNum(anchor + dir * m3), f4 = fNum(anchor + dir * bb);
            if (!isFinite(f0) || !isFinite(f1) || !isFinite(f2) || !isFinite(f3) || !isFinite(f4)) break;
            var dL = Math.abs(f2 - 2 * f1 + f0), dM = Math.abs(f3 - 2 * f2 + f1), dR = Math.abs(f4 - 2 * f3 + f2);
            if (dL >= dM && dL >= dR) bb = m2;
            else if (dR >= dM && dR >= dL) aa = m2;
            else { aa = m1; bb = m3; }
          }
          return (aa + bb) / 2;
        }
        function refineJumpR(rL, rR) {
          var aa = rL, bb = rR, fa = fNum(anchor + dir * aa);
          for (var it = 0; it < 48; it++) {
            var mid = (aa + bb) / 2;
            if (mid <= aa || mid >= bb) break;
            var fm = fNum(anchor + dir * mid);
            if (!isFinite(fm)) return mid;
            if (Math.abs(fm - fa) >= Math.abs(fNum(anchor + dir * bb) - fm)) bb = mid;
            else { aa = mid; fa = fm; }
          }
          return (aa + bb) / 2;
        }
        var rawSplits = [];
        for (var m = 2; m < N - 2; m++) {
          var localScale = Math.max(Math.abs(vs[m - 1]), Math.abs(vs[m]), Math.abs(vs[m + 1]), 1e-32 * peak);
          if (localScale < 1e-29 * peak) continue;
          var dv0 = Math.abs(vs[m] - vs[m - 1]), dv1 = Math.abs(vs[m + 1] - vs[m]), dv2 = Math.abs(vs[m + 2] - vs[m + 1]);
          var localStep = Math.max(dv0, dv2, 1e-10 * localScale);
          var candR = null, candKind = null;
          if (dv1 > 15 * localStep && dv1 > 1e-6 * localScale) {
            candR = refineJumpR(rs[m], rs[m + 1]); candKind = 'jump';
          } else {
            var d0 = (vs[m - 1] - vs[m - 2]) / dr, d1 = (vs[m] - vs[m - 1]) / dr;
            var d2 = (vs[m + 1] - vs[m]) / dr, d3 = (vs[m + 2] - vs[m + 1]) / dr;
            var jump1 = Math.abs(d2 - d1), curv1 = Math.max(Math.abs(d1 - d0), Math.abs(d3 - d2), 1e-8 * localScale);
            if (jump1 > 20 * curv1 && jump1 > 1e-6 * localScale) {
              candR = refineKinkR(rs[m - 1], rs[m + 1]); candKind = 'kink';
            } else if (m + 3 <= N) {
              var d4 = (vs[m + 3] - vs[m + 2]) / dr, jump2 = Math.abs(d3 - d1);
              var curv2 = Math.max(Math.abs(d1 - d0), Math.abs(d4 - d3), 1e-8 * localScale);
              if (jump2 > 18 * curv2 && jump2 > 1e-6 * localScale) {
                candR = refineKinkR(rs[m - 1], rs[m + 2]); candKind = 'kink';
              }
            }
          }
          if (candR !== null && candR > 1e-6 * xCut && candR < xCut - 1e-6 * xCut) {
            if (!rawSplits.some(function (s) { return Math.abs(candR - s.r) < 1e-4 * xCut; })) {
              rawSplits.push({ r: candR, kind: candKind });
              if (rawSplits.length > 140) return null;
            }
          }
        }
        if (rawSplits.length === 0) return null;
        var loBound = dir === 1 ? anchor : anchor - xCut;
        var hiBound = dir === 1 ? anchor + xCut : anchor;
        for (var ri = 0; ri < rawSplits.length; ri++) {
          if (Date.now() - tStart > maxMs * 0.45) return null;
          var sp = rawSplits[ri];
          var spXStr = refineSplitDecimal(fNum.src, anchor + dir * sp.r, sp.kind, loBound, hiBound, 60);
          var xSp = new D(spXStr);
          var rSp = xSp.minus(anchorDec).mul(dir);
          if (rSp.gt(0) && rSp.lt(xCut)) nodes.push(xSp);
        }
      }

      nodes.push(xEndDec);
      nodes.sort(function (u, v) { return u.cmp(v); });
      var uniqNodes = [nodes[0]];
      for (var ui = 1; ui < nodes.length; ui++) {
        if (nodes[ui].minus(uniqNodes[uniqNodes.length - 1]).abs().gt('1e-28')) {
          uniqNodes.push(nodes[ui]);
        }
      }
      if (uniqNodes.length < 3 || uniqNodes.length > 220) return null;

      /* 验证尾部截断误差确实低于目标位数 */
      var tailPeak = new D(0);
      for (var tj = 0; tj < 12; tj++) {
        var xt = anchorDec.plus(new D(xCut + tj * 0.7).mul(dir));
        var vt = evalDec(fDec, xt);
        if (!vt.isFinite()) return null;
        if (vt.abs().gt(tailPeak)) tailPeak = vt.abs();
      }

      var rule32 = glStdRule(32), rule16 = glStdRule(16);
      var panelTol = new D(peak || 1).mul(new D(10).pow(-(digits + 9)));
      var counter = { n: 0 };
      var sum = new D(0), absSum = new D(0), estQuadErr = new D(0);
      var needCheckAll = false;

      for (var p = 0; p + 1 < uniqNodes.length; p++) {
        if (Date.now() - tStart > maxMs) return null;
        var pa = uniqNodes[p], pb = uniqNodes[p + 1];
        var v32 = glIntegratePanel(fDec, pa, pb, rule32);
        counter.n += rule32.n;
        if (!v32.isFinite()) return null;
        var pv = v32;
        if (needCheckAll || p < 12 || (p % 4 === 0)) {
          var v16 = glIntegratePanel(fDec, pa, pb, rule16);
          counter.n += rule16.n;
          if (!v16.isFinite()) return null;
          var diffP = v32.minus(v16).abs();
          if (diffP.gt(panelTol)) {
            needCheckAll = true;
            pv = glIntegrateAdaptive(fDec, pa, pb, panelTol, 1, rule32, rule16, counter);
            if (!pv.isFinite()) return null;
            estQuadErr = estQuadErr.plus(panelTol);
          } else {
            estQuadErr = estQuadErr.plus(diffP);
          }
        }
        sum = sum.plus(pv);
        absSum = absSum.plus(pv.abs());
      }

      var refScale = D.max(sum.abs(), absSum, new D('1e-300'));
      var tailBound = tailPeak.mul(25);
      var floor = refScale.mul(new D(10).pow(-digits));
      var sigma = D.max(estQuadErr.mul(16), tailBound, floor);
      if (sigma.gt(refScale.mul('1e-14'))) return null;

      var dig = Math.min(40, sigma.div(refScale).ln().div(new D(10).ln()).neg().toNumber());
      var isNearZ = sum.abs().lte(sigma) && sigma.lt(refScale.mul('1e-12'));
      return {
        value: isNearZ ? 0 : sum.toNumber(),
        valueText: isNearZ ? '0' : sum.toSignificantDigits(digits + 6).toFixed(),
        sigma: sigma.toNumber(),
        digits: Math.max(0, dig),
        absInt: absSum.toNumber(),
        isNearZero: isNearZ,
        level: 1,
        evals: counter.n,
        panels: uniqNodes.length - 1,
        converged: true,
        transformLabel: '周期折点分段 GL32（Decimal）',
        overflowBound: xCut
      };
    } catch (e) {
      return null;
    } finally {
      D.set({ precision: oldPrec });
    }
  }

  global.IntegralHP = {
    available: true,
    compile: compileDec,
    compileSplit: compileSplitDec,
    parseBoundDec: parseBoundDec,
    tanhSinh: tanhSinh,
    expSinh: expSinh,
    sinhSinh: sinhSinh,
    integrate: integrateHP,
    integrateOsc: integrateOsc,
    integrateOscGeneral: integrateOscGeneral,
    integratePosOsc: integratePosOsc,
    integrateLogTailDec: integrateLogTailDec,
    integratePeriodicKinkExpTail: integratePeriodicKinkExpTail,
    refineSplitDecimal: refineSplitDecimal,
    decPI: decPI
  };
})(typeof window !== 'undefined' ? window : globalThis);
