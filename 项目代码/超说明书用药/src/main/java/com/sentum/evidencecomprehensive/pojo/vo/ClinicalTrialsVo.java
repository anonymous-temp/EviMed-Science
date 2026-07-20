package com.sentum.evidencecomprehensive.pojo.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.util.List;
import java.util.Map;

/**
 * 临床实验VO类
 * @author zgm
 */
@Data
@ApiModel("临床试验返回vo")
public class ClinicalTrialsVo {
    @ApiModelProperty("登记号")
    private String registerNo;
    @ApiModelProperty("该临床试验的原文链接")
    private String url;
    @ApiModelProperty("实验题目")
    private String publicTitle;
    @ApiModelProperty("招募状态")
    private String recruitmentStatus;
    @ApiModelProperty("注册时间")
    private String registerDate;
    @ApiModelProperty("试验阶段")
    private String studyPhase;
    @ApiModelProperty("样本量")
    private String sampleSize;
    @ApiModelProperty("干预措施")
    private List<String> intervention;
    @ApiModelProperty("适应症")
    private List<String> condition;
    @ApiModelProperty("关联文章，集合的形式，一个临床试验可能存在多个关联文章")
    private List<Map<String, String>> reference;
    @ApiModelProperty("纳入状态，1-纳入；0-未操作；2 排除")
    private Integer inclusionStatus = 0;
    //@ApiModelProperty("订阅状态，true-订阅；0-未订阅")
    //private Boolean subscribe;
    @ApiModelProperty("研究结果")
    private Boolean studyResults;
    @ApiModelProperty("研究类型")
    private String studyType;
    @ApiModelProperty("实施单位")
    private String primarySponsor;
}
