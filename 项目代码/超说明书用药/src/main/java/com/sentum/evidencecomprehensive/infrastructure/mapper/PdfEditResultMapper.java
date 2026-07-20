package com.sentum.evidencecomprehensive.infrastructure.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.sentum.evidencecomprehensive.pojo.dto.entity.PdfEditResult;
import io.lettuce.core.dynamic.annotation.Param;
import org.apache.ibatis.annotations.Mapper;

/**
 * Description: 
 */

@Mapper
public interface PdfEditResultMapper extends BaseMapper<PdfEditResult> {
    
    void deletePdfEditResultByPaperIdAndQuestionId(@Param("paperId") String paperId, @Param("questionId") String questionId);
    
    PdfEditResult selectPdfEditResultByPaperIdAndQuestionId(@Param("paperId") String paperId, @Param("questionId") String questionId);
}
