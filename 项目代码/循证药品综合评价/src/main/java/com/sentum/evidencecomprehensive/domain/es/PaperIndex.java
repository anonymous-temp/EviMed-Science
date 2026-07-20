package com.sentum.evidencecomprehensive.domain.es;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.elasticsearch.annotations.Document;

import java.util.List;

/**
 * elasticsearch中文献对应索引
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document(indexName = "literature_index_wsz", shards = 3)
public class PaperIndex {
    /**
     *文献id
     */
    @Id
    private String id;

    /**
     * 文献类型
     */
    private List<Integer> type;

    /**
     * 标题
     */
    private String title;

    /**
     * 关键字
     */
    private List<String> allKeyword;

    /**
     * 文献质量等级
     */
    private String quality;

    /**
     * 简介
     */
    private String tldr;

    /**
     * 作者
     */
    private List<String> author;

    /**
     * 第一作者
     */
    private String firstAuthor;

    /**
     * 文献重复数量
     */
    private String dupNum;

    /**
     * 年份
     */
    private String year;

    /**
     * 语言
     */
    private String language;

    /**
     * 总结
     */
    private String summary;

    /**
     * pdfName
     */
    private String pdfName;

    /**
     * 文献新类型
     */
    private List<Integer> lastNewType;
}
