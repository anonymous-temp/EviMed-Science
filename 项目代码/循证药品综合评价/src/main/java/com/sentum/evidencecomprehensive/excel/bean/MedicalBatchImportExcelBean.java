package com.sentum.evidencecomprehensive.excel.bean;

import com.alibaba.excel.annotation.ExcelProperty;
import lombok.Data;

import java.io.Serializable;

/**
 * 自用 excel 导入实体类
 */
@Data
public class MedicalBatchImportExcelBean implements Serializable {

    private static final long serialVersionUID = -8649072826732307428L;
    
    @ExcelProperty("药品名称")
    private String drugName;

    @ExcelProperty("剂型")
    private String dosageForm;

    @ExcelProperty("价格")
    private String price;
    
    @ExcelProperty("医保类型")
    private String medical_type;

    @ExcelProperty("备注")
    private String payLimit;
    
    @ExcelProperty("药品名称1")
    private String name1;

    @ExcelProperty("药品名称2")
    private String name2;

    @ExcelProperty("药品名称3")
    private String name3;

    @ExcelProperty("药品名称4")
    private String name4;

    @ExcelProperty("药品名称5")
    private String name5;

    @ExcelProperty("药品名称6")
    private String name6;

    @ExcelProperty("药品名称7")
    private String name7;

    @ExcelProperty("药品名称8")
    private String name8;

    @ExcelProperty("药品名称9")
    private String name9;
}

