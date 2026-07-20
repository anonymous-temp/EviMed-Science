package com.evimed.agent.evidence.agentevidencebased.entity.record;

/**
 * 循证研究计划任务记录
 *
 * - id:          任务唯一标识（用于依赖关系）
 * - title:       简短任务标题（用于 UI 展示）
 * - detail:      任务详细描述（用于 UI 展示）
 * - instruction: 发给 LLM 执行器的完整指令（含工具调用说明）
 * - order:       执行顺序（相同 order 的任务并行执行）
 */
public record EvidencePlanTask(
        String id,
        String title,
        String detail,
        String instruction,
        int order
) {
}
