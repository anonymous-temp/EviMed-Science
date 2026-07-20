package com.sentum.evidencecomprehensive.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.sentum.evidencecomprehensive.infrastructure.mapper.PdfEditResultMapper;
import com.sentum.evidencecomprehensive.pojo.dto.entity.PdfEditResult;
import com.sentum.evidencecomprehensive.service.PdfEditResultService;
import org.apache.commons.lang3.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;


/**
 * Description:
 */
@Service
public class PdfEditResultServiceImpl extends ServiceImpl<PdfEditResultMapper, PdfEditResult> implements PdfEditResultService {
    
    @Autowired
    PdfEditResultMapper pdfEditResultMapper;
    
    @Override
    public PdfEditResult getPaperEditResultPaperIdAndQuestionId(String paperId, String questionId, String paperType) {
        if (StringUtils.isNotBlank(paperType)) {
            LambdaQueryWrapper<PdfEditResult> lqw = new QueryWrapper<PdfEditResult>()
                    .lambda()
                    .eq(PdfEditResult::getPaperId, paperId)
                    .eq(PdfEditResult::getQuestionId, questionId)
                    .eq(PdfEditResult::getPaperType, paperType);
            return getOne(lqw);
        } else {
            LambdaQueryWrapper<PdfEditResult> lqw = new QueryWrapper<PdfEditResult>()
                    .lambda()
                    .eq(PdfEditResult::getPaperId, paperId)
                    .eq(PdfEditResult::getQuestionId, questionId);
            return getOne(lqw);
        }
    }

    @Override
    public void deletePdfEditResultByPaperIdAndQuestionId(String paperId, String questionId) {
        pdfEditResultMapper.deletePdfEditResultByPaperIdAndQuestionId(paperId, questionId);
    }
}
