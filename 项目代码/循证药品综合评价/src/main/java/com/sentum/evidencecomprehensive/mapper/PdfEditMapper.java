package com.sentum.evidencecomprehensive.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.sentum.evidencecomprehensive.domain.entity.paper.PdfEdit;
import io.lettuce.core.dynamic.annotation.Param;

import java.util.List;

/**
 * Description:
 */

public interface PdfEditMapper extends BaseMapper<PdfEdit> {
    
    List<PdfEdit> getPaperStandardsByPaperIdAndQuestionId(@Param("paperId") String paperId, @Param("questionId") String questionId);

    void deletePdfEditByPaperIdAndQuestionId(@Param("paperId") String paperId, @Param("questionId") String questionId);
}
