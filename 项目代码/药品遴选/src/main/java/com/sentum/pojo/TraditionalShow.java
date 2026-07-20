package com.sentum.pojo;

import lombok.Data;
import org.springframework.data.mongodb.core.mapping.Document;

@Document("traditional_show")
@Data
public class TraditionalShow {

    // 传承评价相关属性
    // 传承评价总得分
    private int inheritanceTotalScore;
    // 组方来源得分
    private int recipeSourceScore;
    // 组方来源的具体内容
    private String recipeSourceContent;
    // 理论发展得分
    private int theoryDevelopmentScore;
    // 理论发展的具体内容
    private String theoryDevelopmentContent;
    // 病症结合得分
    private int diseaseCombinationScore;
    // 病症结合的具体内容
    private String diseaseCombinationContent;

    // 临床评价相关属性
    // 临床评价总得分
    private int clinicalTotalScore;
    // 临床定位得分
    private int clinicalPositioningScore;
    // 临床定位的具体内容，依据取药品说明书中的“适应症”或“功能主治”模块内容
    private String clinicalPositioningContent;
    // 临床研究得分
    private int clinicalResearchScore;
    // 临床研究的具体内容
    private String clinicalResearchContent;
    // 证据推荐得分
    private int evidenceRecommendationScore;
    // 证据推荐的具体内容，如临床指南共识证据
    private String evidenceRecommendationContent;
    // 临床需求得分
    private int clinicalDemandScore;
    // 临床需求的选项内容，如临床需求的不同选择项
    private String clinicalDemandOption;

    // 安全评价相关属性
    // 安全评价总得分
    private int safetyTotalScore;
    // 安全信息评价得分，包含不良反应分级等相关信息得分
    private int safetyInformationScore;
    // 安全信息评价的具体内容，如不良反应、禁忌等内容展示
    private String safetyInformationContent;
    // 人群限制得分，针对不同特殊人群用药限制的得分
    private int populationRestrictionScore;
    // 人群限制的具体内容，如儿童、孕妇等特殊人群用药说明
    private String populationRestrictionContent;
    // 风险应对得分，对不良反应等风险应对措施的得分
    private int riskResponseScore;
    // 风险应对的具体内容，如不良反应应对处置等内容
    private String riskResponseContent;

    // 技术评价相关属性
    // 技术评价总得分
    private int technologyTotalScore;
    // 适宜性得分
    private int suitabilityScore;
    // 适宜性的具体内容，衡量药品在某些方面的适宜程度说明
    private String suitabilityContent;
    // 给药频次得分
    private int administrationFrequencyScore;
    // 给药频次的具体内容，依据说明书中【用法用量】模块内容
    private String administrationFrequencyContent;
    // 包装规格得分
    private int packagingSpecificationScore;
    // 包装规格的选项内容，如包装规格与临床常用日剂量的搭配选项
    private String packagingSpecificationOption;
    // 采用大包装得分
    private int largePackageAdoptionScore;
    // 采用大包装的具体内容，关于大包装采用情况的说明
    private String largePackageAdoptionContent;



}
