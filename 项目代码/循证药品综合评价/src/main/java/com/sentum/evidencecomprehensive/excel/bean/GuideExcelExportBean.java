package com.sentum.evidencecomprehensive.excel.bean;

import com.alibaba.excel.annotation.ExcelProperty;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;
import lombok.EqualsAndHashCode;

/**
 * 指南导出模版
 */
@EqualsAndHashCode(callSuper = true)
@Data
@ApiModel(description = "指南 excel 实体类")
public class GuideExcelExportBean extends BaseExcelExportBean {
    
    @ApiModelProperty(value = "序号")
    @ExcelProperty(value = "序号", index = 0)
    private String number;
    
    @ApiModelProperty(value = "指南/共识标题")
    @ExcelProperty(value = "指南/共识标题", index = 1)
    private String title;

    @ApiModelProperty(value = "制定者")
    @ExcelProperty(value = "制定者", index = 2)
    private String zdz;

    @ApiModelProperty(value = "指南简介")
    @ExcelProperty(value = "指南简介", index = 3)
    private String nrjs;

    @ApiModelProperty(value = "发布时间")
    @ExcelProperty(value = "发布时间", index = 4)
    private String fbdate;

    
}
