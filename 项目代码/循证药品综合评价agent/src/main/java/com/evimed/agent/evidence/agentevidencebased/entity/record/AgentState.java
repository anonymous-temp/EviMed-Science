package com.evimed.agent.evidence.agentevidencebased.entity.record;

import java.util.ArrayList;
import java.util.List;

/** 跨轮次的 Agent 全局状态（存储搜索结果等跨轮次数据） */
public class AgentState {
    public List<SearchResult> searchResults = new ArrayList<>();
}
