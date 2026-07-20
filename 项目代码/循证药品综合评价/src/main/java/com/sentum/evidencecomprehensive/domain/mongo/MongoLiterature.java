package com.sentum.evidencecomprehensive.domain.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;

import java.util.List;
import java.util.Map;

/**
 * 新检索架构中mongo中文献的对应实体类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class MongoLiterature {
    /**
     *文献id
     */
    @Id
    private String id;
    /**
     * 文献标题
     */
    private String title;

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

    /**
     * 新文献 类型
     */
    private List<Integer> lastNewType;
    private List<Integer> zteNewtype;
    
    /**
     * 结局指标
     */
    private List<String> outType;
    /**
     * 文献作者
     */
    private List<String> author;
    //*******************************************
    /**
     * 作者单位
     */
    private List<String> authorFacility;
    //********************************************
    /**
     * 影响因子
     */
    private Double jcr;

    /**
     * 文献来源的url
     */
    private List<String> url;

    /**
     * 文献语言，中文zh，英文en
     */
    private String language;

    /**
     * 结论句
     */
    private String conclusion;

    /**
     * 样本量
     */
    private Long sampleSize;

    /**
     * 质量等级
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

    /**
     * 结局指标
     */
    private List<String> o;

    private String objective;


    private String result;

    /**
     * 期刊简写
     */
    private String abbreviatedJournal;

    /**
     * 期刊全写
     */
    private String fullJournal;
    /**
     * 原文链接🔗
     */
    private String mainUrl;

    private List<String> allKeyword;

    /**
     * 关键词的类型
     */
    private List<String> allKeywordType;

    private String pdfName;
    //***********************************************
    /**
     * 卷
     */
    private List<String> volume;
    /**
     * 期
     */
    private List<String> issue;
    /**
     * 页码
     */
    private String pages;
    /**
     * doi
     */
    private List<String> doi;
    /**
     * 文献类型
     */
    private List<String> publicationType;
    /**
     * 期刊ISSN号
     */
    private List<String> issn;
    /**
     * 文献来源
     */
    private List<String> belong;
    /**
     * 出版国家
     */
    private List<String> countryOfPublication;
    /**
     * method
     */
    private String method;

    /**
     * country
     */
    private List<String> country;

    //******************20230102新加字段**************************

    /**
     * 记录文献属于哪个核心的字段------中文文献特有字段
     */
    private List<String> recognizedKernelJournals;

    /**
     * 更多链接
     */
    private Map<String, String> urlDict;

    /**
     * 重复文献的来源及数量
     */
    private String dupBelongNums;

    /**
     * 引用文献数量
     */
    private Integer referencedCount;

    /**
     * 文献摘要的简写---英文文献特有
     */
    private String tldr;

    /**
     * 英文文献分区---英文文献特有
     */
    private List<String> journalDivision;

    /**
     * 引用文献id的集合
     */
    private List<String> referencesList;

    /**
     * 被引用文献id的集合
     */
    private List<String> quotedList;

    /**
     * 只是excelbean会用到
     */
    private String coreJournal;

    
    //增加经济学文献的项目解析数据
    /**
     * 分析国家
     */
    private String economicsResearchCountry;
    /**
     * 评价方法
     */
    private String economicsEvaluationMethods;
    /**
     * 研究角度
     */
    private String economicsResearchPerspective;
    /**
     * 研究时限
     */
    private String economicsStudyTime;
    /**
     * 干预对照
     */
    private String economicsIC;
    /**
     * 结局指标
     */
    private String economicsO;
    /**
     * 研究结果
     */
    private String economicsResult;
    /**
     * 研究结论
     */
    private String economicsConclusion;
}
