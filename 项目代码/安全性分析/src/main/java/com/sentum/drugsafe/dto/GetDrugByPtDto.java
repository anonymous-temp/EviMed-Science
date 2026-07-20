package com.sentum.drugsafe.dto;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.util.List;

@Data
@ApiModel
public class GetDrugByPtDto {
    @ApiModelProperty("不良反应")
    List<String> pt;
    @ApiModelProperty("按照信号排序 + 1 - 0")
    int sort;
    @ApiModelProperty("页码，从1开始")
    Integer pageNum;
    @ApiModelProperty("每页显示数量")
    Integer pageSize;
    @ApiModelProperty("药品名称")
    String drugName;
}
