package com.sentum.evidencecomprehensive.service;


import com.sentum.evidencecomprehensive.pojo.dto.entity.PdfEditResult;

/**
 * Description: 质量评价 相关
 */

public interface PdfEditResultService extends BaseRepository<PdfEditResult>{

    /**
     * 根据文献 id 和 课题 id 获取
     * @param paperId 文献 id
     * @param questionId 课题 id
     */
    PdfEditResult getPaperEditResultPaperIdAndQuestionId(String paperId, String questionId, String paperType);

    /**
     * @param paperId  文献 id
     * @param questionId 课题 id
     */
    void deletePdfEditResultByPaperIdAndQuestionId(String paperId, String questionId);
}