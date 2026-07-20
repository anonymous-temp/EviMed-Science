package com.sentum.evidencecomprehensive.domain.vo.req;

import com.sentum.evidencecomprehensive.domain.dto.PaperModelConditionDTO;
import com.sentum.evidencecomprehensive.domain.dto.PaperPICOConditionDTO;
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
@ApiModel(value = "PaperInitialRequest", description = "文献导航栏初始数据实体类")
public class PaperInitialRequest {
    @NotNull
    @NotBlank
    @ApiModelProperty("检索id")
    private String id;
    @ApiModelProperty("操作类型 1、纳入 2、排除 0、默认")
    private String type;
    @ApiModelProperty("内部PICO检索条件")
    private PaperPICOConditionDTO paperPICOConditionDTO;
    @ApiModelProperty("内部高级检索检索条件")
    private PaperModelConditionDTO paperModelConditionDTO;
}
