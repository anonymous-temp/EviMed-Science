package com.sentum.evidencecomprehensive.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.sentum.evidencecomprehensive.domain.entity.paper.PaperInfo;
import io.lettuce.core.dynamic.annotation.Param;

import java.util.List;

/**
 * Description:
 */

public interface PaperInfoMapper extends BaseMapper<PaperInfo> {
    
    List<PaperInfo> getPaperContentsByPaperIdAndQuestionId(@Param("paperId") String paperId, @Param("questionId") String questionId);
}
