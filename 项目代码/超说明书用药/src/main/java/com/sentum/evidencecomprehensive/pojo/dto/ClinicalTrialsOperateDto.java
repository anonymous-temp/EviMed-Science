package com.sentum.evidencecomprehensive.pojo.dto;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * 批量/单个操作临床试验的dto类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel(value = "ClinicalTrialsOperateDto", description = "批量/单个操作临床试验的dto类")
public class ClinicalTrialsOperateDto {
    @ApiModelProperty("检索id")
    private String id;
    @ApiModelProperty("需要操作的id的集合（登记号）")
    private List<String> ids;
    @ApiModelProperty("操作的命令，1-纳入；2-排除；0-取消纳排")
    private Integer operate;
}
