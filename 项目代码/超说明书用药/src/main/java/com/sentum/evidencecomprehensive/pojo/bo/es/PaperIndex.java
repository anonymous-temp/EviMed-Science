package com.sentum.evidencecomprehensive.pojo.bo.es;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.elasticsearch.annotations.Document;

import java.time.LocalDate;
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
     * 新文献类型
     */
    private List<Integer> lastNewType;

    /**
     * 标题
     */
    private String title;

    /**
     * 关键字
     */
    private List<String> keywords;
    private List<String> allKeyword;
    
    private List<String> ic;
    private List<String> p;

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
     * 总结
     */
    private List<String> journalDivision;

    // 判断是否包含指定类型
    public boolean containsType(Integer type) {
        return lastNewType != null && lastNewType.contains(type);
    }

    // 判断是否是近20年
    public boolean isRecent20Years() {
        try {
            int paperYear = Integer.parseInt(year);
            int currentYear = LocalDate.now().getYear();
            return paperYear >= (currentYear - 20);
        } catch (NumberFormatException e) {
            return false;
        }
    }
}
