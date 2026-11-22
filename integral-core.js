/* integral-core.js — 定积分数值层 v2.12（纯 JS，无外部依赖）
 * 提供：表达式编译、端点渐近/发散诊断、内部奇点与折点扫描、端点拉伸、
 *       通用交替/正项振荡积分、自适应 Simpson 求积、高精度层调度。
 * 离线可用；UMD 风格，Node 下可直接 require 做测试。
 */
(function (global) {
  'use strict';

  var CONSTS = {
    pi: Math.PI, 'π': Math.PI, e: Math.E, tau: 2 * Math.PI,
    phi: (1 + Math.sqrt(5)) / 2, inf: Infinity, infinity: Infinity,
    ln2: Math.LN2, ln10: Math.LN10
  };

  var FUNCS = {
    sin: [Math.sin, 1], cos: [Math.cos, 1], tan: [Math.tan, 1],
    asin: [Math.asin, 1], acos: [Math.acos, 1], atan: [Math.atan, 1],
    arcsin: [Math.asin, 1], arccos: [Math.acos, 1], arctan: [Math.atan, 1],
    sinh: [Math.sinh, 1], cosh: [Math.cosh, 1], tanh: [Math.tanh, 1],
    asinh: [Math.asinh, 1], acosh: [Math.acosh, 1], atanh: [Math.atanh, 1],
    arcsinh: [Math.asinh, 1], arccosh: [Math.acosh, 1], arctanh: [Math.atanh, 1],
    arsinh: [Math.asinh, 1], arcosh: [Math.acosh, 1], artanh: [Math.atanh, 1],
    exp: [Math.exp, 1], log: [Math.log, 1], ln: [Math.log, 1],
    log10: [Math.log10, 1], log2: [Math.log2, 1],
    sqrt: [Math.sqrt, 1], cbrt: [Math.cbrt, 1],
    abs: [Math.abs, 1], sign: [Math.sign, 1], floor: [Math.floor, 1],
    ceil: [Math.ceil, 1], round: [Math.round, 1],
    min: [Math.min, 2], max: [Math.max, 2], pow: [Math.pow, 2],
    atan2: [Math.atan2, 2], hypot: [Math.hypot, 2]
  };

  var INNER_CONSTS = { pi: 1, e: 1, tau: 1, phi: 1 };

  /* 拆分连写标识符：如 sinx → sin, x；sinsinx → sin, sin, x；sin2 → sin, 2；
     已知整体（ln2/log2/log10/atan2/pi/sin/cos/x 等）直接保留，变量/常数后紧接数字（如 x2/e2）报错。 */
  function splitGluedIdent(word, firstWs) {
    var low = String(word).toLowerCase();
    if (low === 'x' || Object.prototype.hasOwnProperty.call(CONSTS, low) || Object.prototype.hasOwnProperty.call(FUNCS, low)) {
      return [{ t: 'id', v: low, ws: !!firstWs }];
    }
    var n = low.length;
    var memo = Object.create(null);
    function solve(i, canNum) {
      if (i === n) return { toks: [], cost: 0 };
      var key = i + ':' + (canNum ? 1 : 0);
      if (key in memo) return memo[key];
      var best = null;
      function accept(cand) {
        if (!best || cand.cost < best.cost) { best = cand; return; }
        if (cand.cost === best.cost && cand.toks[0].v.length > best.toks[0].v.length) best = cand;
      }
      if (canNum && low[i] >= '0' && low[i] <= '9') {
        var j = i;
        while (j < n && low[j] >= '0' && low[j] <= '9') j++;
        var numRaw = low.slice(i, j);
        var restN = solve(j, false);
        if (restN) {
          accept({ toks: [{ t: 'num', v: parseFloat(numRaw), raw: numRaw, ws: false }].concat(restN.toks), cost: 1 + restN.cost });
        }
      }
      for (var k = n; k > i; k--) {
        var sub = low.slice(i, k);
        var spec = Object.prototype.hasOwnProperty.call(FUNCS, sub) ? FUNCS[sub] : null;
        var isUnary = !!(spec && spec[1] === 1);
        var isAtom = (sub === 'x' || Object.prototype.hasOwnProperty.call(INNER_CONSTS, sub));
        if (!isUnary && !isAtom) continue;
        var rest = solve(k, isUnary);
        if (rest) {
          var pc = isUnary ? 1 : (sub === 'x' ? 1 : 1.05);
          accept({ toks: [{ t: 'id', v: sub, ws: false }].concat(rest.toks), cost: pc + rest.cost });
        }
      }
      memo[key] = best;
      return best;
    }
    var res = solve(0, false);
    if (!res) {
      if (/^(?:x|pi|e|tau|phi)\d+$/i.test(low)) {
        throw new Error('变量或常数「' + word + '」后面不能直接紧跟数字（请用 ^ 或 *，例如 x^2、2*x）');
      }
      throw new Error('未知标识符：' + word + '（变量只能用 x）');
    }
    res.toks[0].ws = !!firstWs;
    return res.toks;
  }

  function tokenize(src) {
    /* 逐字符词法分析：记录空白边界、支持 Unicode 符号与 ** / ² / ³、拆分连写函数名（如 sinx/sinsinx/sin2^x） */
    var out = [], i = 0, s = String(src);
    while (i < s.length) {
      var hadWs = false;
      while (i < s.length && /\s/.test(s[i])) { hadWs = true; i++; }
      if (i >= s.length) break;
      var c = s[i];
      if (/[0-9.]/.test(c)) {
        var m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
        if (!m) throw new Error('无法解析的数字：' + s.slice(i, i + 12));
        out.push({ t: 'num', v: parseFloat(m[0]), raw: m[0], ws: hadWs }); i += m[0].length; continue;
      }
      if (c === 'π') { out.push({ t: 'id', v: 'pi', ws: hadWs }); i++; continue; }
      if (c === '∞') { out.push({ t: 'id', v: 'inf', ws: hadWs }); i++; continue; }
      if (/[a-zA-Z_]/.test(c)) {
        var m2 = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(s.slice(i));
        var word = m2[0], wLow = word.toLowerCase();
        if (!(wLow === 'x' || Object.prototype.hasOwnProperty.call(CONSTS, wLow) || Object.prototype.hasOwnProperty.call(FUNCS, wLow))) {
          /* 若尾部数字其实是浮点小数或科学记数法（如 sin0.5x / sin1e-2x），把尾部数字退回给数字词法器 */
          var after = s.slice(i + word.length);
          var mDec = /^(.*?)(\d+)$/.exec(word);
          if (mDec && after.length >= 2 && after[0] === '.' && /[0-9]/.test(after[1])) {
            word = mDec[1];
          } else {
            var mSci = /^(.*?)(\d+[eE])$/.exec(word);
            if (mSci && /^[+-]?\d/.test(after)) {
              word = mSci[1];
            } else {
              var mSciFull = /^([a-zA-Z_]+?)(\d+[eE]\d+.*)$/.exec(word);
              if (mSciFull && !/^\d/.test(mSciFull[1])) {
                word = mSciFull[1];
              }
            }
          }
        }
        var pieces = splitGluedIdent(word, hadWs);
        for (var pi = 0; pi < pieces.length; pi++) out.push(pieces[pi]);
        i += word.length;
        continue;
      }
      if (c === '*' && s[i + 1] === '*') { out.push({ t: 'op', v: '^', ws: hadWs }); i += 2; continue; }
      if ('+-*/^'.indexOf(c) >= 0) { out.push({ t: 'op', v: c, ws: hadWs }); i++; continue; }
      if (c === '−') { out.push({ t: 'op', v: '-', ws: hadWs }); i++; continue; }
      if (c === '·' || c === '×') { out.push({ t: 'op', v: '*', ws: hadWs }); i++; continue; }
      if (c === '²') { out.push({ t: 'op', v: '^', ws: false }, { t: 'num', v: 2, raw: '2', ws: false }); i++; continue; }
      if (c === '³') { out.push({ t: 'op', v: '^', ws: false }, { t: 'num', v: 3, raw: '3', ws: false }); i++; continue; }
      if (c === '(') { out.push({ t: 'lp', ws: hadWs }); i++; continue; }
      if (c === ')') { out.push({ t: 'rp', ws: hadWs }); i++; continue; }
      if (c === ',') { out.push({ t: 'comma', ws: hadWs }); i++; continue; }
      throw new Error('非法字符：' + c);
    }
    return out;
  }

  function isFuncName(name) {
    return Object.prototype.hasOwnProperty.call(FUNCS, name);
  }

  function describeToken(k) {
    if (!k) return '表达式结尾';
    if (k.t === 'num') return k.raw !== undefined ? k.raw : String(k.v);
    if (k.t === 'id') return k.v;
    if (k.t === 'op') return k.v;
    if (k.t === 'lp') return '(';
    if (k.t === 'rp') return ')';
    if (k.t === 'comma') return ',';
    return k.t;
  }

  /* 解析表达式为统一 AST：支持显式括号及无歧义免括号函数自变量（sinx, sinsinx, sin2^x, sin2x 等） */
  function parseExprAst(src) {
    var ts = tokenize(src), pos = 0;
    function peek(off) { return ts[pos + (off || 0)]; }
    function eat(t) {
      var k = ts[pos];
      if (!k || k.t !== t) throw new Error('表达式语法错误：位置 ' + pos + ' 附近是「' + describeToken(k) + '」');
      pos++; return k;
    }
    function isUnaryFnTok(k) {
      return !!(k && k.t === 'id' && isFuncName(k.v) && FUNCS[k.v][1] === 1);
    }
    function isBinaryFnTok(k) {
      return !!(k && k.t === 'id' && isFuncName(k.v) && FUNCS[k.v][1] === 2);
    }
    function isInnerAtomTok(k) {
      return !!(k && k.t === 'id' && (k.v === 'x' || Object.prototype.hasOwnProperty.call(INNER_CONSTS, k.v)));
    }
    function canStartImplicitFactor(k) {
      return !!(k && (k.t === 'num' || k.t === 'id' || k.t === 'lp'));
    }

    function bareArg(fnName) {
      var k = peek();
      if (!k) throw new Error('函数 ' + fnName + ' 缺少自变量（可写为 ' + fnName + '(x) 或 ' + fnName + 'x）');
      if (k.t === 'op' && (k.v === '+' || k.v === '-')) {
        pos++;
        var inner = bareArg(fnName);
        return k.v === '-' ? { k: 'un', op: '-', a: inner } : inner;
      }
      if (isUnaryFnTok(k)) {
        pos++;
        if (peek() && peek().t === 'lp') {
          pos++;
          var args = [];
          if (!peek() || peek().t !== 'rp') {
            args.push(expr());
            while (peek() && peek().t === 'comma') { pos++; args.push(expr()); }
          }
          eat('rp');
          if (args.length !== 1) throw new Error(k.v + ' 需要 1 个参数');
          var callNode = { k: 'fn', name: k.v, args: args };
          if (peek() && peek().t === 'op' && peek().v === '^') {
            pos++;
            callNode = { k: 'bin', op: '^', l: callNode, r: unary() };
          }
          return callNode;
        }
        return { k: 'fn', name: k.v, args: [bareArg(k.v)] };
      }
      if (k.t === 'lp') {
        pos++;
        var sub = expr();
        eat('rp');
        if (peek() && peek().t === 'op' && peek().v === '^') {
          pos++;
          sub = { k: 'bin', op: '^', l: sub, r: unary() };
        }
        return sub;
      }
      function bareAtomPow() {
        var t = peek();
        var node;
        if (t && t.t === 'num') {
          pos++;
          node = { k: 'num', v: t.v, raw: t.raw };
        } else if (t && t.t === 'id' && t.v === 'x') {
          pos++;
          node = { k: 'var' };
        } else if (t && t.t === 'id' && Object.prototype.hasOwnProperty.call(CONSTS, t.v)) {
          pos++;
          node = { k: 'const', name: t.v, v: CONSTS[t.v] };
        } else {
          throw new Error('函数 ' + fnName + ' 缺少有效的整体自变量（位置 ' + pos + ' 附近是「' + describeToken(t) + '」；复杂表达式请加括号如 ' + fnName + '(x+1)）');
        }
        if (peek() && peek().t === 'op' && peek().v === '^') {
          pos++;
          node = { k: 'bin', op: '^', l: node, r: unary() };
        }
        return node;
      }
      var first = bareAtomPow();
      var hadPow = (first.k === 'bin' && first.op === '^');
      var endedWithVar = (first.k === 'var');
      if (!hadPow && !endedWithVar) {
        while (peek() && !peek().ws && isInnerAtomTok(peek())) {
          var rhs = bareAtomPow();
          first = { k: 'bin', op: '*', l: first, r: rhs };
          if (rhs.k === 'var' || (rhs.k === 'bin' && rhs.op === '^')) break;
        }
      }
      return first;
    }

    function primary() {
      var k = peek();
      if (!k) throw new Error('表达式意外结束');
      if (k.t === 'num') { pos++; return { k: 'num', v: k.v, raw: k.raw }; }
      if (k.t === 'lp') { pos++; var e = expr(); eat('rp'); return e; }
      if (k.t === 'op' && (k.v === '+' || k.v === '-')) {
        pos++;
        var inner = unary();
        return k.v === '-' ? { k: 'un', op: '-', a: inner } : inner;
      }
      if (k.t === 'id') {
        pos++;
        var name = k.v;
        if (peek() && peek().t === 'lp') {
          pos++;
          var args = [];
          if (!peek() || peek().t !== 'rp') {
            args.push(expr());
            while (peek() && peek().t === 'comma') { pos++; args.push(expr()); }
          }
          eat('rp');
          var spec = FUNCS[name];
          if (!spec) throw new Error('未知函数：' + name);
          if (args.length !== spec[1]) throw new Error(name + ' 需要 ' + spec[1] + ' 个参数');
          return { k: 'fn', name: name, args: args };
        }
        if (isBinaryFnTok(k)) {
          throw new Error('二元函数 ' + name + ' 必须带括号和 2 个参数，例如 ' + name + '(x, 0)');
        }
        if (isUnaryFnTok(k)) {
          return { k: 'fn', name: name, args: [bareArg(name)] };
        }
        if (name === 'x') return { k: 'var' };
        if (Object.prototype.hasOwnProperty.call(CONSTS, name)) {
          return { k: 'const', name: name, v: CONSTS[name] };
        }
        throw new Error('未知标识符：' + name + '（变量只能用 x）');
      }
      throw new Error('表达式语法错误：位置 ' + pos + ' 附近是「' + describeToken(k) + '」');
    }

    function power() {
      var base = primary();
      if (peek() && peek().t === 'op' && peek().v === '^') {
        pos++;
        return { k: 'bin', op: '^', l: base, r: unary() };
      }
      return base;
    }

    function unary() {
      var k = peek();
      if (k && k.t === 'op' && (k.v === '+' || k.v === '-')) {
        pos++;
        var inner = unary();
        return k.v === '-' ? { k: 'un', op: '-', a: inner } : inner;
      }
      return power();
    }

    function term() {
      var left = unary();
      while (peek()) {
        var k = peek();
        if (k.t === 'op' && (k.v === '*' || k.v === '/')) {
          pos++;
          left = { k: 'bin', op: k.v, l: left, r: unary() };
        } else if (canStartImplicitFactor(k)) {
          left = { k: 'bin', op: '*', l: left, r: power() };
        } else {
          break;
        }
      }
      return left;
    }

    function expr() {
      var left = term();
      while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
        var op = ts[pos++].v;
        left = { k: 'bin', op: op, l: left, r: term() };
      }
      return left;
    }

    var ast = expr();
    if (pos !== ts.length) throw new Error('表达式语法错误：位置 ' + pos + ' 起有多余内容「' + describeToken(ts[pos]) + '」');
    return ast;
  }

  /* 将 AST 序列化为唯一显式括号+显式乘号的标准表达式（sinx→sin(x), sin2^x→sin(2^x)） */
  function formatAst(node) {
    if (!node) return '';
    if (node.k === 'num') return node.raw !== undefined ? node.raw : String(node.v);
    if (node.k === 'var') return 'x';
    if (node.k === 'const') return node.name;
    if (node.k === 'fn') return node.name + '(' + node.args.map(formatAst).join(',') + ')';
    if (node.k === 'un') {
      var innerS = formatAst(node.a);
      if (node.op === '-') {
        if (node.a.k === 'bin' || node.a.k === 'un') return '-(' + innerS + ')';
        return '-' + innerS;
      }
      return innerS;
    }
    if (node.k === 'bin') {
      var ls = formatAst(node.l), rs = formatAst(node.r);
      if (node.op === '+') return ls + '+' + rs;
      if (node.op === '-') {
        if ((node.r.k === 'bin' && (node.r.op === '+' || node.r.op === '-')) || node.r.k === 'un') rs = '(' + rs + ')';
        return ls + '-' + rs;
      }
      if (node.op === '*') {
        if (node.l.k === 'bin' && (node.l.op === '+' || node.l.op === '-')) ls = '(' + ls + ')';
        if ((node.r.k === 'bin' && (node.r.op === '+' || node.r.op === '-')) || node.r.k === 'un') rs = '(' + rs + ')';
        return ls + '*' + rs;
      }
      if (node.op === '/') {
        if (node.l.k === 'bin' && (node.l.op === '+' || node.l.op === '-')) ls = '(' + ls + ')';
        if (node.r.k === 'bin' || node.r.k === 'un') rs = '(' + rs + ')';
        return ls + '/' + rs;
      }
      if (node.op === '^') {
        if (node.l.k === 'bin' || node.l.k === 'un') ls = '(' + ls + ')';
        if (node.r.k === 'bin' || node.r.k === 'un') rs = '(' + rs + ')';
        return ls + '^' + rs;
      }
    }
    return '';
  }

  function normalizeExpr(src) {
    return formatAst(parseExprAst(src));
  }

  /* 安全把表达式源码里的自变量 x 替换为子表达式字符串（先做标准规范化再按 AST 替换） */
  function substXSrc(src, repl) {
    function replaceAst(node) {
      if (!node) return '';
      if (node.k === 'var') return '(' + repl + ')';
      if (node.k === 'num') return node.raw !== undefined ? node.raw : String(node.v);
      if (node.k === 'const') return node.name;
      if (node.k === 'fn') return node.name + '(' + node.args.map(replaceAst).join(',') + ')';
      if (node.k === 'un') {
        var is = replaceAst(node.a);
        return node.op === '-' ? ((node.a.k === 'bin' || node.a.k === 'un') ? '-(' + is + ')' : '-' + is) : is;
      }
      if (node.k === 'bin') {
        var ls = replaceAst(node.l), rs = replaceAst(node.r);
        if (node.op === '+') return ls + '+' + rs;
        if (node.op === '-') return ls + '-' + (((node.r.k === 'bin' && (node.r.op === '+' || node.r.op === '-')) || node.r.k === 'un') ? '(' + rs + ')' : rs);
        if (node.op === '*') {
          if (node.l.k === 'bin' && (node.l.op === '+' || node.l.op === '-')) ls = '(' + ls + ')';
          if ((node.r.k === 'bin' && (node.r.op === '+' || node.r.op === '-')) || node.r.k === 'un') rs = '(' + rs + ')';
          return ls + '*' + rs;
        }
        if (node.op === '/') {
          if (node.l.k === 'bin' && (node.l.op === '+' || node.l.op === '-')) ls = '(' + ls + ')';
          if (node.r.k === 'bin' || node.r.k === 'un') rs = '(' + rs + ')';
          return ls + '/' + rs;
        }
        if (node.op === '^') {
          if (node.l.k === 'bin' || node.l.k === 'un') ls = '(' + ls + ')';
          if (node.r.k === 'bin' || node.r.k === 'un') rs = '(' + rs + ')';
          return ls + '^' + rs;
        }
      }
      return '';
    }
    return replaceAst(parseExprAst(src));
  }

  function compileAstNode(node) {
    if (node.k === 'num') { var v = node.v; return function () { return v; }; }
    if (node.k === 'var') return function (x) { return x; };
    if (node.k === 'const') { var cv = node.v; return function () { return cv; }; }
    if (node.k === 'un') {
      var a = compileAstNode(node.a);
      return node.op === '-' ? function (x) { return -a(x); } : a;
    }
    if (node.k === 'fn') {
      var spec = FUNCS[node.name], fn = spec[0];
      if (node.args.length === 1) {
        var a0 = compileAstNode(node.args[0]);
        return function (x) { return fn(a0(x)); };
      }
      var cArgs = node.args.map(compileAstNode);
      return function (x) { return fn.apply(null, cArgs.map(function (c) { return c(x); })); };
    }
    if (node.k === 'bin') {
      var L = compileAstNode(node.l), R = compileAstNode(node.r);
      if (node.op === '+') return function (x) { return L(x) + R(x); };
      if (node.op === '-') return function (x) { return L(x) - R(x); };
      if (node.op === '*') return function (x) { return L(x) * R(x); };
      if (node.op === '/') return function (x) { return L(x) / R(x); };
      return function (x) { return Math.pow(L(x), R(x)); };
    }
    throw new Error('未知 AST 节点');
  }

  function compile(src) {
    var ast = parseExprAst(src);
    var f = compileAstNode(ast);
    try { f.src = formatAst(ast); } catch (e) {}
    return f;
  }

  function safeEval(g, t) {
    try { return g(t); } catch (e) { return NaN; }
  }

  function parseBound(raw) {
    var s = String(raw).trim().toLowerCase().replace(/\s/g, '');
    if (s === 'inf' || s === '+inf' || s === 'infinity' || s === '+infinity' || s === '∞' || s === '+∞') return Infinity;
    if (s === '-inf' || s === '-infinity' || s === '-∞') return -Infinity;
    if (/^(pi|π)$/.test(s)) return Math.PI;
    if (s === '-pi' || s === '-π') return -Math.PI;
    var v = Number(s);
    if (!isFinite(v) && s !== '') {
      try { v = compile(s)(0); } catch (e) { throw new Error('无法解析积分限：' + raw); }
    }
    if (isNaN(v)) throw new Error('无法解析积分限：' + raw);
    return v;
  }

  /* 把无限区间映射到 t∈(0,1)，返回 {g, lo, hi, label, toX, fromX} */
  function transform(f, a, b) {
    var eps = 1e-14;
    if (isFinite(a) && isFinite(b)) {
      var span = b - a;
      return {
        g: function (t) { return f(a + span * t) * span; },
        toX: function (t) { return a + span * t; },
        fromX: function (x) { return (x - a) / span; },
        lo: 0, hi: 1,
        label: '有限区间线性映射'
      };
    }
    if (isFinite(a) && b === Infinity) {
      return {
        g: function (t) {
          var q = 1 - t; if (q <= 0) return 0;
          return f(a + t / q) / (q * q);
        },
        toX: function (t) { var q = 1 - t; return q <= 0 ? Infinity : a + t / q; },
        fromX: function (x) { var d = x - a; return d / (1 + d); },
        lo: 0, hi: 1 - eps, label: 'x = a + t/(1−t)，dx = dt/(1−t)²'
      };
    }
    if (a === -Infinity && isFinite(b)) {
      return {
        g: function (t) {
          if (t <= 0) return 0;
          return f(b - (1 - t) / t) / (t * t);
        },
        toX: function (t) { return t <= 0 ? -Infinity : b - (1 - t) / t; },
        fromX: function (x) { var d = b - x; return 1 / (1 + d); },
        lo: eps, hi: 1, label: 'x = b − (1−t)/t，dx = dt/t²'
      };
    }
    if (a === -Infinity && b === Infinity) {
      return {
        g: function (t) {
          var ang = Math.PI * (t - 0.5);
          var cs = Math.cos(ang);
          return f(Math.tan(ang)) * Math.PI / (cs * cs);
        },
        toX: function (t) { return Math.tan(Math.PI * (t - 0.5)); },
        fromX: function (x) { return Math.atan(x) / Math.PI + 0.5; },
        lo: eps, hi: 1 - eps, label: 'x = tan(π(t−1/2))'
      };
    }
    throw new Error('不支持的积分区间');
  }

  /* 端点可去奇点：当 [1e-6, 1e-8, 1e-10] 受 0/0 抵消（如 (1-cos x)/x²）失效时，
     回退到 [1e-3, 1e-4, 1e-5] 以免误判为真奇点或丢掉有限端点值。 */
  function patchEnds(g, lo, hi) {
    var W = hi - lo;
    function limitAt(t, inward) {
      var ds1 = [1e-6, 1e-8, 1e-10], v = [];
      for (var i = 0; i < ds1.length; i++) {
        var u = safeEval(g, t + inward * ds1[i] * W);
        if (!isFinite(u)) { v = null; break; }
        v.push(u);
      }
      if (v) {
        var a = Math.abs(v[0]), b = Math.abs(v[1]), c = Math.abs(v[2]);
        var scale = Math.max(a, b, c, 1);
        if (!(c > 1.1 * b && b > 1.1 * a) &&
            Math.abs(v[2] - v[1]) <= 1e-6 * scale &&
            Math.abs(v[1] - v[0]) <= 1e-6 * scale) {
          return (100 * v[1] - v[0]) / 99;
        }
      }
      var ds2 = [1e-3, 1e-4, 1e-5], v2 = [];
      for (var j = 0; j < ds2.length; j++) {
        var u2 = safeEval(g, t + inward * ds2[j] * W);
        if (!isFinite(u2)) return null;
        v2.push(u2);
      }
      var a2 = Math.abs(v2[0]), b2 = Math.abs(v2[1]), c2 = Math.abs(v2[2]);
      var scale2 = Math.max(a2, b2, c2, 1);
      if (c2 > 1.05 * b2 && b2 > 1.05 * a2) return null;
      if (Math.abs(v2[2] - v2[1]) > 1e-4 * scale2) return null;
      if (Math.abs(v2[1] - v2[0]) > 1e-4 * scale2) return null;
      return (10 * v2[2] - v2[1]) / 9;
    }
    var limLo = isFinite(safeEval(g, lo)) ? null : limitAt(lo, 1);
    var limHi = isFinite(safeEval(g, hi)) ? null : limitAt(hi, -1);
    if (limLo === null && limHi === null) return g;
    return function (t) {
      if (t === lo && limLo !== null) return limLo;
      if (t === hi && limHi !== null) return limHi;
      return g(t);
    };
  }

  /* 双端尾部浮点溢出截断：同时处理右端（hi）和左端（lo）的良性溢出（如 sinh/cosh） */
  function trimOverflowTail(g, lo, hi, peak, trimLeft, trimRight) {
    var N = 600, changed = false, newLo = lo, newHi = hi, dropped = 0;
    if (trimRight && !isFinite(safeEval(g, hi))) {
      var tOkHi = null, vOkHi = 0;
      for (var k = N - 1; k >= 1; k--) {
        var t = lo + (hi - lo) * k / N, v = safeEval(g, t);
        if (isFinite(v)) { tOkHi = t; vOkHi = v; break; }
      }
      if (tOkHi !== null) {
        var scaleR = Math.max(peak, Math.abs(vOkHi), 1e-300);
        if (Math.abs(vOkHi) <= 1e-10 * scaleR) {
          dropped += Math.abs(vOkHi) * (hi - tOkHi);
          newHi = tOkHi;
          changed = true;
        }
      }
    }
    if (trimLeft && !isFinite(safeEval(g, newLo))) {
      var tOkLo = null, vOkLo = 0;
      for (var k2 = 1; k2 < N; k2++) {
        var t2 = newLo + (newHi - newLo) * k2 / N, v2 = safeEval(g, t2);
        if (isFinite(v2)) { tOkLo = t2; vOkLo = v2; break; }
      }
      if (tOkLo !== null) {
        var scaleL = Math.max(peak, Math.abs(vOkLo), 1e-300);
        if (Math.abs(vOkLo) <= 1e-10 * scaleL) {
          dropped += Math.abs(vOkLo) * (tOkLo - newLo);
          newLo = tOkLo;
          changed = true;
        }
      }
    }
    return changed ? { lo: newLo, hi: newHi, dropped: dropped } : null;
  }

  function simpson(g, a, b, fa, fb, fc) {
    return (b - a) / 6 * (fa + 4 * fc + fb);
  }

  function adaptive(g, a, b, fa, fb, fc, whole, tol, depth, maxDepth, counter) {
    var m = (a + b) / 2;
    if (m <= a || m >= b) { counter.capped = true; return whole; }
    if (counter.n >= counter.maxEvals || ((counter.n & 4095) === 0 && Date.now() > counter.deadline)) {
      counter.capped = true;
      counter.evalCapped = true;
      return whole;
    }
    var lf = safeEval(g, (a + m) / 2), rf = safeEval(g, (m + b) / 2);
    counter.n += 2;
    if (!isFinite(lf) || !isFinite(rf)) { counter.bad = true; return whole; }
    var L = simpson(g, a, m, fa, fc, lf), R = simpson(g, m, b, fc, fb, rf);
    var delta = L + R - whole;
    var noiseTol = 16 * Number.EPSILON * (Math.abs(whole) + (b - a) * (Math.abs(fa) + 2 * Math.abs(fc) + Math.abs(fb)));
    var effTol = tol > noiseTol ? tol : noiseTol;
    if (depth >= maxDepth) { counter.capped = true; counter.err += Math.abs(delta) / 15; return L + R + delta / 15; }
    if (Math.abs(delta) <= 15 * effTol) { counter.err += Math.abs(delta) / 15; return L + R + delta / 15; }
    return adaptive(g, a, m, fa, fc, lf, L, tol / 2, depth + 1, maxDepth, counter)
         + adaptive(g, m, b, fc, fb, rf, R, tol / 2, depth + 1, maxDepth, counter);
  }

  function integrateOnce(g, lo, hi, tol, segments, maxDepth, maxEvals) {
    var total = 0, absSum = 0;
    var counter = {
      n: 0, err: 0, bad: false, capped: false, evalCapped: false, openEnd: false,
      maxEvals: maxEvals || 450000,
      deadline: Date.now() + 20000
    };
    var md = maxDepth || 24;
    for (var k = 0; k < segments; k++) {
      var a = lo + (hi - lo) * k / segments, b = lo + (hi - lo) * (k + 1) / segments;
      var m = (a + b) / 2, fa = safeEval(g, a), fb = safeEval(g, b), fc = safeEval(g, m);
      counter.n += 3;
      if (!isFinite(fa) || !isFinite(fb) || !isFinite(fc)) {
        var pad = (b - a) * 1e-12;
        a += pad; b -= pad; m = (a + b) / 2;
        fa = safeEval(g, a); fb = safeEval(g, b); fc = safeEval(g, m);
        counter.openEnd = true;
        if (!isFinite(fa) || !isFinite(fb) || !isFinite(fc)) { counter.bad = true; continue; }
      }
      var whole = simpson(g, a, b, fa, fb, fc);
      total += adaptive(g, a, b, fa, fb, fc, whole, tol / segments, 0, md, counter);
      absSum += (Math.abs(fa) + 4 * Math.abs(fc) + Math.abs(fb)) * (b - a) / 6;
    }
    return { value: total, absSum: absSum, evals: counter.n, err: counter.err,
             bad: counter.bad, capped: counter.capped, evalCapped: counter.evalCapped, openEnd: counter.openEnd };
  }

  /* 16 点 Gauss-Legendre 复合求积（有限区间光滑高频振荡，比 4 阶 Simpson 快百倍） */
  var GL16_X = [
    0.09501250983763744019, 0.28160355077925891323,
    0.45801677765722738634, 0.61787624440264374845,
    0.75540440835500303390, 0.86563120238783174388,
    0.94457502307323257608, 0.98940093499164993260
  ];
  var GL16_W = [
    0.18945061045506849629, 0.18260341504492358887,
    0.16915651939500253819, 0.14959598881657673208,
    0.12462897125553387205, 0.09515851168249278481,
    0.06225352393864789286, 0.02715245941175409485
  ];

  function compositeGL16(g, lo, hi, panels) {
    var h = (hi - lo) / panels, half = h * 0.5;
    var sum = 0, absSum = 0, bad = false;
    for (var p = 0; p < panels; p++) {
      var mid = lo + (p + 0.5) * h;
      var ps = 0, pa = 0;
      for (var i = 0; i < 8; i++) {
        var dx = half * GL16_X[i], w = GL16_W[i];
        var v1 = safeEval(g, mid - dx), v2 = safeEval(g, mid + dx);
        if (!isFinite(v1) || !isFinite(v2)) { bad = true; return { value: NaN, absSum: NaN, bad: true, evals: (p + 1) * 16 }; }
        ps += w * (v1 + v2);
        pa += w * (Math.abs(v1) + Math.abs(v2));
      }
      sum += ps * half;
      absSum += pa * half;
    }
    return { value: sum, absSum: absSum, bad: bad, evals: panels * 16 };
  }

  function integrateHighFreqGL(g, lo, hi, signChanges) {
    var n0 = Math.max(64, Math.min(4096, Math.ceil(signChanges * 3)));
    var r1 = compositeGL16(g, lo, hi, n0);
    if (r1.bad || !isFinite(r1.value)) return null;
    var totalEvals = r1.evals, prev = r1, cur = r1, n = n0;
    var lastDiff = Infinity, prevDiff = Infinity;
    for (var step = 0; step < 4; step++) {
      n *= 2;
      if (n > 32768) break;
      cur = compositeGL16(g, lo, hi, n);
      totalEvals += cur.evals;
      if (cur.bad || !isFinite(cur.value)) return null;
      var diff = Math.abs(cur.value - prev.value);
      prevDiff = lastDiff;
      lastDiff = diff;
      var scale = Math.max(Math.abs(cur.value), cur.absSum, 1e-300);
      if (diff <= 1e-13 * scale && (step >= 1 || n0 >= 128)) {
        var sig = Math.max(diff * 32, 512 * Number.EPSILON * (cur.absSum + Math.abs(cur.value)));
        return { value: cur.value, absSum: cur.absSum, sigma: sig, evals: totalEvals, panels: n };
      }
      prev = cur;
    }
    var scaleLast = Math.max(Math.abs(cur.value), cur.absSum, 1e-300);
    if (lastDiff <= 1e-10 * scaleLast && (prevDiff === Infinity || prevDiff >= lastDiff * 6)) {
      var sigLast = Math.max(lastDiff * 32, 512 * Number.EPSILON * (cur.absSum + Math.abs(cur.value)));
      return { value: cur.value, absSum: cur.absSum, sigma: sigLast, evals: totalEvals, panels: n };
    }
    return null;
  }

  /* ---------- 端点渐近与发散诊断 ---------- */
  function olsSlope(arr, xfn, yfn) {
    if (arr.length < 2) return 0;
    var mx = 0, my = 0, i;
    for (i = 0; i < arr.length; i++) { mx += xfn(arr[i]); my += yfn(arr[i]); }
    mx /= arr.length; my /= arr.length;
    var num = 0, den = 0;
    for (i = 0; i < arr.length; i++) {
      var dx = xfn(arr[i]) - mx, dy = yfn(arr[i]) - my;
      num += dx * dy; den += dx * dx;
    }
    return den > 0 ? num / den : 0;
  }

  /* 分析 g 在端点 side ('lo' / 'hi') 的渐近行为：
     - D1 幂次发散（p_F <= -0.995 且 I_k 未衰减）
     - D2 对数临界发散（三段递陡 + Cauchy 凝聚衰减指数 q_F <= 1.08）
     - D3 溢出发散（排除尾部已衰减的良性 sinh/cosh 溢出和 bounded chirp）
     - 区分振荡尾部（oscillatoryTail）与真实发散 */
  function analyzeEndpoint(g, lo, hi, side, isFiniteEnd) {
    var W = hi - lo;
    if (!(W > 0) || !isFinite(W)) return { slope: 0, divergent: false, integrableSingularity: false, oscillatoryTail: false, benignOverflow: false, domainBad: true };
    var t0 = side === 'lo' ? lo : hi;
    var minOff = t0 === 0 ? 1e-300 : 4 * Number.EPSILON * Math.abs(t0);

    var samples = [], pts = [], peak = 0, signChanges = 0, lastSign = 0;
    var deepSignChanges = 0, lastDeepSign = 0;
    for (var k = 2; k <= 34; k++) {
      var d = W * Math.pow(2, -k);
      if (d < minOff) break;
      var t = side === 'lo' ? lo + d : hi - d;
      var v = safeEval(g, t);
      samples.push({ k: k, d: d, t: t, v: v });
      if (isFinite(v)) {
        var av = Math.abs(v);
        if (av > peak) peak = av;
        if (av > 0) {
          pts.push({ k: k, d: d, v: v, abs: av, I: d * av });
          var sg = v > 0 ? 1 : -1;
          if (lastSign !== 0 && sg !== lastSign) signChanges++;
          lastSign = sg;
          if (k >= 14) {
            if (lastDeepSign !== 0 && sg !== lastDeepSign) deepSignChanges++;
            lastDeepSign = sg;
          }
        }
      }
    }

    var deepDirReversals = 0;
    if (isFiniteEnd) {
      var prevV = null, prevDir = 0, revTol = 1e-3 * Math.max(peak, 1e-300);
      for (var si = 0; si < samples.length; si++) {
        if (samples[si].k < 14 || !isFinite(samples[si].v)) continue;
        var cv = samples[si].v;
        if (prevV !== null) {
          var dv = cv - prevV;
          if (Math.abs(dv) > revTol) {
            var curDir = dv > 0 ? 1 : -1;
            if (prevDir !== 0 && curDir !== prevDir) deepDirReversals++;
            prevDir = curDir;
          }
        }
        prevV = cv;
      }
    }

    /* 有限端点仅在微观尺度（δ <= 2^-14 W）仍持续变号或剧烈折返时才判为振荡奇点，
       避免把 2x·sin(x²) [0,30] 等光滑高频函数误判为端点振荡奇点，同时捕获 sin(1/x)+c 等带偏置振荡 */
    var oscillatoryTail = isFiniteEnd
      ? (deepSignChanges >= 3 || deepDirReversals >= 5)
      : (signChanges >= 4);
    var tailNonFin = 0;
    for (var s = samples.length - 1; s >= 0; s--) {
      if (!isFinite(samples[s].v)) tailNonFin++;
      else break;
    }

    if (pts.length === 0 && samples.length > 0 && tailNonFin === samples.length) {
      return { slope: 0, divergent: false, integrableSingularity: false, oscillatoryTail: false, benignOverflow: false, domainBad: true };
    }

    /* D3 溢出发散检查（区分实为 float64 相消下溢壁：如 ln(1-sin x) 在 π/2 处） */
    var isCancelWall = false;
    var lastFinVEdge = pts.length ? pts[pts.length - 1].abs : 0;
    if (tailNonFin >= 4 || (pts.length < 6 && samples.length > 0 && !isFinite(samples[samples.length - 1].v))) {
      var lastFinIdx = -1;
      for (var lf = samples.length - 1; lf >= 0; lf--) {
        if (isFinite(samples[lf].v)) { lastFinIdx = lf; break; }
      }
      if (lastFinIdx < 0) {
        return { slope: 0, divergent: true, reason: 'overflow', integrableSingularity: false, oscillatoryTail: false, benignOverflow: false, domainBad: true };
      }
      var dOk = samples[lastFinIdx].d, dBad = samples[Math.min(samples.length - 1, lastFinIdx + 1)].d;
      var vEdge = samples[lastFinIdx].v;
      for (var it = 0; it < 30; it++) {
        var dm = (dOk + dBad) / 2;
        var tm = side === 'lo' ? lo + dm : hi - dm;
        var vm = safeEval(g, tm);
        if (isFinite(vm)) { dOk = dm; vEdge = vm; }
        else dBad = dm;
      }
      if (Math.abs(vEdge) <= 1e-10 * Math.max(peak, 1e-300)) {
        return { slope: 0, divergent: false, integrableSingularity: false, oscillatoryTail: oscillatoryTail, benignOverflow: true, domainBad: false };
      }
      var tailAllInf = tailNonFin > 0;
      for (var ti = lastFinIdx + 1; ti < samples.length; ti++) {
        if (samples[ti].v !== Infinity && samples[ti].v !== -Infinity) { tailAllInf = false; break; }
      }
      if (tailAllInf && Math.abs(vEdge) < 1e100 && pts.length >= 10 && dBad <= 1e-4 * W) {
        isCancelWall = true;
        lastFinVEdge = Math.abs(vEdge);
        pts = pts.slice(0, pts.length - 2);
      } else {
        if (oscillatoryTail && Math.abs(vEdge) < 1e200) {
          /* 如 sin(2^x) 在 x>=1024 因 2^x 溢出变 NaN，但 f 本身幅值有界（仅雅可比放大），交由振荡分支检验 */
          return { slope: -1.5, divergent: false, integrableSingularity: false, oscillatoryTail: true, benignOverflow: false, domainBad: false };
        }
        return { slope: -1.5, divergent: true, reason: 'overflow', integrableSingularity: false, oscillatoryTail: oscillatoryTail, benignOverflow: false, domainBad: false };
      }
    }

    if (pts.length < 6) {
      return { slope: 0, divergent: false, integrableSingularity: false, oscillatoryTail: oscillatoryTail, benignOverflow: false, domainBad: false };
    }

    var slopeAll = olsSlope(pts, function (p) { return Math.log(p.d); }, function (p) { return Math.log(p.abs); });

    if (oscillatoryTail) {
      return {
        slope: slopeAll,
        divergent: false,
        integrableSingularity: slopeAll < -0.08 && slopeAll > -0.995,
        oscillatoryTail: true,
        benignOverflow: false,
        domainBad: false
      };
    }

    var n = pts.length;
    var q1 = Math.floor(n / 3), q2 = Math.floor(2 * n / 3);
    var A = pts.slice(0, Math.max(2, q1));
    var B = pts.slice(q1, Math.max(q1 + 2, q2));
    var C = pts.slice(q2);
    var F = pts.slice(Math.floor(n / 2));

    var pB = olsSlope(B, function (p) { return Math.log(p.d); }, function (p) { return Math.log(p.abs); });
    var pC = olsSlope(C, function (p) { return Math.log(p.d); }, function (p) { return Math.log(p.abs); });
    var pF = olsSlope(F, function (p) { return Math.log(p.d); }, function (p) { return Math.log(p.abs); });
    var ratioI = F[F.length - 1].I / Math.max(F[0].I, 1e-300);
    var qF = -olsSlope(F, function (p) { return Math.log(Math.max(1e-12, Math.log(W / p.d))); }, function (p) { return Math.log(p.I); });

    /* D1 幂次发散 */
    if (pF <= -0.995 && ratioI >= 0.85) {
      return { slope: pF, divergent: true, reason: 'power', integrableSingularity: false, oscillatoryTail: false, benignOverflow: false, domainBad: false };
    }
    /* D2 对数临界发散（三段尾部仍继续变陡且 Cauchy 凝聚幂指数 <= 1.08） */
    if (pC < -0.88 && (pC - pB) < -0.008 && qF <= 1.08) {
      return { slope: pF, divergent: true, reason: 'log-critical', integrableSingularity: false, oscillatoryTail: false, benignOverflow: false, domainBad: false };
    }

    var useSlope = (pF < -0.005 && pts[pts.length - 1].abs > pts[0].abs * 1.1)
      ? Math.min(pF, slopeAll)
      : pF;
    return {
      slope: pF,
      slopeAll: slopeAll,
      useSlope: useSlope,
      divergent: false,
      integrableSingularity: useSlope < -0.08 || (isCancelWall && lastFinVEdge > Math.max(pts[0].abs * 1.5, 1)),
      oscillatoryTail: false,
      benignOverflow: false,
      domainBad: false
    };
  }

  /* 兼容旧导出签名，补充细粒度端点分析与变号计数 */
  function diagnose(g, lo, hi, isFiniteLo, isFiniteHi) {
    var notes = [], verdict = 'ok', maxSeen = 0, badCount = 0, signChanges = 0;
    var lastSign = 0, N = 2047;
    for (var k = 1; k < N; k++) {
      var t = lo + (hi - lo) * k / N, v = safeEval(g, t);
      if (!isFinite(v)) { badCount++; continue; }
      var av = Math.abs(v);
      if (av > maxSeen) maxSeen = av;
      if (v !== 0) {
        var sg = v > 0 ? 1 : -1;
        if (lastSign !== 0 && sg !== lastSign) signChanges++;
        lastSign = sg;
      }
    }
    var endLo = analyzeEndpoint(g, lo, hi, 'lo', !!isFiniteLo);
    var endHi = analyzeEndpoint(g, lo, hi, 'hi', !!isFiniteHi);

    if (endLo.divergent || endHi.divergent) {
      verdict = 'divergent';
      var worst = Math.min(endLo.divergent ? endLo.slope : 0, endHi.divergent ? endHi.slope : 0);
      notes.push('端点渐近分析：|g| ~ δ^(' + worst.toFixed(2) + ')，达到不可积或临界发散阶，积分发散。');
    } else if ((endLo.domainBad && endHi.domainBad) || badCount >= N - 5) {
      verdict = 'divergent';
      notes.push('积分区间内几乎全部无定义（NaN/Inf），请检查定义域。');
    } else if (endLo.integrableSingularity || endHi.integrableSingularity) {
      var minSl = Math.min(endLo.slope, endHi.slope);
      if (minSl < -0.30) {
        verdict = 'uncertain';
        notes.push('检测到可积型端点奇点（|g| ~ δ^(' + minSl.toFixed(2) + ')）。');
      }
    }

    if (badCount > 0 && !endLo.benignOverflow && !endHi.benignOverflow) {
      if (verdict !== 'divergent') verdict = 'uncertain';
      notes.push('采样中有 ' + badCount + ' 个点出现 NaN/Inf，可能存在内部奇点或定义域问题。');
    }
    if (maxSeen > 1e10 && !endLo.oscillatoryTail && !endHi.oscillatoryTail) {
      if (verdict === 'ok') verdict = 'uncertain';
      notes.push('被积函数峰值达 ' + maxSeen.toExponential(2) + '，数值结果可能不稳定。');
    }
    return {
      verdict: verdict, notes: notes,
      slopeLo: endLo.slope, slopeHi: endHi.slope,
      endLo: endLo, endHi: endHi,
      badCount: badCount, maxSeen: maxSeen, signChanges: signChanges
    };
  }

  /* ---------- 内部奇点与有限区间折点扫描 ---------- */
  function refinePoleOrPeak(g, tL, tR, flipSign) {
    var a = tL, b = tR;
    if (flipSign) {
      var fa = safeEval(g, a), fb = safeEval(g, b);
      for (var it = 0; it < 50; it++) {
        var mid = (a + b) / 2, fm = safeEval(g, mid);
        if (!isFinite(fm)) return mid;
        if (Math.abs(fm) === 0) return null; /* 只是普通过零点，不是极点 */
        if ((fa > 0 && fm > 0) || (fa < 0 && fm < 0)) {
          if (Math.abs(fm) < Math.abs(fa) * 0.5) return null;
          a = mid; fa = fm;
        } else {
          if (Math.abs(fm) < Math.abs(fb) * 0.5) return null;
          b = mid; fb = fm;
        }
      }
      return (a + b) / 2;
    }
    for (var it2 = 0; it2 < 50; it2++) {
      var m1 = a + (b - a) / 3, m2 = a + 2 * (b - a) / 3;
      var v1 = safeEval(g, m1), v2 = safeEval(g, m2);
      var s1 = isFinite(v1) ? Math.abs(v1) : Infinity;
      var s2 = isFinite(v2) ? Math.abs(v2) : Infinity;
      if (s1 === Infinity && s2 === Infinity) {
        var lLo = a, lHi = m1, rLo = m2, rHi = b;
        for (var bi = 0; bi < 30; bi++) {
          var lm = (lLo + lHi) / 2;
          if (!isFinite(safeEval(g, lm))) lHi = lm; else lLo = lm;
          var rm = (rLo + rHi) / 2;
          if (!isFinite(safeEval(g, rm))) rLo = rm; else rHi = rm;
        }
        return (lHi + rLo) / 2;
      }
      if (s1 > s2) b = m2;
      else a = m1;
    }
    return (a + b) / 2;
  }

  function refineKink(g, tL, tR) {
    var a = tL, b = tR;
    for (var it = 0; it < 44; it++) {
      var w = b - a;
      var m1 = a + 0.25 * w, m2 = a + 0.5 * w, m3 = a + 0.75 * w;
      var v0 = safeEval(g, a), v1 = safeEval(g, m1), v2 = safeEval(g, m2), v3 = safeEval(g, m3), v4 = safeEval(g, b);
      if (!isFinite(v0) || !isFinite(v1) || !isFinite(v2) || !isFinite(v3) || !isFinite(v4)) break;
      var dL = Math.abs(v2 - 2 * v1 + v0);
      var dM = Math.abs(v3 - 2 * v2 + v1);
      var dR = Math.abs(v4 - 2 * v3 + v2);
      if (dL >= dM && dL >= dR) b = m2;
      else if (dR >= dM && dR >= dL) a = m2;
      else { a = m1; b = m3; }
    }
    return (a + b) / 2;
  }

  function refineJump(g, tL, tR) {
    var a = tL, b = tR;
    var fa = safeEval(g, a), fb = safeEval(g, b);
    if (!isFinite(fa) || !isFinite(fb)) return (a + b) / 2;
    for (var it = 0; it < 52; it++) {
      var mid = (a + b) / 2;
      if (mid <= a || mid >= b) break;
      var fm = safeEval(g, mid);
      if (!isFinite(fm)) return mid;
      if (Math.abs(fm - fa) >= Math.abs(fb - fm)) { b = mid; fb = fm; }
      else { a = mid; fa = fm; }
    }
    return (a + b) / 2;
  }

  /* AST 引导的特征点提取：从被积函数源码中符号解析内部极点、分支/折点与远端窄峰中心 */
  function extractAstSeeds(src, a, b) {
    if (!src) return [];
    try {
      var ast = parseExprAst(src);

      function poly2(node) {
        if (!node) return null;
        if (node.k === 'num') return isFinite(node.v) ? { c0: node.v, c1: 0, c2: 0 } : null;
        if (node.k === 'const') return isFinite(node.v) ? { c0: node.v, c1: 0, c2: 0 } : null;
        if (node.k === 'var') return { c0: 0, c1: 1, c2: 0 };
        if (node.k === 'un') {
          var p = poly2(node.a);
          if (!p) return null;
          return node.op === '-' ? { c0: -p.c0, c1: -p.c1, c2: -p.c2 } : p;
        }
        if (node.k === 'bin') {
          var l = poly2(node.l), r = poly2(node.r);
          if (!l || !r) return null;
          if (node.op === '+') return { c0: l.c0 + r.c0, c1: l.c1 + r.c1, c2: l.c2 + r.c2 };
          if (node.op === '-') return { c0: l.c0 - r.c0, c1: l.c1 - r.c1, c2: l.c2 - r.c2 };
          if (node.op === '*') {
            var dL = l.c2 !== 0 ? 2 : l.c1 !== 0 ? 1 : 0;
            var dR = r.c2 !== 0 ? 2 : r.c1 !== 0 ? 1 : 0;
            if (dL + dR > 2) return null;
            return {
              c0: l.c0 * r.c0,
              c1: l.c0 * r.c1 + l.c1 * r.c0,
              c2: l.c0 * r.c2 + l.c1 * r.c1 + l.c2 * r.c0
            };
          }
          if (node.op === '/') {
            if (r.c1 === 0 && r.c2 === 0 && r.c0 !== 0) {
              return { c0: l.c0 / r.c0, c1: l.c1 / r.c0, c2: l.c2 / r.c0 };
            }
            return null;
          }
          if (node.op === '^') {
            if (r.c1 === 0 && r.c2 === 0) {
              if (r.c0 === 0) return { c0: 1, c1: 0, c2: 0 };
              if (r.c0 === 1) return l;
              if (r.c0 === 2 && l.c2 === 0) {
                return { c0: l.c0 * l.c0, c1: 2 * l.c0 * l.c1, c2: l.c1 * l.c1 };
              }
            }
            return null;
          }
        }
        return null;
      }

      var seeds = [];
      function addSeed(x, hint) {
        if (!isFinite(x)) return;
        if (isFinite(a) && !(x > a)) return;
        if (isFinite(b) && !(x < b)) return;
        for (var i = 0; i < seeds.length; i++) {
          if (seeds[i].hint === hint && Math.abs(seeds[i].x - x) <= 1e-12 * Math.max(1, Math.abs(x))) return;
        }
        if (seeds.length < 24) seeds.push({ x: x, hint: hint });
      }
      function addPolyRoots(p, offset, hint) {
        if (!p) return;
        var c0 = p.c0 + offset, c1 = p.c1, c2 = p.c2;
        if (c2 === 0) {
          if (c1 !== 0) addSeed(-c0 / c1, hint);
          return;
        }
        var disc = c1 * c1 - 4 * c2 * c0;
        if (disc >= 0) {
          var sd = Math.sqrt(disc);
          addSeed((-c1 - sd) / (2 * c2), hint);
          addSeed((-c1 + sd) / (2 * c2), hint);
        }
      }

      var ZERO_FNS = { ln: 1, log: 1, log10: 1, log2: 1, abs: 1, sign: 1, floor: 1, ceil: 1, sqrt: 1, cbrt: 1 };
      var UNIT_FNS = { asin: 1, acos: 1, atanh: 1 };
      function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (node.k === 'fn' && node.args && node.args.length >= 1) {
          var p0 = poly2(node.args[0]);
          if (p0) {
            if (ZERO_FNS[node.name]) addPolyRoots(p0, 0, 'sing_or_kink');
            if (UNIT_FNS[node.name]) { addPolyRoots(p0, -1, 'sing_or_kink'); addPolyRoots(p0, 1, 'sing_or_kink'); }
            if (node.name === 'exp' && p0.c2 !== 0) addSeed(-p0.c1 / (2 * p0.c2), 'peak');
          }
          for (var ai = 0; ai < node.args.length; ai++) walk(node.args[ai]);
          return;
        }
        if (node.k === 'bin') {
          if (node.op === '/') {
            var pr = poly2(node.r);
            if (pr) {
              addPolyRoots(pr, 0, 'sing_or_kink');
              if (pr.c2 !== 0) addSeed(-pr.c1 / (2 * pr.c2), 'peak');
            }
          } else if (node.op === '^') {
            var ex = poly2(node.r), baseP = poly2(node.l);
            if (baseP && ex && ex.c1 === 0 && ex.c2 === 0 && Math.abs(ex.c0 - Math.round(ex.c0)) > 1e-12) {
              addPolyRoots(baseP, 0, 'sing_or_kink');
            }
          }
          walk(node.l); walk(node.r);
          return;
        }
        if (node.k === 'un') walk(node.a);
      }
      walk(ast);
      return seeds;
    } catch (e) {
      return [];
    }
  }

  function scanInterior(f, tr, isFiniteInterval, hasKinkFuncs, onlySqrtKink) {
    var g = tr.g, lo = tr.lo, hi = tr.hi, W = hi - lo;
    if (!(W > 0)) return { divergent: false, splits: [] };

    /* 构造内部采样网格（含常见分点以直接踩中 1/x 或 1/(3x-1) 一类极点） */
    var grid = [], N = 2048;
    for (var k = 1; k < N; k++) grid.push(lo + W * (k / N));
    var extras = [1 / 3, 2 / 3, 1 / 5, 2 / 5, 3 / 5, 4 / 5];
    for (var ei = 0; ei < extras.length; ei++) {
      var te = lo + W * extras[ei];
      if (te > lo + 1e-12 * W && te < hi - 1e-12 * W) grid.push(te);
    }
    grid.sort(function (x, y) { return x - y; });
    var ts = [], vs = [], mags = [], badTotal = 0;
    for (var i = 0; i < grid.length; i++) {
      if (ts.length && grid[i] - ts[ts.length - 1] <= 1e-13 * W) continue;
      var val = safeEval(g, grid[i]);
      ts.push(grid[i]);
      vs.push(val);
      if (isFinite(val)) mags.push(Math.abs(val));
      else badTotal++;
    }
    if (badTotal > 20) {
      /* 大片无定义域不是孤立奇点 */
      return { divergent: false, splits: [], domainGap: true };
    }

    mags.sort(function (a, b) { return a - b; });
    var med = mags.length ? mags[Math.floor(mags.length * 0.5)] : 0;
    var p75 = mags.length ? mags[Math.floor(mags.length * 0.75)] : 0;
    var refMag = Math.max(med, p75 * 0.25, 1e-300);

    var cands = [], peakCands = [];
    for (var j = 1; j < ts.length - 1; j++) {
      var v = vs[j], vL = vs[j - 1], vR = vs[j + 1];
      if (!isFinite(v)) {
        if (isFinite(vL) && isFinite(vR)) {
          cands.push({ tL: ts[j - 1], tR: ts[j + 1], flip: (vL * vR < 0), exact: ts[j] });
        }
        continue;
      }
      var av = Math.abs(v);
      var avL = isFinite(vL) ? Math.abs(vL) : Infinity;
      var avR = isFinite(vR) ? Math.abs(vR) : Infinity;
      /* 放宽局域峰值门槛（av > 12*refMag 且 > 1.25*min(avL,avR)），确保 1/√|x²-2| 一类弱无理奇点被捕获 */
      if (av > 12 * refMag && av > 1.25 * Math.min(avL, avR) && av >= avL && av >= avR) {
        peakCands.push({ tL: ts[j - 1], tR: ts[j + 1], flip: false, peakMag: av });
      } else if (isFinite(vR) && v * vR < 0 && Math.min(av, avR) > 30 * refMag) {
        cands.push({ tL: ts[j], tR: ts[j + 1], flip: true });
      }
    }
    if (peakCands.length > 16) {
      peakCands.sort(function (a, b) { return b.peakMag - a.peakMag; });
      peakCands = peakCands.slice(0, 16);
    }
    cands = cands.concat(peakCands);

    var splits = [];
    var seenT = [];
    var refMagF = null;
    function getRefMagF() {
      if (refMagF !== null) return refMagF;
      var fMags = [];
      var fStep = Math.max(1, Math.floor(ts.length / 64));
      for (var fi = 0; fi < ts.length; fi += fStep) {
        var fv = safeEval(f, tr.toX(ts[fi]));
        if (isFinite(fv)) fMags.push(Math.abs(fv));
      }
      fMags.sort(function (a, b) { return a - b; });
      var fMed = fMags.length ? fMags[Math.floor(fMags.length * 0.5)] : 0;
      var fP75 = fMags.length ? fMags[Math.floor(fMags.length * 0.75)] : 0;
      refMagF = Math.max(fMed, fP75 * 0.25, 1e-300);
      return refMagF;
    }

    for (var ci = 0; ci < cands.length; ci++) {
      var cd = cands[ci];
      var tStar = cd.exact !== undefined && !cd.flip
        ? cd.exact
        : refinePoleOrPeak(g, cd.tL, cd.tR, cd.flip);
      if (tStar === null || !(tStar > lo + 1e-12 * W && tStar < hi - 1e-12 * W)) continue;
      var dup = false;
      for (var si = 0; si < seenT.length; si++) {
        if (Math.abs(tStar - seenT[si]) < 1e-5 * W) { dup = true; break; }
      }
      if (dup) continue;
      seenT.push(tStar);

      var spanSide = Math.min(0.1 * W, Math.max(tStar - lo, 0) * 0.5, Math.max(hi - tStar, 0) * 0.5);
      if (!isFiniteInterval && cd.tR > cd.tL) {
        spanSide = Math.min(spanSide, Math.max(6 * (cd.tR - cd.tL), 1e-4 * W));
      }
      if (spanSide <= 1e-11 * W) continue;
      var leftA = analyzeEndpoint(g, tStar - spanSide, tStar, 'hi', true);
      var rightA = analyzeEndpoint(g, tStar, tStar + spanSide, 'lo', true);
      var xStar = tr.toX(tStar);
      if (leftA.divergent || rightA.divergent) {
        return { divergent: true, atX: xStar, atT: tStar, splits: [] };
      }
      var vStar = safeEval(g, tStar);
      var hasLeftSing = leftA.integrableSingularity && leftA.slope < -0.04;
      var hasRightSing = rightA.integrableSingularity && rightA.slope < -0.04;
      if (!isFinite(vStar) || hasLeftSing || hasRightSing) {
        splits.push({ t: tStar, x: xStar, kind: 'singularity' });
      } else if (isFinite(vStar) && Math.abs(vStar) > 1000 * refMag) {
        var allowPeak = isFiniteInterval;
        if (!allowPeak) {
          /* 无穷区间仅当原函数 |f(x*)| 本身也远超原空间参考量级时才判为孤立远端峰（如 exp(-(x-50)²)） */
          var fStar = safeEval(f, xStar);
          allowPeak = isFinite(fStar) && Math.abs(fStar) > 1000 * getRefMagF();
        }
        if (allowPeak) splits.push({ t: tStar, x: xStar, kind: 'peak' });
      }
    }

    /* AST 解析直达特征点：捕获偏置对数奇点（如 10+ln|x-0.37|）与远端亚网格孤立峰（如 exp(-(x-1000)²)） */
    if (f && f.src) {
      var xA = tr.toX(lo), xB = tr.toX(hi);
      var astSeeds = extractAstSeeds(f.src, xA, xB);
      for (var asi = 0; asi < astSeeds.length; asi++) {
        var sd = astSeeds[asi];
        var tSd = tr.fromX ? tr.fromX(sd.x) : NaN;
        if (!(tSd > lo + 1e-12 * W && tSd < hi - 1e-12 * W)) continue;
        if (sd.hint === 'sing_or_kink') {
          var dupAst = false;
          for (var sj0 = 0; sj0 < seenT.length; sj0++) {
            if (Math.abs(tSd - seenT[sj0]) < 1e-6 * W) { dupAst = true; break; }
          }
          if (dupAst) continue;
          var spS = Math.min(0.1 * W, Math.max(tSd - lo, 0) * 0.5, Math.max(hi - tSd, 0) * 0.5);
          if (spS <= 1e-12 * W) continue;
          var lAst = analyzeEndpoint(g, tSd - spS, tSd, 'hi', true);
          var rAst = analyzeEndpoint(g, tSd, tSd + spS, 'lo', true);
          if (lAst.divergent || rAst.divergent) {
            return { divergent: true, atX: sd.x, atT: tSd, splits: [] };
          }
          var fxSd = safeEval(f, sd.x);
          if (!isFinite(fxSd) || (lAst.integrableSingularity && lAst.slope < -0.02) || (rAst.integrableSingularity && rAst.slope < -0.02)) {
            seenT.push(tSd);
            splits.push({ t: tSd, x: sd.x, kind: 'singularity', exactX: true });
          } else {
            var hAst = Math.min(1e-5 * Math.max(1, Math.abs(sd.x)), Math.abs(sd.x - xA) * 0.1, Math.abs(xB - sd.x) * 0.1);
            if (hAst > 0) {
              var fm1 = safeEval(f, sd.x - hAst), fp1 = safeEval(f, sd.x + hAst);
              var fm2 = safeEval(f, sd.x - 2 * hAst), fp2 = safeEval(f, sd.x + 2 * hAst);
              if (isFinite(fm1) && isFinite(fp1) && isFinite(fm2) && isFinite(fp2)) {
                var jmpV = Math.abs(fp1 - fm1), diffV = Math.abs((fp2 - fp1) - (fm1 - fm2));
                var jumpK = Math.abs(fp1 - 2 * fxSd + fm1), smoothK = Math.max(Math.abs(fp2 - 2 * fp1 + fxSd), Math.abs(fxSd - 2 * fm1 + fm2), 1e-12 * Math.max(1, Math.abs(fxSd)));
                if (jmpV > 12 * Math.max(diffV, 1e-12 * Math.max(1, Math.abs(fxSd)))) {
                  seenT.push(tSd);
                  splits.push({ t: tSd, x: sd.x, kind: 'jump', exactX: true });
                } else if (jumpK > 20 * smoothK && jumpK > 1e-11 * Math.max(1, Math.abs(fxSd))) {
                  seenT.push(tSd);
                  splits.push({ t: tSd, x: sd.x, kind: 'kink', exactX: true });
                }
              }
            }
          }
        } else if (sd.hint === 'peak') {
          var fPeak = safeEval(f, sd.x);
          if (!isFinite(fPeak) || !(Math.abs(fPeak) > 0)) continue;
          var hw = 0.5;
          for (var ws1 = 0; ws1 < 22; ws1++) {
            var fwA = Math.max(Math.abs(safeEval(f, sd.x - hw) || 0), Math.abs(safeEval(f, sd.x + hw) || 0));
            if (fwA >= 0.05 * Math.abs(fPeak)) break;
            hw *= 0.5;
          }
          for (var ws2 = 0; ws2 < 14; ws2++) {
            var fwB = Math.min(Math.abs(safeEval(f, sd.x - hw) || 0), Math.abs(safeEval(f, sd.x + hw) || 0));
            if (fwB <= 0.5 * Math.abs(fPeak)) break;
            hw *= 2;
          }
          var wing16 = Math.max(
            (sd.x - 16 * hw > xA) ? Math.abs(safeEval(f, sd.x - 16 * hw) || 0) : 0,
            (sd.x + 16 * hw < xB) ? Math.abs(safeEval(f, sd.x + 16 * hw) || 0) : 0
          );
          if (wing16 < 0.05 * Math.abs(fPeak) && (hw < 0.05 * Math.max(1, Math.abs(sd.x)) || Math.abs(fPeak) > 100 * getRefMagF())) {
            var candPk = [sd.x];
            if (wing16 < 1e-6 * Math.abs(fPeak)) {
              candPk.push(sd.x - 16 * hw, sd.x + 16 * hw);
            }
            for (var pki = 0; pki < candPk.length; pki++) {
              var xPk = candPk[pki];
              var tPk = tr.fromX ? tr.fromX(xPk) : NaN;
              if (!(tPk > lo + 1e-12 * W && tPk < hi - 1e-12 * W)) continue;
              var dupPk = false;
              for (var sji = 0; sji < seenT.length; sji++) {
                if (Math.abs(tPk - seenT[sji]) < 1e-10 * W) { dupPk = true; break; }
              }
              if (!dupPk) {
                seenT.push(tPk);
                splits.push({ t: tPk, x: xPk, kind: 'peak', exactX: true });
              }
            }
          }
        }
      }
    }

    /* 有限区间折点与阶跃检测（含 abs/floor/ceil/round/min/max/sign/sqrt） */
    if (isFiniteInterval && hasKinkFuncs && badTotal === 0) {
      var peak = mags.length ? mags[mags.length - 1] : 1;
      var kinks = [];
      for (var m = 2; m < ts.length - 2; m++) {
        /* 1. 阶跃跳变检测（floor / ceil / round / sign） */
        var dv0 = Math.abs(vs[m] - vs[m - 1]);
        var dv1 = Math.abs(vs[m + 1] - vs[m]);
        var dv2 = Math.abs(vs[m + 2] - vs[m + 1]);
        var localStep = Math.max(dv0, dv2, 1e-10 * Math.max(peak, 1));
        if (!onlySqrtKink && dv1 > 15 * localStep && dv1 > 1e-6 * Math.max(peak, 1)) {
          var tj = refineJump(g, ts[m], ts[m + 1]);
          var dupJ = false;
          for (var ji = 0; ji < kinks.length; ji++) {
            if (Math.abs(tj - kinks[ji].t) < 1e-5 * W) { dupJ = true; break; }
          }
          for (var sj = 0; sj < splits.length; sj++) {
            if (Math.abs(tj - splits[sj].t) < 1e-5 * W) { dupJ = true; break; }
          }
          if (!dupJ) kinks.push({ t: tj, x: tr.toX(tj), kind: 'jump' });
          if (kinks.length > 48) { kinks = []; break; }
          continue;
        }

        /* 2. 导数折点检测（同时检查单点折点与跨网格中点折点，避免折点落于网格中点漏检） */
        var d0 = (vs[m - 1] - vs[m - 2]) / (ts[m - 1] - ts[m - 2]);
        var d1 = (vs[m] - vs[m - 1]) / (ts[m] - ts[m - 1]);
        var d2 = (vs[m + 1] - vs[m]) / (ts[m + 1] - ts[m]);
        var d3 = (vs[m + 2] - vs[m + 1]) / (ts[m + 2] - ts[m + 1]);
        if (!isFinite(d0) || !isFinite(d1) || !isFinite(d2) || !isFinite(d3)) continue;
        var jump1 = Math.abs(d2 - d1);
        var curv1 = Math.max(Math.abs(d1 - d0), Math.abs(d3 - d2), 1e-8 * Math.max(peak, 1));
        var isKink1 = jump1 > 22 * curv1 && jump1 > 1e-6 * Math.max(peak, 1);
        var isKink2 = false, jumpUse = jump1, kLeft = ts[m - 1], kRight = ts[m + 1];
        if (!isKink1 && m + 3 < ts.length) {
          var d4 = (vs[m + 3] - vs[m + 2]) / (ts[m + 3] - ts[m + 2]);
          if (isFinite(d4)) {
            var jump2 = Math.abs(d3 - d1);
            var curv2 = Math.max(Math.abs(d1 - d0), Math.abs(d4 - d3), 1e-8 * Math.max(peak, 1));
            if (jump2 > 18 * curv2 && jump2 > 1e-6 * Math.max(peak, 1)) {
              isKink2 = true;
              jumpUse = jump2;
              kLeft = ts[m - 1];
              kRight = ts[m + 2];
            }
          }
        }
        if (isKink1 || isKink2) {
          var tk = refineKink(g, kLeft, kRight);
          if (onlySqrtKink) {
            /* 校验真折点：在 h=1e-6 尺度上左右导数仍存在显著跳变，过滤光滑 sqrt(x+1) */
            var hh = Math.min(1e-6 * W, (tk - lo) * 0.25, (hi - tk) * 0.25);
            if (!(hh > 0)) continue;
            var vm = safeEval(g, tk), vml = safeEval(g, tk - hh), vmr = safeEval(g, tk + hh);
            if (!isFinite(vm) || !isFinite(vml) || !isFinite(vmr)) continue;
            var sLeft = (vm - vml) / hh, sRight = (vmr - vm) / hh;
            if (Math.abs(sRight - sLeft) < 0.25 * jumpUse) continue;
          }
          var dupK = false;
          for (var ki = 0; ki < kinks.length; ki++) {
            if (Math.abs(tk - kinks[ki].t) < 1e-5 * W) { dupK = true; break; }
          }
          for (var si2 = 0; si2 < splits.length; si2++) {
            if (Math.abs(tk - splits[si2].t) < 1e-5 * W) { dupK = true; break; }
          }
          if (!dupK) kinks.push({ t: tk, x: tr.toX(tk), kind: 'kink' });
          if (kinks.length > 48) { kinks = []; break; }
        }
      }
      splits = splits.concat(kinks);
    }

    if (splits.length > 48) return { divergent: false, splits: [] };
    splits.sort(function (a, b) { return a.x - b.x; });
    return { divergent: false, splits: splits };
  }

  /* 供符号层复用：检测区间内部是否存在发散奇点（如 ∫_{-1}^1 1/x³） */
  function hasInteriorDivergence(f, aRaw, bRaw) {
    var a = typeof aRaw === 'number' ? aRaw : parseBound(aRaw);
    var b = typeof bRaw === 'number' ? bRaw : parseBound(bRaw);
    if (!(b > a)) return false;
    var tr = transform(f, a, b);
    var d = diagnose(tr.g, tr.lo, tr.hi, isFinite(a), isFinite(b));
    if (d.verdict === 'divergent') return true;
    var trim = trimOverflowTail(tr.g, tr.lo, tr.hi, d.maxSeen, d.endLo.benignOverflow, d.endHi.benignOverflow);
    if (trim) { tr.lo = trim.lo; tr.hi = trim.hi; }
    var res = scanInterior(f, tr, isFinite(a) && isFinite(b), false);
    return !!res.divergent;
  }

  /* ---------- 端点拉伸（两端奇点在缓斜率时用 sin²，高阶用对称幂次拼接） ---------- */
  function stretchEnds(g, lo, hi, mLo, mHi, aReal, bReal) {
    var W = hi - lo;
    var minOffLo = lo === 0 ? 1e-300 : 4 * Number.EPSILON * Math.abs(lo);
    var minOffHi = hi === 0 ? 1e-300 : 4 * Number.EPSILON * Math.abs(hi);
    if (isFinite(aReal) && aReal !== 0 && isFinite(bReal)) {
      minOffLo = Math.max(minOffLo, 4 * Number.EPSILON * Math.abs(aReal) / Math.max(Math.abs(bReal - aReal), 1e-300));
    }
    if (isFinite(bReal) && bReal !== 0 && isFinite(aReal)) {
      minOffHi = Math.max(minOffHi, 4 * Number.EPSILON * Math.abs(bReal) / Math.max(Math.abs(bReal - aReal), 1e-300));
    }
    if (mLo > 1 && mHi > 1) {
      if (mLo <= 2 && mHi <= 2) {
        return function (s) {
          var u = s <= 0.5 ? s : 1 - s;
          var sn = Math.sin(Math.PI * u / 2);
          var off = W * sn * sn;
          var need = s <= 0.5 ? minOffLo : minOffHi;
          if (off < need) { off = need; u = Math.asin(Math.sqrt(off / W)) * 2 / Math.PI; }
          var t = s <= 0.5 ? lo + off : hi - off;
          return safeEval(g, t) * W * Math.PI / 2 * Math.sin(Math.PI * u);
        };
      }
      var halfW = W / 2;
      return function (s) {
        if (s <= 0.5) {
          var u = Math.max(2 * s, 1e-13);
          var off = halfW * Math.pow(u, mLo);
          if (off < minOffLo) { off = minOffLo; u = Math.pow(off / halfW, 1 / mLo); }
          return safeEval(g, lo + off) * W * mLo * Math.pow(u, mLo - 1);
        }
        var uR = Math.max(2 * (1 - s), 1e-13);
        var offR = halfW * Math.pow(uR, mHi);
        if (offR < minOffHi) { offR = minOffHi; uR = Math.pow(offR / halfW, 1 / mHi); }
        return safeEval(g, hi - offR) * W * mHi * Math.pow(uR, mHi - 1);
      };
    }
    if (mLo > 1) {
      return function (s) {
        var u = s < 1e-13 ? 1e-13 : s;
        var off = W * Math.pow(u, mLo);
        if (off < minOffLo) { off = minOffLo; u = Math.pow(off / W, 1 / mLo); }
        return safeEval(g, lo + off) * W * mLo * Math.pow(u, mLo - 1);
      };
    }
    return function (s) {
      var u = 1 - s < 1e-13 ? 1e-13 : 1 - s;
      var off = W * Math.pow(u, mHi);
      if (off < minOffHi) { off = minOffHi; u = Math.pow(off / W, 1 / mHi); }
      return safeEval(g, hi - off) * W * mHi * Math.pow(u, mHi - 1);
    };
  }

  /* ---------- QUADPACK dqelg 风格对角 Wynn-ε ---------- */
  function wynnEpsDiag(s) {
    var n = s.length;
    if (n < 4) return { value: s[n - 1], err: Infinity };
    var prev2 = new Array(n), prev1 = s.slice();
    for (var i = 0; i < n; i++) prev2[i] = 0;
    var evenLast = [s[n - 1]];
    var evenHoriz = [Infinity];
    for (var k = 0; k < n - 1; k++) {
      var len = n - 1 - k, cur = new Array(len), anyFin = false;
      for (var j = 0; j < len; j++) {
        var d = prev1[j + 1] - prev1[j];
        if (!isFinite(d) || Math.abs(d) < 1e-290) {
          cur[j] = NaN;
        } else {
          cur[j] = prev2[j + 1] + 1 / d;
          if (isFinite(cur[j])) anyFin = true;
        }
      }
      prev2 = prev1; prev1 = cur;
      if (!anyFin) break;
      if ((k + 1) % 2 === 0 && isFinite(cur[len - 1])) {
        evenLast.push(cur[len - 1]);
        var hErr = (len >= 2 && isFinite(cur[len - 2]))
          ? Math.abs(cur[len - 1] - cur[len - 2]) : Infinity;
        evenHoriz.push(hErr);
      }
    }
    if (evenLast.length < 2) return { value: s[n - 1], err: Infinity };
    var bestVal = evenLast[evenLast.length - 1];
    var bestDiff = Math.min(
      Math.abs(evenLast[evenLast.length - 1] - evenLast[evenLast.length - 2]),
      evenHoriz[evenLast.length - 1]
    );
    for (var m = 1; m < evenLast.length; m++) {
      var df = Math.min(Math.abs(evenLast[m] - evenLast[m - 1]), evenHoriz[m]);
      if (df <= bestDiff) { bestDiff = df; bestVal = evenLast[m]; }
    }
    return { value: bestVal, err: bestDiff };
  }

  function wynnEps(s) {
    return wynnEpsDiag(s).value;
  }

  function isRaySingDivergent(gRay, zR, leftLim, rightLim) {
    var sp = Math.min(0.25, Math.max(zR - leftLim, 0) * 0.45, Math.max(rightLim - zR, 0) * 0.45);
    if (!(sp > 1e-10)) return false;
    var lA = analyzeEndpoint(gRay, zR - sp, zR, 'hi', true);
    var rA = analyzeEndpoint(gRay, zR, zR + sp, 'lo', true);
    return !!(lA.divergent || rA.divergent);
  }

  /* ---------- 通用双精度振荡积分（支持 [a, ∞) 与 (−∞, b]；含周期内部可积奇点探测与发散极点守卫） ---------- */
  function oscillatory(f, a, b, opt) {
    var dir, anchor;
    if (isFinite(a) && b === Infinity) { dir = 1; anchor = a; }
    else if (a === -Infinity && isFinite(b)) { dir = -1; anchor = b; }
    else return null;

    var gRay = dir === 1 ? function (r) { return f(anchor + r); } : function (r) { return f(anchor - r); };
    var maxPanels = (opt && opt.maxPanels) || 160;
    var evals = 0;

    var r = 0, fr = safeEval(gRay, 0); evals++;
    if (!isFinite(fr)) {
      var probes = [1e-9, 1e-6, 1e-4];
      for (var pi = 0; pi < probes.length; pi++) {
        fr = safeEval(gRay, probes[pi]); evals++;
        if (isFinite(fr)) { r = probes[pi]; break; }
      }
      if (!isFinite(fr)) return null;
    }

    var rZeros = [], singHints = [], h = 0.02, guard = 0, hitInfinity = false, stepsSinceZero = 0;
    while (guard++ < 400000 && rZeros.length < maxPanels) {
      if (r > 1e9) break;
      var r1 = r + h, f1 = safeEval(gRay, r1); evals++;
      if (!isFinite(f1)) {
        if (r1 > 1e6) { hitInfinity = true; break; }
        /* 尝试跳过孤立可积/发散奇点，避免在 π/2+kπ 一类奇点处因连续踩到 ∞ 而卡死 */
        var rJump = r1 + Math.max(h * 0.37, 1e-4);
        var fJump = safeEval(gRay, rJump); evals++;
        if (!isFinite(fJump)) {
          rJump = r1 + Math.max(h * 0.83, 1e-3);
          fJump = safeEval(gRay, rJump); evals++;
        }
        if (isFinite(fJump)) {
          if (singHints.length < 64) singHints.push(r1);
          if (fr * fJump < 0) {
            var lp = r, rp = rJump, flp = fr;
            for (var itp = 0; itp < 50; itp++) {
              var mp = (lp + rp) / 2, fmp = safeEval(gRay, mp); evals++;
              if (!isFinite(fmp)) { lp = rp = mp; break; }
              if (flp * fmp <= 0) rp = mp; else { lp = mp; flp = fmp; }
              if (rp - lp <= 1e-13 * (1 + Math.abs(lp))) break;
            }
            var zP = (lp + rp) / 2;
            var epsP = Math.max(1e-7 * (1 + Math.abs(zP)), (rp - lp) * 2);
            var fPL = safeEval(gRay, zP - epsP), fPR = safeEval(gRay, zP + epsP); evals += 2;
            if (!isFinite(fPL) || !isFinite(fPR) ||
                Math.min(Math.abs(fPL), Math.abs(fPR)) > 15 * Math.max(Math.abs(fr), Math.abs(fJump), 1e-12)) {
              if (isRaySingDivergent(gRay, zP, Math.max(0, r - h), rJump + h)) {
                return { divergent: true, atX: anchor + dir * zP, evals: evals };
              }
            } else {
              rZeros.push(zP);
            }
          }
          r = rJump; fr = fJump; stepsSinceZero++;
          continue;
        }
        h /= 2;
        if (h < 1e-12) break;
        continue;
      }

      /* 恰好踩到 f1 === 0：向前跨微步防止 fr 归零卡死 */
      if (f1 === 0) {
        var rNext = r1 + Math.max(h * 0.13, 1e-9);
        var fNext = safeEval(gRay, rNext); evals++;
        if (isFinite(fNext) && fr * fNext < 0) {
          rZeros.push(r1);
          if (rZeros.length >= 2) h = Math.max((r1 - rZeros[rZeros.length - 2]) * 0.22, 1e-9);
          r = rNext; fr = fNext; stepsSinceZero = 0;
          continue;
        }
        r = rNext; fr = fNext; stepsSinceZero++;
        continue;
      }

      if (fr * f1 < 0) {
        var lo = r, hi2 = r1, flo = fr;
        for (var it = 0; it < 75; it++) {
          var mid = (lo + hi2) / 2, fm = safeEval(gRay, mid); evals++;
          if (!isFinite(fm)) break;
          if (flo * fm <= 0) hi2 = mid; else { lo = mid; flo = fm; }
          if (hi2 - lo <= 1e-14 * (1 + Math.abs(lo))) break;
        }
        var z = (lo + hi2) / 2;
        var epsZ = Math.max(1e-7 * (1 + Math.abs(z)), (hi2 - lo) * 2);
        var fzL = safeEval(gRay, z - epsZ), fzR = safeEval(gRay, z + epsZ); evals += 2;
        if (!isFinite(fzL) || !isFinite(fzR) ||
            Math.min(Math.abs(fzL), Math.abs(fzR)) > 15 * Math.max(Math.abs(fr), Math.abs(f1), 1e-12)) {
          /* 实为变号极点（如 tan(x)/x 在 π/2 处），非真正过零点 */
          if (isRaySingDivergent(gRay, z, Math.max(0, r - h), r1 + h)) {
            return { divergent: true, atX: anchor + dir * z, evals: evals };
          }
          if (singHints.length < 64) singHints.push(z);
          r = r1; fr = f1; stepsSinceZero++;
          continue;
        }
        rZeros.push(z);
        if (rZeros.length >= 2) {
          h = Math.max((z - rZeros[rZeros.length - 2]) * 0.22, 1e-9);
        } else {
          h = Math.max(z * 0.22, 1e-9);
        }
        r = z + Math.min(h * 0.25, 1e-7);
        fr = safeEval(gRay, r); evals++;
        if (!isFinite(fr)) { r = z + Math.max(h * 0.1, 1e-6); fr = safeEval(gRay, r); evals++; }
        stepsSinceZero = 0;
        continue;
      }

      r = r1; fr = f1; stepsSinceZero++;
      if (rZeros.length === 0 && stepsSinceZero >= 15) {
        h = Math.min(h * 1.25, 0.5 + 0.02 * r);
        stepsSinceZero = 0;
      }
    }
    if (rZeros.length < 10) return null;

    function scanPanelSings(u, v) {
      var trP = transform(gRay, u, v);
      var scP = scanInterior(gRay, trP, true, false, false);
      if (scP.divergent) return { divergent: true, atR: scP.atX, sings: [] };
      var sings = [];
      for (var si = 0; si < scP.splits.length; si++) {
        if (scP.splits[si].kind === 'singularity' && scP.splits[si].x > u && scP.splits[si].x < v) {
          sings.push(scP.splits[si].x);
        }
      }
      sings.sort(function (x, y) { return x - y; });
      return { divergent: false, sings: sings };
    }

    function integratePanelWithSplits(u, v, sings, tol) {
      var pts = [u];
      for (var si = 0; si < sings.length; si++) {
        if (sings[si] > pts[pts.length - 1] + 1e-12 * Math.max(1, v - u) && sings[si] < v - 1e-12 * Math.max(1, v - u)) {
          pts.push(sings[si]);
        }
      }
      pts.push(v);
      var sumV = 0, subEvals = 0;
      for (var pi = 0; pi + 1 < pts.length; pi++) {
        var pA = pts[pi], pB = pts[pi + 1];
        var isSingLo = pi > 0, isSingHi = (pi + 1 < pts.length - 1);
        var trS = transform(gRay, pA, pB);
        var gS = patchEnds(trS.g, 0, 1);
        var eL = analyzeEndpoint(gS, 0, 1, 'lo', true);
        var eR = analyzeEndpoint(gS, 0, 1, 'hi', true);
        if (eL.divergent || eR.divergent) {
          return { divergent: true, atR: eL.divergent ? pA : pB, evals: subEvals };
        }
        var mLo = 1, mHi = 1;
        if (isSingLo || eL.integrableSingularity) {
          mLo = Math.min(12, Math.max(2, Math.ceil(1 / Math.max(0.05, 1 + Math.min(eL.slope, -0.05)))));
        }
        if (isSingHi || eR.integrableSingularity) {
          mHi = Math.min(12, Math.max(2, Math.ceil(1 / Math.max(0.05, 1 + Math.min(eR.slope, -0.05)))));
        }
        if (mLo > 1 || mHi > 1) {
          gS = stretchEnds(gS, 0, 1, mLo, mHi, pA, pB);
          var glLo = compositeGL16(gS, 0, 1, 6);
          var glHi = compositeGL16(gS, 0, 1, 12);
          subEvals += glLo.evals + glHi.evals;
          if (!glHi.bad && isFinite(glHi.value)) {
            sumV += glHi.value;
            continue;
          }
        }
        var resS = integrateOnce(gS, 0, 1, tol, 8, 16, 40000);
        subEvals += resS.evals;
        if (resS.bad || !isFinite(resS.value)) return { value: NaN, evals: subEvals };
        sumV += resS.value;
      }
      return { value: sumV, evals: subEvals };
    }

    var initScan = rZeros[0] > 0 ? scanPanelSings(0, rZeros[0]) : { divergent: false, sings: [] };
    if (initScan.divergent) return { divergent: true, atX: anchor + dir * initScan.atR, evals: evals };
    var p0Scan = scanPanelSings(rZeros[0], rZeros[1]);
    if (p0Scan.divergent) return { divergent: true, atX: anchor + dir * p0Scan.atR, evals: evals };
    var p1Scan = rZeros.length >= 3 ? scanPanelSings(rZeros[1], rZeros[2]) : { divergent: false, sings: [] };
    if (p1Scan.divergent) return { divergent: true, atX: anchor + dir * p1Scan.atR, evals: evals };

    var hasPanelSings = (initScan.sings.length > 0 || p0Scan.sings.length > 0 || p1Scan.sings.length > 0 || singHints.length > 0);
    var initSeg = 0, panels = [], sums = [], acc = 0, panelSingsList = null;

    if (hasPanelSings) {
      if (rZeros[0] > 0) {
        var rInitSp = integratePanelWithSplits(0, rZeros[0], initScan.sings, 1e-11);
        evals += rInitSp.evals;
        if (rInitSp.divergent) return { divergent: true, atX: anchor + dir * rInitSp.atR, evals: evals };
        if (!isFinite(rInitSp.value)) return null;
        initSeg = rInitSp.value;
      }
      var fracsEven = p0Scan.sings.map(function (s) { return (s - rZeros[0]) / (rZeros[1] - rZeros[0]); });
      var fracsOdd = (rZeros.length >= 3 ? p1Scan.sings.map(function (s) { return (s - rZeros[1]) / (rZeros[2] - rZeros[1]); }) : fracsEven);
      panelSingsList = [];
      var nPanS = Math.min(rZeros.length - 1, 64);
      for (var iS = 0; iS < nPanS; iS++) {
        var aP = rZeros[iS], bP = rZeros[iS + 1], span2 = bP - aP;
        var sList;
        if (iS === 0) sList = p0Scan.sings.slice();
        else if (iS === 1) sList = p1Scan.sings.slice();
        else {
          var fracs = (iS % 2 === 0) ? fracsEven : fracsOdd;
          sList = [];
          for (var fi2 = 0; fi2 < fracs.length; fi2++) {
            var sPred = aP + fracs[fi2] * span2;
            var loPred = Math.max(aP + 1e-9 * span2, sPred - 0.08 * span2);
            var hiPred = Math.min(bP - 1e-9 * span2, sPred + 0.08 * span2);
            if (!(hiPred > loPred)) continue;
            var sRef = refinePoleOrPeak(gRay, loPred, hiPred, false);
            if (sRef !== null && sRef > aP + 1e-9 * span2 && sRef < bP - 1e-9 * span2) {
              var vRef = safeEval(gRay, sRef);
              var vRefL = safeEval(gRay, Math.max(aP + 1e-9 * span2, sRef - 0.03 * span2));
              var vRefR = safeEval(gRay, Math.min(bP - 1e-9 * span2, sRef + 0.03 * span2));
              if (!isFinite(vRef) || (isFinite(vRefL) && isFinite(vRefR) && Math.abs(vRef) > 4 * Math.max(Math.abs(vRefL), Math.abs(vRefR), 1e-300))) {
                sList.push(sRef);
              }
            }
          }
          if (!sList.length && fracs.length) {
            var scFb = scanPanelSings(aP, bP);
            if (scFb.divergent) return { divergent: true, atX: anchor + dir * scFb.atR, evals: evals };
            sList = scFb.sings;
          }
        }
        panelSingsList.push(sList);
        var resPS = integratePanelWithSplits(aP, bP, sList, 1e-10);
        evals += resPS.evals;
        if (resPS.divergent) return { divergent: true, atX: anchor + dir * resPS.atR, evals: evals };
        if (!isFinite(resPS.value)) break;
        panels.push(resPS.value);
        acc += resPS.value;
        sums.push(acc);
      }
    } else {
      /* 首段 [0, z_0] 用自适应 Simpson（若 0 端有可积奇点自动拉伸） */
      if (rZeros[0] > 0) {
        var trInit = transform(gRay, 0, rZeros[0]);
        var gInit = patchEnds(trInit.g, trInit.lo, trInit.hi);
        var end0 = analyzeEndpoint(gInit, trInit.lo, trInit.hi, 'lo', true);
        if (end0.divergent) return null;
        if (end0.slope < -0.08) {
          var m0 = Math.min(12, Math.max(4, Math.ceil(1 / Math.max(0.05, 1 + end0.slope))));
          gInit = stretchEnds(gInit, trInit.lo, trInit.hi, m0, 1);
        }
        var resInit = integrateOnce(gInit, 0, 1, 1e-12, 16);
        evals += resInit.evals;
        if (resInit.bad || !isFinite(resInit.value)) return null;
        initSeg = resInit.value;
      }

      /* 真正的半周期面板 [z_k, z_{k+1}] 逐片自适应求积（1e-11 容差避免触底双精度舍入噪声） */
      var nPan = Math.min(rZeros.length - 1, 120);
      for (var i2 = 0; i2 < nPan; i2++) {
        var trP = transform(gRay, rZeros[i2], rZeros[i2 + 1]);
        var resP = integrateOnce(trP.g, 0, 1, 1e-11, 4, 14, 20000);
        evals += resP.evals;
        if (!isFinite(resP.value)) break;
        panels.push(resP.value);
        acc += resP.value;
        sums.push(acc);
      }
    }
    if (sums.length < 8) return null;

    /* 幅度衰减判据：尾部最大值需明显低于早段峰值（避免首片贴零点时被误杀） */
    var earlyPeak = 0;
    for (var eIdx = 0; eIdx < Math.min(8, panels.length); eIdx++) {
      earlyPeak = Math.max(earlyPeak, Math.abs(panels[eIdx]));
    }
    var tailPeak = 0;
    for (var tIdx = Math.max(0, panels.length - 4); tIdx < panels.length; tIdx++) {
      tailPeak = Math.max(tailPeak, Math.abs(panels[tIdx]));
    }
    if (!isFinite(earlyPeak) || earlyPeak === 0 || !(tailPeak < 0.85 * earlyPeak)) return null;

    var half = Math.floor(sums.length / 2);
    var fullRes = wynnEpsDiag(sums), partRes = wynnEpsDiag(sums.slice(0, half));
    if (!isFinite(fullRes.value) || !isFinite(partRes.value)) return null;

    var val = initSeg + fullRes.value;
    var gap = Math.max(Math.abs(fullRes.value - partRes.value), isFinite(fullRes.err) ? fullRes.err : 0);
    var scale = Math.max(Math.abs(val), earlyPeak, 1e-300);
    return {
      value: val,
      tail: Math.abs(sums[sums.length - 1] - fullRes.value),
      panels: sums.length,
      evals: evals,
      consistent: gap <= 1e-7 * scale,
      gap: gap,
      hitInfinity: hitInfinity,
      zeros: rZeros.map(function (z) { return anchor + dir * z; }),
      panelSings: hasPanelSings ? { init: initScan.sings, panels: panelSingsList } : null
    };
  }

  /* ---------- 正项周期振荡检测（sin²x/x²、sin²x/x 等） ---------- */
  function detectPositiveOsc(f, a, b) {
    var dir, anchor;
    if (isFinite(a) && b === Infinity) { dir = 1; anchor = a; }
    else if (a === -Infinity && isFinite(b)) { dir = -1; anchor = b; }
    else return null;

    var gRay = dir === 1 ? function (r) { return f(anchor + r); } : function (r) { return f(anchor - r); };
    var dr = 0.04, r = 2 * dr, prev2 = safeEval(gRay, dr), prev1 = safeEval(gRay, 2 * dr);
    if (!isFinite(prev2) || !isFinite(prev1)) return null;
    var maxVal = Math.max(Math.abs(prev2), Math.abs(prev1)), tinyRun = 0;
    var minima = [];
    for (var step = 3; step <= 18000 && minima.length < 36; step++) {
      r += dr;
      var cur = safeEval(gRay, r);
      if (!isFinite(cur)) break;
      if (Math.abs(cur) > maxVal) maxVal = Math.abs(cur);
      if (maxVal > 0 && Math.abs(cur) < 1e-12 * maxVal) {
        if (++tinyRun >= 64) return null;
      } else {
        tinyRun = 0;
      }
      if (prev1 <= prev2 && prev1 <= cur && (prev1 < prev2 || prev1 < cur)) {
        /* 抛物线插值估计极小值位置 */
        var den = prev2 - 2 * prev1 + cur;
        var shift = den > 0 ? 0.5 * (prev2 - cur) / den : 0;
        var rm = r - dr + Math.max(-0.5, Math.min(0.5, shift)) * dr;
        if (!minima.length || rm - minima[minima.length - 1] > dr * 2) {
          minima.push(rm);
          if (minima.length === 4) {
            var estT = (minima[3] - minima[0]) / 3;
            if (estT > 0.4) dr = Math.min(0.2, Math.max(0.02, estT / 32));
          }
        }
      }
      prev2 = prev1; prev1 = cur;
    }
    if (minima.length < 28) return null;

    /* 检验极小值间距是否大致周期性 */
    var gaps = [];
    for (var i = 1; i < minima.length; i++) gaps.push(minima[i] - minima[i - 1]);
    var medGap = gaps.slice().sort(function (x, y) { return x - y; })[Math.floor(gaps.length / 2)];
    if (!(medGap > 0)) return null;
    for (var gi = 0; gi < gaps.length; gi++) {
      if (gaps[gi] < 0.4 * medGap || gaps[gi] > 2.5 * medGap) return null;
    }

    /* 在双精度下逐周期求值，计算尾部振幅衰减斜率 */
    var panels = [];
    for (var m = 0; m + 1 < minima.length; m++) {
      var trP = transform(gRay, minima[m], minima[m + 1]);
      var resP = integrateOnce(trP.g, 0, 1, 1e-10, 4);
      if (!isFinite(resP.value) || resP.value <= 0) return null;
      panels.push(resP.value);
    }
    var half = Math.floor(panels.length / 2), tailPts = [];
    for (var ti = half; ti < panels.length; ti++) {
      tailPts.push({ k: ti + 1, a: panels[ti] });
    }
    var tailSlope = olsSlope(tailPts, function (p) { return Math.log(p.k); }, function (p) { return Math.log(p.a); });
    if (!(tailSlope > -8) || (panels[0] > 0 && panels[panels.length - 1] / panels[0] < 1e-10)) return null;

    /* 指数尺度单周期均值探测 + Cauchy 凝聚检验（精确捕获 sin²x/(x ln x) 一类对数临界正项发散） */
    var isDiv = tailSlope >= -1.05;
    if (!isDiv) {
      var dyadic = [];
      for (var dj = 2; dj <= 18; dj++) {
        var rStart = medGap * (4 + Math.pow(2, dj));
        var perVal = compositeGL16(gRay, rStart, rStart + medGap, 2);
        if (perVal.bad || !isFinite(perVal.value) || !(perVal.value > 0)) break;
        dyadic.push({ j: dj, r: rStart, A: perVal.value, I: Math.pow(2, dj) * perVal.value });
      }
      if (dyadic.length >= 10) {
        var dHalf = dyadic.slice(Math.floor(dyadic.length / 2));
        var pExp = olsSlope(dHalf, function (p) { return Math.log(p.r); }, function (p) { return Math.log(p.A); });
        var qCond = -olsSlope(dHalf, function (p) { return Math.log(p.j); }, function (p) { return Math.log(p.I); });
        if (pExp >= -1.03 || (pExp > -1.16 && qCond <= 1.12)) {
          isDiv = true;
          tailSlope = pExp;
        }
      }
    }

    return {
      divergent: isDiv,
      tailSlope: tailSlope,
      minimaX: minima.map(function (rm) { return anchor + dir * rm; })
    };
  }

  /* ---------- 绝对收敛无穷振荡检测与分段 GL16（如 sin(x)sin(√2·x)/x²） ---------- */
  function probeAbsoluteTailEnvelope(f, a, b) {
    var dir, anchor;
    if (isFinite(a) && b === Infinity) { dir = 1; anchor = a; }
    else if (a === -Infinity && isFinite(b)) { dir = -1; anchor = b; }
    else return null;
    var gRay = dir === 1 ? function (r) { return f(anchor + r); } : function (r) { return f(anchor - r); };
    var shells = [];
    for (var k = 3; k <= 13; k++) {
      var R = Math.pow(2, k), sumAbs = 0;
      for (var j = 0; j < 16; j++) {
        var r = R * (1 + (j + 0.5) / 16);
        var v = safeEval(gRay, r);
        if (!isFinite(v)) return null;
        sumAbs += Math.abs(v);
      }
      var shellAbs = (sumAbs / 16) * R;
      if (!(shellAbs > 0)) {
        if (k >= 8 && shells.length >= 4) return { absConv: true, expZero: true, envIntSlope: -10, cutoffR: R };
        return null;
      }
      shells.push({ R: R, A: shellAbs });
    }
    var tailSh = shells.slice(Math.floor(shells.length / 2));
    var slope = olsSlope(tailSh, function (s) { return Math.log(s.R); }, function (s) { return Math.log(s.A); });
    if (!(slope < -0.35)) return null;
    return { absConv: true, expZero: false, envIntSlope: slope };
  }

  function integrateAbsConvOsc(f, a, b, envInfo) {
    var dir, anchor;
    if (isFinite(a) && b === Infinity) { dir = 1; anchor = a; }
    else if (a === -Infinity && isFinite(b)) { dir = -1; anchor = b; }
    else return null;
    var gRay = dir === 1 ? function (r) { return f(anchor + r); } : function (r) { return f(anchor - r); };

    /* 首壳 [0, 1]：支持端点可积奇点拉伸 */
    var tr0 = transform(gRay, 0, 1);
    var g0 = patchEnds(tr0.g, tr0.lo, tr0.hi);
    var end0 = analyzeEndpoint(g0, tr0.lo, tr0.hi, 'lo', true);
    if (end0.divergent) return null;
    if (end0.slope < -0.08) {
      var m0 = Math.min(12, Math.max(2, Math.ceil(0.98 / Math.max(0.05, 1 + end0.slope))));
      g0 = stretchEnds(g0, tr0.lo, tr0.hi, m0, 1);
    }
    var r0 = integrateOnce(g0, 0, 1, 1e-12, 32, 18, 80000);
    if (!isFinite(r0.value) || r0.bad) return null;

    var val = r0.value, accAbs = r0.absSum, quadErr = r0.err, evals = r0.evals, segs = 32;
    var lastShellAbs = r0.absSum, endedEarly = false, tinyRun = 0;
    var maxEvalsTotal = 240000;
    for (var k = 0; k <= 13; k++) {
      var R1 = Math.pow(2, k), R2 = R1 * 2;
      var sc = 0, lastS = 0;
      for (var s = 0; s < 192; s++) {
        var vs = safeEval(gRay, R1 + (R2 - R1) * (s + 0.5) / 192);
        if (!isFinite(vs)) return null;
        if (vs !== 0) {
          var sg = vs > 0 ? 1 : -1;
          if (lastS !== 0 && sg !== lastS) sc++;
          lastS = sg;
        }
      }
      var panels = Math.max(32, Math.min(4096, Math.max(sc * 3, 48)));
      if (evals + panels * 48 > maxEvalsTotal && k >= 6) break;
      var gLo = compositeGL16(gRay, R1, R2, panels);
      var gHi = compositeGL16(gRay, R1, R2, panels * 2);
      evals += gLo.evals + gHi.evals;
      segs += panels * 2;
      if (gLo.bad || gHi.bad || !isFinite(gHi.value)) return null;
      val += gHi.value;
      accAbs += gHi.absSum;
      quadErr += Math.abs(gHi.value - gLo.value);
      lastShellAbs = gHi.absSum;
      if (gHi.absSum <= 1e-13 * Math.max(accAbs, 1e-300)) {
        if (++tinyRun >= 2) { endedEarly = true; break; }
      } else {
        tinyRun = 0;
      }
    }
    var ratio = Math.pow(2, envInfo.envIntSlope);
    var tailBound = endedEarly ? lastShellAbs * 4 : (2 * lastShellAbs * ratio / Math.max(0.15, 1 - ratio));
    var sigma = Math.max(quadErr * 16, tailBound, 128 * Number.EPSILON * (accAbs + Math.abs(val)));
    if (!isFinite(val) || !isFinite(sigma)) return null;
    return { value: val, sigma: sigma, absSum: accAbs, evals: evals, segments: segs };
  }

  /* ---------- 主积分入口 ---------- */
  function integrate(f, aRaw, bRaw, options) {
    var opt = options || {};
    var depth = opt._depth || 0;
    var reqDigits = Math.max(8, Math.min(40, Number(opt._hpDigits || opt.targetDigits) || 25));
    var reqMaxLevel = opt._hpMaxLevel || (reqDigits <= 12 ? 4 : reqDigits <= 25 ? 6 : 8);
    var reqFastPrec = (typeof opt._hpFastPrec === 'boolean') ? opt._hpFastPrec : (reqDigits <= 18);
    var reqMaxEvals = reqDigits > 25 ? 12000 : 4500;
    var a = typeof aRaw === 'number' ? aRaw : parseBound(aRaw);
    var b = typeof bRaw === 'number' ? bRaw : parseBound(bRaw);
    if (isNaN(a) || isNaN(b)) throw new Error('无法解析积分限');

    /* 零宽度区间 */
    if (a === b) {
      if (!isFinite(a)) throw new Error('上下限不能同为无穷大');
      return {
        value: 0, sigma: 0, digits: 40, valueText: '0', hpDigits: 40, isNearZero: true,
        a: a, b: b, verdict: 'ok', notes: ['上下限相等，积分值为精确 0。'],
        slopes: { lo: 0, hi: 0 }, evals: 0, transformLabel: '零宽度区间', segments: 0,
        method: '零宽度区间（精确 0）', signChanges: 0, errorType: '精确（零宽度）'
      };
    }

    /* 反向积分：交换上下限并对结果取反 */
    if (a > b) {
      var rev = integrate(f, bRaw, aRaw, opt);
      var flippedText = null;
      if (rev.valueText) {
        flippedText = rev.valueText === '0' ? '0'
          : (rev.valueText.charAt(0) === '-' ? rev.valueText.slice(1) : '-' + rev.valueText);
      }
      return {
        value: rev.value === 0 ? 0 : -rev.value,
        sigma: rev.sigma,
        digits: rev.digits,
        valueText: flippedText,
        hpDigits: rev.hpDigits,
        isNearZero: rev.isNearZero,
        a: a, b: b,
        verdict: rev.verdict,
        notes: ['下限 > 上限，已自动交换上下限并对结果取反。'].concat(rev.notes),
        slopes: { lo: rev.slopes ? rev.slopes.hi : 0, hi: rev.slopes ? rev.slopes.lo : 0 },
        evals: rev.evals,
        transformLabel: rev.transformLabel,
        segments: rev.segments,
        method: rev.method,
        signChanges: rev.signChanges,
        errorType: rev.errorType
      };
    }

    var ROOT = typeof window !== 'undefined' ? window
             : (typeof globalThis !== 'undefined' ? globalThis : null);

    var tr = transform(f, a, b);
    tr.g = patchEnds(tr.g, tr.lo, tr.hi);
    var diag = diagnose(tr.g, tr.lo, tr.hi, isFinite(a), isFinite(b));
    var notes = diag.notes.slice();
    var method = '自适应 Simpson';

    /* 高精度偶函数核验：用于 (−∞,∞) 振荡或 0 处可去奇点场景，避免两半轴重复求积翻倍耗时 */
    function isEvenDec(fObj) {
      if (!fObj || !fObj.src || !ROOT || !ROOT.IntegralHP || !ROOT.IntegralHP.compile || typeof Decimal === 'undefined') return false;
      if (/\b(floor|ceil|round|min|max|sign)\b/i.test(fObj.src)) return false;
      var oldP = Decimal.precision;
      try {
        Decimal.set({ precision: 45 });
        var fd = ROOT.IntegralHP.compile(fObj.src);
        var ptsE = ['0.0137', '0.1731', '0.6193', '1.4142', '2.7183', '5.317', '13.73', '37.91'];
        for (var ei = 0; ei < ptsE.length; ei++) {
          var xd = new Decimal(ptsE[ei]);
          var vp = fd(xd), vm = fd(xd.neg());
          if (!vp.isFinite() || !vm.isFinite()) return false;
          var sc = Decimal.max(vp.abs(), vm.abs(), new Decimal(1));
          if (vp.minus(vm).abs().gt(sc.mul('1e-36'))) return false;
        }
        return true;
      } catch (e) {
        return false;
      } finally {
        Decimal.set({ precision: oldP });
      }
    }

    /* 1. 换元感知的高精度 chirp 振荡求积（sin(x²)、sin(2^x) 等） */
    if ((!isFinite(a) || !isFinite(b)) && ROOT && ROOT.IntegralHP && ROOT.IntegralHP.integrateOsc && f.src) {
      var ohp = null;
      try { ohp = ROOT.IntegralHP.integrateOsc(f, aRaw, bRaw, { digits: reqDigits }); }
      catch (e) { ohp = null; }
      if (ohp && ohp.consistent && isFinite(ohp.value)) {
        var digO = ohp.sigma > 0
          ? Math.max(0, -Math.log10(Math.max(ohp.sigma / Math.max(Math.abs(ohp.value), 1e-300), 1e-300)))
          : 40;
        var ohNotes;
        if (ohp.zeroBySymmetry) {
          ohNotes = ['被积函数是奇函数，两半轴各自收敛且恰好抵消，积分值精确为 0。'];
        } else if (ohp.finiteRange) {
          ohNotes = [
            '识别 chirp 结构：换元 ' + ohp.subLabel + ' 后是有限区间，直接 Decimal 双指数求积（' + ohp.evals + ' 次求值），保守有效位 ' + ohp.digits.toFixed(1) + '。'
          ];
        } else {
          ohNotes = [
            (ohp.chirp ? '识别 chirp 结构（频率随 x 递增）：' : '识别振荡结构：') + '换元 ' + ohp.subLabel + ' 后振幅单调衰减，半周期面板适用。',
            '首段双指数 + ' + ohp.panels + ' 个半周期面板（32 点 Gauss-Legendre，40+ 位精度），交错级数用 Cohen–Villegas–Zagier 加速；两种加速长度相差 ' + ohp.gap.toExponential(2) + '，保守有效位 ' + ohp.digits.toFixed(1) + '。'
          ];
        }
        var ohBase = notes.filter(function (n) { return !/发散|采样中有|峰值达/.test(n); });
        return {
          value: ohp.value, sigma: ohp.sigma,
          digits: Math.min(40, digO),
          valueText: ohp.valueText, hpDigits: ohp.digits,
          isNearZero: !!ohp.zeroBySymmetry,
          a: a, b: b, verdict: 'ok', notes: ohBase.concat(ohNotes),
          slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
          evals: ohp.evals, transformLabel: tr.label, segments: ohp.panels,
          method: ohp.finiteRange ? '换元 + Decimal 双指数'
                : ohp.zeroBySymmetry ? '奇函数对称性（精确 0）'
                : '换元 + 半周期面板 + CVZ 加速（Decimal）',
          signChanges: ohp.panels,
          errorType: ohp.zeroBySymmetry ? '精确（奇函数对称性）'
                   : '估计界（CVZ 双长度一致性 + 收敛定理界，非严格保证）'
        };
      }
    }

    /* 2. 有限区间端点剧烈振荡奇点（如 sin(1/x)/x、sin(1/x)/x²、sin(1/x)+sin(1/(1-x))）：
          单端走倒数换元 u = 1/(x-a) 或 1/(b-x)，双端则在中点拆为两半分别处理 */
    if (depth < 2 && isFinite(a) && isFinite(b)) {
      if (diag.endLo.oscillatoryTail && diag.endHi.oscillatoryTail) {
        var midOsc = (a + b) / 2;
        var midOscRaw = String(midOsc);
        /* 若被积函数关于区间中点对称（f(a+b-x) === f(x)，如 sin(1/x)+sin(1/(1-x))），只需算左半再乘 2 */
        var isMidSym = false;
        if (f.src && ROOT && ROOT.IntegralHP && ROOT.IntegralHP.compile && ROOT.IntegralHP.parseBoundDec && typeof Decimal !== 'undefined' &&
            !/\b(floor|ceil|round|min|max|sign)\b/i.test(f.src)) {
          var oldPM = Decimal.precision;
          try {
            Decimal.set({ precision: 45 });
            var fdM = ROOT.IntegralHP.compile(f.src);
            var aD = ROOT.IntegralHP.parseBoundDec(aRaw).dec;
            var bD = ROOT.IntegralHP.parseBoundDec(bRaw).dec;
            if (aD && bD) {
              var abSum = aD.plus(bD), abW = bD.minus(aD);
              var fracs = ['0.0317', '0.0913', '0.1731', '0.2619', '0.3417', '0.4271'];
              isMidSym = true;
              for (var fi = 0; fi < fracs.length; fi++) {
                var x1M = aD.plus(abW.mul(fracs[fi]));
                var x2M = abSum.minus(x1M);
                var v1M = fdM(x1M), v2M = fdM(x2M);
                if (!v1M.isFinite() || !v2M.isFinite()) { isMidSym = false; break; }
                var scM = Decimal.max(v1M.abs(), v2M.abs(), new Decimal(1));
                if (v1M.minus(v2M).abs().gt(scM.mul('1e-36'))) { isMidSym = false; break; }
              }
            }
          } catch (e) { isMidSym = false; }
          finally { Decimal.set({ precision: oldPM }); }
        }
        if (isMidSym) {
          var oHalf = integrate(f, aRaw, midOscRaw, Object.assign({}, opt, { _depth: depth + 1 }));
          if (oHalf.verdict === 'divergent') {
            oHalf.a = a; oHalf.b = b;
            oHalf.notes = ['双端振荡奇点（中点对称）检测到不可积发散。'].concat(oHalf.notes);
            return oHalf;
          }
          if (oHalf.verdict === 'ok' && isFinite(oHalf.value)) {
            var symText = null;
            if (oHalf.valueText && typeof Decimal !== 'undefined') {
              var oldPS = Decimal.precision;
              try {
                Decimal.set({ precision: Math.max(oldPS, reqDigits + 15) });
                symText = oHalf.isNearZero ? '0' : new Decimal(oHalf.valueText).mul(2).toSignificantDigits(Math.max(31, reqDigits + 6)).toFixed();
              } catch (e) { symText = null; }
              finally { Decimal.set({ precision: oldPS }); }
            }
            return {
              value: oHalf.isNearZero ? 0 : oHalf.value * 2,
              sigma: oHalf.sigma * 2,
              digits: oHalf.digits,
              valueText: symText,
              hpDigits: oHalf.hpDigits,
              isNearZero: oHalf.isNearZero,
              a: a, b: b, verdict: 'ok',
              notes: ['双端均检测到振荡奇点且经 45 位 Decimal 核验关于中点对称，转为 2 × 左半倒数换元求积。'].concat(oHalf.notes),
              slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
              evals: oHalf.evals, transformLabel: tr.label, segments: oHalf.segments,
              method: '双端振荡对称性 + ' + oHalf.method, signChanges: oHalf.signChanges,
              errorType: oHalf.errorType
            };
          }
        }
        var oL = integrate(f, aRaw, midOscRaw, Object.assign({}, opt, { _depth: depth + 1 }));
        var oR = integrate(f, midOscRaw, bRaw, Object.assign({}, opt, { _depth: depth + 1 }));
        if (oL.verdict === 'divergent' || oR.verdict === 'divergent') {
          var divEnd = oL.verdict === 'divergent' ? oL : oR;
          divEnd.a = a; divEnd.b = b;
          divEnd.notes = ['双端振荡奇点在中点拆分后检测到不可积发散。'].concat(divEnd.notes);
          return divEnd;
        }
        if (oL.verdict === 'ok' && oR.verdict === 'ok' && isFinite(oL.value) && isFinite(oR.value)) {
          var ov = oL.value + oR.value;
          var os = oL.sigma + oR.sigma;
          var oScale = Math.max(Math.abs(ov), Math.abs(oL.value) + Math.abs(oR.value), 1e-300);
          var oDig = os > 0 ? Math.max(0, -Math.log10(os / oScale)) : 40;
          var oNearZ = Math.abs(ov) <= os && os < 1e-11 * oScale;
          var oText = null;
          if (oL.valueText && oR.valueText && typeof Decimal !== 'undefined') {
            var oldPrecO = Decimal.precision;
            try {
              Decimal.set({ precision: Math.max(oldPrecO, reqDigits + 15) });
              oText = oNearZ ? '0' : new Decimal(oL.valueText).plus(new Decimal(oR.valueText)).toSignificantDigits(Math.max(31, reqDigits + 6)).toFixed();
            } catch (e) { oText = null; }
            finally { Decimal.set({ precision: oldPrecO }); }
          }
          return {
            value: oNearZ ? 0 : ov, sigma: os,
            digits: Math.min(oText ? 40 : 17, oDig),
            valueText: oText, hpDigits: oText ? Math.min(oL.hpDigits || 25, oR.hpDigits || 25) : null,
            isNearZero: oNearZ, a: a, b: b, verdict: 'ok',
            notes: ['双端均检测到振荡奇点，已在中点拆分并分别做倒数换元求积再求和。'],
            slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
            evals: oL.evals + oR.evals, transformLabel: tr.label, segments: oL.segments + oR.segments,
            method: '双端振荡拆分 + 倒数换元', signChanges: oL.signChanges + oR.signChanges,
            errorType: '估计界（两半段误差界之和，非严格保证）'
          };
        }
      }
      if (diag.endLo.oscillatoryTail && !diag.endHi.oscillatoryTail && !diag.endHi.divergent) {
        var invU = function (u) { return f(a + 1 / u) / (u * u); };
        if (f.src) invU.src = '(' + substXSrc(f.src, '(' + String(aRaw) + ')+1/(x)') + ')/((x)^2)';
        var subLo = integrate(invU, 1 / (b - a), Infinity, Object.assign({}, opt, { _depth: depth + 1 }));
        if (subLo.verdict === 'ok' || subLo.verdict === 'oscillatory' || subLo.verdict === 'divergent') {
          subLo.a = a; subLo.b = b;
          subLo.notes = ['左端检测到振荡奇点，已做倒数换元 u = 1/(x−a) 转为半无穷振荡积分。'].concat(subLo.notes);
          return subLo;
        }
      }
      if (diag.endHi.oscillatoryTail && !diag.endLo.oscillatoryTail && !diag.endLo.divergent) {
        var invU2 = function (u) { return f(b - 1 / u) / (u * u); };
        if (f.src) invU2.src = '(' + substXSrc(f.src, '(' + String(bRaw) + ')-1/(x)') + ')/((x)^2)';
        var subHi = integrate(invU2, 1 / (b - a), Infinity, Object.assign({}, opt, { _depth: depth + 1 }));
        if (subHi.verdict === 'ok' || subHi.verdict === 'oscillatory' || subHi.verdict === 'divergent') {
          subHi.a = a; subHi.b = b;
          subHi.notes = ['右端检测到振荡奇点，已做倒数换元 u = 1/(b−x) 转为半无穷振荡积分。'].concat(subHi.notes);
          return subHi;
        }
      }
    }

    /* 3. 无穷区间振荡分流：仅由振荡尾特征或全局高频变号触发（不再混入非振荡的 -0.85 斜率） */
    var infOscTrigger = (!isFinite(a) || !isFinite(b)) && (
      diag.endLo.oscillatoryTail || diag.endHi.oscillatoryTail ||
      (diag.signChanges >= 12 && !diag.endLo.divergent && !diag.endHi.divergent)
    );
    if (infOscTrigger) {
      /* 有限端点若存在非振荡真发散（如 cos(x²)/x 在 x=0 呈 1/x），尾部振荡救不了头部，立即判发散 */
      var finiteBad =
        (isFinite(a) && !diag.endLo.oscillatoryTail && diag.endLo.divergent) ||
        (isFinite(b) && !diag.endHi.oscillatoryTail && diag.endHi.divergent);
      if (finiteBad) {
        notes.push('有限端点处存在不可积奇点；尾部即使振荡衰减也不能改变头部发散，判定为发散积分。');
        return {
          value: 0, sigma: Infinity, digits: 0, a: a, b: b, verdict: 'divergent',
          notes: notes, slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
          evals: 0, transformLabel: tr.label, segments: 0,
          method: '端点渐近判定（已短路）', signChanges: diag.signChanges,
          errorType: '不适用'
        };
      }

      /* 双无穷区间且存在振荡尾/陡斜率：偶函数直接 2×∫₀^∞，一般函数拆 (−∞,0] 与 [0,∞) */
      if (a === -Infinity && b === Infinity && depth < 2) {
        if (isEvenDec(f)) {
          var hHalf = integrate(f, 0, Infinity, Object.assign({}, opt, { _depth: depth + 1 }));
          if (hHalf.verdict === 'ok' && isFinite(hHalf.value)) {
            var evText = null;
            if (hHalf.valueText && typeof Decimal !== 'undefined') {
              var oldPE = Decimal.precision;
              try {
                Decimal.set({ precision: Math.max(oldPE, 40) });
                evText = hHalf.isNearZero ? '0' : new Decimal(hHalf.valueText).mul(2).toSignificantDigits(31).toFixed();
              } catch (e) { evText = null; }
              finally { Decimal.set({ precision: oldPE }); }
            }
            return {
              value: hHalf.isNearZero ? 0 : hHalf.value * 2,
              sigma: hHalf.sigma * 2,
              digits: hHalf.digits,
              valueText: evText,
              hpDigits: hHalf.hpDigits,
              isNearZero: hHalf.isNearZero,
              a: a, b: b, verdict: 'ok',
              notes: notes.filter(function (n) { return n.indexOf('发散') < 0; }).concat([
                '经 45 位 Decimal 多点核验为偶函数，利用对称性转为 2 × ∫₀^∞ 求积（' + hHalf.method + '，' + hHalf.digits.toFixed(1) + ' 位）。'
              ]),
              slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
              evals: hHalf.evals, transformLabel: tr.label, segments: hHalf.segments,
              method: '偶函数对称性 + ' + hHalf.method, signChanges: diag.signChanges,
              errorType: hHalf.errorType
            };
          }
          return {
            value: 0, sigma: Infinity, digits: 0, a: a, b: b,
            verdict: hHalf.verdict === 'oscillatory' ? 'oscillatory' : 'divergent',
            notes: notes.concat(['偶函数半轴求积未收敛，判定为不可积或未收敛。']),
            slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
            evals: hHalf.evals, transformLabel: tr.label, segments: 0,
            method: '双无穷对称性判定', signChanges: diag.signChanges, errorType: '不适用'
          };
        }
        var hL = integrate(f, -Infinity, 0, Object.assign({}, opt, { _depth: depth + 1 }));
        var hR = integrate(f, 0, Infinity, Object.assign({}, opt, { _depth: depth + 1 }));
        if (hL.verdict === 'ok' && hR.verdict === 'ok' && isFinite(hL.value) && isFinite(hR.value)) {
          var sv = hL.value + hR.value;
          var ss = hL.sigma + hR.sigma;
          var scaleB = Math.max(Math.abs(sv), Math.abs(hL.value) + Math.abs(hR.value), 1e-300);
          var digB = ss > 0 ? Math.max(0, -Math.log10(ss / scaleB)) : 40;
          var nearZeroB = Math.abs(sv) <= ss && ss < 1e-11 * scaleB;
          var textB = null;
          if (hL.valueText && hR.valueText && typeof Decimal !== 'undefined') {
            var oldPrecB = Decimal.precision;
            try {
              Decimal.set({ precision: Math.max(oldPrecB, 40) });
              textB = nearZeroB ? '0' : new Decimal(hL.valueText).plus(new Decimal(hR.valueText)).toSignificantDigits(31).toFixed();
            } catch (e) {
              textB = null;
            } finally {
              Decimal.set({ precision: oldPrecB });
            }
          }
          return {
            value: nearZeroB ? 0 : sv, sigma: ss,
            digits: Math.min(textB ? 40 : 17, digB),
            valueText: textB, hpDigits: textB ? Math.min(hL.hpDigits || 25, hR.hpDigits || 25) : null,
            isNearZero: nearZeroB,
            a: a, b: b, verdict: 'ok',
            notes: notes.filter(function (n) { return n.indexOf('发散') < 0; }).concat([
              '双无穷区间已拆成 (−∞,0] 与 [0,∞) 两个半轴分别求积再求和。',
              '左半轴：' + hL.method + '，' + hL.digits.toFixed(1) + ' 位；右半轴：' + hR.method + '，' + hR.digits.toFixed(1) + ' 位。'
            ]),
            slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
            evals: hL.evals + hR.evals, transformLabel: tr.label, segments: hL.segments + hR.segments,
            method: '双无穷拆分 + 半轴各自求积', signChanges: diag.signChanges,
            errorType: '估计界（两半轴误差界之和，非严格保证）'
          };
        }
        return {
          value: 0, sigma: Infinity, digits: 0, a: a, b: b,
          verdict: (hL.verdict === 'oscillatory' || hR.verdict === 'oscillatory') ? 'oscillatory' : 'divergent',
          notes: notes.concat(['双无穷半轴拆分后未均收敛，判定为不可积或未收敛。']),
          slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
          evals: hL.evals + hR.evals, transformLabel: tr.label, segments: 0,
          method: '双无穷拆分判定', signChanges: diag.signChanges, errorType: '不适用'
        };
      }

      /* 半无穷区间交替振荡：双精度零交叉 + 对角 Wynn，随后尝试 Decimal 通用高精度加速（含周期奇点拆分 / 配对周期 Levin-u） */
      var osc = oscillatory(f, a, b, opt);
      if (osc && osc.divergent) {
        notes.push('振荡区间内部分点 x ≈ ' + Number(osc.atX).toFixed(7) + ' 处检测到不可积奇点，判定为发散积分。');
        return {
          value: 0, sigma: Infinity, digits: 0, a: a, b: b, verdict: 'divergent',
          notes: notes, slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
          evals: osc.evals || 0, transformLabel: tr.label, segments: 0,
          method: '振荡区间内部奇点判定（发散）', signChanges: diag.signChanges,
          errorType: '不适用'
        };
      }
      if (osc && isFinite(osc.value)) {
        var oscNotes = notes.filter(function (n) { return n.indexOf('发散') < 0; });
        var minZerosHp = osc.panelSings ? (reqDigits <= 14 ? 24 : reqDigits <= 20 ? 32 : 42) : 48;
        if (ROOT && ROOT.IntegralHP && ROOT.IntegralHP.integrateOscGeneral && f.src && osc.zeros && osc.zeros.length >= minZerosHp) {
          var ghp = null;
          try {
            ghp = ROOT.IntegralHP.integrateOscGeneral(f, aRaw, bRaw, osc.zeros, {
              digits: osc.panelSings ? Math.min(reqDigits, 35) : Math.min(reqDigits, 25),
              maxMs: 25000,
              panelSings: osc.panelSings
            });
          }
          catch (e) { ghp = null; }
          if (ghp && ghp.consistent && isFinite(ghp.value)) {
            var gGap = Math.abs(ghp.value - osc.value);
            var gScale = Math.max(Math.abs(osc.value), Math.abs(ghp.value), 1e-300);
            var sigOscD = Math.max(osc.gap * 10, 1e-8 * gScale);
            var allowOscGap = osc.consistent ? Math.max(1e-5 * gScale, 16 * sigOscD) : Math.max(2e-2 * gScale, 25 * osc.gap);
            if (gGap <= allowOscGap) {
              var digG = ghp.sigma > 0 ? Math.max(0, -Math.log10(ghp.sigma / Math.max(Math.abs(ghp.value), 1e-300))) : 40;
              return {
                value: ghp.value, sigma: ghp.sigma,
                digits: Math.min(40, digG),
                valueText: ghp.valueText, hpDigits: ghp.digits,
                a: a, b: b, verdict: 'ok',
                notes: oscNotes.concat([
                  '通用交替振荡积分：Decimal 零点精化 + 变步 Gauss-Legendre 面板 + ' + ghp.accelMethod + ' 加速（双长度一致性差 ' + ghp.gap.toExponential(2) + '），保守有效位 ' + ghp.digits.toFixed(1) + '。'
                ]),
                slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
                evals: ghp.evals, transformLabel: tr.label, segments: ghp.panels,
                method: 'Decimal 零点面板 + ' + ghp.accelMethod, signChanges: ghp.panels,
                errorType: '估计界（双长度加速一致性，非严格保证）'
              };
            }
          }
        }
        if (osc.consistent) {
          var sigOsc = Math.max(osc.gap * 10, 1e-8 * Math.abs(osc.value), 1e-15 * Math.abs(osc.value));
          return {
            value: osc.value, sigma: sigOsc,
            digits: Math.min(17, Math.max(0, -Math.log10(Math.max(sigOsc / Math.max(Math.abs(osc.value), 1e-300), 1e-300)))),
            a: a, b: b, verdict: 'ok',
            notes: oscNotes.concat([
              'x 域检测到「零交叉分片幅度递减」的振荡收敛结构，改用「自适应零交叉分片 + 对角 Wynn 外推」，共 ' + osc.panels + ' 片；两段加速相差 ' + osc.gap.toExponential(2) + '。'
            ]),
            slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
            evals: osc.evals, transformLabel: tr.label, segments: osc.panels,
            method: '零交叉分片 + 对角 Wynn 外推', signChanges: osc.panels,
            errorType: '估计界（两段加速一致性，非严格保证）'
          };
        }
      }
      /* 若单调交替加速未适用（如准周期拍频 sin(x)sin(√2·x)/x²），先核验包络是否绝对可积 ∫|f|<∞ */
      if (isFinite(a) !== isFinite(b)) {
        var absEnv = probeAbsoluteTailEnvelope(f, a, b);
        if (absEnv && absEnv.absConv) {
          var absRes = integrateAbsConvOsc(f, a, b, absEnv);
          if (absRes && isFinite(absRes.value)) {
            var absScale = Math.max(Math.abs(absRes.value), 1e-300);
            var absDig = absRes.sigma > 0 ? Math.max(0, -Math.log10(absRes.sigma / absScale)) : 16;
            var absNearZ = Math.abs(absRes.value) <= absRes.sigma && absRes.sigma < 1e-11 * Math.max(absScale, absRes.absSum);
            return {
              value: absNearZ ? 0 : absRes.value,
              sigma: absRes.sigma,
              digits: Math.min(17, absDig),
              valueText: absNearZ ? '0' : null,
              hpDigits: null,
              isNearZero: absNearZ,
              a: a, b: b, verdict: 'ok',
              notes: notes.filter(function (n) { return n.indexOf('发散') < 0; }).concat([
                '检测到无穷振荡但包络绝对可积（壳积分衰减阶 ~ R^(' + absEnv.envIntSlope.toFixed(2) + ') < -0.35），改用倍增壳复合 GL16 并附带几何截断上界。'
              ]),
              slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
              evals: absRes.evals, transformLabel: tr.label, segments: absRes.segments,
              method: '绝对收敛振荡分段 GL16', signChanges: diag.signChanges,
              errorType: '估计界（倍增壳复合 GL16 误差 + 包络截断上界）'
            };
          }
        }
      }
      if (osc && !osc.consistent) {
        return {
          value: 0, sigma: Infinity, digits: 0, a: a, b: b, verdict: 'oscillatory',
          notes: notes.filter(function (n) { return n.indexOf('发散') < 0; }).concat([
            '被积函数在无穷区间反复变号，零交叉分片 + Wynn 外推未达成一致（差 ' + osc.gap.toExponential(2) + '），且未检测到绝对可积衰减包络，不给假数。'
          ]),
          slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
          evals: osc.evals, transformLabel: tr.label, segments: osc.panels,
          method: '振荡（未收敛）', signChanges: osc.panels,
          errorType: '不适用'
        };
      }
      if (diag.endLo.divergent || diag.endHi.divergent ||
          (diag.endLo.oscillatoryTail && diag.slopeLo <= -0.95) ||
          (diag.endHi.oscillatoryTail && diag.slopeHi <= -0.95)) {
        notes.push('端点增长率达到发散量级，且未找到可加速衰减的零交叉结构，判定为发散积分。');
        return {
          value: 0, sigma: Infinity, digits: 0, a: a, b: b, verdict: 'divergent',
          notes: notes, slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
          evals: 0, transformLabel: tr.label, segments: 0,
          method: '端点渐近判定（已短路）', signChanges: diag.signChanges,
          errorType: '不适用'
        };
      }
    }

    /* 4. 非振荡型真发散短路（必须在求积前拦截） */
    if (diag.verdict === 'divergent') {
      return {
        value: 0, sigma: Infinity, digits: 0, a: a, b: b, verdict: 'divergent',
        notes: notes, slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
        evals: 0, transformLabel: tr.label, segments: 0,
        method: method + '（判定发散后短路）', signChanges: diag.signChanges,
        errorType: '不适用'
      };
    }

    /* 5. 无穷端良性浮点溢出截断（仅允许无穷端点；绝不能把有限区间的半段 NaN 定义域裁掉） */
    var trim = (!isFinite(a) || !isFinite(b))
      ? trimOverflowTail(tr.g, tr.lo, tr.hi, diag.maxSeen,
          !isFinite(a) && (diag.endLo.benignOverflow || !isFinite(safeEval(tr.g, tr.lo))),
          !isFinite(b) && (diag.endHi.benignOverflow || !isFinite(safeEval(tr.g, tr.hi))))
      : null;
    if (trim) {
      tr.lo = trim.lo; tr.hi = trim.hi;
      var d3 = diagnose(tr.g, tr.lo, tr.hi);
      diag.endLo = d3.endLo; diag.endHi = d3.endHi;
      diag.slopeLo = d3.slopeLo; diag.slopeHi = d3.slopeHi;
      diag.badCount = d3.badCount;
      if (d3.verdict === 'ok' && diag.verdict === 'uncertain') {
        diag.verdict = 'ok';
        notes = notes.filter(function (n) { return n.indexOf('NaN/Inf') < 0; });
      }
      notes.push('尾部出现良性浮点溢出（溢出前已衰减到可忽略），已自动截断溢出尾区。');
    }

    /* 大片定义域缺失守卫（如 sqrt(x-0.5) 在 [0,1]、ln(sin x) 在 [0,2π]）：绝不忽略半段 NaN */
    if (diag.badCount >= 12 && !diag.endLo.benignOverflow && !diag.endHi.benignOverflow) {
      notes.push('积分区间内存在大段无定义区域（采样出现 ' + diag.badCount + ' 个 NaN/Inf），实数域定积分无定义。');
      return {
        value: 0, sigma: Infinity, digits: 0, a: a, b: b, verdict: 'divergent',
        notes: notes, slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
        evals: 0, transformLabel: tr.label, segments: 0,
        method: '定义域缺失守卫（已短路）', signChanges: diag.signChanges,
        errorType: '不适用'
      };
    }

    /* 6. 内部奇点、尖峰、阶跃与折点扫描 */
    var hasStrictKink = !!(f.src && /\b(abs|floor|ceil|round|min|max|sign)\b/i.test(f.src));
    var hasSqrtKink = !hasStrictKink && !!(f.src && /\bsqrt\b/i.test(f.src));
    var hasKinkFuncs = hasStrictKink || hasSqrtKink;
    if (depth < 2 && !opt._noInteriorSplit) {
      var interior = scanInterior(f, tr, isFinite(a) && isFinite(b), hasKinkFuncs, hasSqrtKink);
      if (interior.domainGap) {
        notes.push('内部扫描检测到连续无定义区域（NaN/Inf），实数域定积分无定义。');
        return {
          value: 0, sigma: Infinity, digits: 0, a: a, b: b, verdict: 'divergent',
          notes: notes, slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
          evals: 0, transformLabel: tr.label, segments: 0,
          method: '定义域缺失守卫（已短路）', signChanges: diag.signChanges,
          errorType: '不适用'
        };
      }
      if (interior.divergent) {
        notes.push('内部点 x ≈ ' + interior.atX.toPrecision(8) + ' 处检测到不可积奇点，判定为发散积分。');
        return {
          value: 0, sigma: Infinity, digits: 0, a: a, b: b, verdict: 'divergent',
          notes: notes, slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
          evals: 0, transformLabel: tr.label, segments: 0,
          method: '内部奇点扫描（判定发散）', signChanges: diag.signChanges,
          errorType: '不适用'
        };
      }
      if (interior.splits && interior.splits.length > 0) {
        /* 双无穷在 x=0 拆点且为偶函数（如 sin²x/x² 在 (−∞,∞)）：利用对称性只算 [0,∞) 并乘 2 */
        if (a === -Infinity && b === Infinity && interior.splits.length === 1 &&
            Math.abs(interior.splits[0].x) < 1e-10 && isEvenDec(f)) {
          var hEv0 = integrate(f, 0, Infinity, Object.assign({}, opt, { _depth: depth + 1, _noInteriorSplit: true }));
          if (hEv0.verdict === 'ok' && isFinite(hEv0.value)) {
            var evT0 = null;
            if (hEv0.valueText && typeof Decimal !== 'undefined') {
              var oldPE0 = Decimal.precision;
              try {
                Decimal.set({ precision: Math.max(oldPE0, 40) });
                evT0 = hEv0.isNearZero ? '0' : new Decimal(hEv0.valueText).mul(2).toSignificantDigits(31).toFixed();
              } catch (e) { evT0 = null; }
              finally { Decimal.set({ precision: oldPE0 }); }
            }
            return {
              value: hEv0.isNearZero ? 0 : hEv0.value * 2,
              sigma: hEv0.sigma * 2,
              digits: hEv0.digits,
              valueText: evT0,
              hpDigits: hEv0.hpDigits,
              isNearZero: hEv0.isNearZero,
              a: a, b: b, verdict: 'ok',
              notes: notes.filter(function (n) { return n.indexOf('NaN/Inf') < 0 && n.indexOf('峰值') < 0; }).concat([
                '检测到 x=0 处内部奇点且经 45 位 Decimal 核验为偶函数，转为 2 × ∫₀^∞ 求积（' + hEv0.method + '）。'
              ]),
              slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
              evals: hEv0.evals, transformLabel: tr.label, segments: hEv0.segments,
              method: '偶函数对称性 + ' + hEv0.method, signChanges: diag.signChanges,
              errorType: hEv0.errorType
            };
          }
        }

        var ptsX = [aRaw];
        for (var spI = 0; spI < interior.splits.length; spI++) {
          var sp = interior.splits[spI];
          var spRaw = sp.exactX
            ? String(sp.x)
            : (ROOT && ROOT.IntegralHP && ROOT.IntegralHP.refineSplitDecimal && f.src)
            ? ROOT.IntegralHP.refineSplitDecimal(f.src, sp.x, sp.kind, a, b, 60)
            : String(sp.x);
          ptsX.push(spRaw);
        }
        ptsX.push(bRaw);

        var totalVal = 0, totalSig = 0, totalEvals = 0, totalSegs = 0;
        var allOk = true, allHpTexts = [];
        var canHpSum = (typeof Decimal !== 'undefined');
        var hasKink = false, hasSing = false, hasJump = false, hasPeak = false;
        for (var si = 0; si < interior.splits.length; si++) {
          var sk = interior.splits[si].kind;
          if (sk === 'kink') hasKink = true;
          else if (sk === 'jump') hasJump = true;
          else if (sk === 'peak') hasPeak = true;
          else hasSing = true;
        }
        var manySplits = interior.splits.length >= 10;
        var subOpt = Object.assign({}, opt, {
          _depth: depth + 1,
          _noInteriorSplit: true,
          _hpDigits: manySplits ? Math.min(16, reqDigits) : reqDigits,
          _hpMaxLevel: manySplits ? Math.min(4, reqMaxLevel) : reqMaxLevel,
          _hpFastPrec: manySplits ? true : reqFastPrec
        });
        for (var pi = 0; pi + 1 < ptsX.length; pi++) {
          var subRes = integrate(f, ptsX[pi], ptsX[pi + 1], subOpt);
          if (subRes.verdict === 'divergent' || subRes.verdict === 'oscillatory') return subRes;
          if (subRes.verdict !== 'ok') allOk = false;
          totalVal += subRes.value;
          totalSig += subRes.sigma;
          totalEvals += subRes.evals;
          totalSegs += subRes.segments;
          if (subRes.valueText && canHpSum) {
            allHpTexts.push(subRes.valueText);
          } else {
            canHpSum = false;
          }
        }
        var scaleSp = Math.max(Math.abs(totalVal), 1e-300);
        var digSp = totalSig > 0 ? Math.max(0, -Math.log10(totalSig / scaleSp)) : 40;
        var nearZSp = Math.abs(totalVal) <= totalSig && totalSig < 1e-11 * scaleSp;
        var valTextSp = null;
        if (canHpSum && allHpTexts.length > 0) {
          var oldPrecSp = Decimal.precision;
          try {
            Decimal.set({ precision: Math.max(oldPrecSp, reqDigits + 15) });
            var decSum = new Decimal(0);
            for (var hpIdx = 0; hpIdx < allHpTexts.length; hpIdx++) decSum = decSum.plus(new Decimal(allHpTexts[hpIdx]));
            valTextSp = nearZSp ? '0' : decSum.toSignificantDigits(Math.max(31, reqDigits + 6)).toFixed();
          } catch (e) {
            valTextSp = null;
          } finally {
            Decimal.set({ precision: oldPrecSp });
          }
        }
        var splitDesc = hasSing ? '内部可积奇点' : hasJump ? '内部阶跃' : hasPeak ? '内部窄尖峰' : '内部折点';
        if (hasSing && (hasKink || hasJump)) splitDesc = '内部奇点/折点';
        return {
          value: nearZSp ? 0 : totalVal, sigma: totalSig,
          digits: Math.min(valTextSp ? 40 : 17, digSp),
          valueText: valTextSp, hpDigits: valTextSp ? Math.min(reqDigits, digSp) : null,
          isNearZero: nearZSp,
          a: a, b: b, verdict: allOk ? 'ok' : 'uncertain',
          notes: notes.filter(function (n) { return n.indexOf('NaN/Inf') < 0 && n.indexOf('峰值') < 0; }).concat([
            '检测到 ' + interior.splits.length + ' 处' + splitDesc + '，已分段求积再求和。'
          ]),
          slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
          evals: totalEvals, transformLabel: tr.label, segments: totalSegs,
          method: splitDesc + '分段' + (valTextSp ? ' + Decimal 双指数' : ' + 自适应 Simpson'),
          signChanges: diag.signChanges,
          errorType: valTextSp ? '估计界（分段双指数之和，非严格保证）' : '估计界（分段误差之和，非严格保证）'
        };
      }
    }

    /* 7. 有限区间与半无穷有限端的可积奇点做变量拉伸（非零实端点上限封顶 4，防下溢抖动） */
    var origSlopeLo = (diag.endLo && typeof diag.endLo.useSlope === 'number') ? diag.endLo.useSlope : diag.slopeLo;
    var origSlopeHi = (diag.endHi && typeof diag.endHi.useSlope === 'number') ? diag.endHi.useSlope : diag.slopeHi;
    var effLo = origSlopeLo, effHi = origSlopeHi;
    var mLo = 1, mHi = 1;
    if (isFinite(a) && effLo < -0.08) {
      var minMLo = effLo < -0.30 ? 2 : (tr.lo === 0 ? 4 : 3);
      var capMLo = a === 0 ? 12 : 4;
      mLo = Math.min(capMLo, Math.max(minMLo, Math.ceil(0.98 / Math.max(0.05, 1 + effLo))));
    }
    if (isFinite(b) && effHi < -0.08) {
      var minMHi = effHi < -0.30 ? 2 : (tr.hi === 0 ? 4 : 3);
      var capMHi = b === 0 ? 12 : 4;
      mHi = Math.min(capMHi, Math.max(minMHi, Math.ceil(0.98 / Math.max(0.05, 1 + effHi))));
    }
    if (mLo > 1 || mHi > 1) {
      tr = {
        g: stretchEnds(tr.g, tr.lo, tr.hi, mLo, mHi, a, b), lo: 0, hi: 1,
        label: tr.label + '，端点拉伸 s^' + Math.max(mLo, mHi)
      };
      method = '端点拉伸 + 自适应 Simpson';
      notes.push('端点奇点用变量拉伸处理（' +
        (mLo > 1 && mHi > 1 ? '左 s^' + mLo + ' / 右 s^' + mHi : mLo > 1 ? '左端 s^' + mLo : '右端 s^' + mHi) +
        '），替代内缩回避，避免精度损失。');
      var d2 = diagnose(tr.g, tr.lo, tr.hi);
      diag.slopeLo = d2.slopeLo; diag.slopeHi = d2.slopeHi;
    }

    if (diag.verdict === 'divergent') {
      return {
        value: 0, sigma: Infinity, digits: 0, a: a, b: b, verdict: 'divergent',
        notes: notes, slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
        evals: 0, transformLabel: tr.label, segments: 0,
        method: method + '（判定发散后短路）', signChanges: diag.signChanges,
        errorType: '不适用'
      };
    }

    /* 7b. 有限高频通道前检测端点非解析分支点（如 sin(x)/sqrt(x) 在 x=0 呈 √x，GL 阶退化到 O(h^1.5)） */
    if (depth < 2 && isFinite(a) && isFinite(b) && diag.signChanges >= 40 && mLo === 1 && mHi === 1 &&
        f.src && /\b(sqrt|cbrt|ln|log|asin|acos|atanh)\b|\^\s*\(?\s*-?\d*\.\d+|\^\s*\(?\s*-?\d+\s*\/\s*\d+/i.test(f.src)) {
      var Wcol = b - a;
      var h1C = Math.min(1e-6 * Wcol, 1e-5), h2C = 100 * h1C;
      var endNonSmooth = function (isLeft) {
        var ePt = isLeft ? a : b, sgn = isLeft ? 1 : -1;
        var fe = safeEval(f, ePt);
        if (!isFinite(fe)) return true;
        var f1a = safeEval(f, ePt + sgn * h1C), f1b = safeEval(f, ePt + sgn * 2 * h1C);
        var f2a = safeEval(f, ePt + sgn * h2C), f2b = safeEval(f, ePt + sgn * 2 * h2C);
        if (!isFinite(f1a) || !isFinite(f1b) || !isFinite(f2a) || !isFinite(f2b)) return true;
        var dNear = Math.abs(f1b - f1a) / h1C;
        var dMid = Math.abs(f2b - f2a) / h2C;
        return dNear > 4 * Math.max(dMid, 1e-12) && dNear > 10;
      };
      var splitLoCol = endNonSmooth(true);
      var splitHiCol = endNonSmooth(false);
      if ((splitLoCol || splitHiCol) && Wcol > 0) {
        var colW = Math.min(2, 0.05 * Wcol);
        var colPts = [a];
        if (splitLoCol) colPts.push(a + colW);
        if (splitHiCol && (!splitLoCol || b - colW > a + colW + 1e-6 * Wcol)) colPts.push(b - colW);
        colPts.push(b);
        if (colPts.length >= 3) {
          var cVal = 0, cSig = 0, cEvals = 0, cSegs = 0, cOk = true;
          for (var colI = 0; colI + 1 < colPts.length; colI++) {
            var subC = integrate(f, colPts[colI], colPts[colI + 1], Object.assign({}, opt, { _depth: depth + 1, _noInteriorSplit: true }));
            if (subC.verdict === 'divergent' || subC.verdict === 'oscillatory') return subC;
            if (subC.verdict !== 'ok') cOk = false;
            cVal += subC.value; cSig += subC.sigma; cEvals += subC.evals; cSegs += subC.segments;
          }
          var cScale = Math.max(Math.abs(cVal), 1e-300);
          var cDig = cSig > 0 ? Math.max(0, -Math.log10(cSig / cScale)) : 16;
          return {
            value: cVal, sigma: cSig, digits: Math.min(17, cDig),
            valueText: null, hpDigits: null, isNearZero: false,
            a: a, b: b, verdict: cOk ? 'ok' : 'uncertain',
            notes: notes.concat(['检测到有限高频区间端点非解析（导数呈分支奇异增长），已剥离边界颈区与光滑主体分段求积。']),
            slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
            evals: cEvals, transformLabel: tr.label, segments: cSegs,
            method: '端点颈区剥离 + 分段复合求积', signChanges: diag.signChanges,
            errorType: '估计界（颈区与光滑段误差之和，非严格保证）'
          };
        }
      }
    }

    /* 8. 有限区间光滑高频振荡快速通道（16 点复合 Gauss-Legendre，避免 4 阶 Simpson 爆炸） */
    if (isFinite(a) && isFinite(b) && diag.signChanges >= 40 && mLo === 1 && mHi === 1 &&
        !diag.endLo.integrableSingularity && !diag.endHi.integrableSingularity && diag.badCount === 0) {
      var glRes = integrateHighFreqGL(tr.g, tr.lo, tr.hi, diag.signChanges);
      if (glRes && isFinite(glRes.value)) {
        var glNearZ = Math.abs(glRes.value) <= glRes.sigma && glRes.sigma < 1e-11 * Math.max(Math.abs(glRes.value), glRes.absSum, 1e-300);
        var glScale = (!glNearZ && Math.abs(glRes.value) > 10 * glRes.sigma)
          ? Math.max(Math.abs(glRes.value), 1e-300)
          : Math.max(Math.abs(glRes.value), glRes.absSum, 1e-300);
        var glDig = glRes.sigma > 0 ? Math.max(0, -Math.log10(glRes.sigma / glScale)) : 16;
        return {
          value: glNearZ ? 0 : glRes.value, sigma: glRes.sigma,
          digits: Math.min(17, glDig), valueText: glNearZ ? '0' : null, hpDigits: null,
          isNearZero: glNearZ, a: a, b: b, verdict: 'ok',
          notes: notes.concat(['有限区间高频光滑振荡（' + diag.signChanges + ' 次变号），采用 16 点复合 Gauss-Legendre（' + glRes.panels + ' 片，' + glRes.evals + ' 次求值）。']),
          slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
          evals: glRes.evals, transformLabel: tr.label, segments: glRes.panels,
          method: '16 点复合 Gauss-Legendre', signChanges: diag.signChanges,
          errorType: '估计界（加倍分片差，非严格保证）'
        };
      }
    }

    /* 8b. 双精度自适应 Simpson（有限高频按变号次数加密初始分段；HP 在场时先跑快速校验档） */
    var baseSegs = opt.segments || 192;
    if (isFinite(a) && isFinite(b) && diag.signChanges >= 24) {
      baseSegs = Math.max(baseSegs, Math.min(2048, diag.signChanges * 6));
    }
    var hpEligible = diag.verdict !== 'divergent' && diag.verdict !== 'oscillatory' &&
      !(isFinite(a) && isFinite(b) && diag.signChanges >= 80);
    var hasHP = !!(hpEligible && ROOT && ROOT.IntegralHP && f.src);
    var usedFullFine = !hasHP;
    var fine = hasHP
      ? integrateOnce(tr.g, tr.lo, tr.hi, 1e-10, Math.min(baseSegs, 192), 16, 120000)
      : integrateOnce(tr.g, tr.lo, tr.hi, 1e-13, baseSegs, 22, 450000);

    function computeDoubleSigma(resFine) {
      var v0 = resFine.value;
      var fl = 64 * Number.EPSILON * (resFine.absSum + Math.abs(v0)) + 1e-14 * Math.max(Math.abs(v0), resFine.absSum);
      var tl = 0;
      if (!isFinite(b) && tr.hi < 1) {
        var hv = safeEval(tr.g, tr.hi);
        if (isFinite(hv)) tl += Math.abs(hv) * (1 - tr.hi) / Math.max(0.05, 1 + Math.min(0, origSlopeHi));
      }
      if (!isFinite(a) && tr.lo > 0) {
        var lv = safeEval(tr.g, tr.lo);
        if (isFinite(lv)) tl += Math.abs(lv) * tr.lo / Math.max(0.05, 1 + Math.min(0, origSlopeLo));
      }
      var endFloor = 0;
      if (isFinite(a) && a !== 0 && origSlopeLo < -0.55 && origSlopeLo > -0.995) {
        var qLo = 1 + origSlopeLo;
        endFloor = Math.max(endFloor, Math.pow(8 * Number.EPSILON * Math.max(Math.abs(a), 1), qLo) / Math.max(0.05, qLo));
      }
      if (isFinite(b) && b !== 0 && origSlopeHi < -0.55 && origSlopeHi > -0.995) {
        var qHi = 1 + origSlopeHi;
        endFloor = Math.max(endFloor, Math.pow(8 * Number.EPSILON * Math.max(Math.abs(b), 1), qHi) / Math.max(0.05, qHi));
      }
      var sg = Math.max(resFine.err * 16, fl, 1e-15 * Math.abs(v0), tl, endFloor);
      if (resFine.evalCapped) sg = Math.max(sg, 0.05 * Math.max(resFine.absSum, Math.abs(v0)));
      if (trim) sg = Math.max(sg, trim.dropped);
      return sg;
    }

    var value = fine.value;
    var sigma = computeDoubleSigma(fine);
    if (!isFinite(value) || !isFinite(sigma)) {
      return {
        value: 0, sigma: Infinity, digits: 0, a: a, b: b, verdict: 'divergent',
        notes: notes.concat(['求积结果溢出为 Infinity，判定为发散。']),
        slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
        evals: fine.evals, transformLabel: tr.label, segments: baseSegs,
        method: method, signChanges: diag.signChanges, errorType: '不适用'
      };
    }

    var scaleD = (sigma > 0.01 * Math.max(Math.abs(value), 1e-300))
      ? Math.max(Math.abs(value), 1e-300)
      : Math.max(Math.abs(value), fine.absSum, 1e-300);
    var digitsD = sigma > 0 ? Math.max(0, -Math.log10(sigma / scaleD)) : 16;

    /* 9. 非变号正项周期振荡兜底（如 sin²x/x²、sin⁴x/x⁴、或 sin²x/(x ln x) 实则发散） */
    if ((isFinite(a) !== isFinite(b)) && diag.signChanges <= 2 && (fine.capped || digitsD < 11)) {
      var posOsc = detectPositiveOsc(f, a, b);
      if (posOsc) {
        if (posOsc.divergent) {
          notes.push('正项周期振荡积分尾部振幅呈 k^(' + posOsc.tailSlope.toFixed(2) + ')（或对数临界衰减），不满足可积条件，判定为发散。');
          return {
            value: 0, sigma: Infinity, digits: 0, a: a, b: b, verdict: 'divergent',
            notes: notes, slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
            evals: fine.evals, transformLabel: tr.label, segments: baseSegs,
            method: '正项周期衰减判定（发散）', signChanges: diag.signChanges, errorType: '不适用'
          };
        }
        if (ROOT && ROOT.IntegralHP && ROOT.IntegralHP.integratePosOsc && f.src) {
          var php = null;
          try { php = ROOT.IntegralHP.integratePosOsc(f, aRaw, bRaw, posOsc.minimaX, { digits: Math.min(reqDigits, 25), maxMs: 20000 }); }
          catch (e) { php = null; }
          if (php && php.consistent && isFinite(php.value)) {
            var pGap = Math.abs(php.value - value);
            var pScale = Math.max(Math.abs(value), Math.abs(php.value), 1e-300);
            if (pGap <= Math.max(1e-2 * pScale, 16 * sigma)) {
              var digP = php.sigma > 0 ? Math.max(0, -Math.log10(php.sigma / Math.max(Math.abs(php.value), 1e-300))) : 40;
              var pNotes = notes.filter(function (n) { return !/峰值达|深度上限/.test(n); });
              return {
                value: php.value, sigma: php.sigma,
                digits: Math.min(40, digP),
                valueText: php.valueText, hpDigits: php.digits,
                a: a, b: b, verdict: 'ok',
                notes: pNotes.concat([
                  '识别正项周期振荡衰减（尾阶 ~ k^' + posOsc.tailSlope.toFixed(2) + '）：Decimal 极值分片 + Levin u-transform 加速（双阶差 ' + php.gap.toExponential(2) + '），保守有效位 ' + php.digits.toFixed(1) + '。'
                ]),
                slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
                evals: php.evals, transformLabel: tr.label, segments: php.panels,
                method: 'Decimal 极值分片 + Levin u-transform', signChanges: php.panels,
                errorType: '估计界（Levin 两阶一致性，非严格保证）'
              };
            }
          }
        }
      }
    }

    /* 10. 高精度精化：按求值次数上限控制（不再用短壁钟时间误杀慢设备） */
    var slowInf = (isFinite(a) !== isFinite(b)) && ((b === Infinity && origSlopeHi < -0.65) || (a === -Infinity && origSlopeLo < -0.65));
    var slowFinLo = isFinite(a) && isFinite(b) && origSlopeLo < -0.70 && origSlopeHi > -0.35;
    var slowFinHi = isFinite(a) && isFinite(b) && origSlopeHi < -0.70 && origSlopeLo > -0.35;
    var isLikelyLogTail = (slowInf || slowFinLo || slowFinHi) &&
      (Math.min(origSlopeLo, origSlopeHi) < -0.82) && (fine.capped || digitsD < 6);
    var skipHpForLowTarget = reqDigits <= 12 && !fine.bad && !fine.capped && digitsD >= 11.5 && diag.verdict === 'ok';

    var hp = null;
    var hasPeriodicKink = hasStrictKink && (isFinite(a) !== isFinite(b)) &&
      f.src && /\b(abs|sign|min|max)\s*\([^)]*(sin|cos|tan)/i.test(f.src);
    if (hasHP && !hasPeriodicKink && !skipHpForLowTarget) {
      try {
        hp = ROOT.IntegralHP.integrate(f, aRaw, bRaw, {
          digits: reqDigits,
          maxLevel: isLikelyLogTail ? Math.min(6, reqMaxLevel) : reqMaxLevel,
          maxEvals: isLikelyLogTail ? ((isFinite(a) && isFinite(b)) ? 1600 : 900) : reqMaxEvals,
          fastPrec: reqFastPrec,
          maxMs: 25000,
          singularitySlopeLo: isFinite(a) ? origSlopeLo : undefined,
          singularitySlopeHi: isFinite(b) ? origSlopeHi : undefined
        });
      } catch (e) { hp = null; }
    }

    var hpUsed = false;
    var hpSuspect = false;
    var hpAccept = !!(hp && isFinite(hp.value) && (hp.digits > Math.min(12, reqDigits - 1) || (hp.digits >= 7 && (fine.capped || hp.digits > digitsD + 0.5))));
    if (hpAccept) {
      var hpGap = Math.abs(hp.value - value);
      var hpRel = hpGap / Math.max(Math.abs(value), Math.abs(hp.value), fine.absSum, hp.absInt || 0, 1e-300);
      var fineUnreliable = fine.bad || fine.capped || sigma > 0.01 * Math.max(Math.abs(value), 1e-300);
      hpSuspect = !fineUnreliable && isFinite(value) && hpRel > 1e-6 && hpGap > 8 * sigma;
    }

    /* 10b. 慢衰减 / 迭代对数尾部兜底（1/x^1.02、1/(x ln^1.5 x)、1/(x ln x (ln ln x)^2)、1/(x ln^2(1/x)) 及迭代对数发散） */
    if ((!hpAccept || hpSuspect || (hp && (hp.budgetHit || hp.digits < (isLikelyLogTail ? 20 : 12)))) &&
        ROOT && ROOT.IntegralHP && ROOT.IntegralHP.integrateLogTailDec && f.src &&
        !diag.endLo.oscillatoryTail && !diag.endHi.oscillatoryTail) {
      if (slowInf || slowFinLo || slowFinHi) {
        var ltOpt = { digits: Math.min(reqDigits, 25), maxMs: 20000 };
        if (slowFinLo) ltOpt.side = 'lo';
        else if (slowFinHi) ltOpt.side = 'hi';
        var lt = null;
        try { lt = ROOT.IntegralHP.integrateLogTailDec(f, aRaw, bRaw, ltOpt); } catch (e) { lt = null; }
        if (lt && lt.divergent) {
          notes.push('倍增对数壳 Cauchy 凝聚检验：壳面积衰减斜率 ' + lt.slope.toFixed(2) + '（比值 ' + lt.ratio.toFixed(4) + '），判定为发散积分。');
          return {
            value: 0, sigma: Infinity, digits: 0, a: a, b: b, verdict: 'divergent',
            notes: notes, slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
            evals: lt.evals, transformLabel: lt.transformLabel, segments: 0,
            method: 'Decimal 倍增对数壳判定（发散）', signChanges: diag.signChanges,
            errorType: '不适用'
          };
        }
        if (lt && !lt.divergent && isFinite(lt.value) && lt.digits >= 6) {
          if (!hp || !hpAccept || hpSuspect || lt.digits > hp.digits + 0.5 || (hp.budgetHit && lt.digits >= hp.digits - 2)) {
            hp = lt;
            hpAccept = true;
            hpSuspect = false;
          }
        }
      }
    }

    /* 10c. 半无穷周期折点/阶跃指数衰减精化（按 reqDigits 适配 12/18/25/35 位） */
    if ((!hpAccept || hpSuspect || (hp && hp.digits < Math.min(16, reqDigits))) && hasStrictKink && (isFinite(a) !== isFinite(b)) &&
        ROOT && ROOT.IntegralHP && ROOT.IntegralHP.integratePeriodicKinkExpTail && f.src) {
      var kHp = null;
      try { kHp = ROOT.IntegralHP.integratePeriodicKinkExpTail(f, aRaw, bRaw, { digits: reqDigits, maxMs: 25000 }); }
      catch (e) { kHp = null; }
      if (kHp && isFinite(kHp.value) && kHp.digits >= Math.min(18, reqDigits - 1)) {
        var kGap = Math.abs(kHp.value - value);
        var kScale = Math.max(Math.abs(value), Math.abs(kHp.value), fine.absSum, kHp.absInt || 0, 1e-300);
        var kFineUnrel = fine.bad || fine.capped || sigma > 0.01 * Math.max(Math.abs(value), 1e-300);
        if (kFineUnrel || kGap / kScale <= 1e-6 || kGap <= 16 * sigma) {
          hp = kHp;
          hpAccept = true;
          hpSuspect = false;
        }
      }
    }
    if (!hp && hasHP && hasPeriodicKink && !skipHpForLowTarget) {
      try {
        hp = ROOT.IntegralHP.integrate(f, aRaw, bRaw, {
          digits: reqDigits,
          maxLevel: isLikelyLogTail ? 4 : reqMaxLevel,
          maxEvals: isLikelyLogTail ? 900 : reqMaxEvals,
          fastPrec: reqFastPrec,
          maxMs: 25000,
          singularitySlopeLo: isFinite(a) ? origSlopeLo : undefined,
          singularitySlopeHi: isFinite(b) ? origSlopeHi : undefined
        });
        if (hp && isFinite(hp.value) && hp.digits > Math.min(12, reqDigits - 1)) {
          hpAccept = true;
          hpGap = Math.abs(hp.value - value);
          hpRel = hpGap / Math.max(Math.abs(value), Math.abs(hp.value), fine.absSum, hp.absInt || 0, 1e-300);
          var fineUnrelK = fine.bad || fine.capped || sigma > 0.01 * Math.max(Math.abs(value), 1e-300);
          hpSuspect = !fineUnrelK && isFinite(value) && hpRel > 1e-6 && hpGap > 8 * sigma;
        }
      } catch (e) { hp = null; }
    }

    /* 若未采用 HP（失败或疑似假收敛），且尚未跑全精度双精度档，则升级重跑并复核 */
    if ((!hpAccept || hpSuspect) && !usedFullFine && !skipHpForLowTarget) {
      fine = integrateOnce(tr.g, tr.lo, tr.hi, 1e-13, baseSegs, 22, 450000);
      value = fine.value;
      sigma = computeDoubleSigma(fine);
      usedFullFine = true;
      scaleD = (sigma > 0.01 * Math.max(Math.abs(value), 1e-300))
        ? Math.max(Math.abs(value), 1e-300)
        : Math.max(Math.abs(value), fine.absSum, 1e-300);
      digitsD = sigma > 0 ? Math.max(0, -Math.log10(sigma / scaleD)) : 16;
      hpAccept = !!(hp && isFinite(hp.value) && (hp.digits > Math.min(12, reqDigits - 1) || (hp.digits >= 6 && (fine.capped || hp.digits > digitsD + 0.5))));
      if (hpAccept) {
        hpGap = Math.abs(hp.value - value);
        hpRel = hpGap / Math.max(Math.abs(value), Math.abs(hp.value), fine.absSum, hp.absInt || 0, 1e-300);
        var fineUnrel2 = fine.bad || fine.capped || sigma > 0.01 * Math.max(Math.abs(value), 1e-300);
        hpSuspect = !fineUnrel2 && isFinite(value) && hpRel > 1e-6 && hpGap > 8 * sigma;
      }
    }

    if (hpAccept) {
      if (hpSuspect) {
        notes.push('高精度层与双精度求积相差 ' + hpGap.toExponential(2) +
          '（相对 ' + hpRel.toExponential(2) + '），远超双精度误差界，疑似双指数假收敛；' +
          '已保留双精度结果，不采用该高精度值。');
      } else {
        hpUsed = true;
        value = hp.value;
        sigma = Math.max(hp.sigma, 1e-300);
        notes = notes.filter(function (n) {
          return !/端点奇点用变量拉伸|端点不可直接求值|自适应细分达到深度上限|检测到可积型端点奇点|出现非有限采样值/.test(n);
        });
        if (diag.verdict === 'uncertain') diag.verdict = 'ok';
        notes.push('高精度精化：' + (hp.transformLabel || 'Decimal 双指数') + '（' + hp.evals + ' 次求值' +
          (hp.level ? '，L' + hp.level : '') + '），保守有效位 ' + hp.digits.toFixed(1) + '。');
      }
    }

    if (!hpUsed) {
      if (fine.bad) {
        if (diag.verdict === 'ok') diag.verdict = 'uncertain';
        notes.push('出现非有限采样值，误差估计仅供参考。');
      }
      if (fine.capped) {
        notes.push('自适应细分达到深度上限（被积函数有导数跳变，或已接近双精度极限），误差界取保守值。');
      }
      if (fine.openEnd) {
        if (diag.verdict === 'ok') diag.verdict = 'uncertain';
        notes.push('端点不可直接求值，已用开端点替代。');
      }
    }

    var scaleFinal = (!hpUsed && sigma > 0.01 * Math.max(Math.abs(value), 1e-300))
      ? Math.max(Math.abs(value), 1e-300)
      : Math.max(Math.abs(value), (hpUsed && hp.absInt) ? hp.absInt : fine.absSum, 1e-300);
    var digits = sigma > 0 ? Math.max(0, -Math.log10(sigma / scaleFinal)) : 16;
    var isNearZero = (hpUsed && hp.isNearZero) || (Math.abs(value) <= sigma && sigma < 1e-11 * scaleFinal);
    if (isNearZero) value = 0;

    return {
      value: value, sigma: sigma, digits: Math.min(hpUsed ? 40 : 17, digits),
      valueText: hpUsed ? (isNearZero ? '0' : hp.valueText) : (isNearZero ? '0' : null),
      hpDigits: hpUsed ? hp.digits : null,
      isNearZero: isNearZero,
      a: a, b: b, verdict: diag.verdict, notes: notes,
      slopes: { lo: diag.slopeLo, hi: diag.slopeHi },
      evals: fine.evals, transformLabel: hpUsed && hp.transformLabel ? hp.transformLabel : tr.label,
      segments: baseSegs,
      method: hpUsed ? ('Decimal ' + (hp.transformLabel || '双指数')) : method,
      signChanges: diag.signChanges,
      errorType: hpUsed ? '估计界（相邻两层双指数结果之差，非严格保证）'
                        : '估计界（自适应 Simpson 修正量累加，非严格保证）'
    };
  }

  function formatValue(value, sigma, valueText) {
    if (valueText === '0' || value === 0) return '0';
    var relSig = sigma > 0 ? sigma / Math.max(Math.abs(value), 1e-300) : 0;
    var d = relSig > 0 ? Math.max(6, Math.min(40, Math.ceil(-Math.log10(relSig)) + 2)) : 17;
    if (valueText && typeof Decimal !== 'undefined') {
      try { return new Decimal(String(valueText)).toSignificantDigits(d).toString(); } catch (e) {}
    }
    var s = value.toPrecision(Math.min(17, d));
    if (s.indexOf('e') >= 0) return s.replace(/(\.\d*?)0+e/, '$1e').replace(/\.e/, 'e');
    return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }

  var API = {
    compile: compile, parseBound: parseBound, integrate: integrate,
    normalizeExpr: normalizeExpr,
    transform: transform, diagnose: diagnose, formatValue: formatValue,
    wynnEps: wynnEps, oscillatory: oscillatory,
    analyzeEndpoint: analyzeEndpoint, hasInteriorDivergence: hasInteriorDivergence
  };
  global.IntegralCore = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
