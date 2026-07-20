package com.sentum.evidencecomprehensive.domain.mongo;

import com.sentum.evidencecomprehensive.domain.dto.FormatDataDTO;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

import java.util.List;

/**
 *  hta 信息表
 */
@Data
@Document("evidence_hta")
@NoArgsConstructor
@AllArgsConstructor
public class HtaReport {
    
    @Id
    private String id;
    
    /**
     * pdf标题
     */
    @Field(name = "title")
    private String title;
    
    /**
     * 链接
     */
    @Field(name = "link")
    private String link;
    
    /**
     * 来源-国家
     */
    @Field(name = "source")
    private String source;
    
    /**
     * 来源-国家完整
     */
    @Field(name = "sourceFull")
    private String sourceFull;
    
    /**
     * pdf名
     */
    @Field(name = "pdfName")
    private String pdfName;
    
    /**
     * pdf链接
     */
    private String pdfNameUrl;

    /**
     * 是否存在 pdf
     */
    @Field(name = "exists_flag")
    private int existsFlag;
    /**
     * 排序使用
     */
    private Long publishTimeDateTs;
    /**
     * 发表时间
     */
    private String publishTime;


    @Field("pdf_tag_list")
    private List<String> pdfTagList;

    @Field("clean_image_pdf_data_gpt_ver_list")
    private List<String> cleanImagePdfDataGptVerList;

    @Field("word_clean_image_pdf_data_gpt_ver_list")
    private List<List<FormatDataDTO>> wordCleanImagePdfDataGptVerList;

    @Field("security")
    private String security;

    @Field("effectiveness")
    private String effectiveness;

    @Field("economic_viability")
    private String economicViability;

    @Field("ethic")
    private String ethic;

    @Field("doctor_advice")
    private String doctorAdvice;

    @Field("patient_advice")
    private String patientAdvice;

    @Field("recommended_advice")
    private String recommendedAdvice;
}

