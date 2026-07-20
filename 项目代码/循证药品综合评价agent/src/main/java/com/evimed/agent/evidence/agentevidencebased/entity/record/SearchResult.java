package com.evimed.agent.evidence.agentevidencebased.entity.record;

/** 搜索结果记录（用于参考文献展示） */
public record SearchResult(
        String url,
        String title,
        String content
) {
}
