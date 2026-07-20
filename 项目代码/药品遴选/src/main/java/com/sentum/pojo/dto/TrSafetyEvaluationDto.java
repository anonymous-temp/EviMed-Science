package com.sentum.pojo.dto;

import lombok.Data;

@Data
public class TrSafetyEvaluationDto {
    // 安全评价总得分
    private Double totalScore;
    // 安全信息评价得分
    private Double safetyInfoScore;
    // 不良反应、禁忌等描述得分
    private Double adverseReactionScore;
    // 不良反应、禁忌等描述内容
    private String adverseReactionContent;
    // 说明书中警示语或注意事项得分
    private Double warningNoteScore;
    // 说明书中警示语或注意事项内容
    private String warningNoteContent;
    // 辅料得分
    private Double excipientScore;
    private String excipient;
    // 安全性再评价得分
    private Double safetyReevaluationScore;
    // 安全性再评价内容
    private String safetyReevaluationContent;


    //人群限制得分
    private Double crowdRestrictionScore;

    // 儿童用药得分
    private Double pediatricDrugUseScore;
    // 儿童用药内容
    private String pediatricDrugUseContent;
    // 妊娠期妇女用药得分
    private Double pregnancyDrugUseScore;
    // 妊娠期妇女用药内容
    private String pregnancyDrugUseContent;
    // 哺乳期妇女用药得分
    private Double lactationDrugUseScore;
    // 哺乳期妇女用药内容
    private String lactationDrugUseContent;
    // 肝功能异常者用药得分
    private Double liverDysfunctionDrugUseScore;
    // 肝功能异常者用药内容
    private String liverDysfunctionDrugUseContent;
    // 肾功能异常者用药得分
    private Double kidneyDysfunctionDrugUseScore;
    // 肾功能异常者用药内容
    private String kidneyDysfunctionDrugUseContent;
    // 运动员用药得分
    private Double athleteDrugUseScore;
    // 运动员用药内容
    private String athleteDrugUseContent;

    //人群限制总分方法


    // 不良反应分层得分
    private Double adverseReactionStratificationScore;
    // 不良反应分层内容
    private String adverseReactionStratificationContent;

    public void setCrowdRestrictionScore() {
        this.pediatricDrugUseScore = (pediatricDrugUseScore != null) ? pediatricDrugUseScore : 0.0;
        this.pregnancyDrugUseScore = (pregnancyDrugUseScore != null) ? pregnancyDrugUseScore : 0.0;
        this.lactationDrugUseScore = (lactationDrugUseScore != null) ? lactationDrugUseScore : 0.0;
        this.liverDysfunctionDrugUseScore = (liverDysfunctionDrugUseScore != null) ? liverDysfunctionDrugUseScore : 0.0;
        this.kidneyDysfunctionDrugUseScore = (kidneyDysfunctionDrugUseScore != null) ? kidneyDysfunctionDrugUseScore : 0.0;
        this.athleteDrugUseScore = (athleteDrugUseScore != null) ? athleteDrugUseScore : 0.0;

        this.crowdRestrictionScore = pediatricDrugUseScore + pregnancyDrugUseScore + lactationDrugUseScore + liverDysfunctionDrugUseScore + kidneyDysfunctionDrugUseScore + athleteDrugUseScore;
    }
    public void setSafetyInfoScore() {
        this.adverseReactionScore = (adverseReactionScore != null) ? adverseReactionScore : 0.0;
        this.warningNoteScore = (warningNoteScore != null) ? warningNoteScore : 0.0;
        this.excipientScore = (excipientScore != null) ? excipientScore : 0.0;
        this.safetyReevaluationScore = (safetyReevaluationScore != null) ? safetyReevaluationScore : 0.0;

        this.safetyInfoScore = adverseReactionScore + warningNoteScore + excipientScore + safetyReevaluationScore;
    }

    public void setTotalScore() {
        this.safetyInfoScore = (safetyInfoScore != null) ? safetyInfoScore : 0.0;
        this.crowdRestrictionScore = (crowdRestrictionScore != null) ? crowdRestrictionScore : 0.0;
        this.adverseReactionStratificationScore = (adverseReactionStratificationScore != null) ? adverseReactionStratificationScore : 0.0;

        this.totalScore = safetyInfoScore + crowdRestrictionScore + adverseReactionStratificationScore;
    }


}
