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
 * hta 报告 es 索引
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document(indexName = "cde_index", shards = 3)
public class CdeIndex {
    @Id
    private String id;

//    @Field(type = FieldType.Keyword)
    private String acceptid;

    private String drgnamecn;

    @Field(type = FieldType.Keyword)
    private String drugtype;

    @Field(type = FieldType.Keyword)
    private String registerkind;

    private String companys;

    @Field(type = FieldType.Text)
    private String pdfUrl1;

    @Field(type = FieldType.Text)
    private String indication;

    @Field(type = FieldType.Keyword)
    private List<String> component;

//    @Field(type = FieldType.Auto)
//    private List<String> english_component;
//
//    @Field(type = FieldType.Auto)
//    private List<String> english_component_synonyms;
//
//    @Field(type = FieldType.Auto)
//    private List<String> chinese_component;
//
//    @Field(type = FieldType.Auto)
//    private List<String> chinese_component_synonyms;

    @Field(type = FieldType.Date)
    private String date;
    
    /**
     * 发表时间的long类型 方便排序
     */
    @Field(type = FieldType.Long)
    private Long dateTimeDateTs;
}
