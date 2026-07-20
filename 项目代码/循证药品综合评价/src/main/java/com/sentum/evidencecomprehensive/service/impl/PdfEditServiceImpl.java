package com.sentum.evidencecomprehensive.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.sentum.evidencecomprehensive.mapper.PdfEditMapper;
import com.sentum.evidencecomprehensive.domain.entity.paper.PdfEdit;
import com.sentum.evidencecomprehensive.service.PdfEditService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * Description:
 */
@Service
public class PdfEditServiceImpl extends ServiceImpl<PdfEditMapper, PdfEdit> implements PdfEditService {

    @Autowired
    PdfEditMapper pdfEditMapper;

    @Override
    public PdfEdit getPaperStandardByPaperIdAndQuestionId(String paperId, String questionId, String standardId) {
        LambdaQueryWrapper<PdfEdit> lqw = new QueryWrapper<PdfEdit>()
                .lambda()
                .eq(PdfEdit::getPaperId, paperId)
                .eq(PdfEdit::getQuestionId, questionId)
                .eq(PdfEdit::getStandardId, standardId);
        return this.getOne(lqw);
    }

    @Override
    public List<PdfEdit> getPaperEditByQuestionId(String questionId) {
        LambdaQueryWrapper<PdfEdit> lqw = new QueryWrapper<PdfEdit>()
                .lambda()
                .eq(PdfEdit::getQuestionId, questionId);
        return list(lqw);
    }

    @Override
    public List<PdfEdit> getPaperStandardsByPaperIdAndQuestionId(String paperId, String questionId) {
        return lambdaQuery()
                .eq(PdfEdit::getPaperId, paperId)
                .eq(PdfEdit::getQuestionId, questionId)
                .list();
//        return pdfEditMapper.getPaperStandardsByPaperIdAndQuestionId(paperId, questionId);
    }

    @Override
    public void deletePdfEditByPaperIdAndQuestionId(String paperId, String questionId) {
        pdfEditMapper.deletePdfEditByPaperIdAndQuestionId(paperId, questionId);
    }
}
