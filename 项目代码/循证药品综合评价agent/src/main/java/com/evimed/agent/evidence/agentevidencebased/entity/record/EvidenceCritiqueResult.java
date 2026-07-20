package com.evimed.agent.evidence.agentevidencebased.entity.record;

/**
 * 循证研究批判/评审结果
 *
 * - passed:   是否通过（true = 证据充分，可进入报告生成）
 * - feedback: 未通过时的反馈（需补充哪些证据方向）
 */
public record EvidenceCritiqueResult(
        boolean passed,
        String feedback
) {
}
