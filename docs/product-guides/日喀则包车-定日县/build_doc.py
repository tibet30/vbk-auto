# -*- coding: utf-8 -*-
"""渲染《日喀则包车全流程操作指引》为 docx。"""
from pathlib import Path
from docx import Document
from docx.shared import Cm, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from PIL import Image
from content import COVER, BLOCKS

OUT = Path(__file__).parent / '日喀则包车全流程操作指引（定日县示例·评审稿）.docx'
FONT = 'PingFang SC'
INK = RGBColor(0x1F, 0x2A, 0x37)
MUTED = RGBColor(0x5A, 0x6B, 0x80)
BLUE = RGBColor(0x1F, 0x4E, 0x79)

def set_font(run, size=None, bold=None, color=None, name=FONT):
    run.font.name = name
    run._element.rPr.rFonts.set(qn('w:eastAsia'), name)
    if size: run.font.size = Pt(size)
    if bold is not None: run.font.bold = bold
    if color: run.font.color.rgb = color

def shade(cell, hexcolor):
    tcPr = cell._tc.get_or_add_tcPr()
    el = OxmlElement('w:shd'); el.set(qn('w:val'), 'clear'); el.set(qn('w:color'), 'auto'); el.set(qn('w:fill'), hexcolor)
    tcPr.append(el)

def cell_margins(table, top=80, bottom=80, left=100, right=100):
    tblPr = table._tbl.tblPr
    mar = OxmlElement('w:tblCellMar')
    for k, v in (('top', top), ('bottom', bottom), ('left', left), ('right', right)):
        e = OxmlElement(f'w:{k}'); e.set(qn('w:w'), str(v)); e.set(qn('w:type'), 'dxa'); mar.append(e)
    tblPr.append(mar)

def para_border_bottom(p, color='1F4E79', sz=8):
    pPr = p._p.get_or_add_pPr(); pbdr = OxmlElement('w:pBdr'); b = OxmlElement('w:bottom')
    b.set(qn('w:val'), 'single'); b.set(qn('w:sz'), str(sz)); b.set(qn('w:space'), '4'); b.set(qn('w:color'), color)
    pbdr.append(b); pPr.append(pbdr)

def h1(doc, text):
    p = doc.add_paragraph(); p.paragraph_format.space_before = Pt(16); p.paragraph_format.space_after = Pt(8)
    p.paragraph_format.keep_with_next = True
    set_font(p.add_run(text), 15, True, BLUE); para_border_bottom(p)
    return p

def h2(doc, text):
    p = doc.add_paragraph(); p.paragraph_format.space_before = Pt(12); p.paragraph_format.space_after = Pt(5)
    p.paragraph_format.keep_with_next = True
    set_font(p.add_run(text), 12.5, True, RGBColor(0x2E, 0x75, 0xB6))
    return p

def h3(doc, text):
    p = doc.add_paragraph(); p.paragraph_format.space_before = Pt(8); p.paragraph_format.space_after = Pt(3)
    p.paragraph_format.keep_with_next = True
    set_font(p.add_run(text), 10.8, True, RGBColor(0x33, 0x41, 0x55))
    return p

def body(doc, text):
    p = doc.add_paragraph(); p.paragraph_format.space_after = Pt(4); p.paragraph_format.line_spacing = 1.35
    set_font(p.add_run(text), 10.5, False, INK)
    return p

def bullets(doc, items):
    for it in items:
        p = doc.add_paragraph(style='List Bullet'); p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.left_indent = Cm(0.7); p.paragraph_format.first_line_indent = Cm(-0.35)
        p.paragraph_format.line_spacing = 1.3
        set_font(p.add_run(it), 10.2, False, INK)

def callout(doc, text):
    t = doc.add_table(rows=1, cols=1); t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = True
    c = t.cell(0, 0); shade(c, 'EAF1FB'); cell_margins(t, 120, 120, 160, 160)
    p = c.paragraphs[0]; p.paragraph_format.space_after = Pt(0); p.paragraph_format.line_spacing = 1.3
    set_font(p.add_run('提示  '), 9.6, True, RGBColor(0x1D, 0x63, 0xDA))
    set_font(p.add_run(text), 9.6, False, RGBColor(0x2B, 0x3A, 0x4F))
    doc.add_paragraph().paragraph_format.space_after = Pt(2)

def table(doc, headers, rows, widths):
    t = doc.add_table(rows=1, cols=len(headers)); t.style = 'Table Grid'; t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False; cell_margins(t)
    for i, w in enumerate(widths):
        t.columns[i].width = Cm(w)
    for i, h in enumerate(headers):
        c = t.rows[0].cells[i]; c.width = Cm(widths[i]); shade(c, 'D9E2F3')
        p = c.paragraphs[0]; p.paragraph_format.space_after = Pt(0)
        set_font(p.add_run(h), 9.2, True, BLUE)
    for row in rows:
        cells = t.add_row().cells
        for i, val in enumerate(row):
            cells[i].width = Cm(widths[i])
            p = cells[i].paragraphs[0]; p.paragraph_format.space_after = Pt(0); p.paragraph_format.line_spacing = 1.2
            set_font(p.add_run(str(val)), 8.8, False, INK)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)

def add_caption(doc, text):
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(2); p.paragraph_format.space_after = Pt(8)
    set_font(p.add_run(text), 8.8, False, MUTED)

def image(doc, path, width_cm, caption):
    path = str((Path(__file__).parent / 'assets' / path).resolve()) if not Path(path).is_absolute() else path
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(4); p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.keep_with_next = True
    p.add_run().add_picture(path, width=Cm(width_cm))
    add_caption(doc, caption)

def image_pair(doc, a, b):
    t = doc.add_table(rows=1, cols=2); t.alignment = WD_TABLE_ALIGNMENT.CENTER; cell_margins(t, 40, 40, 60, 60)
    for i, (path, cap) in enumerate((a, b)):
        path = str((Path(__file__).parent / 'assets' / path).resolve()) if not Path(path).is_absolute() else path
        c = t.cell(0, i); c.width = Cm(7.8)
        p = c.paragraphs[0]; p.alignment = WD_ALIGN_PARAGRAPH.CENTER; p.paragraph_format.space_after = Pt(2)
        im = Image.open(path); w, h = im.size
        p.add_run().add_picture(path, width=Cm(7.4))
        cp = c.add_paragraph(); cp.alignment = WD_ALIGN_PARAGRAPH.CENTER; cp.paragraph_format.space_after = Pt(2)
        set_font(cp.add_run(cap), 8.4, False, MUTED)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)

def page_number_footer(section):
    p = section.footer.paragraphs[0]; p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(); f1 = OxmlElement('w:fldChar'); f1.set(qn('w:fldCharType'), 'begin')
    it = OxmlElement('w:instrText'); it.set(qn('xml:space'), 'preserve'); it.text = ' PAGE '
    f2 = OxmlElement('w:fldChar'); f2.set(qn('w:fldCharType'), 'end')
    run._r.append(f1); run._r.append(it); run._r.append(f2)
    set_font(run, 8.5, False, MUTED)

def cover(doc):
    for _ in range(3): doc.add_paragraph()
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_font(p.add_run(COVER['title']), 26, True, BLUE)
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(6)
    set_font(p.add_run(COVER['subtitle']), 12.5, False, RGBColor(0x2E, 0x75, 0xB6))
    doc.add_paragraph()
    t = doc.add_table(rows=0, cols=2); t.alignment = WD_TABLE_ALIGNMENT.CENTER; cell_margins(t, 90, 90, 140, 140)
    for k, v in COVER['meta']:
        cells = t.add_row().cells
        cells[0].width = Cm(3.2); cells[1].width = Cm(10.8)
        set_font(cells[0].paragraphs[0].add_run(k + '：'), 9.5, True, MUTED)
        set_font(cells[1].paragraphs[0].add_run(v), 9.5, False, INK)
    doc.add_paragraph()
    callout(doc, COVER['note'])
    doc.add_page_break()

def render():
    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21), Cm(29.7)
    sec.left_margin = sec.right_margin = Cm(2.2); sec.top_margin = Cm(2.0); sec.bottom_margin = Cm(2.0)
    st = doc.styles['Normal']; st.font.name = FONT; st.font.size = Pt(10.5)
    st.element.rPr.rFonts.set(qn('w:eastAsia'), FONT)
    page_number_footer(sec)
    doc.core_properties.title = '日喀则包车全流程操作指引（定日县示例·评审稿）'
    doc.core_properties.author = '喜格孜运营'
    doc.core_properties.subject = '产品发布到订单结束的全流程角色操作指引'
    cover(doc)
    for block in BLOCKS:
        kind = block[0]
        if kind == 'h1': h1(doc, block[1])
        elif kind == 'h2': h2(doc, block[1])
        elif kind == 'h3': h3(doc, block[1])
        elif kind == 'p': body(doc, block[1])
        elif kind == 'b': bullets(doc, block[1])
        elif kind == 'callout': callout(doc, block[1])
        elif kind == 'table': table(doc, block[1], block[2], block[3])
        elif kind == 'img': image(doc, block[1], block[2], block[3])
        elif kind == 'imgpair': image_pair(doc, *block[1:])
        else: raise ValueError(kind)
    doc.save(OUT)
    print('saved', OUT, OUT.stat().st_size)

if __name__ == '__main__':
    render()
