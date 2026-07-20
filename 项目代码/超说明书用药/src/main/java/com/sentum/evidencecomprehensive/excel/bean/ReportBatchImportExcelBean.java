package com.sentum.evidencecomprehensive.excel.bean;

import com.alibaba.excel.annotation.ExcelProperty;
import lombok.Data;

import java.io.Serializable;

/**
 * 自用 excel 导入实体类
 */
@Data
public class ReportBatchImportExcelBean implements Serializable {

    private static final long serialVersionUID = -8649072826732307428L;
    
    @ExcelProperty("i1")
    private String i1;
    
    @ExcelProperty("i1扩展词")
    private String i1Expanded;

    @ExcelProperty("i2")
    private String i2;
    
    @ExcelProperty("i2扩展词")
    private String i2Expanded;

    @ExcelProperty("i3")
    private String i3;
    
    @ExcelProperty("i3扩展词")
    private String i3Expanded;

    @ExcelProperty("p1")
    private String p1;
    
    @ExcelProperty("p1扩展词")
    private String p1Expanded;

    @ExcelProperty("p2")
    private String p2;
    
    @ExcelProperty("p2扩展词")
    private String p2Expanded;

    @ExcelProperty("p3")
    private String p3;
    
    @ExcelProperty("p3扩展词")
    private String p3Expanded;

}

