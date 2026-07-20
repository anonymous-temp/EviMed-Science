package com.sentum.evidencecomprehensive.excel.bean;

import com.alibaba.excel.annotation.ExcelProperty;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;
import lombok.EqualsAndHashCode;

/**
 * 临床试验导出模版
 */
@EqualsAndHashCode(callSuper = true)
@Data
@ApiModel(description = "临床试验 excel 实体类")
public class ClinicalExcelExportBean extends BaseExcelExportBean {
    
    @ApiModelProperty(value = "序号")
    @ExcelProperty(value = "序号", index = 0)
    private String number;
    
    @ApiModelProperty(value = "NCT Number")
    @ExcelProperty(value = "NCT Number", index = 1)
    private String registerNo;

    @ApiModelProperty(value = "标题")
    @ExcelProperty(value = "标题", index = 2)
    private String studyTitle;

    @ApiModelProperty(value = "注册日期")
    @ExcelProperty(value = "注册日期", index = 3)
    private String registerDate;
    
    @ApiModelProperty(value = "研究类型")
    @ExcelProperty(value = "研究类型", index = 4)
    private String studyType;
    
    @ApiModelProperty(value = "研究阶段")
    @ExcelProperty(value = "研究阶段", index = 5)
    private String studyPhase;

    @ApiModelProperty(value = "样本量")
    @ExcelProperty(value = "样本量", index = 6)
    private String sampleSize;

    @ApiModelProperty(value = "干预措施")
    @ExcelProperty(value = "干预措施", index = 7)
    private String intervention;

    @ApiModelProperty(value = "研究疾病")
    @ExcelProperty(value = "研究疾病", index = 8)
    private String condition;
}
