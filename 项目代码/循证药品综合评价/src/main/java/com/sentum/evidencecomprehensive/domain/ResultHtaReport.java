package com.sentum.evidencecomprehensive.domain;

import com.sentum.evidencecomprehensive.domain.dto.FormatDataDTO;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

import java.util.List;

/**
 *  有翻译之后数据的 hta 信息表
 */
@Data
@Document("result_hta_report")
@NoArgsConstructor
@AllArgsConstructor
public class ResultHtaReport {

    @Id
    private String id;

    /**
     * pdf标题
     */
    private String title;

    /**
     * 链接
     */
    private String link;

    /**
     * 来源-国家
     */
    private String source;

    /**
     * 发表时间
     */
    private String publishTime;

    /**
     * 来源-国家完整
     */
    private String sourceFull;

    /**
     * pdf名
     */
    private String pdfName;

    /**
     * pdf链接
     */
    private String pdfNameUrl;

    /**
     * 适应症
     */
    private String indication;

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

