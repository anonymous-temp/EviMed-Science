package com.evimed.agent.evidence.agentevidencebased.entity.record;

import lombok.Data;
import org.springframework.ai.chat.messages.AssistantMessage;

import java.util.Collections;
import java.util.ArrayList;
import java.util.List;

/** Agent 单轮执行状态（每次 LLM 调用的中间状态） */
@Data
public class RoundState {

    /** 当前运行模式 */
    public RoundMode mode = RoundMode.UNKNOWN;

    /** 文本缓冲区（收集非工具调用的文本片段） */
    public StringBuilder textBuffer = new StringBuilder();

    /** 工具调用列表（流式合并） */
    public List<AssistantMessage.ToolCall> toolCalls = Collections.synchronizedList(new ArrayList<>());

    public RoundMode getMode() {
        return mode;
    }
}
