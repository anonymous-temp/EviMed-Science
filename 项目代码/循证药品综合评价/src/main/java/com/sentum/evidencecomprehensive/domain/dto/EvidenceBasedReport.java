package com.sentum.evidencecomprehensive.domain.dto;

import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import lombok.Data;

/**
 * @Description:
 */
@Data
public class EvidenceBasedReport {
    
    /**
     * 全局唯一id 课题 id
     */
    private String id;
    
    /**
     *  报告标题
     */
    private String title;

    /**
     * 背景
     */
    private String background;

    /**
     * 指南
     */
    private JSONArray guide;

    /**
     * 文献
     */
    private JSONObject literature;

    /**
     * 说明书信息介绍
     */
    private JSONArray instructionInfos;
    
    /**
     * 其他国家说明书信息介绍
     */
    private JSONArray otherInstructionInfos;

    /**
     * 其他属性信息
     */
    private JSONArray otherSourceDrugInfo;
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    

    /**
     * hta 建议图表
     */
    private JSONObject htaReportByVarious;

    /**
     * 报告整体
     */
    private JSONObject evidenceMain;
    
    
    
    /**
     * XX药品名称卫生技术评估（HTA）报告摘要标题
     */
    private String title1;
    
    /**
     * XX药品名称卫生技术评估（HTA）报告正文标题
     */
    private String title2;
    
    /**
     * 说明书信息
     */
    private JSONArray instructions;

    /**
     * 说明书 mongo id List
     */
    private JSONArray instructionsIds;
    
    /**
     * 推荐等级
     */
    private String recommendLevel;
    
    /**
     * 证据等级
     */
    private String evidenceLevel;
    
    /**
     * 卫生技术评估（HTA）报告摘要
     */
    private JSONObject htaDigest;

    /**
     * 卫生技术评估（HTA）报告正文
     */
    private JSONObject htaMain;
    
    /**
     * 不良反应信息
     */
    private JSONObject adverseReaction;
    
    /**
     * 参考文献模块
     */
    private JSONObject bibliography;

    /**
     * 质量评价附录
     */
    private JSONObject paperEditJson;

    
    /**
     * 疾病问题
     */
    private JSONObject generateDiseaseAndTreatmentStatus;

    /**
     * 疾病治疗药品医保收录情况
     */
    private JSONObject searchDrugList;

    

   

   

    /**
     * FARES 数据库信息
     */
    private JSONObject showDBAnalysis;

    /**
     * 政策信息
     */
    private JSONObject showPolicyAnalysis;

    

    /**
     * 伦理问题
     */
    private JSONObject ethic;

    /**
     * 总结
     */
    private JSONObject summarizeBrief;

    /**
     * hta问题
     */
    private JSONObject digestHta;
}
