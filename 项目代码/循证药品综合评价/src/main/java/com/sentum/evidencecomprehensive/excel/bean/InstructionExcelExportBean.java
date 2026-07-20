package com.sentum.evidencecomprehensive.excel.bean;

import com.alibaba.excel.annotation.ExcelProperty;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;
import lombok.EqualsAndHashCode;

/**
 * 说明书导出模版
 */
@EqualsAndHashCode(callSuper = true)
@Data
@ApiModel(description = "excel 实体类")
public class InstructionExcelExportBean extends BaseExcelExportBean {
    
    @ApiModelProperty(value = "药品名称")
    @ExcelProperty(value = "药品名称", index = 0)
    private String drugName;
    
    @ApiModelProperty(value = "英文名称")
    @ExcelProperty(value = "英文名称", index = 1)
    private String enName;

    @ApiModelProperty(value = "商品名称")
    @ExcelProperty(value = "商品名称", index = 2)
    private String commodityName;

    @ApiModelProperty(value = "核准日期")
    @ExcelProperty(value = "核准日期", index = 3)
    private String approvalDate;

    @ApiModelProperty(value = "最新修订日期")
    @ExcelProperty(value = "最新修订日期", index = 4)
    private String lastRevisionDate;

    @ApiModelProperty(value = "成分")
    @ExcelProperty(value = "成分", index = 5)
    private String ingredient;

    @ApiModelProperty(value = "性状")
    @ExcelProperty(value = "性状", index = 6)
    private String characters;

    @ApiModelProperty(value = "规格")
    @ExcelProperty(value = "规格", index = 7)
    private String specifications;

    @ApiModelProperty(value = "用法用量")
    @ExcelProperty(value = "用法用量", index = 8)
    private String usageAndDosage;

    @ApiModelProperty(value = "功能主治/适应症")
    @ExcelProperty(value = "功能主治/适应症", index = 9)
    private String indications;

    @ApiModelProperty(value = "孕妇及哺乳期妇女用药")
    @ExcelProperty(value = "孕妇及哺乳期妇女用药", index = 10)
    private String pregnantWomen;

    @ApiModelProperty(value = "儿童用药")
    @ExcelProperty(value = "儿童用药", index = 11)
    private String childrenMedicine;

    @ApiModelProperty(value = "老年用药")
    @ExcelProperty(value = "老年用药", index = 12)
    private String geriatricMedicine;

    @ApiModelProperty(value = "不良反应")
    @ExcelProperty(value = "不良反应", index = 13)
    private String adverseReaction;

    @ApiModelProperty(value = "禁忌")
    @ExcelProperty(value = "禁忌", index = 14)
    private String taboo;

    @ApiModelProperty(value = "注意事项")
    @ExcelProperty(value = "注意事项", index = 15)
    private String notes;

    @ApiModelProperty(value = "药物相互作用")
    @ExcelProperty(value = "药物相互作用", index = 16)
    private String drugInteraction;

    @ApiModelProperty(value = "药理作用")
    @ExcelProperty(value = "药理作用", index = 17)
    private String pharmacology;

    @ApiModelProperty(value = "药代动力学")
    @ExcelProperty(value = "药代动力学", index = 18)
    private String pharmacokinetics;

    @ApiModelProperty(value = "药物过量")
    @ExcelProperty(value = "药物过量", index = 19)
    private String overdose;

    @ApiModelProperty(value = "贮藏")
    @ExcelProperty(value = "贮藏", index = 20)
    private String storage;

    @ApiModelProperty(value = "包装")
    @ExcelProperty(value = "包装", index = 21)
    private String pack;

    @ApiModelProperty(value = "有效期")
    @ExcelProperty(value = "有效期", index = 22)
    private String indate;

    @ApiModelProperty(value = "执行标准")
    @ExcelProperty(value = "执行标准", index = 23)
    private String executiveStandard;

    @ApiModelProperty(value = "批准文号")
    @ExcelProperty(value = "批准文号", index = 24)
    private String approvalNumber;

    @ApiModelProperty(value = "生产企业")
    @ExcelProperty(value = "生产企业", index = 25)
    private String manufacturer;
}
