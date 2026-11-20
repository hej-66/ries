import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.Decimal = require('../assets/decimal.js');
const glue = require('../integral-glue.js');

test('equivalent integral and sum rewrites are classified as non-closed-form', () => {
  assert.equal(
    glue.isIntegralOrSumForm(
      '积分 / 求和数据库： x ≈ -1/√2·int_0^1 x^-1/2 (1-x)^0 log(x)^0 log(1-x) / (2-x) dx',
      'RATIONAL_LOG_BETA/unit_rational_log_beta; rational beta/log integral family'
    ),
    true
  );
  assert.equal(
    glue.isIntegralOrSumForm('integral/sum database: x ≈ sum_{n=1}^inf 1/(n^3+1)', ''),
    true
  );
  assert.equal(
    glue.isIntegralOrSumForm('RIES 方程： 1/(x) = ln(ln(3))', ''),
    false
  );
  assert.equal(
    glue.isIntegralOrSumForm('Möbius 关系： x ≈ 4·G/π', '比值 = 1.16624; 高度 4'),
    false
  );
});

test('atanh(x)/sqrt(x^2+x) candidates report no reliable closed form instead of pretending integral rewrite is closed', () => {
  const lastInfo = {
    value: 0.6885603792371556,
    valueText: '0.688560379237155657672029298696',
    sigma: 6.89e-26,
    digits: 25
  };
  const rawRows = [
    {
      formula: '积分 / 求和数据库： x ≈ -1/√2·int_0^1 x^-1/2 (1-x)^0 log(x)^0 log(1-x) / (2-x) dx',
      fullText: 'RATIONAL_LOG_BETA; integral family',
      delta: 0, verified: true, terms: 0, height: 4
    },
    {
      formula: 'Möbius 关系： x ≈ (143·e + 204·e^2)/(64·e + 318·e^2 + 230)',
      fullText: '高度 318',
      delta: 4.44e-16, verified: true, terms: 0, height: 318
    },
    {
      formula: 'RIES 方程： exp((x·5)) = ((9·π)+3)',
      fullText: '',
      delta: 8.28e-7, verified: true, terms: 0, height: 0
    },
    {
      formula: '代数关系： 296x^5 + 56x^4 + 40x^3 − 563x^2 + 204x + 55 = 0',
      fullText: '',
      delta: 2.21e-15, verified: true, terms: 0, height: 0
    }
  ];

  const ranked = glue.rankCandidates(rawRows, lastInfo);
  assert.equal(ranked.hasReliableClosed, false);
  assert.equal(ranked.equivIntCount, 1);
  assert.ok(ranked.hpRejectedCount >= 2);
  const eqRow = ranked.rows.find((r) => r.integralForm);
  assert.ok(eqRow);
  assert.equal(eqRow.p, 0);
  assert.equal(eqRow.nonClosed, true);
});

test('asin(x)/sqrt(x^2+x) fake 16-digit Mobius coincidences are refuted in 48-digit Decimal while true closed form passes', () => {
  const lastInfo = {
    value: 0.5913306957450786,
    valueText: '0.5913306957450785871711628815024',
    sigma: 5.91e-26,
    digits: 25
  };

  // True formula passes 48-digit check
  const trueCheck = glue.hpVerifyCandidate('RIES 方程： x ≈ π·ln((1+√2)/2)', lastInfo);
  assert.ok(trueCheck);
  assert.equal(trueCheck.status, 'passed');

  // Fake Float64 Mobius hits are mathematically refuted
  const fakeRows = [
    {
      formula: 'Möbius 关系： x ≈ 38·e^2/(177·e^2 − 396·√2 − 273)',
      fullText: '基 e^2, √2; 高度 396',
      delta: 0, verified: true, terms: 0, height: 396
    },
    {
      formula: 'Möbius 关系： x ≈ (313·G + 59·π·e)/(70·G + 120·π·e + 248)',
      fullText: '基 G, π·e; 高度 313',
      delta: 4.44e-16, verified: true, terms: 0, height: 313
    },
    {
      formula: 'Möbius 关系： x ≈ 388·γ/(186·γ + 197·cos(π/5) + 112)',
      fullText: '基 γ, cos(π/5); 高度 388',
      delta: 4.44e-16, verified: true, terms: 0, height: 388
    },
    {
      formula: '对数组合关系： x ≈ 14/5*1 + 4*log(2) + 1/10*log(3) - 1/10*log(5) - 7/10*π - 27/10*log(π) - 3/10*log(log π) - 7/5*log(log 2) - 6/5*log(log 3)',
      fullText: '9 项基',
      delta: 0, verified: true, terms: 9, height: 27
    },
    {
      formula: '对数组合关系： log|log|x|| ≈ 23/27*1 - 8/27*log(2) - 1/3*log(3) + 1/3*log(5) - 14/27*π + 10/27*log(π) - 1/3*log(log π) + 2/9*log(log 2) - 37/27*log(log 3)',
      fullText: '9 项基',
      delta: 0, verified: true, terms: 9, height: 37
    },
    {
      formula: '积分 / 求和数据库： x ≈ int_0^(pi/2) sin(x)^0 cos(x)^0 log(1-sin(x))^0 log(1+cos(x)^2)^1 dx',
      fullText: 'TRIG_BETA_LOG; integral family',
      delta: 0, verified: true, terms: 0, height: 4
    }
  ];

  const ranked = glue.rankCandidates(fakeRows, lastInfo);
  assert.equal(ranked.hasReliableClosed, false);
  assert.equal(ranked.hpRejectedCount, 5);
  for (const r of ranked.rows) {
    assert.ok(r.p <= 0.01);
  }

  // Even without HP valueText (digits = 14), high-height Mobius must still be capped <= 30%
  const lowPrecRanked = glue.rankCandidates([fakeRows[0]], { value: 0.5913306957450786, sigma: 1e-14, digits: 14 });
  assert.equal(lowPrecRanked.hasReliableClosed, false);
  assert.ok(lowPrecRanked.rows[0].p <= 0.30);
});

test('genuine closed-form RIES equations pass 48-digit Decimal verification and remain #1', () => {
  const lastInfo = {
    value: 10.632887811886484,
    valueText: '10.63288781188648353690927082619',
    sigma: 1.06e-21,
    digits: 22
  };
  const rawRows = [
    {
      formula: 'RIES 方程： 1/(x) = ln(ln(3))',
      fullText: '',
      delta: 8.88e-15, verified: true, terms: 0, height: 0
    },
    {
      formula: 'RIES 方程： root(e,x) = ln(3)',
      fullText: '',
      delta: 0, verified: true, terms: 0, height: 0
    },
    {
      formula: '积分 / 求和数据库： x ≈ int_0^1 x^-1/2 log(1-x) dx',
      fullText: 'integral family',
      delta: 0, verified: true, terms: 0, height: 4
    }
  ];
  const ranked = glue.rankCandidates(rawRows, lastInfo);
  assert.equal(ranked.hasReliableClosed, true);
  assert.equal(ranked.rows[0].hpCheck.status, 'passed');
  assert.ok(ranked.rows[0].p >= 0.8);
});
