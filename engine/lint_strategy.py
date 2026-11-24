"""Helm 策略静态检查：回测前用 AST 检查 agent 写的 LEAN Python 代码（只解析，绝不执行）。

用法（只用标准库）：
    python -I lint_strategy.py < input.json
    input.json = {"files": [{"name": "main.py", "content": "..."}], "entries": ["main.py"]}
输出 JSON：{"errors": [{file, line, code, msg_zh}], "warnings": [...]}
  errors   必须修复，有任何一条就不运行回测
  warnings 提醒，不阻止回测
entries 里的文件必须有继承 QCAlgorithm 的类；其它文件当作项目里的辅助模块。
"""
import ast
import json
import re
import sys

# 禁止导入：文件、进程、网络、反射、序列化等。策略只能用 LEAN 给的数据和 helm_data。
FORBIDDEN_IMPORTS = {
    "os", "sys", "subprocess", "socket", "shutil", "ctypes", "multiprocessing", "threading",
    "importlib", "pickle", "requests", "urllib", "http", "ftplib", "smtplib", "asyncio",
    # 同类的绕过途径
    "builtins", "io", "pathlib", "glob", "tempfile", "shelve", "marshal", "pty", "_thread",
    "inspect", "gc", "urllib3", "httpx", "aiohttp", "telnetlib", "xmlrpc", "webbrowser", "dill",
    # 清单外原来只是警告、但能直接读写文件 / 开进程 / 联网 / 进 .NET 的模块
    "posix", "nt", "_posixsubprocess", "_io", "_socket", "codecs", "fileinput", "linecache", "tokenize",
    "zipfile", "tarfile", "gzip", "bz2", "lzma", "sqlite3", "dbm", "runpy", "code", "codeop", "pdb",
    "zipimport", "pkgutil", "signal", "mmap", "socketserver", "ssl", "select", "selectors", "poplib",
    "imaplib", "concurrent", "clr", "System", "Microsoft", "Python",
}
# 不经 import 也能拿到的危险模块名：`from AlgorithmImports import *` 会带出 os、sys；
# 允许的库上也挂着它们（pd.io.common.os、helm_data.os）。裸名字、from 导入的名字、模块属性都按这个清单拦。
SENSITIVE_NAMES = {
    "os", "sys", "subprocess", "socket", "shutil", "ctypes", "importlib", "builtins", "io", "pathlib",
    "pickle", "marshal", "inspect", "gc", "multiprocessing", "threading", "posix", "nt", "_os", "_sys", "_io",
}
DUNDER_STR = re.compile(r"__\w+__")
ALLOWED_IMPORTS = {
    "AlgorithmImports", "numpy", "pandas", "math", "statistics", "datetime", "collections",
    "itertools", "functools", "json", "typing", "enum", "dataclasses", "decimal", "random",
    "scipy", "helm_data", "__future__",
}
FORBIDDEN_CALLS = {"open", "exec", "eval", "compile", "__import__", "globals", "locals", "vars", "breakpoint", "input"}
SAFE_DUNDERS = {"__init__", "__name__", "__doc__", "__qualname__", "__module__"}
SAFE_DUNDER_STRINGS = SAFE_DUNDERS | {"__main__", "__future__"}
BAD_RESOLUTIONS = {"minute", "second", "tick", "hour"}
HELM_DATA_CLASSES = {"HelmUniverse", "HelmSignals", "HelmMacro", "HelmDataset", "HelmVol", "HelmBreadth", "HelmShortCost"}
UNIVERSE_CALLS = {
    "add_universe", "add_universe_selection", "set_universe_selection",
    "AddUniverse", "AddUniverseSelection", "SetUniverseSelection",
}
UNIVERSE_NAMES = {
    "CoarseFundamental", "FineFundamental", "CoarseFundamentalUniverseSelectionModel",
    "FineFundamentalUniverseSelectionModel",
}
# 读写文件的库函数（策略不能自己读文件，helm_data 会替你读）
FILE_READERS = {"read_csv", "read_parquet", "read_pickle", "read_json", "read_excel", "read_hdf",
                "read_feather", "read_sql", "read_table", "read_fwf", "read_html", "read_xml",
                "load", "loadtxt", "genfromtxt", "fromfile", "save", "savez", "savetxt", "memmap"}
FILE_WRITERS = {"to_csv", "to_pickle", "to_parquet", "to_excel", "to_hdf", "to_feather", "to_sql", "tofile"}
ORDER_CALLS = {"market_order", "limit_order", "stop_market_order", "stop_limit_order",
               "market_on_close_order", "market_on_open_order", "limit_if_touched_order",
               "MarketOrder", "LimitOrder", "StopMarketOrder", "StopLimitOrder",
               "MarketOnCloseOrder", "MarketOnOpenOrder", "buy", "sell", "order", "Buy", "Sell", "Order"}
SETUP_CALLS = {
    "set_start_date": ("SetStartDate", "没有设置开始日期 self.set_start_date(...)，回测区间会用 LEAN 默认值，结果不可复现"),
    "set_cash": ("SetCash", "没有设置初始资金 self.set_cash(...)，会用 LEAN 默认的 100000"),
    "set_benchmark": ("SetBenchmark", "没有设置基准 self.set_benchmark(\"SPY\")，网站的基准对比和统计检验会用默认基准，最好显式写出"),
}


def top(mod):
    return (mod or "").split(".")[0]


def num(node):
    """数字字面量（含负号）返回 float，否则 None。"""
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return float(node.value)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        v = num(node.operand)
        if v is not None:
            return -v if isinstance(node.op, ast.USub) else v
    return None


def call_name(node):
    """调用的函数名：foo(...) -> foo，a.b.foo(...) -> foo。"""
    f = node.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return None


def dotted(node):
    """a.b.c -> "a.b.c"（只处理名字和属性链）。"""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


class Linter(ast.NodeVisitor):
    def __init__(self, fname, local_modules, stored=(), alias_values=()):
        self.fname = fname
        self.local = local_modules
        self.stored = set(stored)            # 文件里被赋值过的名字（自己的变量，比如 open = bar.open）
        self.alias_values = set(alias_values)  # 直接出现在赋值号右边的名字节点（x = eval 这种起别名）
        self.called = set()                  # 作为被调用函数出现的节点（调用本身另有检查，避免重复报）
        self.checked_consts = set()
        self.errors = []
        self.warnings = []
        self.modules = {}       # 别名 -> 真实模块名（import numpy as np -> np: numpy）
        self.random_names = set()  # from random import choice -> choice
        self.random_uses = []
        self.seeded = False
        self.setup_seen = set()
        self.short_nodes = []      # 明显在做空的地方：set_holdings / PortfolioTarget 负权重、下单负数量
        self.borrow_cost = False   # 用了 HelmShortCost
        self.cash_account = None   # AccountType.CASH 出现的位置

    def err(self, node, code, msg):
        self.errors.append({"file": self.fname, "line": getattr(node, "lineno", 0), "code": code, "msg_zh": msg})

    def warn(self, node, code, msg):
        self.warnings.append({"file": self.fname, "line": getattr(node, "lineno", 0), "code": code, "msg_zh": msg})

    # ---------- imports ----------
    def check_module(self, node, mod, level=0):
        t = top(mod)
        if level or t in self.local:
            if t and t not in self.local:
                self.warn(node, "import-unknown", f"相对导入的模块 {mod} 不是项目里的文件")
            return
        if t in FORBIDDEN_IMPORTS:
            self.err(node, "import-forbidden",
                     f"不能导入 {t}：策略不能读写文件、开进程、联网或做反射。数据用 add_equity / history 取，qlib 数据用 helm_data（HelmSignals / HelmUniverse），删掉这行")
        elif t not in ALLOWED_IMPORTS:
            self.warn(node, "import-unlisted",
                      f"导入了 {mod}，不在常用库清单里（AlgorithmImports、numpy、pandas、scipy、math 等）。确认 LEAN 环境里有这个库，并且没有读文件或联网")

    def visit_Import(self, node):
        for a in node.names:
            self.check_module(node, a.name)
            if a.asname:
                self.modules[a.asname] = a.name
            else:
                self.modules[top(a.name)] = top(a.name)
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        self.check_module(node, node.module or "", node.level)
        mod = node.module or ""
        for a in node.names:
            name = a.asname or a.name
            full = f"{mod}.{a.name}" if mod else a.name
            if a.name in SENSITIVE_NAMES and top(mod) not in FORBIDDEN_IMPORTS and not (node.level or top(mod) in self.local):
                self.err(node, "import-forbidden", f"不能从 {mod} 里导入 {a.name}：这是借别的库拿到被禁止的模块，删掉这行")
            if top(mod) == "helm_data" and a.name != "*" and a.name.startswith("_"):
                self.err(node, "private-attr", f"不能从 helm_data 导入 {a.name}：只用 {' / '.join(sorted(HELM_DATA_CLASSES))}")
            if a.name in FILE_READERS and top(mod) in ("pandas", "numpy"):
                self.err(node, "file-io", f"不能从 {mod} 导入 {a.name}：策略不能自己读写文件。价格用 history，qlib 数据用 helm_data")
            if mod == "numpy" and a.name == "random":
                self.modules[name] = "numpy.random"
            elif mod == "random" or mod == "numpy.random":
                if a.name == "seed":
                    self.modules[name] = full
                self.random_names.add(name)
            else:
                self.modules[name] = full
        self.generic_visit(node)

    # ---------- names / attributes ----------
    def visit_Name(self, node):
        if node.id == "HelmShortCost":
            self.borrow_cost = True
        if "__" in node.id and node.id.startswith("__") and node.id.endswith("__") and node.id not in SAFE_DUNDERS:
            self.err(node, "dunder", f"不能使用 {node.id}：双下划线的内部对象可以绕过限制，策略里不需要")
        if node.id in UNIVERSE_NAMES:
            self.err(node, "universe", f"不能用 {node.id}：本地没有 QC 的 coarse/fine 选股数据。按历史成分股选股用 helm_data 的 HelmUniverse（先 prepare_universe），少量股票直接写出代码列表")
        if isinstance(node.ctx, ast.Load):
            own = node.id in self.stored and id(node) not in self.alias_values
            if node.id in FORBIDDEN_CALLS and id(node) not in self.called and not own and not node.id.startswith("__"):
                self.err(node, "call-forbidden", f"不能把 {node.id} 当变量传来传去（起别名、当参数）：这是在绕过对 {node.id}() 的限制")
            if node.id in SENSITIVE_NAMES and node.id not in self.modules and node.id not in self.stored:
                self.err(node, "import-forbidden", f"不能使用 {node.id}：它没有被导入，是 `from AlgorithmImports import *` 之类顺带带出来的模块；策略不能读写文件、开进程或联网")
        self.generic_visit(node)

    def visit_Constant(self, node):
        v = node.value
        if isinstance(v, str) and id(node) not in self.checked_consts and DUNDER_STR.fullmatch(v) and v not in SAFE_DUNDER_STRINGS:
            self.err(node, "dunder", f"不能出现字符串 \"{v}\"：双下划线名字可以配合 getattr 等绕过限制，策略里不需要")

    def visit_Attribute(self, node):
        a = node.attr
        if isinstance(node.value, ast.Name) and node.value.id == "AccountType" and a.upper() == "CASH":
            self.cash_account = self.cash_account or node
        if a == "HelmShortCost":
            self.borrow_cost = True
        if a.startswith("__") and a.endswith("__") and a not in SAFE_DUNDERS:
            self.err(node, "dunder", f"不能访问 .{a}：双下划线属性（如 __class__、__subclasses__）可以绕过限制，策略里不需要")
        if isinstance(node.value, ast.Name) and node.value.id == "Resolution" and a.lower() in BAD_RESOLUTIONS:
            self.err(node, "resolution", f"Resolution.{a} 用不了：本地只有日线数据，订阅和 history 都改成 Resolution.DAILY")
        if a in UNIVERSE_NAMES:
            self.err(node, "universe", f"不能用 {a}：本地没有 QC 的 coarse/fine 选股数据，改用 helm_data 的 HelmUniverse")
        if a.startswith("_") and not (a.startswith("__") and a.endswith("__")):
            base = node.value
            if not (isinstance(base, ast.Name) and base.id in ("self", "cls")):
                self.err(node, "private-attr",
                         f"不能读别的对象的下划线属性 .{a}：helm_data 把整份数据（包括回测当天之后的行）存在下划线属性里，"
                         f"读它就是偷看未来。只用公开方法：latest / top / members / is_member / value / history / events_until")
        if a in SENSITIVE_NAMES or (a in FILE_READERS and id(node) not in self.called):
            mod = self.module_of(node.value)
            if mod and a in SENSITIVE_NAMES:
                self.err(node, "import-forbidden", f"不能访问 {mod}.{a}：这是借别的库拿到被禁止的模块")
            elif mod and top(mod) in ("pandas", "numpy"):
                self.err(node, "file-io", f"不能引用 {mod}.{a}：策略不能自己读写文件（给读文件函数起别名也不行）")
        self.generic_visit(node)

    def visit_ClassDef(self, node):
        # 继承 helm_data 的类，就能在子类里用 self._by 读到完整数据，绕过上面的下划线规则
        for b in node.bases:
            bn = b.id if isinstance(b, ast.Name) else b.attr if isinstance(b, ast.Attribute) else None
            # 别名导入（from helm_data import HelmSignals as HS）：按导入记录还原真名
            if isinstance(b, ast.Name) and bn in self.modules:
                bn = self.modules[bn].split(".")[-1]
            if bn in HELM_DATA_CLASSES:
                self.err(node, "private-attr", f"不能继承 {bn}：子类可以直接读到它存的完整数据（包括未来的行）。直接用 {bn}(...) 的公开方法")
        self.generic_visit(node)

    # ---------- calls ----------
    def module_of(self, node):
        """表达式如果是某个导入的模块（或其子模块），返回真实模块名。"""
        d = dotted(node)
        if not d:
            return None
        head, _, rest = d.partition(".")
        if head not in self.modules:
            return None
        base = self.modules[head]
        return f"{base}.{rest}" if rest else base

    def visit_Call(self, node):
        f = node.func
        name = call_name(node)
        self.called.add(id(f))
        if isinstance(f, ast.Name) and f.id in FORBIDDEN_CALLS:
            what = "读写文件" if f.id == "open" else "动态执行代码、拿到全局/局部对象或等待输入"
            self.err(node, "call-forbidden", f"不能调用 {f.id}()：策略里不能{what}。数据用 LEAN 的 add_equity / history，qlib 数据用 helm_data")
        if isinstance(f, ast.Name) and f.id in ("getattr", "setattr", "delattr", "hasattr") and len(node.args) >= 2:
            k = node.args[1]
            if isinstance(k, ast.Constant) and isinstance(k.value, str) and "__" in k.value:
                self.checked_consts.add(id(k))
                self.err(node, "dunder", f"不能用 {f.id}(…, \"{k.value}\") 访问双下划线属性")
            elif isinstance(k, ast.Constant) and isinstance(k.value, str) and k.value.startswith("_") and not (
                    isinstance(node.args[0], ast.Name) and node.args[0].id in ("self", "cls")):
                self.err(node, "private-attr", f"不能用 {f.id}(…, \"{k.value}\") 读别的对象的下划线属性：helm_data 的完整数据（含未来的行）存在那里")
            elif isinstance(k, ast.Constant) and isinstance(k.value, str):
                m0 = self.module_of(node.args[0])
                if m0 and (k.value in SENSITIVE_NAMES or (k.value in FILE_READERS and top(m0) in ("pandas", "numpy"))):
                    self.err(node, "import-forbidden", f"不能用 {f.id}({m0}, \"{k.value}\")：这是在绕过导入和读文件的限制")
            elif isinstance(k, (ast.Name, ast.Attribute, ast.Subscript)):
                # 属性名放在变量里（n = "_by"; getattr(sig, n)）静态查不出来：除了 self / cls，属性名必须直接写成字符串
                if not (isinstance(node.args[0], ast.Name) and node.args[0].id in ("self", "cls")):
                    self.err(node, "private-attr", f"{f.id}() 的属性名要直接写成字符串：放在变量里没法检查是不是在读 helm_data 存的完整数据（含未来的行）")
            else:
                # 拼出来的属性名（"__cl" + "ass__"、f"__{x}__"）：碎片里有双下划线或以下划线开头就拦
                bits = [c.value for c in ast.walk(k) if isinstance(c, ast.Constant) and isinstance(c.value, str)]
                if any("__" in b or b.startswith("_") for b in bits):
                    self.err(node, "dunder", f"不能用 {f.id}() 加拼接的字符串访问下划线属性")
            if f.id in ("setattr", "delattr") and self.module_of(node.args[0]):
                self.err(node, "setattr-module", f"不能用 {f.id}() 修改模块 {self.module_of(node.args[0])}：会改掉库的行为")
        # operator.attrgetter("_by") / methodcaller：和 getattr 一样能读下划线属性
        if name in ("attrgetter", "methodcaller"):
            for a in node.args[:None if name == "attrgetter" else 1]:
                if not (isinstance(a, ast.Constant) and isinstance(a.value, str)):
                    self.err(node, "private-attr", f"{name}() 的属性名要直接写成字符串")
                elif any(seg.startswith("_") for seg in a.value.split(".")):
                    self.err(node, "private-attr", f"不能用 {name}(\"{a.value}\") 读下划线属性：helm_data 的完整数据（含未来的行）存在那里")
        if isinstance(f, ast.Attribute):
            if name in ("download", "Download"):
                self.err(node, "network", f"不能调用 .{name}()：策略不能联网下载。价格用 add_equity / history，宏观数据用 helm_data 的 HelmMacro")
            if name in UNIVERSE_CALLS:
                self.err(node, "universe", f"不能用 {name}：本地没有 QC 的 coarse/fine 选股数据。按历史成分股选股用 helm_data 的 HelmUniverse（先 prepare_universe），少量股票直接写出代码列表再逐个 add_equity")
            mod = self.module_of(f.value)
            if name in FILE_READERS and mod and top(mod) in ("pandas", "numpy"):
                self.err(node, "file-io", f"不能用 {dotted(f)}() 读写文件：策略不能自己读文件。价格用 history，qlib 打分和股票池用 helm_data")
            if name in FILE_WRITERS:
                self.err(node, "file-io", f"不能用 .{name}() 写文件：要看数据用 self.debug / self.log 打到日志里")
            # 随机数
            if mod in ("random", "numpy.random"):
                self.random_call(node, name)
        elif isinstance(f, ast.Name) and f.id in self.random_names:
            self.random_call(node, f.id)
        # 下单数量写死
        if name in ORDER_CALLS and isinstance(f, ast.Attribute):
            q = node.args[1] if len(node.args) >= 2 else next((k.value for k in node.keywords if k.arg == "quantity"), None)
            v = num(q) if q is not None else None
            if v is not None and v != 0:
                self.warn(node, "fixed-quantity",
                          f"{name} 下单数量写死为 {q.value if isinstance(q, ast.Constant) else v:g} 股：股价和资金变化后仓位会失控。改用 set_holdings(symbol, 权重) 或按 portfolio.total_portfolio_value 计算股数")
        # 做空：负的目标权重 / 负的下单数量（-w 这种取负也算）
        neg = lambda a: a is not None and ((num(a) is not None and num(a) < 0) or (isinstance(a, ast.UnaryOp) and isinstance(a.op, ast.USub)))
        if name in ("set_holdings", "SetHoldings", "PortfolioTarget") and len(node.args) >= 2 and neg(node.args[1]):
            self.short_nodes.append(node)
        elif name in ORDER_CALLS and name not in ("sell", "Sell") and isinstance(f, ast.Attribute):
            q = node.args[1] if len(node.args) >= 2 else next((k.value for k in node.keywords if k.arg == "quantity"), None)
            if neg(q):
                self.short_nodes.append(node)
        for k, (pascal, _) in SETUP_CALLS.items():
            if name in (k, pascal):
                self.setup_seen.add(k)
        self.generic_visit(node)

    def random_call(self, node, name):
        if name == "seed" and (node.args or node.keywords):
            self.seeded = True
        elif name in ("default_rng", "RandomState", "Random", "Generator") and (node.args or node.keywords):
            self.seeded = True
        elif name not in ("seed",):
            self.random_uses.append(node)


def holdings_exposure(stmts):
    """一段语句里 set_holdings 数字权重之和（if/else 取较大的分支）。返回 (总和, 第一处节点)。"""
    total, first = 0.0, None

    def add(v, n):
        nonlocal total, first
        total += v
        first = first or n

    for s in stmts:
        if isinstance(s, ast.If):
            a, na = holdings_exposure(s.body)
            b, nb = holdings_exposure(s.orelse)
            add(*(a, na) if a >= b else (b, nb))
        elif isinstance(s, (ast.For, ast.While, ast.AsyncFor, ast.With, ast.AsyncWith)):
            add(*holdings_exposure(s.body))
        elif isinstance(s, ast.Try):
            add(*holdings_exposure(s.body + s.finalbody))
        elif isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        else:
            for n in ast.walk(s):
                if isinstance(n, ast.Call) and call_name(n) in ("set_holdings", "SetHoldings"):
                    if len(n.args) >= 2:
                        v = num(n.args[1])
                        if v is not None and v > 0:
                            add(v, n)
                    elif n.args and isinstance(n.args[0], (ast.List, ast.Tuple)):
                        for el in n.args[0].elts:
                            if isinstance(el, ast.Call) and call_name(el) == "PortfolioTarget" and len(el.args) >= 2:
                                v = num(el.args[1])
                                if v is not None and v > 0:
                                    add(v, n)
    return total, first


def algorithm_classes(tree):
    out = []
    for n in ast.walk(tree):
        if isinstance(n, ast.ClassDef) and any((isinstance(b, ast.Name) and b.id == "QCAlgorithm") or
                                               (isinstance(b, ast.Attribute) and b.attr == "QCAlgorithm") for b in n.bases):
            out.append(n)
    return out


def lint_source(src, fname="main.py", local_modules=(), entry=True):
    try:
        tree = ast.parse(src, filename=fname)
        compile(tree, fname, "exec", dont_inherit=True)  # 只编译不运行：补上 ast.parse 查不出的错误（如函数外的 return）
    except SyntaxError as e:
        text = (e.text or "").rstrip()
        msg = f"语法错误：{e.msg}" + (f"\n      {text}" if text else "")
        return {"errors": [{"file": fname, "line": e.lineno or 0, "code": "syntax", "msg_zh": msg}], "warnings": []}
    except ValueError as e:  # 例如源码里有空字节
        return {"errors": [{"file": fname, "line": 0, "code": "syntax", "msg_zh": f"无法解析：{e}"}], "warnings": []}
    stored, alias_values = set(), set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
            stored.add(n.id)
        elif isinstance(n, ast.arg):
            stored.add(n.arg)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            stored.add(n.name)
        if isinstance(n, (ast.Assign, ast.AnnAssign, ast.NamedExpr, ast.AugAssign)) and isinstance(n.value, ast.Name):
            alias_values.add(id(n.value))
    L = Linter(fname, set(local_modules) - {fname[:-3]}, stored, alias_values)
    L.visit(tree)
    classes = algorithm_classes(tree)
    if entry and not classes:
        L.err(tree, "no-algorithm", f"{fname} 里找不到继承 QCAlgorithm 的类（需要形如 class MyAlgo(QCAlgorithm):）")
    if classes:
        for k, (_, msg) in SETUP_CALLS.items():
            if k not in L.setup_seen:
                L.warn(classes[0], f"missing-{k.replace('_', '-')}", msg)
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            tot, first = holdings_exposure(n.body)
            if tot > 1.0 + 1e-9:
                L.warn(first, "holdings-over-1",
                       f"{n.name}() 里 set_holdings 的权重加起来是 {tot:g}，超过 1.0 会加杠杆，日线下单还容易因购买力不足被拒。满仓目标不要超过 0.98")
    if L.short_nodes:
        if not L.borrow_cost:
            L.warn(L.short_nodes[0], "short-no-borrow-cost",
                   "策略在做空，但没有算融券费：LEAN 回测默认不收，结果会偏乐观。from helm_data import HelmShortCost，"
                   "initialize 里 self.borrow = HelmShortCost(rate=0.005)，每个交易日 self.borrow.charge(self)，"
                   "on_end_of_algorithm 里 self.log(self.borrow.summary())")
        if L.cash_account is not None:
            L.warn(L.cash_account, "short-cash-account",
                   "现金账户（AccountType.CASH）不能做空，空单会被拒。做空要用 AccountType.MARGIN，并在规格里写明空头上限")
    if L.random_uses and not L.seeded:
        L.warn(L.random_uses[0], "random-no-seed",
               "用了随机数但没有固定种子，每次回测结果会不一样。在 initialize 里加 random.seed(42) 或 np.random.seed(42)（或 np.random.default_rng(42)）")
    key = lambda d: (d["line"], d["code"])
    return {"errors": sorted(L.errors, key=key), "warnings": sorted(L.warnings, key=key)}


def lint_files(files, entries=("main.py",)):
    local = {f["name"][:-3] for f in files if f["name"].endswith(".py")}
    out = {"errors": [], "warnings": []}
    for f in files:
        r = lint_source(f["content"], f["name"], local, f["name"] in entries)
        out["errors"] += r["errors"]
        out["warnings"] += r["warnings"]
    return out


if __name__ == "__main__":
    data = json.loads(sys.stdin.read() or "{}")
    res = lint_files(data.get("files", []), set(data.get("entries") or ["main.py"]))
    sys.stdout.write(json.dumps(res, ensure_ascii=False))
