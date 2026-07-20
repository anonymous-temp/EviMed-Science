package com.sentum.evidencecomprehensive.excel;

import lombok.Data;

/**
 * Description:
 */
@Data
public class ClinicalBo {
    /**
     * 登记号
     */
    private String registerNo;
    
    /**
     * 研究题目
     */
    private String studyTitle;
    
    /**
     * 注册时间
     */
    private String registerDate;

    /**
     * 试验类型
     */
    private String studyType;
    
    /**
     * 试验阶段
     */
    private String studyPhase;
    
    /**
     * 样本量
     */
    private String sampleSize;
    
    /**
     * 干预措施
     */
    private String intervention;
    
    /**
     * 适应症
     */
    private String condition;
}
