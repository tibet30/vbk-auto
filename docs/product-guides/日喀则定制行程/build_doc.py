# -*- coding: utf-8 -*-
"""渲染《日喀则行程定制全流程操作指引》为 docx。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '_shared'))
from guide_docx import render  # noqa: E402

import content  # noqa: E402

OUT = Path(__file__).parent / '日喀则行程定制全流程操作指引（评审稿）.docx'

if __name__ == '__main__':
    render(content, OUT)
