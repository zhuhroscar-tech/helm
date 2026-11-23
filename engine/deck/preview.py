"""把汇报的 PDF 每页渲染成 PNG，给网页做预览。

用法：python preview.py <deck.pdf> <输出目录> [宽度像素=1280]
stdout：{"ok": true, "pages": N}
"""
import json
import os
import sys

import pypdfium2 as pdfium


def main():
    src, out = sys.argv[1], sys.argv[2]
    width = int(sys.argv[3]) if len(sys.argv) > 3 else 1280
    os.makedirs(out, exist_ok=True)
    for f in os.listdir(out):
        if f.endswith(".png"):
            os.remove(os.path.join(out, f))
    doc = pdfium.PdfDocument(src)
    n = len(doc)
    for i in range(n):
        page = doc[i]
        w, _ = page.get_size()
        img = page.render(scale=width / w).to_pil().convert("RGB")
        img.save(os.path.join(out, "p%02d.png" % (i + 1)), optimize=True)
    print(json.dumps({"ok": True, "pages": n}))


if __name__ == "__main__":
    main()
