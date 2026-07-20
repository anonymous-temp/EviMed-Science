package com.sentum.evidencecomprehensive.domain.es;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.elasticsearch.annotations.Document;
import org.springframework.data.elasticsearch.annotations.Field;
import org.springframework.data.elasticsearch.annotations.FieldType;


/**
 * hta 报告 es 索引
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document(indexName = "hta_report_index", shards = 9)
//@Document(indexName = "hta_report_index_20250731", shards = 9)
public class HtaReportIndex {
    @Id
    private String id;
    /**
     * pdf标题
     */
    private String title;
    /**
     * name 就是 title keyword 类型
     */
    @Field(type = FieldType.Keyword)
    private String name;
    /**
     * 链接
     */
    private String link;
    /**
     * 来源-国家
     */
    private String source;
    /**
     * 来源-国家完整
     */
    @Field(type = FieldType.Keyword)
    private String sourceFull;
    /**
     * 全文
     */
    private String fullText;

    /**
     * 中文全文
     */
    private String zhFullText;
    /**
     * pdf名
     */
    private String pdfName;
    /**
     * pdf链接
     */
    private String pdfNameUrl;
    
    /**
     * 是否存在 pdf
     */
    private int existsFlag;

    /**
     * 发表时间的long类型 方便排序
     */
    @Field(type = FieldType.Long)
    private Long publishTimeDateTs;

    /**
     * 发表时间
     */
    @Field(type = FieldType.Keyword)
    private String publishTime;
    
}
