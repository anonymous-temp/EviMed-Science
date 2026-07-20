package com.sentum.pojo.vo;

import com.sentum.pojo.dto.*;
import lombok.Data;

@Data
public class TrInfoScoreVo {

    private String searchId;
    //传承评价
    private String trInheritanceEvaluationScore;
    //临床评价
    private String trClinicalEvaluationScore;
    //安全评价
    private String trSafetyEvaluationScore;
    //技术评价
    private String trTechnologyEvaluationScore;
    //市场评价
    private String trMarketEvaluationScore;
    private String totalScore;
    private String drugName;
    private String drugId;
    private String title;
    private String reportId;
}
