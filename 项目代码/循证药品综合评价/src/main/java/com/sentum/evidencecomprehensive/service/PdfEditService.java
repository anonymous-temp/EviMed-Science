package com.sentum.evidencecomprehensive.service;

import com.sentum.evidencecomprehensive.domain.entity.paper.PdfEdit;

import java.util.List;

/**
 * Description:
 */


public interface PdfEditService extends BaseRepository<PdfEdit>{

    /**
     * 获取课题 文献的质量编辑信息
     * @param paperId  文献 id
     * @param questionId 课题 id
     * @param standardId 标准 id
     */
    PdfEdit getPaperStandardByPaperIdAndQuestionId(String paperId, String questionId, String standardId);

    /**
     * 获取文献的质量编辑信息
     * @param questionId 课题 id
     * @return 返回文献的质量编辑信息
     */
    public List<PdfEdit> getPaperEditByQuestionId(String questionId);

    /**
     * 获取课题 文献的质量编辑列表信息
     * @param paperId  文献 id
     * @param questionId 课题 id
     */
    List<PdfEdit> getPaperStandardsByPaperIdAndQuestionId(String paperId, String questionId);

    /**
     * 删除 文献的质量编辑列表信息
     * @param paperId  文献 id
     * @param questionId 课题 id
     */
    void deletePdfEditByPaperIdAndQuestionId(String paperId, String questionId);
}
