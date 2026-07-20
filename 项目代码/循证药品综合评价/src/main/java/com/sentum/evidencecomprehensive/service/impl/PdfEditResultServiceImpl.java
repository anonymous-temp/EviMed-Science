package com.sentum.evidencecomprehensive.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.sentum.evidencecomprehensive.mapper.PdfEditResultMapper;
import com.sentum.evidencecomprehensive.domain.entity.paper.PdfEditResult;
import com.sentum.evidencecomprehensive.service.BaseRepositoryImpl;
import com.sentum.evidencecomprehensive.service.PdfEditResultService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;


/**
 * Description:
 */
@Service
public class PdfEditResultServiceImpl extends BaseRepositoryImpl<PdfEditResultMapper, PdfEditResult> implements PdfEditResultService {
    
    @Autowired
    PdfEditResultMapper pdfEditResultMapper;
    
    @Override
    public PdfEditResult getPaperEditResultPaperIdAndQuestionId(String paperId, String questionId, String studyType) {
        LambdaQueryWrapper<PdfEditResult> lqw = new QueryWrapper<PdfEditResult>()
                .lambda()
                .eq(PdfEditResult::getPaperId, paperId)
                .eq(PdfEditResult::getPaperType, studyType)
                .eq(PdfEditResult::getQuestionId, questionId);
        return getOne(lqw);
    }

    @Override
    public void deletePdfEditResultByPaperIdAndQuestionId(String paperId, String questionId) {
        pdfEditResultMapper.deletePdfEditResultByPaperIdAndQuestionId(paperId, questionId);
    }
}
