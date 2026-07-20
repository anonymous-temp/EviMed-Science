package com.sentum.evidencecomprehensive.excel.bean;

import com.alibaba.excel.annotation.ExcelProperty;
import com.sentum.evidencecomprehensive.excel.custom.ListToStringConverter;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;
import lombok.EqualsAndHashCode;

import java.util.List;

/**
 * 文献导出模版
 */
@EqualsAndHashCode(callSuper = true)
@Data
@ApiModel(description = "excel 实体类")
public class PaperExcelExportBean extends BaseExcelExportBean {
    
    @ApiModelProperty(value = "序号")
    @ExcelProperty(value = "序号", index = 0)
    private String number;
    
    @ApiModelProperty(value = "标题")
    @ExcelProperty(value = "标题", index = 1)
    private String title;

    @ApiModelProperty(value = "作者")
    @ExcelProperty(value = "作者", index = 2, converter = ListToStringConverter.class)
    private List<String> author;

    @ApiModelProperty(value = "摘要")
    @ExcelProperty(value = "摘要", index = 3)
    private String summary;

    @ApiModelProperty(value = "期刊")
    @ExcelProperty(value = "期刊", index = 4)
    private String journal;

    @ApiModelProperty(value = "年份")
    @ExcelProperty(value = "年份", index = 5)
    private String year;

    @ApiModelProperty(value = "影响因子")
    @ExcelProperty(value = "影响因子", index = 6)
    private Double jcr;

    @ApiModelProperty(value = "核心期刊")
    @ExcelProperty(value = "核心期刊", index = 7)
    private String coreJournal;
}
