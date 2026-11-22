/* integral-symbolic.js — 符号层：先求反导数，再用两条独立路径验证。
 *
 * 设计原则：符号引擎只负责「提出候选」，能不能用由数值说了算。
 *   1. nerdamer 求 F(x) 使 F'(x) = f(x)
 *   2. 验证一：把 F'(x) 和 f(x) 都编译成数值函数，在 9 个采样点上比对
 *   3. 验证二：F(b) − F(a) 的数值 与 定积分数值层的结果 比对
 * 任一验证不过就返回 null，交回「数值 + RIES」老路。
 *
 * 为什么放在 Worker 里：nerdamer 对某些被积函数（如 sin(x)/(e^x+sin(x))、
 * abs(sin(x))/(e^x+abs(sin(x)+cos(x)))）会卡死几十秒且无法中断。
 * 放到 Worker 里就能超时杀掉，主线程永远不冻结。
 *
 * 为什么把源码内联：file:// 页面里 `new Worker(blobUrl)` 能建，
 * 但 blob 的 origin 是 null，`importScripts('file://…')` 会被浏览器拦掉
 * （实测用户环境报「Worker 脚本加载失败」）。所以把 nerdamer 源码当字符串
 * 塞进 Blob，Worker 里不需要再读任何文件。
 */
(function (global) {
  'use strict';

  var C = global.IntegralCore;

  /* 这些函数 nerdamer 要么不认，要么求不出反导，直接放弃交给数值层 */
  var UNSUPPORTED = /log10|log2|atan2|hypot|floor|ceil|round|sign|\bmin\s*\(|\bmax\s*\(/i;

  /* pow(a,b) → ((a)^(b))。nerdamer 不认 pow，会把它当未知符号。
     按括号配对找逗号，支持嵌套（pow(x,pow(y,2))）。 */
  function expandPow(s) {
    var out = '', i = 0;
    while (i < s.length) {
      var m = /^pow\s*\(/i.exec(s.slice(i));
      if (!m) { out += s[i]; i++; continue; }
      var start = i + m[0].length;
      var depth = 1, j = start, comma = -1;
      while (j < s.length && depth > 0) {
        var ch = s[j];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === ',' && depth === 1 && comma < 0) comma = j;
        j++;
      }
      if (depth !== 0 || comma < 0) { out += s[i]; i++; continue; }
      var base = s.slice(start, comma), expo = s.slice(comma + 1, j - 1);
      out += '((' + expandPow(base) + ')^(' + expandPow(expo) + '))';
      i = j;
    }
    return out;
  }

  /* 名字与语法规范化：
     1. 统一 Unicode 符号（π → pi、² → ^2、³ → ^3、− → -、·/× → *、** → ^）
     2. 补齐隐式乘法（如 2πx → 2*pi*x、2x → 2*x），保留函数调用 sin(...) 不插入 *
     3. 本页 ln 转 nerdamer 的 log，并展开 pow(a,b) → ((a)^(b)) */
  var SYM_FUNCS = {
    sin: 1, cos: 1, tan: 1, sec: 1, csc: 1, cot: 1,
    asin: 1, acos: 1, atan: 1, sinh: 1, cosh: 1, tanh: 1,
    asinh: 1, acosh: 1, atanh: 1, exp: 1, log: 1, ln: 1,
    sqrt: 1, cbrt: 1, abs: 1, pow: 1
  };

  function normalizeForEngine(expr) {
    var s = String(expr).trim();
    if (C && C.normalizeExpr) {
      try { s = C.normalizeExpr(s); } catch (e) {}
    }
    var ts = [], i = 0;
    while (i < s.length) {
      var c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c)) {
        var m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
        if (m) { ts.push({ t: 'num', v: m[0] }); i += m[0].length; continue; }
      }
      if (c === 'π') { ts.push({ t: 'id', v: 'pi' }); i++; continue; }
      if (c === '∞') { ts.push({ t: 'id', v: 'Infinity' }); i++; continue; }
      if (/[a-zA-Z_]/.test(c)) {
        var m2 = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(s.slice(i));
        var id = m2[0];
        var low = id.toLowerCase();
        if (low === 'ln') id = 'log';
        else if (low === 'ln2') { id = '(log(2))'; low = ''; }
        else if (low === 'ln10') { id = '(log(10))'; low = ''; }
        else if (low === 'tau') { id = '(2*pi)'; low = ''; }
        else if (low === 'phi') { id = '((1+sqrt(5))/2)'; low = ''; }
        else if (low === 'pi') id = 'pi';
        else if (low === 'arcsin') { id = 'asin'; low = 'asin'; }
        else if (low === 'arccos') { id = 'acos'; low = 'acos'; }
        else if (low === 'arctan') { id = 'atan'; low = 'atan'; }
        else if (low === 'arcsinh' || low === 'arsinh') { id = 'asinh'; low = 'asinh'; }
        else if (low === 'arccosh' || low === 'arcosh') { id = 'acosh'; low = 'acosh'; }
        else if (low === 'arctanh' || low === 'artanh') { id = 'atanh'; low = 'atanh'; }
        ts.push({ t: 'id', v: id, low: low });
        i += m2[0].length;
        continue;
      }
      if (c === '*' && s[i + 1] === '*') { ts.push({ t: 'op', v: '^' }); i += 2; continue; }
      if (c === '−') { ts.push({ t: 'op', v: '-' }); i++; continue; }
      if (c === '·' || c === '×') { ts.push({ t: 'op', v: '*' }); i++; continue; }
      if (c === '²') { ts.push({ t: 'op', v: '^' }, { t: 'num', v: '2' }); i++; continue; }
      if (c === '³') { ts.push({ t: 'op', v: '^' }, { t: 'num', v: '3' }); i++; continue; }
      if (c === '(') { ts.push({ t: 'lp', v: '(' }); i++; continue; }
      if (c === ')') { ts.push({ t: 'rp', v: ')' }); i++; continue; }
      if (c === ',') { ts.push({ t: 'comma', v: ',' }); i++; continue; }
      ts.push({ t: 'op', v: c });
      i++;
    }
    var out = [];
    for (var k = 0; k < ts.length; k++) {
      var cur = ts[k];
      if (k > 0) {
        var prev = ts[k - 1];
        var prevEnds = prev.t === 'num' || prev.t === 'rp' ||
          (prev.t === 'id' && !(SYM_FUNCS[prev.low || prev.v.toLowerCase()] && cur.t === 'lp'));
        var curStarts = cur.t === 'num' || cur.t === 'id' || cur.t === 'lp';
        if (prevEnds && curStarts) out.push('*');
      }
      out.push(cur.v);
    }
    return out.join('');
  }

  function toEngine(expr) {
    return expandPow(normalizeForEngine(expr));
  }

  function boundToEngine(raw) {
    var s = String(raw).trim().toLowerCase().replace(/\s/g, '');
    if (s === 'inf' || s === '+inf' || s === 'infinity' || s === '∞' || s === '+∞') return 'Infinity';
    if (s === '-inf' || s === '-infinity' || s === '-∞') return '-Infinity';
    return toEngine(raw);
  }

  function samplePoints(a, b, n) {
    var pts = [], i;
    if (isFinite(a) && isFinite(b)) {
      for (i = 0; i < n; i++) pts.push(a + (b - a) * (i + 0.5) / n);
    } else if (isFinite(a)) {
      for (i = 1; i <= n; i++) pts.push(a + Math.pow(1.8, i) - 1);
    } else if (isFinite(b)) {
      for (i = 1; i <= n; i++) pts.push(b - Math.pow(1.8, i) + 1);
    } else {
      for (i = 1; i <= n; i++) { pts.push(i * 1.3); pts.push(-i * 1.3); }
    }
    return pts;
  }

  /* 验证 F'(x) 是否真的等于 f(x)。返回最大相对偏差，无法验证返回 null */
  function verifyDerivative(dText, fText, a, b) {
    var D, F;
    try { D = C.compile(dText); F = C.compile(fText); } catch (e) { return null; }
    var pts = samplePoints(a, b, 9), worst = 0, used = 0;
    for (var i = 0; i < pts.length; i++) {
      var x = pts[i], d, f;
      try { d = D(x); f = F(x); } catch (e) { continue; }
      if (!isFinite(d) || !isFinite(f)) continue;
      var scale = Math.max(1, Math.abs(f));
      var err = Math.abs(d - f) / scale;
      if (err > worst) worst = err;
      used++;
    }
    if (used < 3) return null;
    return worst;
  }

  function safeTeX(n, s) {
    try { return n(s).toTeX().replace(/\\mathrm\{log\}/g, '\\ln').replace(/\\mathrm\{ln\}/g, '\\ln'); }
    catch (e) { return null; }
  }

  /* 判断「exact」是不是只是把数值换了个写法（含“浮点近似小数 × 符号常数”如 0.4736...*pi^(1/2)）。
     小整数、简单分数（1/3）、精确初等表达（atan(1.37), 1-cos(1.37)）返回 false；
     纯长小数、科学计数近似、或把浮点转成的超大分子/分母分数（及 TeX 中的大整数分子分母）返回 true。 */
  function looksNumericOnly(s, eTeX, fText, aRaw, bRaw) {
    var inputNums = Object.create(null), inputInts = Object.create(null);
    var collect = function (txt) {
      var str = String(txt || '').toLowerCase();
      var m1 = str.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi);
      if (m1) for (var i = 0; i < m1.length; i++) inputNums[m1[i]] = true;
      var m2 = str.match(/\d+/g);
      if (m2) for (var j = 0; j < m2.length; j++) inputInts[m2[j]] = true;
    };
    collect(fText); collect(aRaw); collect(bRaw);

    var t = String(s).replace(/\s/g, '');
    if (/^[-+]?\d+$/.test(t)) return t.replace(/[-+]/g, '').length > 12;

    var sci = t.match(/\d+(?:\.\d+)?e[+-]?\d+/gi);
    if (sci) {
      for (var i1 = 0; i1 < sci.length; i1++) {
        if (!inputNums[sci[i1].toLowerCase()]) return true;
      }
    }
    var decs = t.match(/(?:\d+\.\d+|\.\d+)/g);
    if (decs) {
      for (var i2 = 0; i2 < decs.length; i2++) {
        var tok = decs[i2];
        if (!inputNums[tok.toLowerCase()]) {
          var frac = tok.split('.')[1] || '';
          if (frac.length >= 6) return true;
        }
      }
    }

    var checkBigInts = function (str) {
      var ints = String(str || '').match(/\d+/g);
      if (!ints) return false;
      for (var i = 0; i < ints.length; i++) {
        if (ints[i].length >= 10 && !inputInts[ints[i]]) return true;
      }
      return false;
    };
    if (checkBigInts(t) || checkBigInts(eTeX)) return true;

    var fracRe = /(\d+)\/(\d+)/g, fm;
    while ((fm = fracRe.exec(t)) !== null) {
      if ((fm[1].length > 6 && !inputInts[fm[1]]) ||
          (fm[2].length > 6 && !inputInts[fm[2]])) {
        return true;
      }
    }

    if (!/[a-zπ]/i.test(t)) {
      var m = /^\(?-?(\d+)\)?\/\(?(\d+)\)?$/.exec(t);
      if (m) return m[1].length > 6 || m[2].length > 6;
      return true;
    }
    return false;
  }

  /* 主线程侧的收尾：验证 + 交叉核对 + 组装展示数据 */
  function finish(raw, fText, aRaw, bRaw, numericValue) {
    var a, b;
    try { a = C.parseBound(aRaw); b = C.parseBound(bRaw); } catch (e) { return null; }
    if (isNaN(a) || isNaN(b) || a === b) return null;
    var lo = a < b ? a : b;
    var hi = a < b ? b : a;

    var worst = verifyDerivative(raw.Ds, fText, lo, hi);
    if (worst === null || worst > 1e-6) return null;

    if (C.hasInteriorDivergence) {
      try {
        if (C.hasInteriorDivergence(C.compile(fText), lo, hi)) return null;
      } catch (e) {}
    }

    var value = (raw.value === null || raw.value === undefined) ? null : Number(raw.value);
    var cross = null;
    if (value !== null && isFinite(value) && isFinite(numericValue)) {
      cross = Math.abs(value - numericValue) / Math.max(1, Math.abs(numericValue));
      if (cross > 1e-9) return null;      /* 符号解与数值积分不符 → 不认 */
    }

    var exact = raw.exact || null;
    return {
      integrandTeX: raw.iTeX || null,
      antiderivative: raw.Fs,
      antiderivativeTeX: raw.FTeX || null,
      exact: exact,
      exactIsNumeric: exact !== null && looksNumericOnly(exact, raw.eTeX, fText, aRaw, bRaw),
      exactTeX: (exact && raw.eTeX) ? raw.eTeX : null,
      value: value,
      valueText: raw.valueText || (value === null ? null : String(value)),
      derivativeError: worst,
      crossError: cross
    };
  }

  /* ---- Worker 里执行的逻辑（nerdamer 源码会拼在它前面） ---- */
  var WORKER_LOGIC = [
    'function __boundText(raw){',
    '  var s=String(raw).trim().toLowerCase().replace(/\\s/g,"");',
    '  if(s==="inf"||s==="+inf"||s==="infinity"||s==="∞"||s==="+∞")return "Infinity";',
    '  if(s==="-inf"||s==="-infinity"||s==="-∞")return "-Infinity";',
    '  return s.replace(/π/g,"pi").replace(/−/g,"-").replace(/[·×]/g,"*").replace(/²/g,"^2").replace(/³/g,"^3").replace(/(\\d)(pi\\b)/g,"$1*$2");',
    '}',
    'function __evalAt(Fs,bt){',
    '  if(bt==="Infinity"||bt==="-Infinity")return nerdamer("limit("+Fs+",x,"+bt+")").toString();',
    '  return nerdamer(Fs,{x:bt}).toString();',
    '}',
    'function __safeTeX(s){',
    '  try{return nerdamer(s).toTeX().replace(/\\\\mathrm\\{log\\}/g,"\\\\ln");}catch(e){return null;}',
    '}',
    'self.onmessage=function(ev){',
    '  var d=ev.data||{},id=d.id;',
    '  function reply(o){o.id=id;self.postMessage(o);}',
    '  try{',
    '    var Fs=nerdamer("integrate("+d.f+",x)").toString();',
    '    if(!Fs||/integrate\\s*\\(/i.test(Fs)){reply({ok:false,reason:"no-antiderivative"});return;}',
    '    var Ds=nerdamer("diff("+Fs+",x)").toString();',
    '    if(!Ds||/diff\\s*\\(/i.test(Ds)){reply({ok:false,reason:"no-derivative"});return;}',
    '    var Fb=null,Fa=null;',
    '    try{Fb=__evalAt(Fs,__boundText(d.b));}catch(e){}',
    '    try{Fa=__evalAt(Fs,__boundText(d.a));}catch(e){}',
    '    var exact=null,value=null,valueText=null;',
    '    if(Fb!==null&&Fa!==null){',
    '      try{',
    '        var raw=nerdamer("("+Fb+")-("+Fa+")");',
    '        var cands=[];',
    '        try{cands.push(raw.simplify().toString());}catch(e){}',
    '        try{cands.push(raw.simplify().expand().toString());}catch(e){}',
    '        var s=null;',
    '        for(var i=0;i<cands.length;i++){var c=cands[i];',
    '          if(!c||/integrate|limit|diff\\s*\\(/i.test(c))continue;',
    '          if(s===null||c.length<s.length)s=c;}',
    '        if(s){',
    '          exact=s;',
    '          var ev=nerdamer(s).evaluate();',
    '          var vnum=Number(ev.valueOf());',
    '          var txt=null;try{txt=ev.text("decimals",25);}catch(e){}',
    '          var p=txt===null?NaN:parseFloat(txt);',
    '          if(isFinite(p)&&Math.abs(p-vnum)<=1e-9*Math.max(1,Math.abs(vnum)))valueText=txt;',
    '          else valueText=String(vnum);',
    '          value=vnum;',
    '        }',
    '      }catch(e){}',
    '    }',
    '    reply({ok:true,Fs:Fs,Ds:Ds,exact:exact,value:value,valueText:valueText,',
    '      FTeX:__safeTeX(Fs),iTeX:__safeTeX(d.f),eTeX:exact?__safeTeX(exact):null});',
    '  }catch(err){reply({ok:false,reason:String(err&&err.message||err)});}',
    '};'
  ].join('\n');

  /* ---- 常驻 Worker：启动一次，之后复用；超时就杀掉重建 ---- */
  var worker = null, workerUrl = null, seq = 0, pending = {};

  function failPending(reason) {
    var p = pending;
    pending = {};
    Object.keys(p).forEach(function (k) {
      try { p[k]({ ok: false, reason: reason, __fatal: true }); } catch (e) {}
    });
  }

  function killWorker(reason) {
    failPending(reason || 'Worker 已终止');
    try { if (worker) worker.terminate(); } catch (e) {}
    try { if (workerUrl) URL.revokeObjectURL(workerUrl); } catch (e) {}
    worker = null; workerUrl = null;
  }

  function ensureWorker() {
    if (worker) return worker;
    var src = global.__NERDAMER_SRC__;
    if (!src || !global.Worker || typeof global.Blob === 'undefined' || !global.URL) return null;
    try {
      workerUrl = URL.createObjectURL(new Blob([src, '\n;\n', WORKER_LOGIC],
        { type: 'application/javascript' }));
      worker = new global.Worker(workerUrl);
    } catch (e) { return null; }
    worker.onmessage = function (ev) {
      var d = ev.data || {}, cb = pending[d.id];
      if (!cb) return;
      delete pending[d.id];
      cb(d);
    };
    worker.onerror = function () { killWorker('Worker 脚本执行出错'); };
    return worker;
  }

  /* 异步求解。返回 {status, sym, why}：
       ok          — 拿到并验证通过，sym 为结果对象
       none        — 符号引擎求不出反导数
       rejected    — 求出来了但没通过数值验证
       timeout     — 超过时限被终止
       unavailable — Worker 不可用（浏览器限制等）
       skipped     — 输入不适合走符号层
     调用方据 status 决定提示语与是否回退。 */
  function solveAsync(fText, aRaw, bRaw, numericValue, timeoutMs) {
    return new Promise(function (resolve) {
      var src = String(fText).trim();
      if (!C) { resolve({ status: 'unavailable', why: 'IntegralCore 未加载' }); return; }
      var cSrc = src;
      if (C.normalizeExpr) { try { cSrc = C.normalizeExpr(src); } catch (e) {} }
      if (!src || src.length > 200 || UNSUPPORTED.test(cSrc)) { resolve({ status: 'skipped' }); return; }

      var w = ensureWorker();
      if (!w) {
        resolve({
          status: 'unavailable',
          why: global.__NERDAMER_SRC__ ? '浏览器不支持 Worker' : '未加载 nerdamer 源码（assets/nerdamer-inline.js 缺失）'
        });
        return;
      }

      var id = ++seq, settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        delete pending[id];
        resolve({ status: 'timeout' });
        killWorker('超时后重建');       /* 卡住的 Worker 直接丢掉，下次重建 */
      }, timeoutMs || 2500);

      pending[id] = function (d) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (d.__fatal) { resolve({ status: 'unavailable', why: d.reason || 'Worker 异常' }); return; }
        if (!d.ok) { resolve({ status: 'none', why: d.reason || '' }); return; }
        var out = null;
        try { out = finish(d, src, aRaw, bRaw, numericValue); } catch (e) { out = null; }
        resolve(out ? { status: 'ok', sym: out } : { status: 'rejected' });
      };

      try { w.postMessage({ id: id, f: toEngine(src), a: boundToEngine(aRaw), b: boundToEngine(bRaw) }); }
      catch (e) {
        settled = true;
        clearTimeout(timer);
        delete pending[id];
        killWorker('通信失败');
        resolve({ status: 'unavailable', why: 'Worker 通信失败' });
      }
    });
  }

  /* 同步版：只给 Node 测试用，浏览器一律走 solveAsync */
  function solveSync(fText, aRaw, bRaw, numericValue) {
    var n = global.nerdamer;
    if (!n || !C) return null;
    var src = String(fText).trim();
    var cSrc = src;
    if (C.normalizeExpr) { try { cSrc = C.normalizeExpr(src); } catch (e) {} }
    if (!src || src.length > 200) return null;
    if (UNSUPPORTED.test(cSrc)) return null;
    var Fs, Ds;
    var eSrc = toEngine(src);
    try { Fs = n('integrate(' + eSrc + ',x)').toString(); } catch (e) { return null; }
    if (!Fs || /integrate\s*\(/i.test(Fs)) return null;
    try { Ds = n('diff(' + Fs + ',x)').toString(); } catch (e) { return null; }
    if (!Ds || /diff\s*\(/i.test(Ds)) return null;

    function boundText(raw) {
      return boundToEngine(raw);
    }
    function evalAt(F, bt) {
      if (bt === 'Infinity' || bt === '-Infinity') return n('limit(' + F + ',x,' + bt + ')').toString();
      return n(F, { x: bt }).toString();
    }
    var Fb = null, Fa = null;
    try { Fb = evalAt(Fs, boundText(bRaw)); } catch (e) {}
    try { Fa = evalAt(Fs, boundText(aRaw)); } catch (e) {}
    var exact = null, value = null, valueText = null;
    if (Fb !== null && Fa !== null) {
      try {
        var raw = n('(' + Fb + ')-(' + Fa + ')');
        var cands = [];
        try { cands.push(raw.simplify().toString()); } catch (e) {}
        try { cands.push(raw.simplify().expand().toString()); } catch (e) {}
        var s = null;
        for (var i = 0; i < cands.length; i++) {
          var c = cands[i];
          if (!c || /integrate|limit|diff\s*\(/i.test(c)) continue;
          if (s === null || c.length < s.length) s = c;
        }
        if (s) {
          exact = s;
          var ev = n(s).evaluate();
          var vnum = Number(ev.valueOf());
          var txt = null;
          try { txt = ev.text('decimals', 25); } catch (e) {}
          var p = txt === null ? NaN : parseFloat(txt);
          valueText = (isFinite(p) && Math.abs(p - vnum) <= 1e-9 * Math.max(1, Math.abs(vnum)))
            ? txt : String(vnum);
          value = vnum;
        }
      } catch (e) {}
    }
    return finish({ Fs: Fs, Ds: Ds, exact: exact, value: value, valueText: valueText,
                    FTeX: safeTeX(n, Fs), iTeX: safeTeX(n, eSrc),
                    eTeX: exact ? safeTeX(n, exact) : null },
                  src, aRaw, bRaw, numericValue);
  }

  global.IntegralSymbolic = {
    solveAsync: solveAsync,
    solve: solveSync,
    available: function () { return !!global.__NERDAMER_SRC__ && !!global.Worker; },
    _normalizeForEngine: normalizeForEngine,
    _boundToEngine: boundToEngine
  };
})(typeof window !== 'undefined' ? window : globalThis);
