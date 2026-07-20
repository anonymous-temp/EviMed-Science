package com.evimed.agent.evidence.agentevidencebased.entity.record;

import java.util.List;
import java.util.Map;

/**
 * 单轮 Plan-Execute 状态快照
 *
 * - round:    轮次编号（从 1 开始）
 * - plan:     本轮生成的执行计划
 * - results:  taskId → 执行结果 映射
 * - critique: 本轮评审结果
 */
public record EvidencePlanRoundState(
        int round,
        List<EvidencePlanTask> plan,
        Map<String, EvidenceTaskResult> results,
        EvidenceCritiqueResult critique
) {
}
