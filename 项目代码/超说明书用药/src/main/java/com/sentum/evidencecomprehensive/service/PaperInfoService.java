package com.sentum.evidencecomprehensive.service;

import com.sentum.evidencecomprehensive.pojo.dto.entity.PaperInfo;

import java.util.List;

/**
 * Description:
 */

public interface PaperInfoService extends BaseRepository<PaperInfo>{

    PaperInfo getPaperInfoByPaperIdAndQuestionId(String paperId, String questionId, String standardId);

    List<PaperInfo> getPaperContentsByPaperIdAndQuestionId(String paperId, String questionId);
}
