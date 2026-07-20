package com.sentum.pojo.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.mongodb.core.mapping.Document;

import java.io.Serializable;
import java.util.List;

@Data
@Document("evaluation_trInfo")
@AllArgsConstructor
@NoArgsConstructor
public class TrInfoDto implements Serializable {
    private String searchId;
    //传承评价
    private TrInheritanceEvaluationDto trInheritanceEvaluationDto;
    //临床评价
    private TrClinicalEvaluationDto trClinicalEvaluationDto;
    //安全评价
    private TrSafetyEvaluationDto trSafetyEvaluationDto;
    //技术评价
    private TrTechnologyEvaluationDto trTechnologyEvaluationDto;
    //市场评价
    private TrMarketEvaluationDto trMarketEvaluationDto;
    private Double totalScore;
    private String drugName;
    private String drugId;
    private String title;
    private List<String> content;


    public void setTotalScore() {
        this.totalScore = trInheritanceEvaluationDto.getTotalScore() + trClinicalEvaluationDto.getTotalScore() + trSafetyEvaluationDto.getTotalScore() + trTechnologyEvaluationDto.getTotalScore() + trMarketEvaluationDto.getTotalScore();
    }


}
