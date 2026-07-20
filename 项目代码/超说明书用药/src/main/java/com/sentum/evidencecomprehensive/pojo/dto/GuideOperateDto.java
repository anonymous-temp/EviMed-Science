package com.sentum.evidencecomprehensive.pojo.dto;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * 批量/单个操作指南的dto类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel(value = "GuideOperateDto", description = "批量/单个操作指南的dto类")
public class GuideOperateDto {
    @ApiModelProperty("检索id")
    private String id;
    @ApiModelProperty("需要操作的id的集合")
    private List<String> ids;
    @ApiModelProperty("操作的命令，1-纳入；2-取消纳入；3-排除；4-取消排除；5-收藏；6-取消收藏")
    private Integer operate;
}
