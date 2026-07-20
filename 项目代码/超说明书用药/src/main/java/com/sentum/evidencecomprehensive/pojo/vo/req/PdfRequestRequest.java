package com.sentum.evidencecomprehensive.pojo.vo.req;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

/**
 * Description: pdf预览请求类
 */
@Data
@ApiModel("pdf预览请求类")
public class PdfRequestRequest {
    
    @ApiModelProperty("文献Id")
    private String id;

    @ApiModelProperty("课题Id")
    private String questionId;
  
    @ApiModelProperty("请求页大小，默认1")
    private Integer pageSize = 1;
   
    @ApiModelProperty("当前请求页")
    private Integer pageNum = 1;

    @ApiModelProperty("质量评价模块 id")
    private Integer modeId;

    @ApiModelProperty("质量评价模块内 对应的多页 的当前请求页")
    private Integer modePageNum;
}
