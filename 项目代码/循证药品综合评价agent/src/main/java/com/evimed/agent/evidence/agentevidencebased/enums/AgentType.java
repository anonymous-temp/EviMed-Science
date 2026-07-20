package com.evimed.agent.evidence.agentevidencebased.enums;

/**
 * Agent 类型枚举
 * 与 LLMentor 保持一致，前端传数字 code
 */
public enum AgentType {

    /** 1 - 医学智能问答（ReAct） */
    MEDICAL_QA(1),

    /** 2 - 文件上传解析 */
    FILE_UPLOAD(2),

    /** 3 - PPT 生成 */
    PPT(3),

    /** 4 - 深度研究 / 循证报告（Plan-Execute） */
    DEEP_RESEARCH(4),

    /** 5 - 知识库循证报告（KB + LLM 混合检索） */
    KB_EVIDENCE_REPORT(5),

    /** 6 - 药品安全性分析（FAERS ADR 信号挖掘，DB 存储名 drug-safety） */
    DRUG_SAFETY(6);

    private final int code;

    AgentType(int code) {
        this.code = code;
    }

    public int getCode() {
        return code;
    }

    /**
     * 根据 code 查找枚举，找不到返回默认的 MEDICAL_QA
     */
    public static AgentType fromCode(Integer code) {
        if (code == null) return MEDICAL_QA;
        for (AgentType t : values()) {
            if (t.code == code) return t;
        }
        return MEDICAL_QA;
    }

    /**
     * 根据枚举名称字符串查找枚举，找不到返回 null。
     * 用于从数据库存储的 agentType 字段还原枚举。
     * 兼容两种格式：DB 存储格式（kb-evidence-report）和枚举名（KB_EVIDENCE_REPORT）
     */
    public static AgentType fromName(String name) {
        if (name == null || name.isBlank()) return null;
        String normalized = name.trim().toUpperCase().replace("-", "_");
        for (AgentType t : values()) {
            if (t.name().equals(normalized)) return t;
        }
        return null;
    }
}
