package com.sentum.evidencecomprehensive.domain.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

import java.util.List;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/3/28
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evidence_report_content")
public class ReportContent {

    /**
     * 课题 id
     */
    private String id;

    /**
     * 初始版本
     */
    private String content;

    /**
     * 修改之后
     */
    private String contChange;

    /**
     * 报告右侧文献内容
     */
    private String paperRight;

    /**
     * 修改内容 - 带标签
     */
    private String contHtml;

    /**
     * word 下载使用
     */
    private String wordHtml;

    /**
     * 更改大纲
     */
    private boolean changeOutline = false;

    /**
     * 点选方式
     */
    private String clickMode;

    /**
     * 当前正在执行模块
     */
    private String modeIng;

    /**
     * 完成进度
     */
    private Integer completeness;
    
    /**
     * 用户 id
     */
    private Long userId;

    /**
     * 报告标题
     */
    private String title;

    /**
     * 报告创建时间
     */
    private String reportCreate;

    private Long timeStamp;

    /**
     * 逻辑删除 0存在 1删除
     */
    private String delete = "0";

    /**
     * 大纲标题 类型 
     */
    private String outlineType;

    /**
     * 是否经过了第一次纳入
     */
    private Boolean firstInclude = false;

    /**
     * 大纲标题
     */
    private String outlineTitle;

    private List<String> tidyIndications;

    private List<String> tidyDrugs;

    private List<String> toWord;

}
