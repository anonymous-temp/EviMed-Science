package com.sentum.evidencecomprehensive.service;

import com.sentum.evidencecomprehensive.domain.entity.paper.PdfEditResult;

/**
 * Description: 质量评价 相关
 */

public interface PdfEditResultService extends BaseRepository<PdfEditResult>{

    /**
     * 根据文献 id 和 课题 id 获取
     *
     * @param paperId    文献 id
     * @param questionId 课题 id
     * @param studyType
     */
    PdfEditResult getPaperEditResultPaperIdAndQuestionId(String paperId, String questionId, String studyType);

    /**
     * @param paperId  文献 id
     * @param questionId 课题 id
     */
    void deletePdfEditResultByPaperIdAndQuestionId(String paperId, String questionId);
}
