package com.sentum.pojo.vo;

import io.swagger.annotations.ApiModelProperty;
import lombok.Data;
import org.springframework.data.elasticsearch.annotations.Document;
import org.springframework.data.elasticsearch.annotations.Field;
import org.springframework.data.elasticsearch.annotations.FieldType;

import java.util.List;

/**
 * @Description: es中的文献表
 */

@Data
@Document(indexName = "literature_index_wsz")
public class Literature {
    
    @Field(type = FieldType.Keyword)
    private String id;

    @Field(type = FieldType.Text)
    private String title;
    
    /**
     * 关键字
     */
    @Field(type = FieldType.Keyword)
    private List<String> allKeyword;

    /**
     * 
     */
    @Field(type = FieldType.Keyword)
    private String tldr;

    /**
     * 生成的临床问题
     */
    @Field(type = FieldType.Keyword)
    private String titleQuestion;
    
    /**
     * 影响因子
     */
    @Field(type = FieldType.Double)
    private double jcr;

    /**
     * 文献类型
     * #   0：Review
     * #   1：case-report/case-series
     * #   2：指南共识
     * #   3：Meta/系统评价
     * #   4：RCT/nRCT
     * #   5：观察性研究
     * #   6：经济学研究
     * #   7：临床试验
     * #
     * #   9：基础研究（排除的文献）
     */
    @Field(type = FieldType.Keyword)
    private List<String> type;

    @Field(type = FieldType.Keyword)
    private List<String> lastNewType;

    /**
     * 文献语言
     */
    @Field(type = FieldType.Keyword)
    private String language;

    /**
     * 结论
     */
    @Field(type = FieldType.Text)
    private String summary;

    /**
     * 期刊/发布机构
     */
    @Field(type = FieldType.Text)
    private String journal;

    /**
     * 年份/发布日期
     */
    @Field(type = FieldType.Keyword)
    private String year;

    @Field(type = FieldType.Text)
    private List<String> author;


    @Field(type = FieldType.Text)
    private List<String> journalDivision;


}
