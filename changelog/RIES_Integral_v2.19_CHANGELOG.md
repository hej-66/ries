# RIES 定积分版 v2.19 更新日志

> 优化表达式输入法（支持无歧义「单个整体」一元函数自变量免括号输入），同步全链路解析器、前端实时解析预览、例题入口与「输入法规范与简写教程」。

## 一、免括号简写解析与防歧义边界
1. **统一 AST 词法/语法引擎（[integral-core.js](file:///c:/Users/%E9%BB%84%E5%B0%94%E6%9D%B0/Desktop/RIES_%E7%A7%AF%E5%88%86%E7%89%88/integral-core.js)、[integral-hp.js](file:///c:/Users/%E9%BB%84%E5%B0%94%E6%9D%B0/Desktop/RIES_%E7%A7%AF%E5%88%86%E7%89%88/integral-hp.js)）**：
   - 新增连写标识符动态规划拆分 `splitGluedIdent` 与空白边界感知词法器 `tokenize`，支持：
     - 单变量/常数连写：`sinx` → `sin(x)`，`cospi` → `cos(pi)`，`lne` → `ln(e)`
     - 复合一元函数：`sinsinx` → `sin(sin(x))`，`lncosx` → `ln(cos(x))`
     - 幂与一元负号整体：`sin2^x` → `sin(2^x)`，`sinx^2` → `sin(x^2)`，`exp-x^2` → `exp(-(x^2))`
     - 紧邻无空格单项式：`sin2x` → `sin(2*x)`，`sin2x^2` → `sin(2*x^2)`，`sin2pix` → `sin(2*pi*x)`，`sin0.5x` → `sin(0.5*x)`，`sin1e-2x` → `sin(1e-2*x)`
     - 相邻整体隐式乘法：`sinxcosx` → `sin(x)*cos(x)`，`xsinx` → `x*sin(x)`
   - **明确优先级与防歧义规则**：
     - 显式括号优先：`sin(x)^2` / `(sinx)^2` 解析为 `(sin(x))^2`，与 `sinx^2`（`sin(x^2)`）严格区分。
     - 保留整体常量名：`ln2`（ln 2）、`ln10`、`log2`、`log10`、`atan2` 等完整保留；`ln2x` 正确拆分为 `ln(2*x)`，`xln2` 拆分为 `x*ln(2)`。
     - 变量与常数后禁止紧跟数字：`x2`、`e2`、`pi2` 立即明确报错提示改用 `^` 或 `*`；二元函数（`min`/`max`/`pow`/`atan2`/`hypot`）与无自变量函数名也明确报错提示写法。
   - 新增规范化接口 `IntegralCore.normalizeExpr`，并让 `compile` 自动存储规范化 `f.src`，确保 AST 种子抽取、折点探测、Split-Decimal 端点消去、符号积分预处理（[integral-symbolic.js](file:///c:/Users/%E9%BB%84%E5%B0%94%E6%9D%B0/Desktop/RIES_%E7%A7%AF%E5%88%86%E7%89%88/integral-symbolic.js)）及积分结构剖析（`analyzeIntegralProfile`）与用户输入简写完全同构；积分上下限同步支持 `sqrt2`、`2pi`、`ln2` 等缩写。

## 二、前端交互、教程与布局优化
1. **实时简写解析预览（[index.html](file:///c:/Users/%E9%BB%84%E5%B0%94%E6%9D%B0/Desktop/RIES_%E7%A7%AF%E5%88%86%E7%89%88/index.html)、[integral-glue.js](file:///c:/Users/%E9%BB%84%E5%B0%94%E6%9D%B0/Desktop/RIES_%E7%A7%AF%E5%88%86%E7%89%88/integral-glue.js)）**：
   - 在 `f(x)` 输入框下方新增 `#igParsePreview` 实时解析预览条：当输入使用了简写并与规范表达式存在结构差异时，高亮展示「简写解析：...」；输入含语法问题时即时给出清晰提示；与标准写法一致时自动隐藏不占空间。
2. **输入法规范与简写教程**：
   - 新增可折叠卡片区 **「输入法规范与简写教程（免括号规则 · 防歧义边界 · 常用函数与常量）」**，与「精度档位与『闭式搜索』开关使用指南」并列收纳在操作按钮条下方，兼顾桌面三栏与手机端自适应排版。
3. **例题与缓存同步**：
   - 例题按钮区新增 **「对数振荡 π²」**（`ln(((1+sinx)/(1-sinx))^2)/x`, `[0, inf]`），移动端优化为 `2×2` 对称网格；同步更新脚本与 Worker 版本号至 **v2.19**。

## 三、回归验证
- 在 [tools/test-framework-acceptance.js](file:///c:/Users/%E9%BB%84%E5%B0%94%E6%9D%B0/Desktop/RIES_%E7%A7%AF%E5%88%86%E7%89%88/tools/test-framework-acceptance.js) 新增 **4.6 节**，覆盖免括号简写等价求值与规范化、高精度 IntegralHP/Split-Decimal 一致性、积分与 PSLQ 闭式复核（`sinx` / `sin2^x` / `exp-x^2` / `ln(((1+sinx)/(1-sinx))^2)/x`）、积分结构画像、符号引擎正则化、非法连写错误拒绝，以及缩写积分上下限。
