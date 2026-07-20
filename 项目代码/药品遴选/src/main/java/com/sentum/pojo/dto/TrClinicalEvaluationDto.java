package com.sentum.pojo.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

import java.util.ArrayList;
import java.util.List;

@Data
public class TrClinicalEvaluationDto {
    // 临床评价总得分
    private Double totalScore;
    // 临床定位得分
    private Double clinicalPositioningScore;
    // 临床定位内容
    private String clinicalPositioningContent;
    // 临床研究得分
    private Double clinicalResearchScore;
    // 临床研究内容
    private String clinicalResearchContent;
    // 证据推荐得分
    private Double evidenceRecommendationScore;
    // 多个证据推荐项
    @JsonProperty("evidenceRecommendationContent")
    private List<EvidenceItem> evidenceItems = new ArrayList<>();
    // 临床需求得分
    private Double clinicalDemandScore;
    // 临床需求选项
    private String clinicalDemandOption;
    // 临床需求内容
    private String clinicalDemandContent;

    // 证据推荐项，内部类存储标题和内容
    @Data
    public static class EvidenceItem {
        private String title;
        private String content;

        public EvidenceItem(String title, String content) {
            this.title = title;
            this.content = content;
        }

        // 省略getter和setter方法
    }



    // 省略getter和setter方法
    public Double getTotalScore() {
        return totalScore;
    }


    public void setTotalScore() {
        this.clinicalPositioningScore = (clinicalPositioningScore != null) ? clinicalPositioningScore : 0.0;
        this.clinicalResearchScore = (clinicalResearchScore != null) ? clinicalResearchScore : 0.0;
        this.evidenceRecommendationScore = (evidenceRecommendationScore != null) ? evidenceRecommendationScore : 0.0;
        this.clinicalDemandScore = (clinicalDemandScore != null) ? clinicalDemandScore : 0.0;

        this.totalScore = clinicalPositioningScore + clinicalResearchScore + evidenceRecommendationScore + clinicalDemandScore;
    }

}
