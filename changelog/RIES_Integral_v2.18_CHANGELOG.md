# RIES 定积分版 v2.18 更新日志

> 修复针对 `∫₀^∞ ln(((1+sin x)/(1-sin x))²) dx / x = π²` 及其同族「含可积对数/根式奇点 + float64 二次相消下溢壁 + 周期交错振荡无穷尾」积分的系统性误判发散与高精度求积问题。

## 一、根因诊断
1. **float64 二次相消下溢壁误判为指数溢出**：
   - 如 `1 - sin(x)` 在 `x = π/2` 附近或 `1 - cos(x)` 在 `x = 0` 附近满足 $1 - \sin(\pi/2 - \delta) \approx \delta^2 / 2$；在双精度中当 $\delta \lesssim 10^{-8}$ 时直接下溢归零，导致 $\ln(\dots)$ 或负幂函数突然跳变到 `±Infinity`。
   - 原 `analyzeEndpoint` 的 `D3` 溢出发散检查把这类 `±Infinity` 相消下溢壁统一按 `slope: -1.5, divergent: true` 判发散，且连带让 `hasInteriorDivergence`、有限端点与 `oscillatory` 都误短路为「发散」。
   - 原 `refinePoleOrPeak` 的三分割遇到两侧同为 `Infinity` 平台时未居中二分定位，而是偏向一侧边缘。
2. **振荡面板内含周期奇点与真发散极点混杂**：
   - `oscillatory` 在寻零循环中踩到周期奇点（如 `x = (k+1/2)π`）时容易被 `Infinity` 卡住步长；面对带内部奇点的半周期面板，`integrateOnce` 自适应 Simpson 会在相消壁前耗尽求值次数并报 `bad` 或耗时数十秒。
   - 同时 `tanhSinh` 需要能识别「仅在工作精度一半（`~prec/2`）附近因二次相消产生的可积分奇点尾部」，且在 `integrateOscGeneral` 中，对于 `1/sqrt(|cos x|)` 一类代数奇点必须消除 `refineZeroDec` 硬编码 `fTol = 1e-40` 与节点表过早按 `w` 截断引入的 $O(\sqrt{\varepsilon})$ 残差。

## 二、核心修复
1. **float64 相消下溢壁识别与平台居中（[integral-core.js](file:///c:/Users/%E9%BB%84%E5%B0%94%E6%9D%B0/Desktop/RIES_%E7%A7%AF%E5%88%86%E7%89%88/integral-core.js)）**：
   - `analyzeEndpoint` 在 `D3` 块识别全 `±Infinity` 且在紧邻边界处有限值可界定（`tailAllInf && |vEdge| < 1e100 && dBad <= 1e-4 * W`）的二次相消壁，裁剪最末 2 个失真点后交回 `D1/D2` 真实渐近阶判定并保留 `integrableSingularity` 标记。
   - `refinePoleOrPeak` 遇双侧 `Infinity` 平台执行对称二分居中；`scanInterior` 在无穷区间限制局部探针跨度不越过相邻周期；`hasInteriorDivergence` 显式透传区间端点有限性标志。
2. **振荡寻零越奇点、真极点守卫与面板拉伸 GL16（[integral-core.js](file:///c:/Users/%E9%BB%84%E5%B0%94%E6%9D%B0/Desktop/RIES_%E7%A7%AF%E5%88%86%E7%89%88/integral-core.js)）**：
   - `oscillatory` 遇到孤立奇点支持跳跃穿越，并对 `tan(x)/x` 等变号极点通过 `isRaySingDivergent` 立即拦截为 `divergent`。
   - 对含内部可积奇点的半周期面板，按奇点拆分并用 `stretchEnds` + 开区间 16 点 Gauss-Legendre（`6` vs `12` 片）求积，避开双精度端点相消同时将双精度阶段耗时从十余秒降至毫秒级。
3. **高精度奇点拆分双指数与零点精度对齐（[integral-hp.js](file:///c:/Users/%E9%BB%84%E5%B0%94%E6%9D%B0/Desktop/RIES_%E7%A7%AF%E5%88%86%E7%89%88/integral-hp.js)）**：
   - `tanhSinh` 增加工作精度半程相消尾安全收敛判据与保守 `tailTrunc` 估计；提高 `fastPrec` 下界保护 18 位二次相消场景。
   - `integrateOscGeneral` 新增 `hasPanelSings` 模式：按档位构建节点并复用 `tanh-sinh` 节点表（工作精度随距奇点距离 `dExp` 自适应提升），单面板校准 `Luse`，并通过动态 `refineZeroDec` `fTol = tol * 1e-8`、`zTol = 10^-(deepPrec - 6)` 与 `minDeltaStop` 消除 `1/sqrt(|cos x|)` 等代数奇点精度瓶颈。

## 三、版本同步与新增验收测试
- 同步 `index.html`、`integral-glue.js` 版本标注至 **v2.18**。
- 在 `tools/test-framework-acceptance.js` 新增 **4.5 节**（覆盖 `ln(((1+sin x)/(1-sin x))²)/x` → `π²`、半角对数变体 `π²/2`、`ln|tan(x/2+π/4)|/x` → `π²/4`、`sin x/(x√|cos x|)` → `Γ(1/4)²/(2√(2π))`、`ln(1-sin x)`、`ln(1-cos x)`，以及 8 项真发散对比用例）。
