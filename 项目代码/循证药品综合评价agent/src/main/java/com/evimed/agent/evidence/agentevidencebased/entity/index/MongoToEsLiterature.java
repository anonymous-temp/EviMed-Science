package com.evimed.agent.evidence.agentevidencebased.entity.index;

import com.evimed.agent.evidence.agentevidencebased.entity.annotation.EsDocument;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;

import java.util.List;

/**
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@EsDocument(index = "literature_index_wsz")
public class MongoToEsLiterature {
    /**
     *文献id6
     */
    @Id
    private String id;
    /**
     * 算法所用的文献标题
     */
    private String title;

    /**
     * 算法所用的文献标题
     */
    private String clearTitle;

    /**
     * 文献描述
     */
    private String summary;

    /**
     * 文献期刊
     */
    private String journal;
    /**
     * 年份
     */
    private String year;
    /**
     * 文献所属
     */
    private List<Integer> type;
    private List<Integer> lastNewType;
    /**
     * 文献作者
     */
    private List<String> author;
    /**
     * 作者单位
     */
    private List<String> showAuthorAddress;
    /**
     * 影响因子
     */
    private Double jcr;

    /**
     * 文献语言，中文zh，英文en
     */
    private String language;

    /**
     * 排序所用时间 后续改为integer
     */
    private String indexYear;

    private List<String> allKeyword;

    private List<String> allKeywordType;
    /**
     * 当前文献所属表
     */
    private String table;
    /**
     * 当前文献的质量
     */
    private String quality;
    /**
     * 研究对象
     */
    private List<String> p;
    /**
     * 实验-对照组
     */
    private List<String> ic;

    private String pdfName;
    /**
     * 文献来源
     */
    private List<String> belong;

    /**
     * 文献发表所在国家
     */
    private List<String> country;

    /**
     * 引用文献数量
     */
    private Integer referencedCount;

    /**
     * 第一作者
     */
    private String firstAuthor;

    /**
     * 第一作者单位
     */
    private String firstAuthorAddress;

    /**
     * 去重文献数量
     */
    private Integer dupNum;

    private Long sampleSize;

    private List<String> themWord;

    private String tldr;

    private String titleQuestion;

    /**
     * 是否为核心期刊
     */
    private List<String> journalDivision;

    /**
     * 省份信息
     */
    private List<String> authorRegion;
    /**
     * 结果
     */
    private String result;
    /**
     * 结论
     */
    private String conclusion;

    /**
     * 1-残缺，0-非残缺
     */
    private Integer isIncomplete;
}
