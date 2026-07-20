package com.sentum.evidencecomprehensive.excel.bean;

import com.alibaba.excel.annotation.ExcelProperty;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;
import lombok.EqualsAndHashCode;

/**
 * hta导出模版
 */
@EqualsAndHashCode(callSuper = true)
@Data
@ApiModel(description = "hta excel 实体类")
public class HtaExcelExportBean extends BaseExcelExportBean {
    
    @ApiModelProperty(value = "序号")
    @ExcelProperty(value = "序号", index = 0)
    private String number;
    
    @ApiModelProperty(value = "标题")
    @ExcelProperty(value = "标题", index = 1)
    private String title;

    @ApiModelProperty(value = "来源")
    @ExcelProperty(value = "来源", index = 2)
    private String source;

    @ApiModelProperty(value = "原文链接")
    @ExcelProperty(value = "原文链接", index = 3)
    private String link;
    
    @ApiModelProperty(value = "发布时间")
    @ExcelProperty(value = "发布时间", index = 4)
    private String publishTime;
}
