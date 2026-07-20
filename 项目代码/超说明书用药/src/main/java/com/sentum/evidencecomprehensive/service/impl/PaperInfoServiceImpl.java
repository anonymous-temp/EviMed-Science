package com.sentum.evidencecomprehensive.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.sentum.evidencecomprehensive.infrastructure.mapper.PaperInfoMapper;
import com.sentum.evidencecomprehensive.pojo.dto.entity.PaperInfo;
import com.sentum.evidencecomprehensive.service.PaperInfoService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * Description:
 */
@Service
public class PaperInfoServiceImpl extends ServiceImpl<PaperInfoMapper, PaperInfo> implements PaperInfoService {


    @Autowired
    PaperInfoMapper paperInfoMapper;
    
    @Override
    public PaperInfo getPaperInfoByPaperIdAndQuestionId(String paperId, String questionId, String infoId) {
        LambdaQueryWrapper<PaperInfo> lqw = new QueryWrapper<PaperInfo>()
                .lambda()
                .eq(PaperInfo::getPaperId, paperId)
                .eq(PaperInfo::getQuestionId, questionId)
                .eq(PaperInfo::getInfoId, infoId);
        return this.getOne(lqw);
    }

    @Override
    public List<PaperInfo> getPaperContentsByPaperIdAndQuestionId(String paperId, String questionId) {
        return paperInfoMapper.getPaperContentsByPaperIdAndQuestionId(paperId, questionId);
    }
}
