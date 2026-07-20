package com.sentum.evidencecomprehensive.utils.operateyl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.domain.mongo.BaseCondition;
import com.sentum.evidencecomprehensive.domain.mongo.Condition;
import com.sentum.evidencecomprehensive.feign.EvidenceChaoFeign;
import com.sentum.evidencecomprehensive.feign.FineScreenFeign;
import com.sentum.evidencecomprehensive.domain.dto.PaperAndGuideIncludeDTO;
import com.sentum.evidencecomprehensive.domain.dto.Disease;
import com.sentum.evidencecomprehensive.domain.dto.Drug;
import com.sentum.evidencecomprehensive.domain.dto.InterventionAndOutcome;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2024/5/30
 */
@Slf4j
@Component
public class DefaultIncludeUtils {

    private final FineScreenFeign fineScreenFeign;
    private final EvidenceChaoFeign evidenceChaoFeign;

    @Autowired
    public DefaultIncludeUtils(FineScreenFeign fineScreenFeign, EvidenceChaoFeign evidenceChaoFeign) {
        this.fineScreenFeign = fineScreenFeign;
        this.evidenceChaoFeign = evidenceChaoFeign;
    }
    
    public List<String> paperAndGuideInclude(PaperAndGuideIncludeDTO guideIncludeDTO) {
        // 本地环境
        try {
            return fineScreenFeign.paperMix(JSON.parseObject(JSON.toJSONString(guideIncludeDTO), JSONObject.class));
        } catch (Exception e) {
            log.error(e.getMessage(), e);
            return new ArrayList<>();
        }        
        // 线上环境
//        String requestForPaperInclude = getRequestForPaperInclude(guideIncludeDTO);
//        return JSON.parseObject(requestForPaperInclude, new TypeReference<List<String>>() {});
    }

    public String createSearchQuery(BaseCondition condition) {
        List<Drug> drugs = condition.getDrugs();
        List<Disease> diseases = condition.getDiseases();
        List<InterventionAndOutcome> interventions = condition.getInterventions();
        List<InterventionAndOutcome> outcomes = condition.getOutcomes();

        StringBuilder picosearchQuery = new StringBuilder();
        // i
        if (CollUtil.isNotEmpty(drugs)) {
            String drugSearch = drugs.stream().filter(term -> term.getStatus() == 1).map(Drug::getWord).collect(Collectors.joining("联合"));
            picosearchQuery.append(drugSearch);
        }

        // p
        if (CollUtil.isNotEmpty(diseases)) {
            String diseaseSearch = diseases.stream().filter(term -> term.getStatus() == 1).map(Disease::getWord).collect(Collectors.joining("合并"));
            if (StrUtil.isNotBlank(picosearchQuery.toString())) {
                picosearchQuery.append("治疗").append(diseaseSearch);
            } else {
                picosearchQuery.append(diseaseSearch);
            }
        }

        // c
        if (CollUtil.isNotEmpty(interventions)) {
            String interventionAndOutcomeSearch = interventions.stream().filter(term -> term.getStatus() == 1).map(InterventionAndOutcome::getWord).collect(Collectors.joining("联合"));
            picosearchQuery.append("干预措施为：").append(interventionAndOutcomeSearch);
        }

        // o
        if (CollUtil.isNotEmpty(outcomes)) {
            String interventionAndOutcomeSearch = outcomes.stream().filter(term -> term.getStatus() == 1).map(InterventionAndOutcome::getWord).collect(Collectors.joining("联合"));
            picosearchQuery.append("结局指标为：").append(interventionAndOutcomeSearch);
        }

        return picosearchQuery.toString();
    }

    public String getRequestForDrugSafeInfoZx (Condition condition) {
        try {
            return evidenceChaoFeign.drugSafeInfoZx(condition).toJSONString();
        } catch (Exception e) {
            throw new RuntimeException("远程feign调用失败！！！");
        }
    }


    /**
     * 指南获得 blocks
     */
    public JSONObject getGuideBlocks(String screenId) {
        try {
            // 本地环境
            return fineScreenFeign.getBlocks(screenId);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
            return null;
        } 
    }
}
