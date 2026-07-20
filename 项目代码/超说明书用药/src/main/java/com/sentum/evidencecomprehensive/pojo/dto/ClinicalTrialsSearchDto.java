package com.sentum.evidencecomprehensive.pojo.dto;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.Arrays;
import java.util.List;

@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel(value = "ClinicalTrialsSearchDto", description = "检索临床试验的dto类")
public class ClinicalTrialsSearchDto {
    @ApiModelProperty("检索id")
    private String id;
    @ApiModelProperty("搜索框输入内容")
    private String searchData;
    @ApiModelProperty("注册开始时间")
    private String startRegistrationTime;
    @ApiModelProperty("注册结束时间")
    private String endRegistrationTime;
    @ApiModelProperty("样本量最小值")
    private Long minSampleSize;
    @ApiModelProperty("样本量最大值")
    private Long maxSampleSize;
    @ApiModelProperty("招募状态多选；默认全选")
    private List<String> recruitmentStatus = Arrays.asList("Not yet recruiting", "Recruiting", "Enrolling by invitation", "Active, not recruiting", "Review", "Suspended", "Terminated", "Completed", "Withdrawn", "Unknown status");
    @ApiModelProperty("试验阶段多选")
    private List<String> testPhase;
    @ApiModelProperty("关联文章多选，0-无关联文献；1-有关联文献；默认全选")
    private List<Integer> associatedArticles = Arrays.asList(0, 1);
    @ApiModelProperty("注册时间排序，0默认值默认排序状态；1正序；2倒序")
    private Integer registrationTimeSort = 0;
    @ApiModelProperty("研究类型，默认全选")
    private List<String> studyType = Arrays.asList("干预性研究", "预防性研究", "诊断试验", "病因学/相关因素研究", "预后研究", "观察性研究", "治疗研究", "基础科学研究", "卫生服务研究", "流行病学研究", "筛查");
    @ApiModelProperty("中英文临床试验：0-中文，1-英文；默认0中文")
    private Integer change = 0;
    @ApiModelProperty("分页-每页大小默认10")
    private Integer pageSize = 10;
    @ApiModelProperty("分页-当前页数默认1")
    private Integer pageNum = 1;
}
