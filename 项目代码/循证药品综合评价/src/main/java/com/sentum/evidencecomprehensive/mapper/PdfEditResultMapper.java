package com.sentum.evidencecomprehensive.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.sentum.evidencecomprehensive.domain.entity.paper.PdfEditResult;
import io.lettuce.core.dynamic.annotation.Param;

/**
 * Description: 
 */


public interface PdfEditResultMapper extends BaseMapper<PdfEditResult> {
    
    void deletePdfEditResultByPaperIdAndQuestionId(@Param("paperId") String paperId, @Param("questionId") String questionId);
}
