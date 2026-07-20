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
public class ReferenceDrugDto {
    @ApiModelProperty("用户勾选的药品的id，作用进行去重")
    private String drugId;
    @ApiModelProperty("用户勾选的疾病类型")
    private String disease;
    //@ApiModelProperty("用户多选的药品名称")
    //private List<String> drugList;
    @ApiModelProperty("用户多选的药品名称")
    private List<String> drugs; 
    @ApiModelProperty("每页大小")
    private Integer pageSize;
    @ApiModelProperty("当前页")
    private Integer pageNum;
    @ApiModelProperty("在列表页用户输入的检索条件")
    private String searchWord;
}
