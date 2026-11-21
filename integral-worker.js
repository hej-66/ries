/* integral-worker.js — 定积分数值求积 + 确定性 PSLQ 后台计算 Worker。
 * 目的：彻底解除主线程阻塞，使手机与低配电脑能跑完与桌面端一致的高精度计算预算，
 * 并支持用户随时停止或重算。
 */
'use strict';

var initError = null;
try {
  var q = (typeof self !== 'undefined' && self.location && self.location.search) ? self.location.search : '';
  importScripts('assets/decimal.js', 'integral-hp.js' + q, 'integral-core.js' + q, 'integral-pslq.js' + q);
} catch (e) {
  initError = String(e && e.message || e);
}

self.onmessage = function (ev) {
  var d = ev && ev.data ? ev.data : {};
  var id = d.id;
  if (initError) {
    self.postMessage({ id: id, type: 'error', message: '后台计算线程初始化失败：' + initError });
    return;
  }
  if (!self.IntegralCore) {
    self.postMessage({ id: id, type: 'error', message: '后台计算线程缺少 IntegralCore' });
    return;
  }
  var t0 = Date.now();
  try {
    self.postMessage({ id: id, type: 'progress', phase: 'integrate' });
    var f = self.IntegralCore.compile(d.src);
    var r = self.IntegralCore.integrate(f, d.aRaw, d.bRaw, d.opt || {});
    var pslqRows = [];
    if (d.runPslq && r && r.verdict === 'ok' && !r.isNearZero && r.value !== 0 &&
        r.valueText && r.digits >= 14.5 && self.IntegralPSLQ && self.IntegralPSLQ.search) {
      self.postMessage({ id: id, type: 'progress', phase: 'pslq' });
      pslqRows = self.IntegralPSLQ.search(r);
    }
    self.postMessage({
      id: id,
      type: 'done',
      result: r,
      pslqRows: pslqRows,
      elapsedMs: Date.now() - t0
    });
  } catch (e) {
    self.postMessage({
      id: id,
      type: 'error',
      message: String(e && e.message || e)
    });
  }
};
