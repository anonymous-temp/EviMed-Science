package com.evimed.agent.evidence.agentevidencebased.agent.deepresearch.template;

/**
 * 医学报告类型枚举
 *
 * 前端可在请求中指定，也可由 AgentDispatcher 从用户问题中识别。
 * 默认为 HTA_ASSESSMENT（卫生技术评估）。
 */
public enum MedicalReportType {

    /** 卫生技术评估（Health Technology Assessment） - 默认 */
    HTA_ASSESSMENT("卫生技术评估报告"),

    /** 循证综合（Evidence Synthesis） */
    EVIDENCE_SYNTHESIS("循证综合报告"),

    /** 系统综述（Systematic Review） */
    SYSTEMATIC_REVIEW("系统综述报告"),

    /** 药物安全报告（Drug Safety Report） */
    DRUG_SAFETY_REPORT("药物安全性报告");

    private final String displayName;

    MedicalReportType(String displayName) {
        this.displayName = displayName;
    }

    public String getDisplayName() {
        return displayName;
    }
}
