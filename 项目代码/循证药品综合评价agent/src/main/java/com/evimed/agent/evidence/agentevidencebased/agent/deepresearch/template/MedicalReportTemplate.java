package com.evimed.agent.evidence.agentevidencebased.agent.deepresearch.template;

import java.util.List;
import java.util.stream.Collectors;

/**
 * 医学报告模板（类型 + 显示名称 + 章节列表）
 * 注入提示词作为"软建议"，LLM 可根据实际证据调整章节。
 */
public record MedicalReportTemplate(
        MedicalReportType type,
        String displayName,
        List<TemplateChapter> chapters
) {

    /**
     * 生成注入提示词的模板说明文本
     */
    public String toPromptString() {
        StringBuilder sb = new StringBuilder();
        sb.append("报告类型: ").append(displayName).append("\n");
        sb.append("建议章节结构（LLM 可根据实际证据增减调整，非强制）:\n");
        for (TemplateChapter ch : chapters) {
            if (ch.order() == 0) {
                // 摘要等前置章节：不带编号
                sb.append("[前置] ").append(ch.title());
            } else {
                sb.append(ch.order()).append(". ").append(ch.title());
            }
            if (!ch.required()) {
                sb.append("（可选）");
            }
            sb.append("\n");
            if (ch.description() != null && !ch.description().isBlank()) {
                sb.append("   ").append(ch.description()).append("\n");
            }
            if (ch.layout() != null && !ch.layout().isBlank()) {
                sb.append("   ").append(ch.layout().strip()).append("\n");
            }
        }
        return sb.toString();
    }

    /**
     * 获取所有章节标题列表（用于 fallback TOC）
     */
    public List<String> getChapterTitles() {
        return chapters.stream()
                .map(TemplateChapter::title)
                .collect(Collectors.toList());
    }
}
