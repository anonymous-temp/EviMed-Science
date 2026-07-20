package com.sentum.pojo.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("返回前台的药品评价其他信息使用的vo类")
public class OtherVo {
    @ApiModelProperty(value = "生产厂商状况")
    private String manufacturers;
    @ApiModelProperty(value = "全球使用情况")
    private String globalUsage;
}
