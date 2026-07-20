package com.sentum.pojo.dto;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * 最终药品与疾病检索条件
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("用户勾选的药品与疾病数据")
public class DrugAndDiseaseDto {
    @ApiModelProperty("用户勾选的药品的id")
    private List<String> drugIds;
    @ApiModelProperty("用户勾选的疾病名称")
    private List<String> diseases;
}
