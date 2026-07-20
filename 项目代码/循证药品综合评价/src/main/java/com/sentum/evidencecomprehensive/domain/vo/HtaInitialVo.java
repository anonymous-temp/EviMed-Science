package com.sentum.evidencecomprehensive.domain.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.util.List;

/**
 * Description: hta 搜索栏目初始数据
 */
@Data
@ApiModel("hta 搜索栏目初始数据实体类")
public class HtaInitialVo {
    
    @ApiModelProperty("搜索栏-国家")
    private List<CountryVo> countries;
}
