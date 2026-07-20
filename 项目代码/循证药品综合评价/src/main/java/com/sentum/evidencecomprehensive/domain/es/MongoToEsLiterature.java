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
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document(indexName = "literature_index_wsz", shards = 9)
public class MongoToEsLiterature {
    /**
     *文献id6
     */
    @Id
    private String id;
    /**
     * 算法所用的文献标题
     */
    @Field(type = FieldType.Text)
    private String title;

    /**
     * 算法所用的文献标题
     */
    @Field(type = FieldType.Text)
    private String clearTitle;

    /**
     * 文献描述
     */
    @Field(type = FieldType.Text)
    private String summary;

    /**
     * 文献期刊
     */
    @Field(type = FieldType.Text)
    private String journal;
    /**
     * 年份
     */
    @Field(type = FieldType.Keyword)
    private String year;
    /**
     * 文献所属
     */
    @Field(type = FieldType.Keyword)
    private List<Integer> type;
    /**
     * 文献作者
     */
    @Field(type = FieldType.Text)
    private List<String> author;
    /**
     * 作者单位
     */
    @Field(type = FieldType.Keyword)
    private List<String> showAuthorAddress;
    /**
     * 影响因子
     */
    @Field(type = FieldType.Double)
    private Double jcr;

    /**
     * 文献语言，中文zh，英文en
     */
    @Field(type = FieldType.Keyword)
    private String language;

    /**
     * 排序所用时间 后续改为integer
     */
    @Field(type = FieldType.Text)
    private String indexYear;

    /*@Field(type = FieldType.Text)
    private List<String> screenP;

    @Field(type = FieldType.Text)
    private List<String> screenIc;

    @Field(type = FieldType.Text)
    private List<String> titleO;*/

    @Field(type = FieldType.Keyword)
    private List<String> allKeyword;

    @Field(type = FieldType.Keyword)
    private List<String> allKeywordType;
    /**
     * 当前文献所属表
     */
    @Field(type = FieldType.Keyword)
    private String table;
    /**
     * 当前文献的质量
     */
    @Field(type = FieldType.Keyword)
    private String quality;
    /**
     * 研究对象
     */
    @Field(type = FieldType.Keyword)
    private List<String> p;
    /**
     * 实验-对照组
     */
    @Field(type = FieldType.Keyword)
    private List<String> ic;

    @Field(type = FieldType.Keyword)
    private String pdfName;
    /**
     * 文献来源
     */
    @Field(type = FieldType.Keyword)
    private List<String> belong;

    /**
     * 文献发表所在国家
     */
    @Field(type = FieldType.Keyword)
    private List<String> country;

    /**
     * 引用文献数量
     */
    @Field(type = FieldType.Keyword)
    private Integer referencedCount;

    /**
     * 第一作者
     */
    @Field(type = FieldType.Keyword)
    private String firstAuthor;

    /**
     * 第一作者单位
     */
    @Field(type = FieldType.Keyword)
    private String firstAuthorAddress;

    /**
     * 去重文献数量
     */
    @Field(type = FieldType.Integer)
    private Integer dupNum;

    @Field(type = FieldType.Long)
    private Long sampleSize;

    private List<String> themWord;

    @Field(type = FieldType.Text)
    private String tldr;

    @Field(type = FieldType.Text)
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
    @Field(type = FieldType.Text)
    private String result;
    /**
     * 结论
     */
    @Field(type = FieldType.Text)
    private String conclusion;

    /**
     * 1-残缺，0-非残缺
     */
    @Field(type = FieldType.Integer)
    private Integer isIncomplete;
}
