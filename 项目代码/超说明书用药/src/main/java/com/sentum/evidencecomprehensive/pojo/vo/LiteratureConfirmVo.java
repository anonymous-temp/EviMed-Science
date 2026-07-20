package com.sentum.evidencecomprehensive.pojo.vo;

import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2024/10/15
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class LiteratureConfirmVo {

    @ApiModelProperty("文献id")
    private String id;

    @ApiModelProperty("文献标题")
    private String title;

    @ApiModelProperty("摘要")
    private String summary;

    

    @ApiModelProperty("文献类型")
    private String type;

    @ApiModelProperty("核心期刊")
    private String journal;

    @ApiModelProperty("影响因子")
    private Double jcr;
    
    

    @ApiModelProperty("期刊")
    private String contentType;
}
