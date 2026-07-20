package com.sentum.evidencecomprehensive.excel.bean;

import com.alibaba.excel.annotation.ExcelProperty;
import lombok.Data;

import java.io.Serializable;

/**
 * 自用 excel 导入实体类
 */
@Data
public class SelfUseBatchImportExcelBean implements Serializable {

    private static final long serialVersionUID = -8649072826732307428L;
    
//    @NotBlank(message = "[文献ID]不能为空")
    @ExcelProperty("文献ID")
    private String paperId;

    @ExcelProperty("作者")
    private String author;

    @ExcelProperty("发表年份")
    private String year;
    
    @ExcelProperty("试验组干预措施")
    private String treatmentMeasure;

    @ExcelProperty("对照组干预措施")
    private String contrastMeasure;
    
    @ExcelProperty("研究结果")
    private String result;

    @ExcelProperty("研究结论")
    private String conclusion;
}

