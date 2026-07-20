package com.sentum.evidencecomprehensive.domain.vo.evaluate;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.util.List;

/**
 * Description: page 和 四角坐标对应关系实体类
 * DateTime: 2024/5/6
 */
@Data
@ApiModel(value = "page 和 四角坐标对应关系实体类")
public class PageBboxVo {
    
    @ApiModelProperty(value = "页")
    private String page;
    
    @ApiModelProperty(value = "页所在的四角坐标")
    private List<String> bbox;
}
