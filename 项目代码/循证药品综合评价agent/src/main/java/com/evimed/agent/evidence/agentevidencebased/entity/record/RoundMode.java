package com.evimed.agent.evidence.agentevidencebased.entity.record;

/** Agent 轮次执行模式 */
public enum RoundMode {
    UNKNOWN,    // 初始未知状态
    TEXT,       // 纯文本输出
    TOOL_CALL   // 工具调用模式
}
