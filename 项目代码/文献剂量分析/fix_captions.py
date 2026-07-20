#!/usr/bin/env python3
"""批量修改报告中图表标题位置：图注在下，表题在上"""
import re

file_path = r"G:\前端代码管理\证据工厂\文献计量分析\src\bibliometric\report\results_sections.py"

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 模式1: 图X. 标题\n![...](...)  =>  ![...](...)\n**图X. 标题**
content = re.sub(
    r'(f?"\\n图\{fig\}\. )([^"]+)(\\n"\s*"!\[)',
    r'\3\n" f"**图{fig}. \2**',
    content
)
content = re.sub(
    r'(f?"\\nFigure \{fig\}\. )([^"]+)(\\n"\s*"!\[)',
    r'\3\n" f"**Figure {fig}. \2**',
    content
)

# 模式2: 直接的图注（不带fig变量）
# 需要手动处理每个具体位置

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("✓ 图表标题位置已调整")
