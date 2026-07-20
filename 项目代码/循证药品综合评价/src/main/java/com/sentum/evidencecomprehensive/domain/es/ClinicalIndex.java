package com.sentum.evidencecomprehensive.domain.es;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.elasticsearch.annotations.Document;
import org.springframework.data.elasticsearch.annotations.Field;
import org.springframework.data.elasticsearch.annotations.FieldType;

import java.util.List;

/**
 * 临床试验 elasticSearch的索引
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document(indexName = "clinical_index_gxp", shards = 3)
public class ClinicalIndex {

    /**
     * 临床试验id
     */
    @Id
    private String id;

    /**
     * 临床试验属于分类
     */
    @Field(type = FieldType.Keyword)
    private String belong;

    /**
     * 试验题目
     */
    @Field(type = FieldType.Text)
    private String publicTitle;

    /**
     * 适应症
     */
    @Field(type = FieldType.Keyword)
    private List<String> condition;

    /**
     * 干预措施
     */
    @Field(type = FieldType.Keyword)
    private List<String> intervention;

    /**
     * 注册时间
     */
    @Field(type = FieldType.Keyword)
    private String registerDate;

    /**
     * 样本量
     */
    @Field(type = FieldType.Keyword)
    private String sampleSize;

    /**
     * 招募状态
     */
    @Field(type = FieldType.Keyword)
    private String recruitmentStatus;

    /**
     * 试验阶段
     */
    @Field(type = FieldType.Keyword)
    private String studyPhase;

    /**
     * 关联文章
     */
    @Field(type = FieldType.Keyword)
    private Integer reference;

    /**
     * 研究类型
     */
    @Field(type = FieldType.Keyword)
    private String studyType;
    
    /**
     * 登记号
     */
    @Field(type = FieldType.Keyword)
    private String registerNo;
    
    /**
     * 研究结果
     */
    @Field(type = FieldType.Boolean)
    private String studyResults;
}
