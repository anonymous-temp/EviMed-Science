package com.sentum.pojo.dto;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * 参比药物的请求类
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("参比药物的请求类")
public class ReferenceDrugAllDto {
    @ApiModelProperty("药品类别")
    private String type;
    @ApiModelProperty("用户多选的药品名称")
    private List<String> drugs;
    @ApiModelProperty("每页大小")
    private Integer pageSize;
    @ApiModelProperty("当前页")
    private Integer pageNum;
    @ApiModelProperty("在列表页用户输入的检索条件")
    private String searchWord;
}
