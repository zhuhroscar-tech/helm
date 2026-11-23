"""Helm 汇报幻灯片渲染器：deck.json（版面 + 文字）+ datapack.json（数字和序列）→ 原生可编辑的 .pptx

用法：python helm_deck.py <job 目录>
  读 <job>/deck.json、<job>/datapack.json、<job>/style.json（公司名、logo、声明、语言、受众）
  写 <job>/deck.pptx，并在 stdout 打一行 JSON：{"ok": true, "slides": N, "warnings": [...]}

版式：白底；左上角结论式标题 + 一句副标题；右上角公司 logo（没有就写公司名）；底部一行章节导航，当前章节加粗；
关键结论放亮黄色框；图表一律灰色、只有要讲的那一个用黄色；封面和章节页是深色整页加一条红色竖条。
（版式参考了一份咨询案例比赛的幻灯片；没有用到它的任何内容、图片或标志。）

数字规则：幻灯片上出现的数字只能来自 datapack —— 文字里写 {{b1.cagr}} 这样的占位符，图表只写引用（哪个回测、哪种图），
数值由这里从 datapack 填。模型写的文字里如果直接出现数字，由服务端在渲染前查出来（见 lib/deck/check.mjs）。

图表的写法（去掉网格线、一个高亮色、其余灰色、瀑布图用堆叠柱 + 透明底座）改写自 mckinsey-charts（MIT License, Copyright (c) 2025 Sruthi Reddy）。
"""
import json
import math
import os
import re
import sys

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION, XL_TICK_LABEL_POSITION, XL_TICK_MARK
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt

# ---------------- 调色板（全部在这里） ----------------
BLACK = RGBColor(0x00, 0x00, 0x00)
INK = RGBColor(0x1A, 0x1A, 0x1A)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
YELLOW = RGBColor(0xFF, 0xF2, 0x2D)
YELLOW_SOFT = RGBColor(0xFF, 0xF9, 0xB8)
RED = RGBColor(0xC8, 0x10, 0x2E)
G1 = RGBColor(0xF2, 0xF2, 0xF2)  # 最浅底色
G2 = RGBColor(0xD9, 0xD9, 0xD9)  # 面板底色、对比柱
G3 = RGBColor(0xA6, 0xA6, 0xA6)  # 导航未选中、分隔线、基准线
G4 = RGBColor(0x7F, 0x7F, 0x7F)  # 次要文字
G5 = RGBColor(0x40, 0x40, 0x40)
DARK = RGBColor(0x12, 0x13, 0x16)
UP = RGBColor(0x2E, 0x7D, 0x4F)
DOWN = RGBColor(0xB4, 0x2B, 0x2B)

LATIN = "Arial"
EA = "PingFang SC"
HL_INK = BLACK  # 高亮色上的文字颜色（模板的高亮色偏暗时换成白色）


def _rgb(h):
    h = str(h or "").strip().lstrip("#")
    return RGBColor.from_string(h.upper()) if re.fullmatch(r"[0-9A-Fa-f]{6}", h) else None


def _lum(c):
    r, g, b = c[0] / 255, c[1] / 255, c[2] / 255
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def apply_template(tpl):
    """用模板的配色 / 字体替换默认的（高亮色、红条、深色页、字体）"""
    global YELLOW, YELLOW_SOFT, RED, DARK, LATIN, EA, HL_INK
    pal = (tpl or {}).get("palette") or {}
    hl, ac, dk = _rgb(pal.get("highlight")), _rgb(pal.get("accent")), _rgb(pal.get("dark"))
    if hl:
        YELLOW = hl
        YELLOW_SOFT = RGBColor(*[int(255 - (255 - c) * 0.28) for c in hl])
        HL_INK = WHITE if _lum(hl) < 0.55 else BLACK
    if ac:
        RED = ac
    if dk and _lum(dk) < 0.35:
        DARK = dk
    fonts = (tpl or {}).get("fonts") or {}
    if fonts.get("latin"):
        LATIN = fonts["latin"]
    if fonts.get("ea"):
        EA = fonts["ea"]

SW, SH = Inches(13.333), Inches(7.5)
ML = Inches(0.32)            # 左右边距
CW = SW - 2 * ML             # 内容宽度
TOP = Inches(1.02)           # 内容区上沿（标题、副标题之下）
BOT = Inches(6.72)           # 内容区下沿（来源行、导航之上）

WARN = []


# ---------------- 文字 ----------------
def _font(run, size, bold=False, italic=False, color=INK, underline=False):
    f = run.font
    f.size = Pt(size)
    f.bold = bold
    f.italic = italic
    f.underline = underline
    f.name = LATIN
    f.color.rgb = color
    rpr = run._r.get_or_add_rPr()
    for tag in ("a:ea", "a:cs"):
        el = rpr.find(qn(tag))
        if el is None:
            el = rpr.makeelement(qn(tag), {})
            rpr.append(el)
        el.set("typeface", EA)


def _is_cjk(ch):
    return "　" <= ch <= "鿿" or "＀" <= ch <= "￯"


def _text_w(s, size):
    """估算一行文字的宽度（pt）。中文按全角，西文按 0.52 个字号。"""
    return sum(size * (1.0 if _is_cjk(c) else 0.52) for c in s)


def _lines_needed(text, size, width_pt):
    n = 0
    for para in str(text).split("\n"):
        n += max(1, math.ceil(_text_w(para, size) / max(width_pt, 1)))
    return n


def _fit(items, width, height, base, minimum, gap=0.35):
    """多段文字在框里放得下的最大字号：从 base 往下试到 minimum。"""
    wpt = width / 12700 - 14
    hpt = height / 12700 - 6
    s = base
    while True:
        lines = sum(_lines_needed(t, s, wpt) for t in items)
        if lines * s * 1.22 + len(items) * s * gap <= hpt:
            return s
        if s <= minimum:
            break
        s = max(minimum, s - 0.5)
    WARN.append(f"文字偏多，已缩到 {minimum}pt：{str(items[0])[:30]}…")
    return minimum


def box(slide, x, y, w, h, fill=None, line=None, shape=MSO_SHAPE.RECTANGLE, dash=False, weight=0.75):
    sp = slide.shapes.add_shape(shape, x, y, w, h)
    sp.shadow.inherit = False
    if fill is None:
        sp.fill.background()
    else:
        sp.fill.solid()
        sp.fill.fore_color.rgb = fill
    if line is None:
        sp.line.fill.background()
    else:
        sp.line.color.rgb = line
        sp.line.width = Pt(weight)
        if dash:
            sp.line.dash_style = 4  # dash
    return sp


def text(slide, x, y, w, h, content, size=11, bold=False, italic=False, color=INK, align=PP_ALIGN.LEFT,
         anchor=MSO_ANCHOR.TOP, underline=False, margin=0.04, spacing=None):
    """content：字符串，或 [字符串 / (字符串, {bold, italic, color, size})] 的段落列表"""
    tb = slide.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    m = Inches(margin)
    tf.margin_left = tf.margin_right = m
    tf.margin_top = tf.margin_bottom = Inches(0.02)
    paras = content if isinstance(content, list) else [content]
    for i, para in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        if spacing:
            p.space_after = Pt(spacing)
        runs = para if isinstance(para, list) else [para]
        for r in runs:
            t, opt = (r, {}) if isinstance(r, str) else r
            run = p.add_run()
            run.text = t
            _font(run, opt.get("size", size), opt.get("bold", bold), opt.get("italic", italic), opt.get("color", color), opt.get("underline", underline))
    return tb


def bullets(slide, x, y, w, h, items, base=11, minimum=8.5, color=INK):
    items = [str(t) for t in items if str(t).strip()]
    if not items:
        return
    size = _fit(items, w, h, base, minimum)
    tb = slide.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = Inches(0.04)
    for i, t in enumerate(items):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.space_after = Pt(size * 0.45)
        pPr = p._p.get_or_add_pPr()
        pPr.set("marL", str(int(Pt(size * 0.95))))
        pPr.set("indent", str(-int(Pt(size * 0.95))))
        bu = pPr.makeelement(qn("a:buChar"), {"char": "•"})
        pPr.append(bu)
        _rich(p, t, size, color)


def _rich(p, t, size, color=INK):
    """**加粗** 的简单标记"""
    parts = re.split(r"(\*\*[^*]+\*\*)", t)
    for part in parts:
        if not part:
            continue
        b = part.startswith("**") and part.endswith("**")
        run = p.add_run()
        run.text = part[2:-2] if b else part
        _font(run, size, bold=b, color=color)


# ---------------- 页面框架 ----------------
class Deck:
    def __init__(self, spec, pack, style):
        self.spec, self.pack, self.style = spec, pack, style
        self.lang = style.get("lang", "zh")
        tpl = style.get("template") or {}
        master = style.get("templatePptx")
        if tpl.get("useMaster") and master and os.path.exists(master):
            # 用户的 PowerPoint 模板：保留母版（背景、logo、页脚），删掉里面原有的页，用最空的版式加页
            self.prs = Presentation(master)
            sldIdLst = self.prs.slides._sldIdLst
            for sldId in list(sldIdLst):
                self.prs.part.drop_rel(sldId.rId)
                sldIdLst.remove(sldId)
            self.blank = min(self.prs.slide_layouts, key=lambda l: (len(l.placeholders), 0 if "blank" in l.name.lower() else 1))
            self.master = True
        else:
            self.prs = Presentation()
            self.prs.slide_width, self.prs.slide_height = SW, SH
            self.blank = self.prs.slide_layouts[6]
            self.master = False
        self.sections = [s for s in spec.get("sections", []) if s][:7]
        self.page = 0

    def L(self, zh, en):
        return en if self.lang == "en" else zh

    def new(self):
        self.page += 1
        slide = self.prs.slides.add_slide(self.blank)
        for ph in list(slide.placeholders):  # 版式自带的空占位框会在放映时显示「单击此处添加文本」
            ph._element.getparent().remove(ph._element)
        return slide

    def logo(self, slide, dark=False):
        lp = self.style.get("logo")
        if lp and os.path.exists(lp):
            try:
                pic = slide.shapes.add_picture(lp, 0, Inches(0.14), height=Inches(0.5))
                if pic.width > Inches(1.6):  # 太宽的 logo 按宽度缩
                    ratio = Inches(1.6) / pic.width
                    pic.width, pic.height = Inches(1.6), int(pic.height * ratio)
                pic.left = SW - ML - pic.width
                return
            except Exception as e:  # 坏图片：退回公司名
                WARN.append(f"logo 读不了：{e}")
        name = self.style.get("firm") or "Helm"
        text(slide, SW - ML - Inches(3), Inches(0.16), Inches(3), Inches(0.4), name, size=11, bold=True,
             color=WHITE if dark else INK, align=PP_ALIGN.RIGHT)

    def frame(self, s, section=None, source=None):
        """白底内容页：标题、副标题、logo、来源、章节导航、页码"""
        slide = self.new()
        title = s.get("title", "")
        sub = s.get("subtitle", "")
        tsize = 20 if _text_w(title, 20) < (CW / 12700 - 140) else 17
        text(slide, ML, Inches(0.12), CW - Inches(1.9), Inches(0.46), title, size=tsize, bold=True, color=BLACK, anchor=MSO_ANCHOR.BOTTOM)
        if sub:
            text(slide, ML, Inches(0.56), CW - Inches(1.9), Inches(0.38), sub, size=11.5, color=INK)
        self.logo(slide)
        src = source if source is not None else s.get("source")
        if src:
            text(slide, ML, Inches(6.77), CW * 0.8, Inches(0.22), src, size=7.5, italic=True, color=G4)
        self.nav(slide, section if section is not None else s.get("section"))
        text(slide, SW - ML - Inches(0.6), Inches(6.77), Inches(0.6), Inches(0.22), str(self.page), size=7.5, color=G4, align=PP_ALIGN.RIGHT)
        return slide

    def nav(self, slide, current):
        if not self.sections:
            return
        y = Inches(7.02)
        line = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, ML, y, SW - ML, y)
        line.line.color.rgb = G3
        line.line.width = Pt(0.5)
        n = len(self.sections)
        cw = CW / n
        for i, name in enumerate(self.sections):
            on = i == current
            text(slide, ML + int(cw * i), y + Inches(0.04), int(cw), Inches(0.4), name, size=8.5, bold=on,
                 color=BLACK if on else G3, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)

    def takeaway(self, slide, msg, y=None, x=None, w=None, h=Inches(0.5), tone="yellow"):
        if not msg:
            return
        x = ML if x is None else x
        w = CW if w is None else w
        y = (BOT - h) if y is None else y
        fill = {"yellow": YELLOW, "grey": G3, "black": BLACK}.get(tone, YELLOW)
        col = WHITE if tone in ("grey", "black") else HL_INK
        b = box(slide, x, y, w, h, fill=fill)
        size = _fit([msg], w, h, 12, 9)
        tf = b.text_frame
        tf.word_wrap = True
        tf.margin_left = tf.margin_right = Inches(0.15)
        tf.vertical_anchor = MSO_ANCHOR.MIDDLE
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.CENTER
        _rich(p, msg, size, col)
        for r in p.runs:
            r.font.bold = True

    def panel_head(self, slide, x, y, w, label):
        """面板小标题：粗斜体加下划线（「…leading to growth…」那种）"""
        text(slide, x, y, w, Inches(0.3), label, size=10.5, bold=True, italic=True, underline=True, color=BLACK)

    def bar_head(self, slide, x, y, w, label, fill=BLACK, h=Inches(0.34)):
        b = box(slide, x, y, w, h, fill=fill)
        tf = b.text_frame
        tf.margin_left = Inches(0.1)
        tf.vertical_anchor = MSO_ANCHOR.MIDDLE
        p = tf.paragraphs[0]
        run = p.add_run()
        run.text = label
        _font(run, 10.5, bold=True, color=WHITE if fill in (BLACK, G5, G4) else BLACK)

    def mark(self, slide, x, y, ok, d=Inches(0.3)):
        """✓ 黄底圆 / ✕ 灰底圆"""
        c = box(slide, x, y, d, d, fill=YELLOW if ok else G2, shape=MSO_SHAPE.OVAL)
        tf = c.text_frame
        tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
        tf.vertical_anchor = MSO_ANCHOR.MIDDLE
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.CENTER
        run = p.add_run()
        run.text = "✓" if ok else "✕"
        _font(run, 12, bold=True, color=HL_INK if ok else WHITE)

    # ---------------- 页面类型 ----------------
    def cover(self):
        slide = self.new()
        self._dark(slide)
        title = self.spec.get("title", "")
        sub = self.spec.get("subtitle", "")
        box(slide, Inches(0.55), Inches(2.55), Inches(0.09), Inches(1.45), fill=RED)
        text(slide, Inches(0.8), Inches(2.45), Inches(9.5), Inches(1.0), title, size=30 if len(title) < 40 else 24, bold=True, color=WHITE, anchor=MSO_ANCHOR.BOTTOM)
        if sub:
            text(slide, Inches(0.8), Inches(3.45), Inches(9.5), Inches(0.6), sub, size=18, italic=True, color=WHITE)
        who = " | ".join(x for x in [self.style.get("firm"), self.style.get("presenter")] if x)
        if who:
            text(slide, Inches(0.55), Inches(6.35), Inches(9), Inches(0.3), who, size=12, bold=True, color=WHITE)
        text(slide, Inches(0.55), Inches(6.68), Inches(9), Inches(0.3), self.pack["meta"]["dateText"], size=11, color=G2)
        aud = self.L("内部讨论", "For internal discussion") if self.style.get("audience") == "team" else self.L("仅供专业投资者参考", "For professional investors only")
        text(slide, SW - ML - Inches(4), Inches(6.68), Inches(4), Inches(0.3), aud, size=9, italic=True, color=G3, align=PP_ALIGN.RIGHT)
        self.logo(slide, dark=True)

    def _dark(self, slide):
        bg = box(slide, 0, 0, SW, SH, fill=DARK)
        cover = self.style.get("coverImage")
        if cover and os.path.exists(cover):
            try:
                pic = slide.shapes.add_picture(cover, 0, 0, width=SW)
                if pic.height < SH:
                    pic.height, pic.width = SH, int(pic.width * SH / pic.height)
                veil = box(slide, 0, 0, SW, SH, fill=BLACK)
                _alpha(veil, 45)
            except Exception as e:
                WARN.append(f"封面图读不了：{e}")
        # 一条细的暗红渐隐带，给纯色封面一点层次
        band = box(slide, 0, Inches(5.95), SW, Inches(0.03), fill=RGBColor(0x3A, 0x10, 0x16))
        return bg, band

    def agenda(self):
        if len(self.sections) < 3:
            return
        slide = self.new()
        text(slide, ML, Inches(0.12), CW, Inches(0.46), self.L("目录", "Contents"), size=20, bold=True, color=BLACK, anchor=MSO_ANCHOR.BOTTOM)
        self.logo(slide)
        # 每个章节从第几页开始
        starts = {}
        page = 3
        for s in self.spec.get("slides", []):
            if s.get("layout") == "divider":
                page += 1
                continue
            sec = s.get("section")
            if isinstance(sec, int) and sec not in starts:
                starts[sec] = page
            page += 1
        romans = ["I", "II", "III", "IV", "V", "VI", "VII"]
        y = Inches(1.25)
        box(slide, ML, y - Inches(0.1), Inches(6.2), Emu(12700), fill=BLACK)
        for i, name in enumerate(self.sections):
            text(slide, ML, y, Inches(0.6), Inches(0.42), romans[i] + ".", size=15, bold=True, color=BLACK)
            text(slide, ML + Inches(0.6), y, Inches(4.8), Inches(0.42), name, size=15, bold=True, color=BLACK)
            if i in starts:
                text(slide, ML + Inches(5.4), y, Inches(0.8), Inches(0.42), str(starts[i]), size=15, bold=True, color=BLACK, align=PP_ALIGN.RIGHT)
            y += Inches(0.55)
        box(slide, ML, y + Inches(0.02), Inches(6.2), Emu(12700), fill=BLACK)
        # 右边：一张总资金曲线做封面图
        main = self.pack.get("primary")
        if main:
            self.chart_equity(slide, Inches(7.0), Inches(1.15), Inches(6.0), Inches(4.6), main, legend=True)
            text(slide, Inches(7.0), Inches(5.8), Inches(6.0), Inches(0.3), self.bt_label(main), size=9, italic=True, color=G4)

    def divider(self, s):
        slide = self.new()
        self._dark(slide)
        box(slide, Inches(0.55), Inches(3.2), Inches(0.09), Inches(0.9), fill=RED)
        text(slide, Inches(0.8), Inches(3.15), Inches(10), Inches(1.0), s.get("title", ""), size=28, bold=True, color=WHITE, anchor=MSO_ANCHOR.MIDDLE)
        self.logo(slide, dark=True)

    def exec_summary(self, s):
        slide = self.frame(s, section=s.get("section", 0))
        cols = (s.get("columns") or [])[:3] or [{"heading": "", "bullets": s.get("bullets", [])}]
        n = len(cols)
        gap = Inches(0.45)
        w = int((CW - gap * (n - 1)) / n)
        top = TOP + Inches(0.05)
        bottom = BOT - Inches(0.62) if s.get("verdict") else BOT
        ends = []
        for i, c in enumerate(cols):
            x = ML + (w + gap) * i
            self.bar_head(slide, x, top, w, c.get("heading", ""), fill=G2)
            rows = [str(b) for b in (c.get("bullets") or [])][:5]
            if rows:
                avail = bottom - top - Inches(1.0)
                size = _fit(rows, w - Inches(0.25), avail, 12, 8.5, gap=1.2)
                wpt = (w - Inches(0.25)) / 12700 - 14
                y = top + Inches(0.48)
                even = int(avail / len(rows))
                for r in rows:
                    rh = max(int(Pt(_lines_needed(r, size, wpt) * size * 1.25 + size * 1.1)), min(even, Inches(1.0)))
                    tb = slide.shapes.add_textbox(x + Inches(0.12), y, w - Inches(0.2), rh - Inches(0.06))
                    tf = tb.text_frame
                    tf.word_wrap = True
                    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
                    _rich(tf.paragraphs[0], r, size)
                    sep = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, x, y + rh - Inches(0.03), x + w, y + rh - Inches(0.03))
                    sep.line.color.rgb = G2
                    sep.line.width = Pt(0.5)
                    y += rh
            ends.append(y if rows else top + Inches(0.48))
        # 分栏结论紧跟内容，不贴页底，避免中间一大片空白
        vy = min(bottom - Inches(0.5), max(ends) + Inches(0.18))
        for i, c in enumerate(cols):
            x = ML + (w + gap) * i
            tone = (c.get("tone") or "").lower()
            if c.get("verdict"):
                self.takeaway(slide, c["verdict"], y=vy, x=x, w=w, h=Inches(0.42), tone="yellow" if tone == "positive" else "grey")
            if i < n - 1:
                ln = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, x + w + gap // 2, top, x + w + gap // 2, vy + Inches(0.42))
                ln.line.color.rgb = G3
                ln.line.width = Pt(0.75)
                ln.line.dash_style = 4
        if s.get("verdict"):
            self.takeaway(slide, s["verdict"], y=min(BOT - Inches(0.5), vy + Inches(0.72)), tone="yellow" if s.get("verdictTone", "positive") != "negative" else "black")

    def chart_slide(self, s):
        slide = self.frame(s)
        has_side = bool(s.get("bullets"))
        has_take = bool(s.get("takeaway"))
        bottom = BOT - (Inches(0.62) if has_take else 0)
        cw = int(CW * (0.64 if has_side else 1.0))
        if s.get("chartTitle"):
            self.panel_head(slide, ML, TOP, cw, s["chartTitle"])
        self.chart(slide, ML, TOP + Inches(0.32), cw, bottom - TOP - Inches(0.36), s.get("chart") or {})
        if has_side:
            x = ML + cw + Inches(0.3)
            w = CW - cw - Inches(0.3)
            box(slide, x, TOP + Inches(0.05), w, bottom - TOP - Inches(0.1), fill=G1)
            if s.get("sideTitle"):
                self.panel_head(slide, x + Inches(0.15), TOP + Inches(0.15), w - Inches(0.3), s["sideTitle"])
            bullets(slide, x + Inches(0.15), TOP + Inches(0.5), w - Inches(0.3), bottom - TOP - Inches(0.65), s["bullets"], base=11)
        self.takeaway(slide, s.get("takeaway"))

    def two_charts(self, s):
        slide = self.frame(s)
        bottom = BOT - (Inches(0.62) if s.get("takeaway") else 0)
        gap = Inches(0.4)
        w = int((CW - gap) / 2)
        for i, k in enumerate(("left", "right")):
            part = s.get(k) or {}
            x = ML + (w + gap) * i
            self.panel_head(slide, x, TOP, w, part.get("heading", ""))
            note = part.get("note")
            ch = bottom - TOP - Inches(0.4) - (Inches(0.55) if note else 0)
            self.chart(slide, x, TOP + Inches(0.32), w, ch, part.get("chart") or {})
            if note:
                box(slide, x, TOP + Inches(0.36) + ch, w, Inches(0.5), fill=G1)
                text(slide, x + Inches(0.08), TOP + Inches(0.38) + ch, w - Inches(0.16), Inches(0.46), note, size=_fit([note], w, Inches(0.46), 10, 8), color=INK, anchor=MSO_ANCHOR.MIDDLE)
        self.takeaway(slide, s.get("takeaway"))

    def kpis(self, s):
        slide = self.frame(s)
        ks = (s.get("kpis") or [])[:5]
        n = max(1, len(ks))
        gap = Inches(0.25)
        w = int((CW - gap * (n - 1)) / n)
        h = Inches(1.45)
        for i, k in enumerate(ks):
            x = ML + (w + gap) * i
            hl = bool(k.get("highlight"))
            box(slide, x, TOP + Inches(0.05), w, h, fill=YELLOW if hl else G1)
            text(slide, x + Inches(0.15), TOP + Inches(0.15), w - Inches(0.3), Inches(0.7), str(k.get("value", "")), size=30 if n <= 4 else 26, bold=True, color=HL_INK if hl else BLACK, anchor=MSO_ANCHOR.BOTTOM)
            text(slide, x + Inches(0.15), TOP + Inches(0.88), w - Inches(0.3), Inches(0.55), str(k.get("label", "")), size=10, color=HL_INK if hl else G5)
        y = TOP + h + Inches(0.3)
        bottom = BOT - (Inches(0.62) if s.get("takeaway") else 0)
        if s.get("chart"):
            cw = int(CW * 0.58) if s.get("bullets") else CW
            if s.get("chartTitle"):
                self.panel_head(slide, ML, y, cw, s["chartTitle"])
            self.chart(slide, ML, y + Inches(0.3), cw, bottom - y - Inches(0.34), s["chart"])
            if s.get("bullets"):
                bullets(slide, ML + cw + Inches(0.3), y + Inches(0.1), CW - cw - Inches(0.3), bottom - y - Inches(0.2), s["bullets"])
        elif s.get("bullets"):
            # 没有图：要点放进灰底面板，高度跟内容走，结论框紧跟在下面（不留一大片空白）
            items = [str(t) for t in s["bullets"] if str(t).strip()]
            size = _fit(items or [" "], CW - Inches(0.3), bottom - y - Inches(0.2), 13, 9)
            need = Pt(sum(_lines_needed(t, size, (CW - Inches(0.3)) / 12700 - 14) * size * 1.22 + size * 0.6 for t in items) + 28)
            ph = min(bottom - y, max(int(need), Inches(1.2)))
            box(slide, ML, y, CW, ph, fill=G1)
            bullets(slide, ML + Inches(0.15), y + Inches(0.12), CW - Inches(0.3), ph - Inches(0.18), items, base=size, minimum=size)
            self.takeaway(slide, s.get("takeaway"), y=min(BOT - Inches(0.5), y + ph + Inches(0.3)))
            return
        self.takeaway(slide, s.get("takeaway"))

    def table_slide(self, s):
        slide = self.frame(s)
        t = s.get("table") or {}
        bottom = BOT - (Inches(0.62) if s.get("takeaway") else 0)
        has_side = bool(s.get("bullets"))
        tw = int(CW * (0.66 if has_side else 1.0))
        if s.get("tableTitle"):
            self.panel_head(slide, ML, TOP, tw, s["tableTitle"])
        y0 = TOP + (Inches(0.34) if s.get("tableTitle") else 0)
        kind = t.get("kind")
        if kind == "gates":
            self.table_gates(slide, ML, y0, tw, bottom - y0, t.get("bt"))
        elif kind == "compare":
            self.table_compare(slide, ML, y0, tw, bottom - y0, t.get("bts") or [], t.get("metrics") or [], t.get("highlight"))
        elif kind == "monthly":
            self.table_monthly(slide, ML, y0, tw, bottom - y0, t.get("bt"))
        else:
            self.table_custom(slide, ML, y0, tw, bottom - y0, t.get("header") or [], t.get("rows") or [])
        if has_side:
            x = ML + tw + Inches(0.3)
            w = CW - tw - Inches(0.3)
            box(slide, x, TOP, w, bottom - TOP, fill=G1)
            if s.get("sideTitle"):
                self.panel_head(slide, x + Inches(0.15), TOP + Inches(0.1), w - Inches(0.3), s["sideTitle"])
            bullets(slide, x + Inches(0.15), TOP + Inches(0.45), w - Inches(0.3), bottom - TOP - Inches(0.55), s["bullets"])
        self.takeaway(slide, s.get("takeaway"))

    def bullets_slide(self, s):
        slide = self.frame(s)
        panels = (s.get("panels") or [])[:3] or [{"heading": "", "bullets": s.get("bullets", [])}]
        n = len(panels)
        gap = Inches(0.3)
        w = int((CW - gap * (n - 1)) / n)
        bottom = BOT - (Inches(0.62) if s.get("takeaway") else 0)
        end = TOP
        for i, pn in enumerate(panels):
            x = ML + (w + gap) * i
            y = TOP
            if pn.get("heading"):
                self.bar_head(slide, x, y, w, pn["heading"], fill=BLACK if i == 0 and n > 1 and pn.get("emphasis") else G5)
                y += Inches(0.42)
            items = [str(t) for t in (pn.get("bullets") or [])]
            size = _fit(items or [" "], w - Inches(0.24), bottom - y - Inches(0.15), 12.5, 9)
            need = Pt(sum(_lines_needed(t, size, (w - Inches(0.24)) / 12700 - 14) * size * 1.22 + size * 0.6 for t in items) + 24)
            ph = min(bottom - y, max(int(need), Inches(1.6)))
            box(slide, x, y, w, ph, fill=G1)
            bullets(slide, x + Inches(0.12), y + Inches(0.1), w - Inches(0.24), ph - Inches(0.15), items, base=size, minimum=size)
            end = max(end, y + ph)
        self.takeaway(slide, s.get("takeaway"), y=min(BOT - Inches(0.5), end + Inches(0.3)))

    def disclaimer(self):
        txt = self.style.get("disclaimer") or ""
        if not txt.strip():
            return
        slide = self.frame({"title": self.L("重要声明", "Important information"), "subtitle": ""}, section=-1)
        paras = [p.strip() for p in txt.split("\n") if p.strip()]
        size = _fit(paras, CW, BOT - TOP, 10.5, 7.5)
        text(slide, ML, TOP, CW, BOT - TOP, paras, size=size, color=G5, spacing=size * 0.6)

    def appendix(self):
        """方法说明：数据从哪来、试了多少次、代码和数据的指纹 —— 每份都自动加，不经过模型"""
        m = self.pack["meta"]
        slide = self.frame({"title": self.L("附录：数据与方法", "Appendix: data and method"),
                            "subtitle": self.L("本汇报中的所有数字都直接取自 Helm 保存的回测结果，没有经过人工或模型改写", "Every number in this deck is read directly from the backtest results saved in Helm; none was typed by a person or a model")}, section=len(self.sections) - 1 if self.sections else None)
        header = [self.L("代号", "Ref"), self.L("回测", "Backtest"), self.L("阶段", "Period"), self.L("区间", "Dates"), self.L("代码指纹", "Code hash"), self.L("数据指纹", "Data hash")]
        rows = []
        for b in self.pack["backtests"]:
            rows.append([b["ref"], b["name"], b["periodText"], f'{b["start"]} → {b["end"]}', (b.get("codeHash") or "")[:10], (b.get("dataHash") or "")[:10]])
        self.table_custom(slide, ML, TOP, CW, Inches(0.36) * (len(rows) + 1), header, rows, widths=[0.06, 0.42, 0.1, 0.18, 0.12, 0.12], size=9)
        notes = m.get("methodNotes") or []
        y = TOP + Inches(0.36) * (len(rows) + 1) + Inches(0.3)
        if notes:
            bullets(slide, ML, y, CW, BOT - y, notes, base=10, minimum=8, color=G5)

    # ---------------- 表格 ----------------
    def table_custom(self, slide, x, y, w, h, header, rows, widths=None, size=None, highlight_row=None):
        rows = [[str(c) for c in r] for r in rows][:14]
        ncol = max([len(header)] + [len(r) for r in rows]) if (header or rows) else 0
        if not ncol:
            return
        nrow = len(rows) + (1 if header else 0)
        rh = min(Inches(0.42), int(h / max(nrow, 1)))
        shape = slide.shapes.add_table(nrow, ncol, x, y, w, rh * nrow)
        tbl = shape.table
        tblPr = tbl._tbl.tblPr
        style = tblPr.find(qn("a:tableStyleId"))
        if style is None:
            style = tblPr.makeelement(qn("a:tableStyleId"), {})
            tblPr.append(style)
        style.text = "{5940675A-B579-460E-94D1-54222C63F5DA}"  # No Style, Table Grid → 再手动上色
        widths = widths or [1 / ncol] * ncol
        for i, f in enumerate(widths[:ncol]):
            tbl.columns[i].width = int(w * f / sum(widths[:ncol]))
        fs = size or (10 if ncol <= 5 else 9)
        all_rows = ([header] if header else []) + rows
        for ri, r in enumerate(all_rows):
            tbl.rows[ri].height = rh
            for ci in range(ncol):
                cell = tbl.cell(ri, ci)
                val = r[ci] if ci < len(r) else ""
                is_head = header and ri == 0
                cell.fill.solid()
                cell.fill.fore_color.rgb = BLACK if is_head else (YELLOW_SOFT if highlight_row is not None and ri - (1 if header else 0) == highlight_row else (WHITE if ri % 2 else G1))
                cell.margin_left = cell.margin_right = Inches(0.06)
                cell.margin_top = cell.margin_bottom = Inches(0.02)
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                tf = cell.text_frame
                tf.word_wrap = True
                p = tf.paragraphs[0]
                p.alignment = PP_ALIGN.LEFT if ci == 0 or not _numeric(val) else PP_ALIGN.RIGHT
                run = p.add_run()
                run.text = val
                _font(run, fs, bold=bool(is_head), color=WHITE if is_head else INK)
        return tbl

    def table_gates(self, slide, x, y, w, h, ref):
        b = self.bt(ref)
        if not b:
            return
        gates = b.get("gates") or []
        rh = min(Inches(0.62), int(h / max(len(gates) + 1, 1)))
        self.bar_head(slide, x, y, w, self.L(f"统计检验 · {b['name']}", f"Statistical checks · {b['name']}"), fill=BLACK)
        yy = y + Inches(0.42)
        for g in gates:
            self.mark(slide, x + Inches(0.05), yy + (rh - Inches(0.3)) // 2, g["ok"])
            text(slide, x + Inches(0.5), yy, int(w * 0.55), rh, g["label"], size=10, bold=True, color=INK, anchor=MSO_ANCHOR.MIDDLE)
            text(slide, x + Inches(0.5) + int(w * 0.55), yy, w - Inches(0.5) - int(w * 0.55), rh, g["detail"], size=9.5, color=G5, anchor=MSO_ANCHOR.MIDDLE)
            ln = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, x, yy + rh, x + w, yy + rh)
            ln.line.color.rgb = G2
            ln.line.width = Pt(0.5)
            yy += rh

    def table_compare(self, slide, x, y, w, h, refs, metrics, highlight=None):
        bts = [self.bt(r) for r in refs if self.bt(r)][:7]
        metrics = [m for m in metrics if m in METRICS][:7] or ["cagr", "sharpe", "maxdd", "excess"]
        header = [self.L("回测", "Backtest")] + [self.L(METRICS[m][0], METRICS[m][1]) for m in metrics]
        rows = []
        hl = None
        for i, b in enumerate(bts):
            rows.append([f'{b["ref"]} · {b["short"]}'] + [b["facts"].get(m, {}).get("text", "—") for m in metrics])
            if b["ref"] == highlight:
                hl = i
        self.table_custom(slide, x, y, w, h, header, rows, widths=[0.4] + [0.6 / len(metrics)] * len(metrics), highlight_row=hl)

    def table_monthly(self, slide, x, y, w, h, ref):
        b = self.bt(ref)
        if not b or not b.get("monthly"):
            return
        mon = b["monthly"]
        years = mon["years"][-12:]
        header = [""] + mon["months"] + [self.L("全年", "Year")]
        nrow = len(years) + 1
        ncol = len(header)
        rh = min(Inches(0.36), int(h / nrow))
        shape = slide.shapes.add_table(nrow, ncol, x, y, w, rh * nrow)
        tbl = shape.table
        tbl.columns[0].width = int(w * 0.08)
        for ci in range(1, ncol):
            tbl.columns[ci].width = int(w * 0.92 / (ncol - 1))
        vals = [v for yr in years for v in mon["cells"][yr] if v is not None]
        top = max([abs(v) for v in vals] + [0.01])
        for ri in range(nrow):
            tbl.rows[ri].height = rh
            for ci in range(ncol):
                cell = tbl.cell(ri, ci)
                cell.margin_left = cell.margin_right = Inches(0.03)
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                p = cell.text_frame.paragraphs[0]
                p.alignment = PP_ALIGN.CENTER
                cell.fill.solid()
                if ri == 0:
                    cell.fill.fore_color.rgb = BLACK
                    run = p.add_run()
                    run.text = header[ci]
                    _font(run, 8.5, bold=True, color=WHITE)
                    continue
                yr = years[ri - 1]
                if ci == 0:
                    cell.fill.fore_color.rgb = G1
                    run = p.add_run()
                    run.text = yr
                    _font(run, 8.5, bold=True)
                    continue
                v = (mon["cells"][yr] + [mon["year"].get(yr)])[ci - 1]
                if v is None:
                    cell.fill.fore_color.rgb = WHITE
                    continue
                t = min(1.0, abs(v) / top)
                base = (0x2E, 0x7D, 0x4F) if v >= 0 else (0xB4, 0x2B, 0x2B)
                mix = tuple(int(255 - (255 - c) * (0.15 + 0.6 * t)) for c in base)
                cell.fill.fore_color.rgb = RGBColor(*mix) if ci < ncol - 1 else (YELLOW if v >= 0 else G2)
                run = p.add_run()
                run.text = f"{v * 100:.1f}"
                _font(run, 8, bold=ci == ncol - 1, color=INK)

    # ---------------- 图表（全部是原生 PowerPoint 图表，可以在 PPT 里改数据） ----------------
    def chart(self, slide, x, y, w, h, c):
        kind = c.get("type")
        ref = c.get("bt") or self.pack.get("primary")
        try:
            if kind == "equity":
                return self.chart_equity(slide, x, y, w, h, ref)
            if kind == "drawdown":
                return self.chart_drawdown(slide, x, y, w, h, ref)
            if kind == "annual":
                return self.chart_annual(slide, x, y, w, h, ref)
            if kind == "metric_bars":
                return self.chart_metric_bars(slide, x, y, w, h, c.get("bts") or [], c.get("metric", "sharpe"), c.get("highlight"))
            if kind == "excess_bridge":
                return self.chart_bridge(slide, x, y, w, h, ref)
            if kind == "monthly":
                return self.table_monthly(slide, x, y, w, h, ref)
            if kind == "gates":
                return self.table_gates(slide, x, y, w, h, ref)
        except Exception as e:  # 一张图坏了不拖垮整份
            WARN.append(f"图表 {kind} 画不出来：{e}")
        box(slide, x, y, w, h, fill=G1)
        text(slide, x, y, w, h, self.L("（这里的图表没有可用数据）", "(No data for this chart)"), size=10, italic=True, color=G4, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)

    def chart_equity(self, slide, x, y, w, h, ref, legend=True):
        b = self.bt(ref)
        eq = b["series"]["equity"]
        cd = CategoryChartData()
        cd.categories = _dates(eq["dates"])
        cd.add_series(b["short"], eq["strategy"])
        if eq.get("benchmark"):
            cd.add_series(self.L("基准", "Benchmark") + (f' ({b["benchmarkName"]})' if b.get("benchmarkName") else ""), eq["benchmark"])
        gf = slide.shapes.add_chart(XL_CHART_TYPE.LINE, x, y, w, h, cd)
        ch = gf.chart
        _style(ch, legend=legend and bool(eq.get("benchmark")))
        _date_axis(ch, eq["dates"])
        ser = ch.plots[0].series
        _line(ser[0], BLACK, 2.0)
        if len(ser) > 1:
            _line(ser[1], G3, 1.5)
        ch.value_axis.tick_labels.number_format = '0'
        ch.value_axis.tick_labels.number_format_is_linked = False
        _end_label(slide, ch, x, y, w, h, eq["strategy"], f'{eq["strategy"][-1]:.0f}')
        return ch

    def chart_drawdown(self, slide, x, y, w, h, ref):
        b = self.bt(ref)
        dd = b["series"]["drawdown"]
        cd = CategoryChartData()
        cd.categories = _dates(dd["dates"])
        cd.add_series(b["short"], dd["strategy"])
        if dd.get("benchmark"):
            cd.add_series(self.L("基准", "Benchmark"), dd["benchmark"])
        gf = slide.shapes.add_chart(XL_CHART_TYPE.AREA, x, y, w, h, cd)
        ch = gf.chart
        _style(ch, legend=bool(dd.get("benchmark")))
        _date_axis(ch, dd["dates"])
        ser = ch.plots[0].series
        _fill(ser[0], G5)
        if len(ser) > 1:
            _fill(ser[1], G2)
            # 先画基准（浅），再画策略（深）：调换顺序
            plot = ch.plots[0]._element
            s0, s1 = plot.findall(qn("c:ser"))[:2]
            plot.remove(s0)
            s1.addnext(s0)
        ch.value_axis.tick_labels.number_format = '0%'
        ch.value_axis.tick_labels.number_format_is_linked = False
        ch.category_axis.tick_label_position = XL_TICK_LABEL_POSITION.LOW
        return ch

    def chart_annual(self, slide, x, y, w, h, ref):
        b = self.bt(ref)
        an = b["series"]["annual"]
        cd = CategoryChartData()
        cd.categories = an["years"]
        cd.add_series(b["short"], an["strategy"])
        if an.get("benchmark"):
            cd.add_series(self.L("基准", "Benchmark"), an["benchmark"])
        gf = slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, x, y, w, h, cd)
        ch = gf.chart
        _style(ch, legend=bool(an.get("benchmark")))
        plot = ch.plots[0]
        plot.gap_width = 60
        plot.overlap = -10
        _bar(plot.series[0], YELLOW, outline=BLACK)
        if len(plot.series) > 1:
            _bar(plot.series[1], G2)
        ch.value_axis.tick_labels.number_format = '0%'
        ch.value_axis.tick_labels.number_format_is_linked = False
        ch.category_axis.tick_label_position = XL_TICK_LABEL_POSITION.LOW
        return ch

    def chart_metric_bars(self, slide, x, y, w, h, refs, metric, highlight=None):
        bts = [self.bt(r) for r in refs if self.bt(r)][:8] or self.pack["backtests"][:6]
        metric = metric if metric in METRICS else "sharpe"
        vals = [b["facts"].get(metric, {}).get("value") for b in bts]
        pairs = [(b, v) for b, v in zip(bts, vals) if isinstance(v, (int, float))]
        if not pairs:
            raise ValueError("no values")
        cd = CategoryChartData()
        cd.categories = [f'{b["ref"]} · {b["short"][:22]}' for b, _ in pairs]
        cd.add_series(self.L(METRICS[metric][0], METRICS[metric][1]), [v for _, v in pairs])
        gf = slide.shapes.add_chart(XL_CHART_TYPE.BAR_CLUSTERED, x, y, w, h, cd)
        ch = gf.chart
        _style(ch, legend=False)
        plot = ch.plots[0]
        plot.gap_width = 45
        plot.has_data_labels = True
        dl = plot.data_labels
        dl.number_format = METRICS[metric][2]
        dl.number_format_is_linked = False
        dl.font.size = Pt(10)
        dl.font.name = LATIN
        _bar(plot.series[0], G2)
        for i, (b, _) in enumerate(pairs):
            if b["ref"] == (highlight or self.pack.get("primary")):
                _point(plot.series[0].points[i], YELLOW, outline=BLACK)
        ch.category_axis.reverse_order = True
        ch.value_axis.visible = False
        ch.value_axis.tick_labels.number_format = METRICS[metric][2]
        ch.value_axis.tick_labels.number_format_is_linked = False
        ch.category_axis.tick_label_position = XL_TICK_LABEL_POSITION.LOW
        return ch

    def chart_bridge(self, slide, x, y, w, h, ref):
        """基准年化 → 超额 → 策略年化（瀑布图）"""
        b = self.bt(ref)
        bench = b["facts"].get("benchCagr", {}).get("value")
        strat = b["facts"].get("cagr", {}).get("value")
        if bench is None or strat is None:
            raise ValueError("no benchmark")
        diff = strat - bench
        labels = [self.L("基准年化", "Benchmark CAGR"), self.L("超额", "Excess"), self.L("策略年化", "Strategy CAGR")]
        base = [0, min(bench, strat), 0]
        start = [bench, 0, 0]
        up = [0, diff if diff > 0 else 0, 0]
        down = [0, -diff if diff < 0 else 0, 0]
        total = [0, 0, strat]
        cd = CategoryChartData()
        cd.categories = labels
        for name, vals in (("__base__", base), ("start", start), ("up", up), ("down", down), ("total", total)):
            cd.add_series(name, vals)
        gf = slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_STACKED, x, y, w, h, cd)
        ch = gf.chart
        _style(ch, legend=False)
        plot = ch.plots[0]
        plot.gap_width = 70
        sm = {s.name: s for s in plot.series}
        _hide(sm["__base__"])
        _bar(sm["start"], G3)
        _bar(sm["up"], YELLOW, outline=BLACK)
        _bar(sm["down"], DOWN)
        _bar(sm["total"], BLACK)
        ch.value_axis.tick_labels.number_format = '0%'
        ch.value_axis.tick_labels.number_format_is_linked = False
        for name, idx, v in (("start", 0, bench), ("up" if diff > 0 else "down", 1, diff), ("total", 2, strat)):
            pt = sm[name].points[idx]
            pt.data_label.has_text_frame = True
            pt.data_label.text_frame.text = f"{v * 100:+.1f}%" if idx == 1 else f"{v * 100:.1f}%"
            pt.data_label.position = 0  # 由 PPT 决定
            for p in pt.data_label.text_frame.paragraphs:
                for r in p.runs:
                    _font(r, 11, bold=True, color=WHITE if name in ("total", "down") else HL_INK)
        return ch

    # ---------------- 数据 ----------------
    def bt(self, ref):
        for b in self.pack.get("backtests", []):
            if b["ref"] == ref:
                return b
        return None

    def bt_label(self, ref):
        b = self.bt(ref)
        return f'{b["name"]} · {b["start"]} → {b["end"]}' if b else ""

    def build(self):
        self.cover()
        self.agenda()
        for s in self.spec.get("slides", []):
            lay = s.get("layout")
            fn = {"exec_summary": self.exec_summary, "chart": self.chart_slide, "two_charts": self.two_charts, "kpis": self.kpis,
                  "table": self.table_slide, "bullets": self.bullets_slide, "divider": self.divider}.get(lay)
            if not fn:
                WARN.append(f"不认识的版式 {lay}，按要点页画")
                fn = self.bullets_slide
            fn(s)
        self.appendix()
        if self.style.get("audience") == "client":
            self.disclaimer()
        return self.prs


METRICS = {
    # key: (中文, English, 数字格式)
    "cagr": ("年化收益", "CAGR", "0.0%"),
    "net": ("累计收益", "Total return", "0%"),
    "sharpe": ("夏普", "Sharpe", "0.00"),
    "maxdd": ("最大回撤", "Max drawdown", "0.0%"),
    "excess": ("年化超额", "Annual excess", "0.0%"),
    "vol": ("年化波动", "Volatility", "0.0%"),
    "winrate": ("胜率", "Win rate", "0%"),
    "trades": ("交易次数", "Trades", "0"),
    "dsr": ("去膨胀夏普", "Deflated Sharpe", "0%"),
    "benchCagr": ("基准年化", "Benchmark CAGR", "0.0%"),
    "benchMaxdd": ("基准最大回撤", "Benchmark max DD", "0.0%"),
}


def _numeric(s):
    return bool(re.fullmatch(r"[\s+\-−]?[\d.,]+\s*[%x×]?", str(s)))


def _alpha(shape, pct):
    sf = shape.fill._xPr.find(qn("a:solidFill"))
    if sf is None:
        return
    clr = sf[0]
    a = clr.makeelement(qn("a:alpha"), {"val": str(int(pct * 1000))})
    clr.append(a)


def _style(ch, legend=False):
    ch.has_title = False
    ch.font.name = LATIN
    ch.font.size = Pt(9.5)
    ch.font.color.rgb = G5
    if legend:
        ch.has_legend = True
        ch.legend.position = XL_LEGEND_POSITION.TOP
        ch.legend.include_in_layout = False
        ch.legend.font.size = Pt(9.5)
        ch.legend.font.name = LATIN
    else:
        ch.has_legend = False
    try:
        va = ch.value_axis
        va.has_major_gridlines = False
        va.format.line.fill.background()
        va.major_tick_mark = XL_TICK_MARK.NONE
        va.tick_labels.font.size = Pt(9)
        va.tick_labels.font.color.rgb = G4
    except Exception:
        pass
    try:
        ca = ch.category_axis
        ca.format.line.color.rgb = G3
        ca.major_tick_mark = XL_TICK_MARK.NONE
        ca.tick_labels.font.size = Pt(9)
        ca.tick_labels.font.color.rgb = G4
    except Exception:
        pass


def _year_labels(dates):
    """每年第一个点标年份，其余留空（年份太多时隔年标）"""
    years = sorted({d[:4] for d in dates})
    every = 1 if len(years) <= 9 else 2 if len(years) <= 18 else 5
    out, seen = [], set()
    for d in dates:
        y = d[:4]
        if y not in seen and int(y) % every == 0:
            seen.add(y)
            out.append(y)
        else:
            seen.add(y)
            out.append(" " * (len(out) % 7 + 1))  # 留空（每个都不同，PPT 不会把它们合并）
    return out


def _dates(ds):
    import datetime
    return [datetime.date.fromisoformat(d) for d in ds]


def _date_axis(ch, dates):
    """真正的日期轴：按年标刻度，只显示年份（PowerPoint 和 LibreOffice 都认）"""
    ax = ch._chartSpace.find(qn("c:chart")).find(qn("c:plotArea")).find(qn("c:dateAx"))
    if ax is not None:
        years = len({d[:4] for d in dates})
        unit = 1 if years <= 10 else 2 if years <= 20 else 5
        for tag in ("c:baseTimeUnit", "c:majorUnit", "c:majorTimeUnit"):
            for old in ax.findall(qn(tag)):
                ax.remove(old)
        # 按 schema 的顺序插在 lblOffset / auto / crosses 后面
        anchor = next((ax.find(qn(t)) for t in ("c:lblOffset", "c:auto", "c:crosses", "c:crossesAt", "c:crossAx") if ax.find(qn(t)) is not None), None)
        new = []
        for tag, val in (("c:baseTimeUnit", "days"), ("c:majorUnit", str(unit)), ("c:majorTimeUnit", "years")):
            el = ax.makeelement(qn(tag), {"val": val})
            new.append(el)
        for el in reversed(new):
            anchor.addnext(el)
        ch.category_axis.tick_labels.number_format = "yyyy"
        ch.category_axis.tick_labels.number_format_is_linked = False
        ch.category_axis.tick_labels.font.size = Pt(9)
        return
    ca = ch.category_axis
    step = 1
    try:
        ca._element.get_or_add_tickLblSkip().set("val", str(step))
        ca._element.get_or_add_tickMarkSkip().set("val", str(step))
    except Exception:
        el = ca._element
        for tag in ("c:tickLblSkip", "c:tickMarkSkip"):
            node = el.find(qn(tag))
            if node is None:
                node = el.makeelement(qn(tag), {})
                el.append(node)
            node.set("val", str(step))
    ca.tick_labels.font.size = Pt(9)


def _line(series, color, width):
    series.format.line.color.rgb = color
    series.format.line.width = Pt(width)
    series.smooth = False
    try:
        series.marker.style = None
        from pptx.enum.chart import XL_MARKER_STYLE
        series.marker.style = XL_MARKER_STYLE.NONE
    except Exception:
        pass


def _fill(series, color):
    series.format.fill.solid()
    series.format.fill.fore_color.rgb = color
    series.format.line.fill.background()


def _bar(series, color, outline=None):
    series.format.fill.solid()
    series.format.fill.fore_color.rgb = color
    if outline is None:
        series.format.line.fill.background()
    else:
        series.format.line.color.rgb = outline
        series.format.line.width = Pt(0.5)


def _point(pt, color, outline=None):
    pt.format.fill.solid()
    pt.format.fill.fore_color.rgb = color
    if outline is not None:
        pt.format.line.color.rgb = outline
        pt.format.line.width = Pt(0.75)


def _hide(series):
    series.format.fill.background()
    series.format.line.fill.background()


def _end_label(slide, ch, x, y, w, h, values, label):
    """线图最后一个点旁边标出终值（黄色小标签）"""
    if not values:
        return
    lo, hi = min(values), max(values)
    if hi <= lo:
        return
    frac = (values[-1] - lo) / (hi - lo)
    ty = y + int(h * 0.12) + int((h * 0.72) * (1 - frac)) - Inches(0.14)
    b = box(slide, x + w - Inches(0.62), ty, Inches(0.6), Inches(0.26), fill=YELLOW)
    tf = b.text_frame
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    r = p.add_run()
    r.text = label
    _font(r, 9.5, bold=True, color=HL_INK)


def main():
    job = sys.argv[1]
    spec = json.load(open(os.path.join(job, "deck.json"), encoding="utf-8"))
    pack = json.load(open(os.path.join(job, "datapack.json"), encoding="utf-8"))
    style = json.load(open(os.path.join(job, "style.json"), encoding="utf-8"))
    apply_template(style.get("template"))
    prs = Deck(spec, pack, style).build()
    out = os.path.join(job, "deck.pptx")
    tmp = out + ".tmp"
    prs.save(tmp)
    os.replace(tmp, out)
    print(json.dumps({"ok": True, "slides": len(prs.slides), "warnings": WARN}, ensure_ascii=False))


if __name__ == "__main__":
    main()
