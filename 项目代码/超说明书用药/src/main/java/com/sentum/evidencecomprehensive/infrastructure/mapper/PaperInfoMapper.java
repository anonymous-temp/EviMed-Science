package com.sentum.evidencecomprehensive.infrastructure.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.sentum.evidencecomprehensive.pojo.dto.entity.PaperInfo;
import io.lettuce.core.dynamic.annotation.Param;
import org.apache.ibatis.annotations.Mapper;

import java.util.List;

/**
 * Description:
 */
@Mapper
public interface PaperInfoMapper extends BaseMapper<PaperInfo> {
    
    List<PaperInfo> getPaperContentsByPaperIdAndQuestionId(@Param("paperId") String paperId, @Param("questionId") String questionId);
}
