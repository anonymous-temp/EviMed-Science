package com.sentum.evidencecomprehensive.pojo.vo.req;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import javax.validation.constraints.NotBlank;
import javax.validation.constraints.NotNull;

@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel(value = "GuideInitialRequest", description = "指南导航栏初始数据实体类")
public class GuideInitialRequest {
    @NotNull
    @NotBlank
    @ApiModelProperty("检索id")
    private String id;
    
    private Integer operateType = 0;
    
    private String search;
}
