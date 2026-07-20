package com.sentum.evidencecomprehensive.domain.vo.resp;

import io.swagger.annotations.ApiModel;
import lombok.Data;

import java.util.List;
import java.util.Map;

/**
 * 临床实验VO类
 * @author zgm
 */
@Data
@ApiModel("临床试验返回vo")
public class ClinicalTrialsResponse {
    /**
     * 登记号
     */
    private String registerNo;
    /**
     * 原文链接
     */
    private String url;
    /**
     * 实验题目
     */
    private String publicTitle;
    /**
     * 试验类型
     */
    private String recruitmentStatus;
    /**
     * 注册时间
     */
    private String registerDate;
    /**
     * 试验阶段
     */
    private String studyPhase;
    /**
     * 样本量
     */
    private String sampleSize;
    /**
     * 干预措施
     */
    private List<String> intervention;
    /**
     * 适应症
     */
    private List<String> condition;
    /**
     * 关联文章
     */
    private List<Map<String, String>> reference;
    /**
     * 纳入状态，1-纳入；0-未操作；2 排除
     */
    private Integer inclusionStatus = 0;
    
    //@ApiModelProperty("订阅状态，true-订阅；0-未订阅")
    //private Boolean subscribe;

    /**
     * 研究结果
     */
    private Boolean studyResults;
    /**
     * 研究类型
     */
    private String studyType;
    /**
     * 实施单位
     */
    private String primarySponsor;
}
