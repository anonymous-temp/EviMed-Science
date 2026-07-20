package com.sentum.evidencecomprehensive.infrastructure.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.sentum.evidencecomprehensive.pojo.dto.entity.PdfEdit;
import io.lettuce.core.dynamic.annotation.Param;
import org.apache.ibatis.annotations.Mapper;

import java.util.List;

/**
 * Description:
 */
@Mapper
public interface PdfEditMapper extends BaseMapper<PdfEdit> {
    
    List<PdfEdit> getPaperStandardsByPaperIdAndQuestionId(@Param("paperId") String paperId, @Param("questionId") String questionId);

    void deletePdfEditByPaperIdAndQuestionId(@Param("paperId") String paperId, @Param("questionId") String questionId);
}
