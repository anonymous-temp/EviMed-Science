package com.sentum.evidencecomprehensive.domain.mongo;

import com.alibaba.fastjson.JSONArray;
import com.sentum.evidencecomprehensive.domain.dto.FormatDataDTO;
import lombok.Data;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

import java.util.List;

/**
 * cde 实体类
 */
@Data
@Document("cde_data")
public class CdeData {
    @Id
    private String id;

    /**
     * 药品名称
     */
    @Field("drgnamecn")
    private String drgnamecn;

    /**
     * 受理号
     */
    @Field("acceptid")
    private String acceptid;

    /**
     * 类型
     */
    @Field("drugtype")
    private String drugtype;

    /**
     * 等级
     */
    @Field("registerkind")
    private String registerkind;

    /**
     * 企业名称
     */
    @Field("clean_companys")
    private String companys;

    /**
     * pdf
     */
    @Field("pdf_url1")
    private String pdfUrl1;
    
    /**
     * 承办日期
     */
    @Field("createddate")
    private String createddate;

    /**
     * 适应症
     */
    @Field("new_indication")
    private String indication;

    /**
     * 有效性
     */
    @Field("new_effective")
    private String effective;

    /**
     * 安全性
     */
    @Field("new_safety")
    private String safety;

    /**
     * 结论
     */
    @Field("new_conclusion")
    private String conclusion;

    /**
     * drug_info
     */
    @Field("drug_info")
    private String drugInfo;

    /**
     * table_product_name
     */
    @Field("table_product_name")
    private String tableProductName;

    /**
     * table_indication 适应症
     */
    @Field("table_indication")
    private String tableIndication;

    /**
     * table_english_name
     */
    @Field("table_english_name")
    private String tableEnglishName;

    /**
     * table_chinese_name
     */
    @Field("table_chinese_name")
    private String tableChineseName;

    /**
     * table_registration_classification 注册证号
     */
    @Field("table_registration_classification")
    private String tableRegistrationClassification;

    @Field("english_component")
    private JSONArray englishComponent;

    @Field("english_component_synonyms")
    private JSONArray englishComponentSynonyms;

    @Field("chinese_component")
    private JSONArray chineseComponent;

    @Field("chinese_component_synonyms")
    private JSONArray chineseComponentSynonyms;



    /**
     * gpt_new_drug_info 带有 HTML 标签
     * 药品信息
     */
    @Field("gpt_new_drug_info")
    private String gptNewDrugInfo;

    /**
     * gpt_new_conclusion 带有 HTML 标签
     * 适应证
     */
    @Field("gpt_new_indication")
    private String gptNewIndication;

    /**
     * gpt_new_conclusion 带有 HTML 标签
     *  有效性评价
     */
    @Field("gpt_new_effective")
    private String gptNewEffective;

    /**
     * gpt_new_conclusion 带有 HTML 标签
     * 安全性
     */
    @Field("gpt_new_safety")
    private String gptNewSafety;
    
    /**
     * gpt_new_conclusion 带有 HTML 标签
     * 获益与风险评估
     */
    @Field("gpt_new_conclusion")
    private String gptNewConclusion;

    /**
     * 技术结论
     */
    @Field("gpt_new_tec_conclusion")
    private String gptNewTecConclusion;

    /**
     * 临床方面
     */
    @Field("gpt_new_aspects")
    private String gptNewAspects;

    
    /**
     * word使用 药品信息
     */
    @Field("word_clean_drug_info")
    private List<FormatDataDTO> wordCleanDrugInfo;

    /**
     * word使用 适应证
     */
    @Field("word_clean_indication")
    private List<FormatDataDTO> wordCleanIndication;

    /**
     * word使用 有效性
     */
    @Field("word_clean_effective")
    private List<FormatDataDTO> wordCleanEffective;

    /**
     * word使用 安全性
     */
    @Field("word_clean_safety")
    private List<FormatDataDTO> wordCleanSafety;
    
    /**
     * word使用 获益与风险评估
     */
    @Field("word_clean_conclusion")
    private List<FormatDataDTO> wordCleanConclusion;

    /**
     * word使用 技术结论
     */
    @Field("word_clean_tec_conclusion")
    private List<FormatDataDTO> wordCleanTecConclusion;

    /**
     * word使用 临床方面
     */
    @Field("word_clean_aspects")
    private List<FormatDataDTO> wordCleanAspects;
}
