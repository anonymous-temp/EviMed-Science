package com.sentum.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.elasticsearch.annotations.Document;
import org.springframework.data.elasticsearch.annotations.Field;
import org.springframework.data.elasticsearch.annotations.FieldType;


/**
 * 用药助手说明书 es 索引
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
//@Document(indexName = "instructions_use_index", shards = 3)
@Document(indexName = "instructions_use_index", shards = 3)
public class InstructionsUseIndex {
    
    @Id
    private String id;

    private String simpleGenericNames;
    
    private String genericNames;

    private String simpleEnglishName;

    private String englishName;

    /**
     * 商品名
     */
    private String simpleTradeNames;

    /**
     * 也是商品名
     */
    private String tradeNames;

    @Field(type = FieldType.Text)
    private String indication;

    @Field(type = FieldType.Text)
    private String simpleIndication;

    /**
     * 规格
     */
    private String specifications;

    /**
     * 用法用量
     */
    private String usage;

    /**
     * 剂型
     */
    private String dosageForm;
    
    @Field(type = FieldType.Text)
    private String taboo;

    @Field(type = FieldType.Keyword)
    private String pdf_name;

    private String enterpriseName;
    
    /**
     * 修订日期
     */
    @Field(type = FieldType.Keyword)
    private String revisionDate;

    /**
     * 批准日期
     */
    @Field(type = FieldType.Keyword)
    private String approveDate;
    
    private String approveCode;
    
    private Boolean medicineUsePdf = true;

    @Field(type = FieldType.Keyword)
    private String source;

    private String duplication;
}
