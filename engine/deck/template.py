"""分析用户上传的汇报模板，输出版式要用的颜色和字体。

用法：python template.py <上传的文件> <输出目录>
  .pptx / .potx：读主题配色（a:clrScheme）、主题字体、页面比例；16:9 的模板会整份当母版用（logo、背景、页脚都保留）
  .pdf：渲染前几页，统计颜色：最常出现的鲜艳颜色 = 高亮色，色相明显不同的第二个 = 强调色；封面偏暗就用它的主色做深色页
输出：<输出目录>/template.json（以及 template.pptx 或 preview.png），stdout 打一行同样的 JSON
"""
import colorsys
import json
import os
import shutil
import sys
import zipfile
from collections import Counter

DEFAULT = {"highlight": "FFF22D", "accent": "C8102E", "dark": "121316"}


def lum(hexs):
    r, g, b = (int(hexs[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def hsv(hexs):
    return colorsys.rgb_to_hsv(*(int(hexs[i:i + 2], 16) / 255 for i in (0, 2, 4)))


def hue_dist(a, b):
    d = abs(hsv(a)[0] - hsv(b)[0])
    return min(d, 1 - d) * 360


# ---------------- PowerPoint 模板 ----------------
def from_pptx(src, out):
    dst = os.path.join(out, "template.pptx")
    # .potx 的内容类型不同，python-pptx 打不开：复制一份并改成普通演示文稿
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst + ".tmp", "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "[Content_Types].xml":
                data = data.replace(b"presentationml.template.main+xml", b"presentationml.presentation.main+xml")
            zout.writestr(item, data)
    os.replace(dst + ".tmp", dst)

    from pptx import Presentation
    from pptx.oxml.ns import qn
    prs = Presentation(dst)
    aspect = prs.slide_width / prs.slide_height
    theme = None
    for rel in prs.slide_master.part.rels.values():
        if rel.reltype.endswith("/theme"):
            theme = rel.target_part
    colors, fonts = {}, {}
    if theme is not None:
        from lxml import etree
        root = etree.fromstring(theme.blob)
        ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
        scheme = root.find(".//a:clrScheme", ns)
        if scheme is not None:
            for el in scheme:
                tag = etree.QName(el).localname
                c = el[0] if len(el) else None
                if c is None:
                    continue
                val = c.get("val") if etree.QName(c).localname == "srgbClr" else c.get("lastClr")
                if val:
                    colors[tag] = val.upper()
        for kind in ("majorFont", "minorFont"):
            f = root.find(f".//a:{kind}", ns)
            if f is not None:
                lat = f.find("a:latin", ns)
                ea = f.find("a:ea", ns)
                fonts[kind] = {"latin": lat.get("typeface") if lat is not None else None, "ea": ea.get("typeface") if ea is not None else None}
    accents = [colors.get(f"accent{i}") for i in range(1, 7) if colors.get(f"accent{i}")]
    # 高亮：前三个强调色里最鲜艳的；强调色：和它色相差最远的那个
    # 高亮：accent1（一般就是品牌主色）；太暗或太灰就换前三个里最鲜艳的。强调色：accent2，和高亮色太像就换色相最远的
    vivid = sorted(accents[:3], key=lambda c: -(hsv(c)[1] * hsv(c)[2])) if accents else []
    a1 = accents[0] if accents else None
    highlight = a1 if a1 and hsv(a1)[1] > 0.35 and hsv(a1)[2] > 0.35 else (vivid[0] if vivid else DEFAULT["highlight"])
    others = [c for c in accents if c != highlight]
    accent = others[0] if others and hue_dist(others[0], highlight) > 40 else (max(others, key=lambda c: hue_dist(c, highlight)) if others else DEFAULT["accent"])
    dark = next((colors[k] for k in ("dk2", "dk1") if colors.get(k) and lum(colors[k]) < 0.3), DEFAULT["dark"])
    minor = fonts.get("minorFont", {})
    use_master = abs(aspect - 16 / 9) < 0.02
    if not use_master:
        os.remove(dst)
    return {
        "kind": "pptx", "useMaster": use_master, "aspect": round(aspect, 3),
        "palette": {"highlight": highlight, "accent": accent, "dark": dark},
        "fonts": {"latin": minor.get("latin") or None, "ea": minor.get("ea") or None},
        "themeColors": colors, "layouts": [l.name for l in prs.slide_layouts],
        "note": None if use_master else "not16x9",
    }


# ---------------- PDF 范例 ----------------
def from_pdf(src, out):
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(src)
    n = len(doc)
    pages = list(range(min(n, 16)))
    import math
    counts = Counter()       # 量化后的颜色 → 像素数
    pages_with = Counter()   # 量化后的颜色 → 出现在几页上（logo 只在几页出现，贯穿全稿的品牌色每页都有）
    exact = {}               # 量化后的颜色 → 原始颜色的计数（最后还原成原图里的真实颜色）
    cover_counts = Counter()
    cover_lum = 1.0
    aspect = None
    for i in pages:
        page = doc[i]
        w, h = page.get_size()
        aspect = aspect or (w / h if h else None)
        img = page.render(scale=0.35).to_pil().convert("RGB")
        px = list(img.get_flattened_data() if hasattr(img, "get_flattened_data") else img.getdata())
        if i == 0:
            img.resize((480, int(480 * img.height / img.width))).save(os.path.join(out, "preview.png"))
            cover_lum = sum(0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in px) / (255 * len(px))
        here = Counter()
        for r, g, b in px:
            q = ((r >> 4) << 4 | 8, (g >> 4) << 4 | 8, (b >> 4) << 4 | 8)
            hh, ss, vv = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if i == 0:
                cover_counts[q] += 1
            if ss >= 0.45 and vv >= 0.35:
                counts[q] += 1
                here[q] += 1
                exact.setdefault(q, Counter())[(r, g, b)] += 1
        for q, k in here.items():
            if k >= 12:
                pages_with[q] += 1
    score = {q: pages_with[q] * math.log(1 + counts[q]) for q in counts}
    ranked = sorted(score, key=lambda q: -score[q])[:60]
    hexes = [("%02X%02X%02X" % exact[q].most_common(1)[0][0], score[q]) for q in ranked]
    highlight = hexes[0][0] if hexes else DEFAULT["highlight"]
    accent = next((c for c, _ in hexes[1:] if hue_dist(c, highlight) > 45), DEFAULT["accent"])
    # 深色页：封面整体偏暗就用封面最常见的暗色
    dark = DEFAULT["dark"]
    if cover_lum < 0.35:
        darks = [c for c, _ in cover_counts.most_common(40) if 0.02 < lum("%02X%02X%02X" % c) < 0.25]
        if darks:
            dark = "%02X%02X%02X" % darks[0]
    # 把量化后的颜色往原色上「吸」：在原图里找最接近的高频真实颜色
    return {
        "kind": "pdf", "useMaster": False, "aspect": round(aspect, 3) if aspect else None, "pages": n,
        "palette": {"highlight": highlight, "accent": accent, "dark": dark},
        "fonts": {"latin": None, "ea": None}, "coverDark": cover_lum < 0.35,
        "note": None,
    }


def main():
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    ext = os.path.splitext(src)[1].lower()
    if ext in (".pptx", ".potx"):
        info = from_pptx(src, out)
    elif ext == ".pdf":
        info = from_pdf(src, out)
    else:
        raise SystemExit(json.dumps({"ok": False, "error": "unsupported"}))
    info["ok"] = True
    with open(os.path.join(out, "template.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False)
    print(json.dumps(info, ensure_ascii=False))


if __name__ == "__main__":
    main()
