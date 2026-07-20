package com.evimed.agent.evidence.agentevidencebased.agent.deepresearch.template;

import java.util.List;

/**
 * 报告模板章节定义
 *
 * - order:       章节序号
 * - title:       章节标题
 * - description: 章节内容说明（注入提示词，作为软建议）
 * - required:    是否为必选章节
 * - searchHints: 本章节检索建议关键词
 * - layout:      撰写阶段排版格式指令（null 表示使用默认段落格式）
 * - deferWrite:  是否延迟撰写（true = 在主体章节写完后，基于全文内容最后补写，如摘要/研究背景）
 */
public record TemplateChapter(
        int order,
        String title,
        String description,
        boolean required,
        List<String> searchHints,
        String layout,
        boolean deferWrite
) {
    /** 兼容：无 layout 无 deferWrite */
    public TemplateChapter(int order, String title, String description, boolean required, List<String> searchHints) {
        this(order, title, description, required, searchHints, null, false);
    }

    /** 兼容：有 layout 无 deferWrite */
    public TemplateChapter(int order, String title, String description, boolean required, List<String> searchHints, String layout) {
        this(order, title, description, required, searchHints, layout, false);
    }
}

