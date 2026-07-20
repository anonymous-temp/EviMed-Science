package com.evimed.agent.evidence.agentevidencebased.entity.record;

/**
 * 单个研究任务的执行结果
 *
 * - taskId:  对应 EvidencePlanTask.id
 * - success: 是否成功
 * - output:  成功时的输出内容（工具结果整理）
 * - error:   失败时的错误信息
 */
public record EvidenceTaskResult(
        String taskId,
        boolean success,
        String output,
        String error
) {
}
