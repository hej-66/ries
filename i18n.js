/* i18n.js — 界面中文本地化层
 * 不修改 ries-script.js：运行时翻译静态文案、属性、表头、候选前缀与动态状态。
 * 数学符号、公式、版本号、文件名、id 一律保留。
 */
(function () {
  'use strict';

  // 整句精确匹配（文本节点 trim 后）
  var EXACT = {
    'Target': '目标数值',
    'Parameters': '参数',
    'Hide parameters': '收起参数',
    'Solve': '开始求解',
    'Stop': '停止',
    'Continue higher': '继续更高深度',
    'Ready.': '就绪。',
    'Results ready.': '结果已就绪。',
    'Enter a target and press Solve.': '输入目标数值后点「开始求解」。',
    'Results': '闭式搜索结果',
    'High-precision value': '高精度数值',
    'Computed expression values are displayed here, separately from RIES candidates.': '这里显示可计算表达式的高精度求值结果，与闭式候选分开。',
    'No RIES/table results under the current settings. High-precision values, if any, are shown above.':
      '当前设置下没有闭式候选；高精度数值（若有）显示在上方。',
    'Sort by confidence': '按置信度排序',
    'Original order': '按发现顺序',
    'candidate': '候选',
    'value / root': '数值 / 根',
    'error': '误差',
    'Home': '首页',
    'copy': '复制',
    'expand': '展开',
    'collapse': '收起',

    // 参数面板标题
    'Search depth and display': '搜索深度与显示',
    'Module master switches': '模块总开关',
    'All modules on': '全部开启',
    'All modules off': '全部关闭',
    'Restore default modules': '恢复默认模块',
    'Candidate rows': '候选行数',
    'Displayed candidates per module': '每个模块显示的候选数',
    'Depth': '深度',
    'Max |value|': '中间值绝对值上限',
    'Max relative error': '最大相对误差',
    'Optional final filter on relative error. Leave as Infinity for default behavior.': '可选的相对误差末级筛选；保持 Infinity 即使用默认行为。',
    'Discard generated intermediate expressions whose absolute value is too large.': '丢弃绝对值过大的中间表达式。',
    'Displayed as depth 1,2,3…; internally this maps to the current RIES levels.': '界面显示为深度 1、2、3…，内部映射到当前 RIES 层级。',
    'Maximum candidate rows kept or displayed by most modules.': '多数模块保留或显示的最大候选行数。',
    'Rows kept for this module; default keeps the current default behavior.': '本模块保留的行数；默认值保持原有搜索行为。',
    'Active RIES expression/root search budget for the current depth; 0 means no internal deadline.': '当前深度的 RIES 表达式/求根搜索时限（毫秒）；0 表示不设内部时限。',
    '0 keeps the automatic integer-size-based default.': '0 表示按整数大小自动选择默认值。',
    'Stage time limit (ms)': '阶段时限（毫秒）',
    'Stage time limits are active search budgets after any lazy database package has loaded. Enter':
      '各阶段时限是懒加载数据包完成后的实际搜索预算。输入',
    "to remove that module's internal time deadline. Depth-specific database modules show separate budgets for each depth tier.":
      ' 0 可取消该模块的内部时限。分深度的数据库模块会分别显示各层预算。',
    'Restriction': '符号限制',
    'Digits': '可用数字',
    'Constants': '常数',
    'Unary operations': '一元运算',
    'Binary operations': '二元运算',
    'Only symbols, -S': '仅允许符号（-S）',
    'Never symbols, -N': '禁用符号（-N）',
    'unrestricted': '不限制',
    'on': '开',

    // 模块
    'RIES equation roots': 'RIES 方程求根',
    'Builds unary/binary expressions from digits and constants, then solves equations around the target.':
      '由数字与常数构造一元/二元表达式，再在目标值附近求解方程。',
    'Algebraic polynomial relation': '代数多项式关系',
    'Uses integer relation reconstruction for direct decimal inputs; precision controls remain internal.':
      '对十进制输入做整数关系重建；精度控制保留在内部。',
    'Max degree': '最大次数',
    'Max coefficient': '最大系数',
    'Max coefficient height': '最大系数高度',
    'Log-combination relation': '对数组合关系',
    'Searches sparse linear relations among selected logarithmic or raw constants.':
      '在选定的对数常数或原始常数中搜索稀疏线性关系。',
    'Default basis': '默认基',
    'Low-precision linear combo': '低精度线性组合',
    'Looks for one-, two-, and three-term rational combinations of the low-precision constant basis.':
      '搜索低精度常数基的一项、两项、三项有理组合。',
    'Möbius constant relations': 'Möbius 常数关系',
    'Checks fractional-linear relations in selected constants, including direct, log|x|, and exp(x) variants.':
      '检查选定常数的分式线性关系，含直接、log|x| 与 exp(x) 变体。',
    'Möbius pass': 'Möbius 通道',
    'Relation passes': '关系通道',
    'Constant database': '常数数据库',
    'Compares x and selected transforms with the 300-entry constant database by rational, algebraic, Möbius, and log-linear passes.':
      '把 x 及选定变换与 300 条常数库做有理、代数、Möbius 与对数线性比对。',
    'Target transforms': '目标变换',
    'Depth transforms': '深度变换',
    'Hard constant database': '硬常数数据库',
    'Loads the pruned harddb once at depth 4; depths 5/6 reuse the same rows with richer comparison constants.':
      '深度 4 时一次性加载剪枝后的硬常数库；深度 5/6 复用同一批行并启用更丰富的比较常数。',
    'Database depths': '数据库深度',
    'Rational multiplier height': '有理乘子高度',
    'Max stored parameter height': '存储参数高度上限',
    'Depth 4 time limit (ms)': '深度 4 时限（毫秒）',
    'Depth 5 time limit (ms)': '深度 5 时限（毫秒）',
    'Depth 6 time limit (ms)': '深度 6 时限（毫秒）',
    'Depth 4 scans all remaining harddb rows with simple comparison constants; 0 means no internal deadline.':
      '深度 4 用简单比较常数扫描全部剩余硬常数行；0 表示不设内部时限。',
    'Depth 5 scans the same rows with core comparison constants; 0 means no internal deadline.':
      '深度 5 用核心比较常数扫描同一批行；0 表示不设内部时限。',
    'Depth 6 scans the same rows with extended comparison constants; 0 means no internal deadline.':
      '深度 6 用扩展比较常数扫描同一批行；0 表示不设内部时限。',
    'Hypergeometric pFq database': '超几何 pFq 数据库',
    'Lazy-loads cumulative depth 4/5/6 pFq chunks and compares H with multiplier families.':
      '按需加载深度 4/5/6 的累计 pFq 数据块，并把 H 与各乘子族比对。',
    'Multiplier families': '乘子族',
    'Integral/sum database': '积分 / 求和数据库',
    'Lazy-loads integral and series identities: depth 4 uses the simplest low-height rows, while depths 5/6 use the full table with richer multiplier families.':
      '按需加载积分与级数恒等式：深度 4 用最低高度的简单行，深度 5/6 用全表并配更丰富的乘子族。',
    'L-function database': 'L 函数数据库',
    'Compares decimal inputs against L(f,s) rational, quadratic, and logarithmic catalogued forms.':
      '把十进制输入与 L(f,s) 的有理、二次、对数编目形式比对。',
    'Integer search': '整数搜索',
    'For exact integer input: factorization, structured/precomputed database, and deterministic shortform search.':
      '针对精确整数输入：因数分解、结构化/预计算数据库与确定性简式搜索。',
    'Integer shortform effort': '整数简式搜索强度',
    'Factorization time override (ms)': '因数分解时限覆盖（毫秒）',
    'factorization': '因数分解',
    'structured/precomputed database': '结构化 / 预计算数据库',
    'deterministic shortform': '确定性简式',
    'allow external/worker QS or ECM handoff': '允许外部 / Worker 二次筛或 ECM 分解',
    'Optional candidates': '可选候选',
    'Continued fraction, base expansions, and digit statistics': '连分数、进制展开与数字统计',
    'special decimal constants': '特殊十进制常数',

    // 选项
    'depth 1': '深度 1', 'depth 2': '深度 2', 'depth 3': '深度 3',
    'depth 4': '深度 4', 'depth 5': '深度 5', 'depth 6': '深度 6',
    'depth 7': '深度 7', 'depth 8': '深度 8', 'depth 9': '深度 9',
    'depth 4: 2F1/3F2': '深度 4：2F1/3F2',
    'depth 5: 4F3/5F4': '深度 5：4F3/5F4',
    'depth 6: full pFq': '深度 6：完整 pFq',
    'depth 4: full rows/simple constants': '深度 4：全行 / 简单常数',
    'depth 5: core constants': '深度 5：核心常数',
    'depth 6: extended constants': '深度 6：扩展常数',
    'depth 4: simple 1/5': '深度 4：简单 1/5',
    'depth 5: full data': '深度 5：完整数据',
    'depth 6: deep multipliers': '深度 6：深度乘子',
    '1-term scan': '1 项扫描',
    '2-term exhaustive scan': '2 项穷举扫描',
    '3-term prioritized scan': '3 项优先扫描',
    '4 triple basis': '4 组三元基',
    '0 · ~1 s': '0 · 约 1 秒', '1 · ~2 s': '1 · 约 2 秒',
    '2 · ~4 s': '2 · 约 4 秒', '3 · ~8 s': '3 · 约 8 秒',
    '4 · ~16 s': '4 · 约 16 秒', '5 · ~32 s': '5 · 约 32 秒',
    '6 · ~64 s': '6 · 约 64 秒', '7 · ~128 s': '7 · 约 128 秒',
    '1-term': '1 项', '2-term': '2 项', '3-term': '3 项',
    'direct x': '直接 x', 'log base': '对数底', 'log forms': '对数形式',
    'rational forms': '有理形式', 'quadratic forms': '二次形式',
    'power law': '幂律', 'exponential law': '指数律', 'log-scale law': '对数尺度律',
    'core Gamma': '核心 Gamma', 'deep/extended': '深度 / 扩展',
    'constructible-style': '可构造式', 'rational-style': '有理式',
    'higher algebraic': '高阶代数', 'simple rational/π/root': '简单有理 / π / 根式',
    'affine in c': '关于 c 仿射', 'rational b/c': '有理 b/c',
    'rational · |A|': '有理 · |A|', 'log-linear/subset': '对数线性 / 子集',
    'quadratic/reciprocal': '二次 / 倒数', 'log|log|x||': 'log|log|x||',
    'integer output': '整数输出', 'root': '根式', 'square': '平方',
    'neg': '取负', 'power': '幂', 'reciprocal': '倒数', 'sqrt': '开方',
    'ln': 'ln', 'exp': 'exp', 'factorization': '因数分解',
    'depth 4 time limit (ms)': '深度 4 时限（毫秒）',
    'depth 5 time limit (ms)': '深度 5 时限（毫秒）',
    'depth 6 time limit (ms)': '深度 6 时限（毫秒）',
    'depth>4 triple basis': '深度 >4 三元基',
    'formula': '公式', 'form': '形式', 'q-expansion': 'q 展开',
    'Level': '层级', 'weight': '权重',
    'Euler γ': '欧拉常数 γ'
  };

  // 长文本 / 动态文本里的短语替换（先长后短）
  var PHRASES = [
    ['Enter a target and press Solve.', '输入目标数值后点「开始求解」。'],
    ['No RIES/table results under the current settings. High-precision values, if any, are shown above.',
     '当前设置下没有闭式候选；高精度数值（若有）显示在上方。'],
    ['Computed expression values are displayed here, separately from RIES candidates.',
     '这里显示可计算表达式的高精度求值结果，与闭式候选分开。'],

    // 候选前缀（公式本体保留）
    ['RIES equation:', 'RIES 方程：'],
    ['low-precision linear combo:', '低精度线性组合：'],
    ['hard constant database:', '硬常数数据库：'],
    ['integral/sum database:', '积分 / 求和数据库：'],
    ['constant database:', '常数数据库：'],
    ['log|c| linear relation:', 'log|c| 线性关系：'],
    ['log-combination relation:', '对数组合关系：'],
    ['Möbius relation:', 'Möbius 关系：'],
    ['algebraic relation:', '代数关系：'],
    ['L-rational #', 'L 函数有理比 #'],
    ['primitive relation:', '原始关系：'],
    ['predicted x ≈', '预测 x ≈'],
    ['relative residual', '相对残差'],
    ['exhaustive bucket scan', '穷举桶扫描'],
    ['full-coefficient scan', '全系数扫描'],
    ['prioritized', '优先'],
    ['1-term', '1 项'], ['2-term', '2 项'], ['3-term', '3 项'],
    ['terms', '项数'],
    ['height', '高度'],
    ['product =', '乘积 ='], ['rhs =', '右端 ='], ['ratio =', '比值 ='],
    ['basis', '基'], ['target', '目标'], ['tier', '层'],
    ['degree-3 ratio b/c', '三次有理比 b/c'],
    ['α root of', 'α 为以下方程的根'], ['α satisfies', 'α 满足'],
    ['generated basic constant', '生成的基础常数'],
    ['Natural logarithm of natural logarithm of 3.', 'ln(ln 3)，即 3 的自然对数的自然对数。'],
    ['Archimedes’ constant, the circle constant.', '阿基米德常数，即圆周率。'],
    ['Natural logarithm of 2.', '2 的自然对数。'],
    ['The unit constant; allows affine rational offsets.', '单位常数；允许仿射有理偏移。'],
    ['Clausen function value at pi/6.', 'π/6 处的 Clausen 函数值。'],
    ['Dirichlet beta value at 6.', 's=6 处的 Dirichlet beta 值。'],
    ['status verified', '状态已校验'],
    ['source data', '来源数据'],
    ['chunk level', '数据块层级'],
    ['original source row', '原始来源行'],
    ['active row', '当前行'],

    // 状态栏动态文案
    ['Enter a number or computable expression', '输入数值或可计算表达式'],
    ['Enter', '输入'],
    ['Results ready.', '结果已就绪。'],
    ['Ready.', '就绪。'],
    ['Sort by confidence', '按置信度排序'],
    ['Original order', '按发现顺序'],
    ['Hide parameters', '收起参数'],
    ['Parameters', '参数'],
    ['loading package', '加载数据包'],
    ['Loading', '正在加载'],
    ['filtered 80k hard-constant database', '筛选后的 8 万条硬常数库'],
    ['precomputed shortform database', '预计算简式数据库'],
    ['hard-constant database package', '硬常数库数据包'],
    ['hard-constant database', '硬常数库'],
    ['constant databaseChecking', '常数库 · 正在检查'],
    ['Checking low-precision constant database matches', '正在检查低精度常数库匹配'],
    ['low-precision constant database matches', '低精度常数库匹配'],
    ['low-precision', '低精度'],
    ['matches', '匹配'],
    ['constant database', '常数库'],
    ['Checking', '正在检查'],
    ['deep relation scan', '深度关系扫描'],
    ['candidate(s)', '个候选'],
    ['candidates', '个候选'],
    [' integer database', ' 整数数据库'],
    ['lazy-loading', '按需加载'],
    [' package…', ' 数据包…'],
    ['No RIES/table results', '没有闭式候选'],
    ['High-precision values, if any, are shown above.', '高精度数值（若有）显示在上方。'],
    ['Open external ECM/SIQS calculator', '打开外部 ECM/SIQS 计算器'],
    ['For hard 40+ digit composites, open Alpertron ECM/SIQS and paste',
     '对 40 位以上的硬合数，可打开 Alpertron ECM/SIQS 并粘贴'],
    ['decimal.js is not loaded; high-precision expression evaluation is unavailable.',
     'decimal.js 未加载，无法进行高精度表达式求值。'],

    // 表头 / 通用
    ['candidate', '候选'], ['value / root', '数值 / 根'], ['error', '误差'],
    ['formula', '公式'], ['form', '形式'], ['q-expansion', 'q 展开'],
    ['Level', '层级'], ['weight', '权重'], ['Home', '首页'],
    ['copy', '复制']
  ];

  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, MJX_CONTAINER: 1, TEXTAREA: 1, SVG: 1 };
  function skipAncestor(node) {
    var p = node.parentNode;
    while (p && p.nodeType === 1) {
      if (SKIP[p.tagName.replace('-', '_')] || SKIP[p.tagName]) return true;
      p = p.parentNode;
    }
    return false;
  }

  function translateText(raw, inCode) {
    var t = String(raw);
    var trimmed = t.trim();
    if (EXACT[trimmed] !== undefined) {
      return t.replace(trimmed, EXACT[trimmed]);
    }
    var out = t;
    for (var i = 0; i < PHRASES.length; i++) {
      var a = PHRASES[i][0], b = PHRASES[i][1];
      if (inCode && i > 12) break;   // <code> 内只做候选前缀替换，不动数学符号
      if (out.indexOf(a) >= 0) out = out.split(a).join(b);
    }
    return out;
  }

  function walkText(root, fn) {
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var n, list = [];
    while ((n = tw.nextNode())) list.push(n);
    list.forEach(fn);
  }

  function translateNode(n) {
    if (!n.nodeValue || skipAncestor(n)) return;
    var inCode = false, p = n.parentNode;
    while (p && p.nodeType === 1) {
      if (p.tagName === 'CODE') { inCode = true; break; }
      p = p.parentNode;
    }
    var out = translateText(n.nodeValue, inCode);
    if (out !== n.nodeValue) n.nodeValue = out;
  }

  var ATTRS = ['title', 'placeholder', 'aria-label'];
  function translateAttrs(root) {
    var els = root.querySelectorAll ? root.querySelectorAll('*') : [];
    Array.prototype.forEach.call(els, function (e) {
      ATTRS.forEach(function (a) {
        var v = e.getAttribute && e.getAttribute(a);
        if (!v) return;
        var out = EXACT[v.trim()] !== undefined ? v.replace(v.trim(), EXACT[v.trim()]) : translateText(v, false);
        if (out !== v) e.setAttribute(a, out);
      });
    });
    if (root.getAttribute) ATTRS.forEach(function (a) {
      var v = root.getAttribute(a);
      if (!v) return;
      var out = EXACT[v.trim()] !== undefined ? v.replace(v.trim(), EXACT[v.trim()]) : translateText(v, false);
      if (out !== v) root.setAttribute(a, out);
    });
  }

  function run(root) {
    root = root || document.body;
    if (!root) return;
    walkText(root, translateNode);
    translateAttrs(root);
  }

  // 搜索期间容器会被高频整体重写，观察器拿到的节点可能已脱离文档。
  // 对这几个高频区域做低频幂等兜底，保证最终留在页面上的文案也是中文。
  function runHot() {
    ['status', 'resultBody', 'resultTools'].forEach(function (id) {
      var e = document.getElementById(id);
      if (e) run(e);
    });
    var h = document.querySelector('.data thead tr');
    if (h) run(h);
  }

  function boot() {
    document.documentElement.lang = 'zh-CN';
    var t = document.title.replace('RIES v12.0.2 · cybcat', 'RIES 12.0.2 · 定积分与闭式搜索');
    if (t !== document.title) document.title = t;
    run(document.body);
    if (window.MutationObserver) {
      // 同步处理：状态栏高频重写，延迟批处理会让英文短暂闪回。
      // 每次变更立即翻译新增节点，并顺带扫一遍高频容器（幂等）。
      var obs = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var r = records[i];
          if (r.type === 'characterData') translateNode(r.target);
          else Array.prototype.forEach.call(r.addedNodes || [], function (n) {
            if (n.nodeType === 3) translateNode(n);
            else if (n.nodeType === 1) run(n);
          });
        }
        runHot();
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    runHot();
    setInterval(runHot, 600);   // 低频保险：搜索结束后的最终一帧
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
