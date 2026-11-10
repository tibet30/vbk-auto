# -*- coding: utf-8 -*-
"""五类产品操作指引共用的 docx 渲染器。

内容模块需提供 COVER、BLOCKS、ASSETS；本模块只负责版式，不承载业务文案。
"""
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

FONT = 'PingFang SC'
INK = RGBColor(0x1F, 0x2A, 0x37)
MUTED = RGBColor(0x5A, 0x6B, 0x80)
BLUE = RGBColor(0x1F, 0x4E, 0x79)
LIGHT = RGBColor(0x2E, 0x75, 0xB6)
DARK = RGBColor(0x33, 0x41, 0x55)


def _font(run, size=None, bold=None, color=None, name=FONT):
    run.font.name = name
    run._element.rPr.rFonts.set(qn('w:eastAsia'), name)
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color:
        run.font.color.rgb = color


def _shade(cell, hexcolor):
    tcPr = cell._tc.get_or_add_tcPr()
    el = OxmlElement('w:shd')
    el.set(qn('w:val'), 'clear')
    el.set(qn('w:color'), 'auto')
    el.set(qn('w:fill'), hexcolor)
    tcPr.append(el)


def _margins(table, top=80, bottom=80, left=100, right=100):
    tblPr = table._tbl.tblPr
    mar = OxmlElement('w:tblCellMar')
    for key, value in (('top', top), ('bottom', bottom), ('left', left), ('right', right)):
        el = OxmlElement(f'w:{key}')
        el.set(qn('w:w'), str(value))
        el.set(qn('w:type'), 'dxa')
        mar.append(el)
    tblPr.append(mar)


def _border(p):
    pPr = p._p.get_or_add_pPr()
    pbdr = OxmlElement('w:pBdr')
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'), 'single')
    bottom.set(qn('w:sz'), '8')
    bottom.set(qn('w:space'), '4')
    bottom.set(qn('w:color'), '1F4E79')
    pbdr.append(bottom)
    pPr.append(pbdr)


def _h1(doc, text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(16)
    p.paragraph_format.space_after = Pt(8)
    p.paragraph_format.keep_with_next = True
    _font(p.add_run(text), 15, True, BLUE)
    _border(p)


def _h2(doc, text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(12)
    p.paragraph_format.space_after = Pt(5)
    p.paragraph_format.keep_with_next = True
    _font(p.add_run(text), 12.5, True, LIGHT)


def _h3(doc, text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(8)
    p.paragraph_format.space_after = Pt(3)
    p.paragraph_format.keep_with_next = True
    _font(p.add_run(text), 10.8, True, DARK)


def _p(doc, text):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(4)
    p.paragraph_format.line_spacing = 1.35
    _font(p.add_run(text), 10.5, False, INK)


def _bullets(doc, items):
    for item in items:
        p = doc.add_paragraph(style='List Bullet')
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.left_indent = Cm(0.7)
        p.paragraph_format.first_line_indent = Cm(-0.35)
        p.paragraph_format.line_spacing = 1.3
        _font(p.add_run(item), 10.2, False, INK)


def _callout(doc, text):
    table = doc.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = True
    cell = table.cell(0, 0)
    _shade(cell, 'EAF1FB')
    _margins(table, 120, 120, 160, 160)
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.line_spacing = 1.3
    _font(p.add_run('提示  '), 9.6, True, RGBColor(0x1D, 0x63, 0xDA))
    _font(p.add_run(text), 9.6, False, RGBColor(0x2B, 0x3A, 0x4F))
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def _table(doc, headers, rows, widths):
    table = doc.add_table(rows=1, cols=len(headers))
    table.style = 'Table Grid'
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    _margins(table)
    header_row = table.rows[0]._tr
    header_row.get_or_add_trPr().append(OxmlElement('w:tblHeader'))
    for index, width in enumerate(widths):
        table.columns[index].width = Cm(width)
    for index, header in enumerate(headers):
        cell = table.rows[0].cells[index]
        cell.width = Cm(widths[index])
        _shade(cell, 'D9E2F3')
        p = cell.paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.keep_with_next = True
        _font(p.add_run(header), 9.2, True, BLUE)
    for row in rows:
        new_row = table.add_row()
        new_row._tr.get_or_add_trPr().append(OxmlElement('w:cantSplit'))
        cells = new_row.cells
        for index, value in enumerate(row):
            cells[index].width = Cm(widths[index])
            p = cells[index].paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.line_spacing = 1.2
            _font(p.add_run(str(value)), 8.8, False, INK)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def _caption(doc, text):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.space_after = Pt(8)
    _font(p.add_run(text), 8.8, False, MUTED)


def _image(doc, path, width_cm, caption):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.keep_with_next = True
    p.add_run().add_picture(str(path), width=Cm(width_cm))
    _caption(doc, caption)


def _image_pair(doc, first, second):
    table = doc.add_table(rows=1, cols=2)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    _margins(table, 40, 40, 60, 60)
    for index, (path, caption) in enumerate((first, second)):
        cell = table.cell(0, index)
        cell.width = Cm(7.8)
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(2)
        p.add_run().add_picture(str(path), width=Cm(7.4))
        capture = cell.add_paragraph()
        capture.alignment = WD_ALIGN_PARAGRAPH.CENTER
        capture.paragraph_format.space_after = Pt(2)
        _font(capture.add_run(caption), 8.4, False, MUTED)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def _footer(section):
    p = section.footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run()
    begin = OxmlElement('w:fldChar')
    begin.set(qn('w:fldCharType'), 'begin')
    instr = OxmlElement('w:instrText')
    instr.set(qn('xml:space'), 'preserve')
    instr.text = ' PAGE '
    end = OxmlElement('w:fldChar')
    end.set(qn('w:fldCharType'), 'end')
    run._r.append(begin)
    run._r.append(instr)
    run._r.append(end)
    _font(run, 8.5, False, MUTED)


def _cover(doc, cover):
    for _ in range(3):
        doc.add_paragraph()
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _font(p.add_run(cover['title']), 26, True, BLUE)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(6)
    _font(p.add_run(cover['subtitle']), 12.5, False, LIGHT)
    doc.add_paragraph()
    table = doc.add_table(rows=0, cols=2)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    _margins(table, 90, 90, 140, 140)
    for key, value in cover['meta']:
        cells = table.add_row().cells
        cells[0].width = Cm(3.2)
        cells[1].width = Cm(10.8)
        _font(cells[0].paragraphs[0].add_run(key + '：'), 9.5, True, MUTED)
        _font(cells[1].paragraphs[0].add_run(value), 9.5, False, INK)
    doc.add_paragraph()
    _callout(doc, cover['note'])
    doc.add_page_break()


def render(content, out_path):
    doc = Document()
    section = doc.sections[0]
    section.page_width, section.page_height = Cm(21), Cm(29.7)
    section.left_margin = section.right_margin = Cm(2.2)
    section.top_margin = section.bottom_margin = Cm(2.0)
    style = doc.styles['Normal']
    style.font.name = FONT
    style.font.size = Pt(10.5)
    style.element.rPr.rFonts.set(qn('w:eastAsia'), FONT)
    _footer(section)
    doc.core_properties.title = content.OUT_TITLE
    doc.core_properties.author = '喜格孜运营'
    doc.core_properties.subject = '产品发布到订单结束的全流程角色操作指引'
    _cover(doc, content.COVER)
    for block in content.BLOCKS:
        kind = block[0]
        if kind == 'h1':
            _h1(doc, block[1])
        elif kind == 'h2':
            _h2(doc, block[1])
        elif kind == 'h3':
            _h3(doc, block[1])
        elif kind == 'p':
            _p(doc, block[1])
        elif kind == 'b':
            _bullets(doc, block[1])
        elif kind == 'callout':
            _callout(doc, block[1])
        elif kind == 'table':
            _table(doc, block[1], block[2], block[3])
        elif kind == 'img':
            _image(doc, block[1], block[2], block[3])
        elif kind == 'imgpair':
            _image_pair(doc, block[1], block[2])
        else:
            raise ValueError(f'unknown block: {kind}')
    doc.save(str(out_path))
    print('saved', out_path, Path(out_path).stat().st_size)
