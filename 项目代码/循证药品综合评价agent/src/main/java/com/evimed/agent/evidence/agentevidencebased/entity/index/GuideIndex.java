package com.evimed.agent.evidence.agentevidencebased.entity.index;

import com.evimed.agent.evidence.agentevidencebased.entity.annotation.EsDocument;
import lombok.Data;

import java.util.List;

/**
 * 指南检索elasticsearch
 */
@Data
@EsDocument(index = "guide_data_index12")
public class GuideIndex {
    /**
     * 指南id
     */
    private String id;
    /**
     * 指南年份
     */
    private String ysar;
    /**
     * 指南标题
     */
    private String title;
    /**
     * 指南类型
     */
    private String wxlx;
    /**
     * 指南发布日期
     */
    private String fbdate;
    /**
     * 发布时间转换为时间戳
     */
    private Long dateTs;
    private String dbName;
    /**
     * pdf名称
     */
    private String pdf_name;
    /**
     * 内容介绍
     */
    private String nrjs;
    /**
     * 制定者
     */
    private String zdz;
    /**
     * 制定者类型
     */
    private String zdzType;
    /**
     * 指南关键字
     */
    private List<String> keywords;
    /**
     * 原始直接爬取指南关键字
     */
    private List<String> originKeyword;
    /**
     * 语言 zh 中文 en 英语
     */
    private String language;
    /**
     * 指南评分
     */
    private String score = "-1";
    /**
     * 指南原文
     */
    private String pdf_txt;
    /**
     * 指南出处  期刊
     */
    private String cc;
    /**
     * 指南提取的最小代码块
     */
    private List<String> blocks;

    /**
     * 1-文献类型指南；0-指南
     */
    private Integer isPaper;
}
