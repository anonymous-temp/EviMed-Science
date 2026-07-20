package com.sentum.pojo.vo;

import com.sentum.pojo.dto.*;
import lombok.Data;

@Data
public class TrInfoAppVo {
    private Double trInheritanceEvaluationScore;
    //临床评价
    private Double trClinicalEvaluationScore;
    //安全评价
    private Double trSafetyEvaluationScore;
    //技术评价
    private Double trTechnologyEvaluationScore;
    //市场评价
    private Double trMarketEvaluationScore;
    private Double totalScore;
    private String drugName;
    private String drugId;
    private String title;
    private String id;
    private String reportId;
}
