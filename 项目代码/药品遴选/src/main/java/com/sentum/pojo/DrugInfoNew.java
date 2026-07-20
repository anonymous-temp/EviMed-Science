package com.sentum.pojo;

import com.sentum.pojo.vo.GuidelinesVo;
import com.sentum.pojo.vo.SaveDrugPrice2;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.List;

/**
 * 药品信息表
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evaluation_drug_info_v2")
public class DrugInfoNew {
    @Id
    private String id;
    /**
     * 药品名称
     */
    private String drugName;
    /**
     * 药品厂家
     */
    private String manufacturer;
    /**
     * 注册账号
     */
    private String register;
    /**
     * 药品规格
     */
    private String specifications;
    /**
     * 剂型
     */
    private String dosageForm;
    /**
     * 商品中文
     */
    private String communityNameZh;
    /**
     * 商品英文
     */
    private String communityNameEn;
    /**
     * 药理作用
     */
    private String pharmacology;
    /**
     * 药理毒理
     */
    private String toxicological;
    /**
     * 作用机制
     */
    private String mechanismAction;
    
    
    
    /**
     * 一级中文
     */
    private String oneNameZh;
    /**
     * 一级英文
     */
    private String oneNameEn;
    /**
     * 二级中文
     */
    private String twoNameZh;
    /**
     * 二级英文
     */
    private String twoNameEn;
    /**
     * 三级中文
     */
    private String threeNameZh;
    /**
     * 三级英文
     */
    private String threeNameEn;
    /**
     * 四级中文
     */
    private String fourNameZh;
    /**
     * 四级英文
     */
    private String fourNameEn;
    /**
     * 五级编码
     */
    private String fiveCoding;
    /**
     * 五级英文
     */
    private String drugEn;
    /**
     * 五级英文同义词
     */
    private List<String> drugSynonymEn;
    /**
     * 五级中文
     */
    private String drugZh;
    /**
     * 五级中文同义词
     */
    private List<String> drugSynonymZh;
    /**
     * 医保情况
     */
    private String medicalInsurance;
    /**
     * 支付范围
     */
    private String paymentScope;
    /**
     * 是否是国家基本药物
     */
    private String essentialMedicines;
    /**
     * 是否有△要求
     */
    private String essentialType;
    /**
     * 适应症
     */
    private String indication;
    /**
     * 中文疾病名称
     */
    private List<String> diseaseZh;
    /**
     * 英文疾病名称
     */
    private List<String> diseaseEn;
    /**
     * 疾病同义词
     */
    private List<String> diseaseSynonym;
    /**
     * 该药品的皮试情况
     */
    private String skinTest;
    /**
     * 集中采药情况
     */
    private String drugCollection;

    private Boolean hasPharmacology = false;

    /**
     * 药品类别
     */
    private String drugCategory;
    /**
     * 药代动力学
     */
    private String pharmacokinetics;

    private Boolean hasPharmacokinetics = false;
    /**
     * 用法用量
     */
    private String usageAndDosage;
    /**
     * 贮藏
     */
    private String storage;
    /**
     * 有效期
     */
    private String indate;
    /**
     * 主治/适应症
     */
    private String indications;
    /**
     * 不良反应
     */
    private String adverseReaction;
    /**
     * 孕妇及哺乳期妇女
     */
    private String pregnantWomen;

    /**
     * 孕妇
     */
    private String pregnant;

    /**
     * 哺乳期
     */
    private String lactation;


    /**
     * 儿童用药
     */
    private String childrenMedicine;
    /**
     * 老人用药
     */
    private String geriatricMedicine;
    /**
     * 药物相互作用
     */
    private String drugInteraction;
    /**
     * 原研药
     */
    private String originalDrug;
    /**
     * 参比药品
     */
    private String referenceDrug;
    /**
     * 一致性评价药品
     */
    private String consistencyDrug;
    /**
     * 成分
     */
    private String ingredient;
    /**
     * 注意事项
     */
    private String notes;
    /**
     * 禁忌
     */
    private String taboo;
    /**
     * 单位
     */
    private String unit;
    /**
     * 单位价格
     */
    private String unitPrice;
    /**
     * 价格
     */
    private String price;
    /**
     * 转换比
     */
    private String ratio;
    /**
     * 集采药品中标价格（元）
     */
    private String outbidPrice;
    /**
     * 包装
     */
    private String pack;

    /**
     * 规格-说明书
     */
    private String specificationsIns;
    /**
     * 说明书来源
     */
    private String insSource;



    /**
     * 严重不良反应
     */
    private String seriousAdverseRactions;


    /**
     * 一般不良反应
     */
    private String commonAdverseReactions;
    /**
     * 肝
     */
    private String doseAdjustmentPatientsWithLiverDysfunction;
    /**
     * 肾
     */
    private String doseAdjustmentPatientsWithRenalInsufficiency;
    /**
     * 黑框警告
     */
    private String blackBoxWaringOfFDA;
    /**
     * 制畸性
     */
    private String geneticsReproductionCarcinogenicity;

    /**
     * 毒理研究
     */
    private String poison;

    /**
     * 指南
     */
    private List<GuidelinesVo> guidelinesVo;

    /**
     * 企业生存状况
     */
    private String manufacturers;

    /**
     * 全球使用量
     */
    private String globalUsage;

    /**
     * 毒理研究
     */
    private String safeAdvantage;

    private String pdf;

    private String drugWarning;

    private String treatmentAdvantage;


    /**
     * 单方制剂/复方制剂
     */
    private String drugType;

    private SaveDrugPrice2 saveDrugPrice;



    private String url;

    private String source;

    private List<DrugContent> images;

    private List<DrugContent> matched_images;

    private String clinical;

    private String Indicationx;

    private String fingerprint;

    private String reevaluation;

    private String contentDeterminationMethod;

    private String description;

    private String contraindications;
    /**
     * 是否中成药保护品种
     */
    private String isProtected;

    /**
     * 保护等级
     */
    private String protectionLevel;

    /**
     * 保护时效
     */
    private String protectionPeriod;



    private String isTheAgreementForTheJudgment;

    private String termOfAgreement;

    private String number;



    /**
     * otc
     */
    private String otc;

    /**
     * 是否收录药典
     */
    private String isInclude;


    /**
     * 说明书内容  json格式
     */
    private String instruction;


    @Override
    public String toString() {
        StringBuilder sb = new StringBuilder();
        sb.append("说明书部分内容{");
        //用法用量
        if (usageAndDosage != null && !usageAndDosage.isEmpty()) {
            sb.append(", 用法用量='").append(usageAndDosage.replaceAll("\\n", "")).append('\'');
        }
        if (adverseReaction != null && !adverseReaction.isEmpty()) {
            sb.append(", 不良反应部分内容='").append(adverseReaction.replaceAll("\\n", "")).append('\'');
        }
        if (pregnantWomen != null && !pregnantWomen.isEmpty()) {
            sb.append(", 孕妇及哺乳期妇女='").append(pregnantWomen.replaceAll("\\n", "")).append('\'');
        }
        if (childrenMedicine != null && !childrenMedicine.isEmpty()) {
            sb.append(", 儿童='").append(childrenMedicine.replaceAll("\\n", "")).append('\'');
        }
        if (geriatricMedicine != null && !geriatricMedicine.isEmpty()) {
            sb.append(", 老人='").append(geriatricMedicine.replaceAll("\\n", "")).append('\'');
        }
        if (drugInteraction != null && !drugInteraction.isEmpty()) {
            sb.append(", 药物相互作用='").append(drugInteraction.replaceAll("\\n", "")).append('\'');
        }
        if (ingredient != null && !ingredient.isEmpty()) {
            sb.append(", 成分='").append(ingredient.replaceAll("\\n", "")).append('\'');
        }
        if (notes != null && !notes.isEmpty()) {
            sb.append(", 注意事项（可能包括儿童、孕妇、老年、特殊人群的注意事项）='").append(notes.replaceAll("\\n", "")).append('\'');
        }
        if (taboo != null && !taboo.isEmpty()) {
            sb.append(", 禁忌（可能包括儿童、孕妇、老年、特殊人群的注意事项）='").append(taboo.replaceAll("\\n", "")).append('\'');
        }
        if (seriousAdverseRactions != null && !seriousAdverseRactions.isEmpty()) {
            sb.append(", 严重不良反应='").append(seriousAdverseRactions.replaceAll("\\n", "")).append('\'');
        }
        if (commonAdverseReactions != null && !commonAdverseReactions.isEmpty()) {
            sb.append(", 常见不良反应='").append(commonAdverseReactions.replaceAll("\\n", "")).append('\'');
        }
        if (doseAdjustmentPatientsWithLiverDysfunction != null && !doseAdjustmentPatientsWithLiverDysfunction.isEmpty()) {
            sb.append(", 肝功能异常用药='").append(doseAdjustmentPatientsWithLiverDysfunction.replaceAll("\\n", "")).append('\'');
        }
        if (doseAdjustmentPatientsWithRenalInsufficiency != null && !doseAdjustmentPatientsWithRenalInsufficiency.isEmpty()) {
            sb.append(", 肾功能异常用药='").append(doseAdjustmentPatientsWithRenalInsufficiency.replaceAll("\\n", "")).append('\'');
        }
        if (blackBoxWaringOfFDA != null && !blackBoxWaringOfFDA.isEmpty()) {
            sb.append(", 黑框警告='").append(blackBoxWaringOfFDA.replaceAll("\\n", "")).append('\'');
        }
        if (geneticsReproductionCarcinogenicity != null && !geneticsReproductionCarcinogenicity.isEmpty()) {
            sb.append(", 制畸性='").append(geneticsReproductionCarcinogenicity.replaceAll("\\n", "")).append('\'');
        }
        if (poison != null && !poison.isEmpty()) {
            sb.append(", 毒理研究='").append(poison.replaceAll("\\n", "")).append('\'');
        }
        if (globalUsage != null && !globalUsage.isEmpty()) {
            sb.append(", 全球使用量='").append(globalUsage.replaceAll("\\n", "")).append('\'');
        }
        if (contraindications != null && !contraindications.isEmpty()){
            sb.append(", 禁忌症='").append(contraindications.replaceAll("\\n", "")).append('\'');
        }


        sb.append('}');
        return sb.toString();
    }


}
