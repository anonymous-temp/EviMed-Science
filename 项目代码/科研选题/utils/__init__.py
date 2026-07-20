"""
通用工具模块
包含：安全JSON解析、文本处理等
"""
import re
import json
import logging
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)


def safe_parse_json(response: str, fallback: Dict[str, Any] = None) -> Dict[str, Any]:
    """
    安全解析LLM返回的JSON，处理各种常见的格式问题

    策略：
    1. 直接解析
    2. 去掉 ```json ``` 包裹后重试
    3. 用正则提取第一个 { ... } 块重试
    4. 尝试修复常见的JSON格式错误
    5. 返回fallback

    Args:
        response: LLM返回的原始文本
        fallback: 解析失败时的默认值

    Returns:
        解析后的字典
    """
    if fallback is None:
        fallback = {}

    if not response or not response.strip():
        logger.warning("LLM返回空响应，使用fallback")
        return fallback

    text = response.strip()

    # 策略1: 直接解析
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # 策略2: 去掉markdown代码块包裹
    # 匹配 ```json ... ``` 或 ``` ... ```
    code_block_pattern = r'```(?:json)?\s*\n?(.*?)\n?\s*```'
    match = re.search(code_block_pattern, text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # 策略3: 提取第一个完整的 { ... } 块（支持嵌套）
    json_block = _extract_json_block(text)
    if json_block:
        try:
            return json.loads(json_block)
        except json.JSONDecodeError:
            pass

    # 策略4: 尝试修复常见格式错误
    fixed = _fix_common_json_errors(json_block or text)
    if fixed:
        try:
            return json.loads(fixed)
        except json.JSONDecodeError:
            pass

    # 策略5: 返回fallback
    logger.warning(f"JSON解析完全失败，使用fallback。原始响应前200字符: {text[:200]}")
    return fallback


def _extract_json_block(text: str) -> Optional[str]:
    """
    从文本中提取第一个完整的JSON对象（支持嵌套大括号）
    """
    start = text.find('{')
    if start == -1:
        return None

    depth = 0
    in_string = False
    escape_next = False

    for i in range(start, len(text)):
        char = text[i]

        if escape_next:
            escape_next = False
            continue

        if char == '\\' and in_string:
            escape_next = True
            continue

        if char == '"' and not escape_next:
            in_string = not in_string
            continue

        if in_string:
            continue

        if char == '{':
            depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0:
                return text[start:i + 1]

    return None


def _fix_common_json_errors(text: str) -> Optional[str]:
    """
    修复LLM输出中常见的JSON格式错误
    """
    if not text:
        return None

    fixed = text

    # 修复1: 去掉尾部多余的逗号 (trailing commas)
    fixed = re.sub(r',\s*([}\]])', r'\1', fixed)

    # 修复2: 将单引号替换为双引号（仅在非嵌套情况下）
    # 这个比较危险，只在其他方法都失败时尝试
    if "'" in fixed and '"' not in fixed:
        fixed = fixed.replace("'", '"')

    # 修复3: 修复 true/false/null 的大小写问题
    fixed = re.sub(r'\bTrue\b', 'true', fixed)
    fixed = re.sub(r'\bFalse\b', 'false', fixed)
    fixed = re.sub(r'\bNone\b', 'null', fixed)

    # 修复4: 去掉注释
    fixed = re.sub(r'//.*?$', '', fixed, flags=re.MULTILINE)

    return fixed
