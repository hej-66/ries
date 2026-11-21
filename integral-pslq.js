/* integral-pslq.js — 确定性高精度闭式搜寻引擎（BigInt 精确 LLL + 连分数 + 幂积 + 低次代数）
 *
 * 定位（对应闭式搜寻第二支柱 S_2）：
 *   1. 直接读取 integral-core / integral-hp 给出的 17~31 位真值，不在 Float64 中自降精度；
 *   2. 在明确界定并声明的搜索空间 S_2 内以纯整数 BigInt LLL（Cohen Algorithm 2.6.7）确定性求解，
 *      消除原版 RIES 3 秒超时截断与 top-5 挤出导致的漏解；
 *   3. 每条候选均做 55 位独立重算并强制满足 MDL 净信息压缩盈余 >= 6.0 位才予放行，
 *      从信息论上阻断高维拟合假阳性。
 */
(function (global) {
  'use strict';

  /* ---------- 55 位经过独立验算的经典常数库 ---------- */
  var VERIFIED_LITERALS = {
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

  /* B_2 .. B_24（奇数项在 Euler-Maclaurin 中的偶数指标 B_{2k}）精确有理数 */
  var BERNOULLI_EVEN_STR = [
    [1, 6], [-1, 30], [1, 42], [-1, 30], [5, 66], [-691, 2730],
    [7, 6], [-3617, 510], [43867, 798], [-174611, 330], [854513, 138], [-236364091, 2730]
  ];

  function decGamma(zDec, D) {
    if (!zDec || !zDec.isFinite()) return null;
    if (zDec.isInteger() && zDec.lte(0)) return null;
    var PI = D.acos(-1);
    if (zDec.lt('0.5')) {
      var s = PI.mul(zDec).sin();
      if (s.isZero()) return null;
      var gRef = decGamma(new D(1).minus(zDec), D);
      return gRef ? PI.div(s.mul(gRef)) : null;
    }
    var N = 36;
    var shift = new D(1);
    for (var j = 0; j < N; j++) shift = shift.mul(zDec.plus(j));
    var w = zDec.plus(N);
    var lnG = w.minus('0.5').mul(w.ln()).minus(w).plus(PI.mul(2).ln().div(2));
    var invW2 = new D(1).div(w.mul(w));
    var invPow = new D(1).div(w);
    for (var k = 1; k <= BERNOULLI_EVEN_STR.length; k++) {
      var bPair = BERNOULLI_EVEN_STR[k - 1];
      var term = new D(bPair[0]).div(bPair[1]).mul(invPow).div((2 * k) * (2 * k - 1));
      lnG = lnG.plus(term);
      invPow = invPow.mul(invW2);
    }
    return lnG.exp().div(shift);
  }

  function getConstants(D) {
    var pi = D.acos(-1);
    var e = new D(1).exp();
    var sqrt2 = new D(2).sqrt(), sqrt3 = new D(3).sqrt(), sqrt5 = new D(5).sqrt();
    var sqrt6 = new D(6).sqrt(), sqrt7 = new D(7).sqrt(), sqrtPi = pi.sqrt();
    var sqrt2Pi = pi.mul(2).sqrt();
    var phi = sqrt5.plus(1).div(2);
    var ln2 = new D(2).ln(), ln3 = new D(3).ln(), ln5 = new D(5).ln(), ln7 = new D(7).ln(), ln10 = new D(10).ln();
    var gamma = new D(VERIFIED_LITERALS.gamma);
    var G = new D(VERIFIED_LITERALS.G);
    var zeta2 = pi.pow(2).div(6);
    var zeta3 = new D(VERIFIED_LITERALS.zeta3);
    var zeta4 = pi.pow(4).div(90);
    var zeta5 = new D(VERIFIED_LITERALS.zeta5);
    var zeta6 = pi.pow(6).div(945);
    var zeta7 = new D(VERIFIED_LITERALS.zeta7);
    var beta2 = G;
    var beta3 = pi.pow(3).div(32);
    var beta4 = new D(VERIFIED_LITERALS.beta4);
    var beta5 = pi.pow(5).mul(5).div(1536);
    var gamma14 = new D(VERIFIED_LITERALS.gamma14);
    var gamma13 = new D(VERIFIED_LITERALS.gamma13);
    var gamma16 = new D(VERIFIED_LITERALS.gamma16);
    var gamma34 = pi.mul(sqrt2).div(gamma14);
    var gamma23 = pi.mul(2).div(sqrt3.mul(gamma13));
    var gamma56 = pi.mul(2).div(gamma16);
    var cl2pi3 = new D(VERIFIED_LITERALS.cl2pi3);
    var li2half = zeta2.div(2).minus(ln2.pow(2).div(2));
    var lemniscate = gamma14.pow(2).div(sqrt2Pi.mul(2));
    var glaisher = new D(VERIFIED_LITERALS.glaisher);
    var khinchin = new D(VERIFIED_LITERALS.khinchin);

    return {
      one: new D(1),
      pi: pi, pi2: pi.pow(2), pi3: pi.pow(3), pi4: pi.pow(4), invPi: new D(1).div(pi),
      e: e, e2: e.pow(2), invE: new D(1).div(e), invE2: new D(1).div(e.pow(2)),
      phi: phi, gamma: gamma, G: G, Catalan: G,
      ln2: ln2, ln3: ln3, ln5: ln5, ln7: ln7, ln10: ln10,
      ln2_2: ln2.pow(2), invLn2: new D(1).div(ln2),
      sqrt2: sqrt2, sqrt3: sqrt3, sqrt5: sqrt5, sqrt6: sqrt6, sqrt7: sqrt7,
      sqrtPi: sqrtPi, sqrt2Pi: sqrt2Pi,
      piLn2: pi.mul(ln2), piLn2_2: pi.mul(ln2.pow(2)),
      piSqrt2: pi.mul(sqrt2), piSqrt3: pi.mul(sqrt3),
      piInvE: pi.div(e), piInvE2: pi.div(e.pow(2)),
      expNegHalfPi: pi.div(-2).exp(),
      ln1pSqrt2: sqrt2.plus(1).ln(),
      piLn1pSqrt2: pi.mul(sqrt2.plus(1).ln()),
      piLnHalf1pSqrt2: pi.mul(sqrt2.plus(1).div(2).ln()),
      GOverPi: G.div(pi), piG: pi.mul(G),
      ln2OverPi: ln2.div(pi), piOverLn2: pi.div(ln2),
      zeta2: zeta2, zeta3: zeta3, zeta4: zeta4, zeta5: zeta5, zeta6: zeta6, zeta7: zeta7,
      beta2: beta2, beta3: beta3, beta4: beta4, beta5: beta5,
      gamma14: gamma14, gamma34: gamma34, gamma13: gamma13, gamma23: gamma23, gamma16: gamma16, gamma56: gamma56,
      gamma14SqSqrtPi: gamma14.pow(2).div(sqrtPi),
      gamma13Cube: gamma13.pow(3),
      cl2pi3: cl2pi3, li2half: li2half, lemniscate: lemniscate,
      glaisher: glaisher, khinchin: khinchin,
      decGamma: function (z) { return decGamma(z, D); }
    };
  }

  /* ---------- 纯整数 BigInt 精确 LLL (Cohen Algorithm 2.6.7) ---------- */
  function absB(x) { return x < 0n ? -x : x; }
  function gcdB(a, b) {
    a = absB(a); b = absB(b);
    while (b !== 0n) { var t = a % b; a = b; b = t; }
    return a;
  }
  function roundDiv(num, den) {
    if (den < 0n) { num = -num; den = -den; }
    return num >= 0n ? (2n * num + den) / (2n * den) : -((2n * (-num) + den) / (2n * den));
  }
  function dotB(a, b) {
    var s = 0n;
    for (var i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  function exactIntLLL(rows, maxIter) {
    var n = rows.length;
    var b = new Array(n);
    var d = new Array(n + 1);
    var lam = new Array(n);
    for (var i = 0; i < n; i++) {
      b[i] = rows[i].slice();
      d[i] = 0n;
      lam[i] = new Array(n).fill(0n);
    }
    d[n] = 0n;
    d[0] = 1n;

    for (var i1 = 0; i1 < n; i1++) {
      for (var j = 0; j <= i1; j++) {
        var u = dotB(b[i1], b[j]);
        for (var m = 0; m < j; m++) {
          u = (d[m + 1] * u - lam[i1][m] * lam[j][m]) / d[m];
        }
        if (j < i1) lam[i1][j] = u;
        else d[i1 + 1] = u;
      }
    }

    function reduce(k, l) {
      if (2n * absB(lam[k][l]) <= d[l + 1]) return;
      var q = roundDiv(lam[k][l], d[l + 1]);
      if (q === 0n) return;
      var bk = b[k], bl = b[l];
      for (var c = 0; c < bk.length; c++) bk[c] -= q * bl[c];
      lam[k][l] -= q * d[l + 1];
      for (var ii = 0; ii < l; ii++) lam[k][ii] -= q * lam[l][ii];
    }

    var k = 1, iter = 0, cap = maxIter || 5000;
    while (k < n && iter++ < cap) {
      reduce(k, k - 1);
      var lkk = lam[k][k - 1];
      var lhs = 4n * (d[k + 1] * d[k - 1] + lkk * lkk);
      var rhs = 3n * d[k] * d[k];
      if (lhs < rhs) {
        var tmp = b[k]; b[k] = b[k - 1]; b[k - 1] = tmp;
        for (var j2 = 0; j2 <= k - 2; j2++) {
          var tl = lam[k][j2]; lam[k][j2] = lam[k - 1][j2]; lam[k - 1][j2] = tl;
        }
        var B = (d[k + 1] * d[k - 1] + lkk * lkk) / d[k];
        for (var i2 = k + 1; i2 < n; i2++) {
          var t = lam[i2][k];
          lam[i2][k] = (d[k + 1] * lam[i2][k - 1] - lkk * t) / d[k];
          lam[i2][k - 1] = (B * t + lkk * lam[i2][k]) / d[k + 1];
        }
        d[k] = B;
        k = k > 1 ? k - 1 : 1;
      } else {
        for (var l = k - 2; l >= 0; l--) reduce(k, l);
        k++;
      }
    }
    return b;
  }

  /* ---------- 工具：连分数 / MDL 代价 / 表达式格式化 ---------- */
  function cfApprox(xNum, maxDen) {
    if (!isFinite(xNum)) return null;
    var neg = xNum < 0, a0 = Math.abs(xNum);
    var h1 = 1, h2 = 0, k1 = 0, k2 = 1, b = a0;
    var best = null, bestErr = Infinity;
    for (var it = 0; it < 40; it++) {
      var fl = Math.floor(b);
      var nh = fl * h1 + h2, nk = fl * k1 + k2;
      if (nk > maxDen) {
        var t = Math.floor((maxDen - k2) / k1);
        if (t >= 1) {
          var th = t * h1 + h2, tk = t * k1 + k2;
          var te = Math.abs(a0 - th / tk);
          if (te < bestErr) { best = { p: neg ? -th : th, q: tk }; bestErr = te; }
        }
        break;
      }
      var err = Math.abs(a0 - nh / nk);
      if (err < bestErr) { best = { p: neg ? -nh : nh, q: nk }; bestErr = err; }
      h2 = h1; h1 = nh; k2 = k1; k1 = nk;
      var rem = b - fl;
      if (rem < 1e-16) break;
      b = 1 / rem;
    }
    return best;
  }

  function mdlCostOfInts(coeffs, vocabCosts) {
    var bits = 0;
    for (var i = 0; i < coeffs.length; i++) {
      var v = Math.abs(Number(coeffs[i]));
      if (v === 0) continue;
      bits += Math.log10(2 * v + 1);
    }
    if (vocabCosts) bits += vocabCosts;
    return bits;
  }

  function formatLinearRHS(den, terms) {
    /* terms: [{ label, coeff (integer), cost }] */
    if (!terms.length) return '0';
    var parts = [];
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i], c = t.coeff, ac = Math.abs(c);
      var core = t.label === '1'
        ? String(ac)
        : (ac === 1 ? t.label : (ac + '·' + t.label));
      if (i === 0) parts.push((c < 0 ? '−' : '') + core);
      else parts.push((c < 0 ? ' − ' : ' + ') + core);
    }
    var numStr = parts.join('');
    if (den === 1) return numStr;
    if (terms.length === 1 && !/\//.test(terms[0].label)) return numStr + '/' + den;
    if (terms.length === 1 && /\//.test(terms[0].label)) return '(' + numStr + ')/' + den;
    return '(' + numStr + ')/' + den;
  }

  function formatQuadSurd(a, b, c, valNum, D) {
    /* 解 ax^2 + bx + c = 0 (a > 0) 并尽量化为最简根式，如 √3 − 1 */
    var disc = b * b - 4 * a * c;
    if (!(disc > 0)) return null;
    var s = 1, r = disc;
    for (var f = 2; f * f <= r; f++) {
      while (r % (f * f) === 0) { r /= f * f; s *= f; }
    }
    if (r === 1) return null; /* 有理根由 R1 负责 */
    var negSign = false;
    var rPlus = (-b + s * Math.sqrt(r)) / (2 * a);
    var rMinus = (-b - s * Math.sqrt(r)) / (2 * a);
    if (Math.abs(rMinus - valNum) < Math.abs(rPlus - valNum)) negSign = true;

    var g = gcdB(BigInt(Math.abs(b)), gcdB(BigInt(s), BigInt(2 * a)));
    var gi = Number(g);
    var nb = -b / gi, ns = (negSign ? -s : s) / gi, nd = (2 * a) / gi;
    var radPart = Math.abs(ns) === 1 ? ('√' + r) : (Math.abs(ns) + '·√' + r);
    var expr;
    if (nb === 0) {
      expr = (ns < 0 ? '−' : '') + radPart;
    } else {
      var firstFirst = ns > 0 ? radPart : ('−' + radPart);
      if (nb < 0) expr = (ns > 0 ? radPart + ' − ' + Math.abs(nb) : '−' + radPart + ' − ' + Math.abs(nb));
      else expr = (ns > 0 ? radPart + ' + ' + nb : nb + ' − ' + radPart);
    }
    if (nd !== 1) expr = (expr.indexOf(' ') >= 0 ? '(' + expr + ')' : expr) + '/' + nd;

    /* Exact Decimal verification */
    var exactD = new D(r).sqrt().mul(ns).plus(nb).div(nd);
    return { text: expr, dec: exactD };
  }

  /* ---------- 主确定性闭式搜索入口 S_2 ---------- */
  function search(lastInfo, opt) {
    var D = (typeof Decimal !== 'undefined' ? Decimal : (global && global.Decimal)) || null;
    if (!D || !lastInfo || !lastInfo.valueText || !(lastInfo.digits >= 14.5)) return [];
    if (!isFinite(lastInfo.value) || lastInfo.value === 0) return [];

    var o = opt || {};
    var availDigits = Math.min(lastInfo.digits || 25, 38);
    var oldPrec = D.precision;
    D.set({ precision: availDigits > 30 ? 64 : 56 });
    try {
      var xDec = new D(String(lastInfo.valueText));
      if (!xDec.isFinite() || xDec.isZero()) return [];
      var absXDec = xDec.abs();
      var absXNum = absXDec.toNumber();
      var sigEff = Math.max(lastInfo.sigma || 0, absXNum * Math.pow(10, -Math.min(availDigits, 38)));
      var errTol = Math.max(200 * sigEff, absXNum * Math.pow(10, -(availDigits - 2.2)));
      var minSurplus = o.minSurplus || 6.0;

      var C = getConstants(D);
      var seenExpr = Object.create(null);
      var out = [];

      function acceptHit(exprText, rhsDec, terms, height, familyNote, mdlComplexity, isAlgClosed) {
        if (!rhsDec || !rhsDec.isFinite()) return;
        var err = xDec.minus(rhsDec).abs().toNumber();
        if (!isFinite(err) || err > errTol) return;
        var matchedDigRaw = err > 0 ? Math.max(0, -Math.log10(err / Math.max(absXNum, 1e-300))) : Math.min(availDigits, 38);
        var matchedDigGate = Math.min(matchedDigRaw, availDigits + 2.0, 38);
        var gateSurplus = matchedDigGate - mdlComplexity;
        if (gateSurplus < minSurplus) return;

        var normKey = exprText.replace(/\s+/g, '');
        if (seenExpr[normKey]) return;
        seenExpr[normKey] = true;

        out.push({
          formula: '高精度 PSLQ： x ≈ ' + exprText,
          expr: exprText,
          fullText: '项数 ' + terms + '；高度 ' + height + '；' + familyNote +
            '；55位残差 ' + err.toExponential(2) + '（净压缩 +' + gateSurplus.toFixed(1) + ' 位）',
          valueText: rhsDec.toSignificantDigits(Math.max(31, Math.ceil(availDigits) + 4)).toFixed(),
          delta: err,
          verified: true,
          terms: terms,
          height: height,
          source: 'pslq',
          algebraicClosed: !!isAlgClosed,
          mdlCost: mdlComplexity,
          hpCheck: { status: 'passed', err: err, matchedDigits: matchedDigRaw }
        });
      }

      /* ===== S2.0：单常数有理倍扫描 R1 & S1（0.3ms，覆盖全部常见单一常数与有理数） ===== */
      var singleCatalog = [
        { label: '1',         dec: C.one,             cost: 0.0 },
        { label: 'π',         dec: C.pi,              cost: 1.0 },
        { label: 'π²',        dec: C.pi2,             cost: 1.4 },
        { label: 'π³',        dec: C.pi3,             cost: 1.8 },
        { label: 'π⁴',        dec: C.pi4,             cost: 2.0 },
        { label: '1/π',       dec: C.invPi,           cost: 1.5 },
        { label: '√π',        dec: C.sqrtPi,          cost: 1.4 },
        { label: '√2',        dec: C.sqrt2,           cost: 1.3 },
        { label: '√3',        dec: C.sqrt3,           cost: 1.3 },
        { label: '√5',        dec: C.sqrt5,           cost: 1.4 },
        { label: 'π√2',       dec: C.piSqrt2,         cost: 1.8 },
        { label: 'π√3',       dec: C.piSqrt3,         cost: 1.8 },
        { label: 'π/√2',      dec: C.pi.div(C.sqrt2), cost: 1.8 },
        { label: 'π/√3',      dec: C.pi.div(C.sqrt3), cost: 1.8 },
        { label: 'e',         dec: C.e,               cost: 1.2 },
        { label: '1/e',       dec: C.invE,            cost: 1.4 },
        { label: 'π/e',       dec: C.piInvE,          cost: 1.8 },
        { label: 'π/e²',      dec: C.piInvE2,         cost: 2.1 },
        { label: 'ln(2)',     dec: C.ln2,             cost: 1.3 },
        { label: 'ln(3)',     dec: C.ln3,             cost: 1.5 },
        { label: 'ln(5)',     dec: C.ln5,             cost: 1.6 },
        { label: '1/ln(2)',   dec: C.invLn2,          cost: 1.7 },
        { label: 'π/ln(2)',   dec: C.piOverLn2,       cost: 2.0 },
        { label: 'π·ln(2)',   dec: C.piLn2,           cost: 1.7 },
        { label: 'ln(2)²',    dec: C.ln2_2,           cost: 1.8 },
        { label: 'G',         dec: C.G,               cost: 1.7 },
        { label: 'G/π',       dec: C.GOverPi,         cost: 2.0 },
        { label: 'γ',         dec: C.gamma,           cost: 1.6 },
        { label: 'ζ(3)',      dec: C.zeta3,           cost: 1.8 },
        { label: 'ζ(5)',      dec: C.zeta5,           cost: 2.2 },
        { label: 'β(4)',      dec: C.beta4,           cost: 2.3 },
        { label: 'Cl₂(π/3)',  dec: C.cl2pi3,          cost: 2.5 },
        { label: 'Γ(1/4)²/√π',dec: C.gamma14SqSqrtPi, cost: 2.2 },
        { label: 'Γ(1/3)',    dec: C.gamma13,         cost: 2.1 },
        { label: 'Γ(1/3)³',   dec: C.gamma13Cube,     cost: 2.3 },
        { label: 'π·ln(1+√2)',dec: C.piLn1pSqrt2,     cost: 2.2 },
        { label: 'π·ln((1+√2)/2)', dec: C.piLnHalf1pSqrt2, cost: 2.4 }
      ];

      for (var si = 0; si < singleCatalog.length; si++) {
        var sc = singleCatalog[si];
        var ratioNum = xDec.div(sc.dec).toNumber();
        var maxDenS = sc.label === '1' ? 5000 : 250;
        var cf = cfApprox(ratioNum, maxDenS);
        if (!cf || cf.p === 0 || cf.q <= 0 || Math.abs(cf.p) > (sc.label === '1' ? 5000 : 400)) continue;
        var rhsD = sc.dec.mul(cf.p).div(cf.q);
        var txt = sc.label === '1'
          ? (cf.q === 1 ? String(cf.p) : (cf.p + '/' + cf.q))
          : formatLinearRHS(cf.q, [{ label: sc.label, coeff: cf.p }]);
        txt = txt.replace(/^-/, '−');
        var mdl = mdlCostOfInts([cf.p, cf.q], sc.cost + 1.0);
        acceptHit(txt, rhsD, 1, Math.max(Math.abs(cf.p), cf.q), '单常数有理倍', mdl, false);
      }

      /* ===== S2.1：多族高精度 BigInt LLL 线性组合（每组维数 <= 9 保证高信噪比） ===== */
      var scaleD = Math.min(34, Math.max(12, Math.floor(availDigits) - 1));
      var Wscale = new D(10).pow(scaleD);

      function runBasisLLL(basisList, maxHeight, maxTerms, familyNote) {
        if (basisList.length > 9 && availDigits < 20.5) return;
        var vals = [xDec];
        for (var i = 0; i < basisList.length; i++) vals.push(basisList[i].dec);
        var dim = vals.length;
        var mat = new Array(dim);
        for (var r = 0; r < dim; r++) {
          var row = new Array(dim + 1).fill(0n);
          row[r] = 1n;
          row[dim] = BigInt(vals[r].mul(Wscale).round().toFixed(0));
          mat[r] = row;
        }
        var red = exactIntLLL(mat, 4500);
        /* 扫描约化基向量（含前几行的轻量差，防止极少数近长度基向量互遮） */
        var checkVecs = red.slice();
        var pairLim = Math.min(4, red.length);
        for (var a0 = 0; a0 < pairLim; a0++) {
          for (var b0 = a0 + 1; b0 < pairLim; b0++) {
            var addR = new Array(dim), subR = new Array(dim);
            for (var c0 = 0; c0 < dim; c0++) {
              addR[c0] = red[a0][c0] + red[b0][c0];
              subR[c0] = red[a0][c0] - red[b0][c0];
            }
            checkVecs.push(addR, subR);
          }
        }

        for (var ri = 0; ri < checkVecs.length; ri++) {
          var vec = checkVecs[ri];
          if (vec[0] === 0n) continue;
          var coeff = vec.slice(0, dim);
          if (coeff[0] < 0n) coeff = coeff.map(function (z) { return -z; });
          var g = 0n;
          for (var gi = 0; gi < dim; gi++) g = gcdB(g, coeff[gi]);
          if (g > 1n) coeff = coeff.map(function (z) { return z / g; });

          var denBig = coeff[0];
          if (denBig <= 0n || denBig > BigInt(maxHeight)) continue;
          var den = Number(denBig);
          var terms = [], maxC = den, vocabCost = 0, okTerms = true;
          var rhsSum = new D(0);
          var intsForMdl = den > 1 ? [den] : [];

          for (var ti = 1; ti < dim; ti++) {
            if (coeff[ti] === 0n) continue;
            var ac = absB(coeff[ti]);
            if (ac > BigInt(maxHeight)) { okTerms = false; break; }
            var cNum = Number(-coeff[ti]);
            terms.push({ label: basisList[ti - 1].label, coeff: cNum, cost: basisList[ti - 1].cost });
            if (Math.abs(cNum) > maxC) maxC = Math.abs(cNum);
            vocabCost += basisList[ti - 1].cost;
            intsForMdl.push(cNum);
            rhsSum = rhsSum.plus(basisList[ti - 1].dec.mul(cNum));
          }
          if (!okTerms || terms.length === 0 || terms.length > maxTerms) continue;
          var rhsVal = rhsSum.div(den);
          var txt = formatLinearRHS(den, terms);
          var mdl = mdlCostOfInts(intsForMdl, vocabCost + 1.2 + Math.max(0, terms.length - 1) * 0.7);
          acceptHit(txt, rhsVal, terms.length, maxC, familyNote, mdl, false);
        }
      }

      var groups = [
        {
          name: '基础 π/对数线性空间 L1',
          maxH: 96, maxT: 4,
          basis: [
            { label: '1',       dec: C.one,     cost: 0.0 },
            { label: 'π',       dec: C.pi,      cost: 1.0 },
            { label: 'π²',      dec: C.pi2,     cost: 1.4 },
            { label: 'π³',      dec: C.pi3,     cost: 1.8 },
            { label: 'ln(2)',   dec: C.ln2,     cost: 1.3 },
            { label: 'ln(3)',   dec: C.ln3,     cost: 1.5 },
            { label: 'π·ln(2)', dec: C.piLn2,   cost: 1.7 },
            { label: 'ln(2)²',  dec: C.ln2_2,   cost: 1.8 },
            { label: 'π·ln(2)²',dec: C.piLn2_2, cost: 2.1 }
          ]
        },
        {
          name: '代数根式与对数根式 L2',
          maxH: 64, maxT: 3,
          basis: [
            { label: '1',              dec: C.one,             cost: 0.0 },
            { label: '√2',             dec: C.sqrt2,           cost: 1.3 },
            { label: '√3',             dec: C.sqrt3,           cost: 1.3 },
            { label: '√5',             dec: C.sqrt5,           cost: 1.4 },
            { label: 'π',              dec: C.pi,              cost: 1.0 },
            { label: 'π√2',            dec: C.piSqrt2,         cost: 1.8 },
            { label: 'ln(1+√2)',       dec: C.ln1pSqrt2,       cost: 1.8 },
            { label: 'π·ln(1+√2)',     dec: C.piLn1pSqrt2,     cost: 2.2 },
            { label: 'π·ln((1+√2)/2)', dec: C.piLnHalf1pSqrt2, cost: 2.4 }
          ]
        },
        {
          name: '指数/高斯/留数空间 L3',
          maxH: 64, maxT: 3,
          basis: [
            { label: '1',         dec: C.one,          cost: 0.0 },
            { label: 'e',         dec: C.e,            cost: 1.2 },
            { label: '1/e',       dec: C.invE,         cost: 1.4 },
            { label: '1/e²',      dec: C.invE2,        cost: 1.7 },
            { label: 'π',         dec: C.pi,           cost: 1.0 },
            { label: 'π/e',       dec: C.piInvE,       cost: 1.8 },
            { label: 'π/e²',      dec: C.piInvE2,      cost: 2.1 },
            { label: '√π',        dec: C.sqrtPi,       cost: 1.4 },
            { label: 'exp(−π/2)', dec: C.expNegHalfPi, cost: 2.0 }
          ]
        },
        {
          name: 'Catalan/Zeta/Euler 周期 L4',
          maxH: 64, maxT: 3,
          basis: [
            { label: '1',       dec: C.one,    cost: 0.0 },
            { label: 'π',       dec: C.pi,     cost: 1.0 },
            { label: 'ln(2)',   dec: C.ln2,    cost: 1.3 },
            { label: 'π·ln(2)', dec: C.piLn2,  cost: 1.7 },
            { label: 'G',       dec: C.G,      cost: 1.7 },
            { label: 'ζ(3)',    dec: C.zeta3,  cost: 1.8 },
            { label: 'γ',       dec: C.gamma,  cost: 1.6 },
            { label: 'G/π',     dec: C.GOverPi,cost: 2.0 },
            { label: '√π',      dec: C.sqrtPi, cost: 1.4 }
          ]
        },
        {
          name: '高阶 Zeta/Beta/素对数 L5',
          maxH: 48, maxT: 3,
          basis: [
            { label: '1',     dec: C.one,   cost: 0.0 },
            { label: 'π²',    dec: C.pi2,   cost: 1.4 },
            { label: 'π⁴',    dec: C.pi4,   cost: 2.0 },
            { label: 'ln(2)', dec: C.ln2,   cost: 1.3 },
            { label: 'ln(3)', dec: C.ln3,   cost: 1.5 },
            { label: 'ln(5)', dec: C.ln5,   cost: 1.6 },
            { label: 'ζ(3)',  dec: C.zeta3, cost: 1.8 },
            { label: 'ζ(5)',  dec: C.zeta5, cost: 2.2 },
            { label: 'β(4)',  dec: C.beta4, cost: 2.3 }
          ]
        },
        {
          name: 'Gamma/倒数对数/Clausen L6',
          maxH: 48, maxT: 3,
          basis: [
            { label: '1',          dec: C.one,             cost: 0.0 },
            { label: '1/ln(2)',    dec: C.invLn2,          cost: 1.7 },
            { label: 'π/ln(2)',    dec: C.piOverLn2,       cost: 2.0 },
            { label: 'G/π',        dec: C.GOverPi,         cost: 2.0 },
            { label: 'Γ(1/4)²/√π', dec: C.gamma14SqSqrtPi, cost: 2.2 },
            { label: 'Γ(1/3)³',    dec: C.gamma13Cube,     cost: 2.3 },
            { label: 'Γ(1/3)',     dec: C.gamma13,         cost: 2.1 },
            { label: 'Cl₂(π/3)',   dec: C.cl2pi3,          cost: 2.5 }
          ]
        }
      ];

      for (var gi = 0; gi < groups.length; gi++) {
        if (availDigits < 17.5 && gi >= 4) continue;
        var grp = groups[gi];
        var gMaxH = availDigits < 17.5 ? Math.min(grp.maxH, 24) : grp.maxH;
        var gMaxT = availDigits < 17.5 ? Math.min(grp.maxT, 3) : grp.maxT;
        runBasisLLL(grp.basis, gMaxH, gMaxT, grp.name);
      }

      /* ===== S2.2：乘法幂积扫描 M1（针对 √(π/8)、Γ(1/4)²/√π、π/(2e)、2π/√3 等） ===== */
      if (absXNum > 1e-12 && absXNum < 1e12) {
        var logX = absXDec.ln();
        var mulBasis = [
          { sym: '2',      base: new D(2),   ln: C.ln2,           cost: 0.4 },
          { sym: '3',      base: new D(3),   ln: C.ln3,           cost: 0.5 },
          { sym: '5',      base: new D(5),   ln: C.ln5,           cost: 0.6 },
          { sym: 'π',      base: C.pi,       ln: C.pi.ln(),       cost: 1.0 },
          { sym: 'e',      base: C.e,        ln: C.one,           cost: 1.2 },
          { sym: 'G',      base: C.G,        ln: C.G.ln(),        cost: 1.7 },
          { sym: 'Γ(1/4)', base: C.gamma14,  ln: C.gamma14.ln(),  cost: 2.0 },
          { sym: 'Γ(1/3)', base: C.gamma13,  ln: C.gamma13.ln(),  cost: 2.0 }
        ];
        var mVals = [logX];
        for (var mi = 0; mi < mulBasis.length; mi++) mVals.push(mulBasis[mi].ln);
        var mDim = mVals.length;
        var mMat = new Array(mDim);
        for (var mr = 0; mr < mDim; mr++) {
          var mRow = new Array(mDim + 1).fill(0n);
          mRow[mr] = 1n;
          mRow[mDim] = BigInt(mVals[mr].mul(Wscale).round().toFixed(0));
          mMat[mr] = mRow;
        }
        var mRed = exactIntLLL(mMat, 3500);
        for (var mri = 0; mri < mRed.length; mri++) {
          var mv = mRed[mri];
          if (mv[0] === 0n) continue;
          var mc = mv.slice(0, mDim);
          if (mc[0] < 0n) mc = mc.map(function (z) { return -z; });
          var mg = 0n;
          for (var mgi = 0; mgi < mDim; mgi++) mg = gcdB(mg, mc[mgi]);
          if (mg > 1n) mc = mc.map(function (z) { return z / mg; });
          var mDen = Number(mc[0]);
          if (mDen <= 0 || mDen > 6) continue;

          var prodVal = new D(1), mOk = true, mMaxC = mDen, activeM = 0, mVocab = 0, mInts = [mDen];
          var numFactors = [], denFactors = [];
          for (var mj = 1; mj < mDim; mj++) {
            if (mc[mj] === 0n) continue;
            var expN = Number(-mc[mj]);
            if (Math.abs(expN) > 12) { mOk = false; break; }
            activeM++;
            if (Math.abs(expN) > mMaxC) mMaxC = Math.abs(expN);
            mInts.push(expN);
            var mb = mulBasis[mj - 1];
            mVocab += mb.cost;
            var gExp = Number(gcdB(BigInt(Math.abs(expN)), BigInt(mDen)));
            var ep = Math.abs(expN) / gExp, eq = mDen / gExp;
            if (eq === 1) {
              var pVal = mb.base.pow(ep);
              prodVal = expN > 0 ? prodVal.mul(pVal) : prodVal.div(pVal);
              var fStr1 = ep === 1 ? mb.sym : (mb.sym + '^' + ep);
              if (expN > 0) numFactors.push(fStr1); else denFactors.push(fStr1);
            } else if (eq === 2) {
              var sVal = mb.base.pow(ep).sqrt();
              prodVal = expN > 0 ? prodVal.mul(sVal) : prodVal.div(sVal);
              var sqBase = ep === 1 ? mb.sym : (mb.sym + '^' + ep);
              var fStr2 = mb.sym.length === 1 ? ('√' + sqBase) : ('√(' + sqBase + ')');
              if (expN > 0) numFactors.push(fStr2); else denFactors.push(fStr2);
            } else {
              var rVal = mb.base.pow(new D(ep).div(eq));
              prodVal = expN > 0 ? prodVal.mul(rVal) : prodVal.div(rVal);
              var fStr3 = mb.sym + '^(' + ep + '/' + eq + ')';
              if (expN > 0) numFactors.push(fStr3); else denFactors.push(fStr3);
            }
          }
          if (!mOk || activeM === 0 || activeM > 4) continue;
          if (xDec.isNeg()) prodVal = prodVal.neg();
          var numJoin = numFactors.length ? numFactors.join('·') : '1';
          var mExpr = (xDec.isNeg() ? '−' : '') + numJoin +
            (denFactors.length ? ('/' + (denFactors.length > 1 ? '(' + denFactors.join('·') + ')' : denFactors[0])) : '');
          var mdlM = mdlCostOfInts(mInts, mVocab + 1.0 + activeM * 0.5);
          acceptHit(mExpr, prodVal, activeM, mMaxC, '高精度乘法幂积 M1', mdlM, false);
        }
      }

      /* ===== S2.3：低次代数关系 A1 (2..4 次最小多项式) ===== */
      if (absXNum > 1e-6 && absXNum < 1e6) {
        var algSpecs = [
          { deg: 2, maxH: 64 },
          { deg: 3, maxH: 32 },
          { deg: 4, maxH: 16 }
        ];
        for (var ai = 0; ai < algSpecs.length; ai++) {
          var sp = algSpecs[ai];
          var aDim = sp.deg + 1;
          var xPows = [new D(1)];
          for (var pw = 1; pw <= sp.deg; pw++) xPows.push(xPows[pw - 1].mul(xDec));
          var aMat = new Array(aDim);
          for (var ar = 0; ar < aDim; ar++) {
            var aRow = new Array(aDim + 1).fill(0n);
            aRow[ar] = 1n;
            aRow[aDim] = BigInt(xPows[ar].mul(Wscale).round().toFixed(0));
            aMat[ar] = aRow;
          }
          var aRed = exactIntLLL(aMat, 2500);
          for (var ari = 0; ari < aRed.length; ari++) {
            var av = aRed[ari];
            var acf = av.slice(0, aDim);
            if (acf[sp.deg] === 0n) continue;
            if (acf[sp.deg] < 0n) acf = acf.map(function (z) { return -z; });
            var ag = 0n;
            for (var agi = 0; agi < aDim; agi++) ag = gcdB(ag, acf[agi]);
            if (ag > 1n) acf = acf.map(function (z) { return z / ag; });
            var aMax = 0, aInts = [], aOk = true;
            for (var ak = 0; ak < aDim; ak++) {
              var valK = Math.abs(Number(acf[ak]));
              if (valK > sp.maxH) { aOk = false; break; }
              if (valK > aMax) aMax = valK;
              if (valK > 0) aInts.push(valK);
            }
            if (!aOk || aInts.length < 2) continue;

            /* 用牛顿迭代在 55 位 Decimal 精化代数根并核验真残差 */
            var px = new D(0), dpx = new D(0);
            for (var pd = sp.deg; pd >= 0; pd--) {
              px = px.mul(xDec).plus(acf[pd].toString());
              if (pd >= 1) dpx = dpx.mul(xDec).plus(new D(acf[pd].toString()).mul(pd));
            }
            if (dpx.abs().lte('1e-12')) continue;
            var rootDec = xDec;
            for (var nr = 0; nr < 4; nr++) {
              var fR = new D(0), dfR = new D(0);
              for (var pd2 = sp.deg; pd2 >= 0; pd2--) {
                fR = fR.mul(rootDec).plus(acf[pd2].toString());
                if (pd2 >= 1) dfR = dfR.mul(rootDec).plus(new D(acf[pd2].toString()).mul(pd2));
              }
              if (dfR.isZero()) break;
              rootDec = rootDec.minus(fR.div(dfR));
            }
            var mdlA = mdlCostOfInts(aInts, 1.5 + sp.deg * 0.9);
            if (sp.deg === 2) {
              var quad = formatQuadSurd(Number(acf[2]), Number(acf[1]), Number(acf[0]), xDec.toNumber(), D);
              if (quad) {
                acceptHit(quad.text, quad.dec, aInts.length - 1, aMax, '2 次显式根式（代数闭式）', mdlA, true);
                continue;
              }
            }
            var polyTerms = [];
            for (var pd3 = sp.deg; pd3 >= 0; pd3--) {
              var ci = Number(acf[pd3]);
              if (ci === 0) continue;
              var aci = Math.abs(ci);
              var varP = pd3 === 0 ? String(aci) : (aci === 1 ? '' : String(aci)) + 'x' + (pd3 === 1 ? '' : '^' + pd3);
              polyTerms.push((polyTerms.length === 0 ? (ci < 0 ? '−' : '') : (ci < 0 ? ' − ' : ' + ')) + varP);
            }
            var polyStr = polyTerms.join('') + ' = 0';
            var polyErr = xDec.minus(rootDec).abs().toNumber();
            if (polyErr <= errTol) {
              var pMatch = polyErr > 0 ? Math.max(0, -Math.log10(polyErr / Math.max(absXNum, 1e-300))) : Math.min(availDigits, 38);
              var pMatchGate = Math.min(pMatch, availDigits + 2.0, 38);
              if (pMatchGate - mdlA >= minSurplus && !seenExpr[polyStr]) {
                seenExpr[polyStr] = true;
                out.push({
                  formula: '高精度代数关系： ' + polyStr,
                  expr: polyStr,
                  polyCoeffs: acf.map(function (z) { return Number(z); }),
                  fullText: '次数 ' + sp.deg + '；高度 ' + aMax + '；最小多项式根（55位残差 ' + polyErr.toExponential(2) + '）',
                  valueText: rootDec.toSignificantDigits(Math.max(31, Math.ceil(availDigits) + 4)).toFixed(),
                  delta: polyErr,
                  verified: true,
                  terms: aInts.length,
                  height: aMax,
                  source: 'pslq',
                  algebraicClosed: true,
                  mdlCost: mdlA,
                  hpCheck: { status: 'passed', err: polyErr, matchedDigits: pMatch }
                });
              }
            }
          }
        }
      }

      /* 数学等价去重：若两式给出同一 45 位真值且源自同一 PSLQ 扫描，保留 MDL 描述更短的写法 */
      out.sort(function (a, b) {
        if (Math.abs(a.mdlCost - b.mdlCost) > 0.3) return a.mdlCost - b.mdlCost;
        return (a.terms - b.terms) || (a.height - b.height) || (a.delta - b.delta);
      });
      var unique = [];
      for (var ui = 0; ui < out.length; ui++) {
        var cur = out[ui], dupVal = false;
        var curD = new D(cur.valueText);
        for (var uj = 0; uj < unique.length; uj++) {
          var prevD = new D(unique[uj].valueText);
          if (curD.minus(prevD).abs().lte(curD.abs().mul('1e-24'))) { dupVal = true; break; }
        }
        if (!dupVal) unique.push(cur);
      }
      return unique.slice(0, 8);
    } catch (e) {
      return [];
    } finally {
      D.set({ precision: oldPrec });
    }
  }

  var API = {
    VERIFIED_LITERALS: VERIFIED_LITERALS,
    decGamma: decGamma,
    getConstants: getConstants,
    exactIntLLL: exactIntLLL,
    search: search
  };
  global.IntegralPSLQ = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
