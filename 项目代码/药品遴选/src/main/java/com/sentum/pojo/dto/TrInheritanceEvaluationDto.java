package com.sentum.pojo.dto;


import lombok.Data;

import java.util.Optional;

@Data
public class TrInheritanceEvaluationDto {
    // 传承评价总得分
    private Double totalScore;
    // 组方来源得分
    private Double recipeSourceScore;
    // 组方来源内容
    private String recipeSourceContent;
    // 理论支撑得分
    private Double theorySupportScore;
    // 理论支撑内容
    private String theorySupportContent;
    //理论支持-理论指导
    private String theoryGuidanceContent;
    private Double theoryGuidanceScore;

    //  理论支持-君臣佐使配伍
    private String theoryCombinationContent;
    private Double theoryCombinationScore;

    //理论支持-药性、归经与治疗目标
    private String theoryPathogenesisContent;
    private Double theoryPathogenesisScore;

    //理论支持-炮制品是否与治疗目标相符
    private String theoryPotContent;
    private Double theoryPotScore;



    // 病症结合得分
    private Double diseaseCombinationScore;
    // 病症结合内容
    private String diseaseCombinationContent;

    //病症结合描述
    private String diseaseCombinationContent1;
    private Double diseaseCombinationScore1;

    //病症结合西医术语描述
    private String diseaseCombinationContent2;
    private Double diseaseCombinationScore2;

    //计算理论支撑得分
    public void setTheorySupportScore() {
        this.theoryGuidanceScore = Optional.ofNullable(theoryGuidanceScore).orElse(0.0);
        this.theoryCombinationScore = Optional.ofNullable(theoryCombinationScore).orElse(0.0);
        this.theoryPathogenesisScore = Optional.ofNullable(theoryPathogenesisScore).orElse(0.0);
        this.theoryPotScore = Optional.ofNullable(theoryPotScore).orElse(0.0);
        this.theorySupportScore = theoryGuidanceScore + theoryCombinationScore +
                theoryPathogenesisScore + theoryPotScore;
    }

    //病症结合描述得分
    public void setDiseaseCombinationScore() {
        this.diseaseCombinationScore1 = Optional.ofNullable(diseaseCombinationScore1).orElse(0.0);
        this.diseaseCombinationScore2 = Optional.ofNullable(diseaseCombinationScore2).orElse(0.0);
        this.diseaseCombinationScore = diseaseCombinationScore1 + diseaseCombinationScore2;
    }

    public void setTotalScore() {
        this.recipeSourceScore = Optional.ofNullable(recipeSourceScore).orElse(0.0);
        this.theorySupportScore = Optional.ofNullable(theorySupportScore).orElse(0.0);
        this.diseaseCombinationScore = Optional.ofNullable(diseaseCombinationScore).orElse(0.0);
        this.totalScore = recipeSourceScore + theorySupportScore + diseaseCombinationScore;
    }
}
