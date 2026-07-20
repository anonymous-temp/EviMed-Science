package com.sentum.evidencecomprehensive.domain.es;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.elasticsearch.annotations.Document;

import java.util.List;

/**
 * 第三个临床试验 elasticSearch的索引
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document(indexName = "clinical_central_index", shards = 3)
public class ThreeClinicalIndex {

    /**
     * id
     */
    @Id
    private String id;

    /**
     * 注册证号
     */
    private String cochraneId;

    /**
     * 题目
     */
    private String title;
    
    /**
     * 年份
     */
    private String year;

    /**
     * 来源
     */
    private String source;

    /**
     * 语言
     */
    private String language;

    /**
     * 
     */
    private List<String> keyword;

}
