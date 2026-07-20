package com.sentum.evidencecomprehensive.domain.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 课题的显示vo类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("课题的显示vo类")
public class QuestionVo {
    @ApiModelProperty("课题id")
    private String id;
    @ApiModelProperty("创建人")
    private String createName;
    @ApiModelProperty("课题名称")
    private String name;
    @ApiModelProperty("创建时间")
    private Long createTime;
    @ApiModelProperty("最后修改时间")
    private Long updateTime;
    @ApiModelProperty("收藏状态：1-收藏；0-未收藏")
    private Integer collectStatus = 0;
    @ApiModelProperty("0-未进行筛选单纯保存；1-以进行报告生成")
    private Integer status;
    @ApiModelProperty("更新提示，true为有更新")
    private Boolean renew;
    @ApiModelProperty("推荐等级")
    private String recommendLevel;
    @ApiModelProperty("证据等级")
    private String evidenceLevel;
    @ApiModelProperty("旧推荐等级")
    private String oldRecommendLevel;
    @ApiModelProperty("旧证据等级")
    private String oldEvidenceLevel;
    
    @ApiModelProperty("true 生成过报告 false 未生成过报告")
    private Boolean exists;
}
