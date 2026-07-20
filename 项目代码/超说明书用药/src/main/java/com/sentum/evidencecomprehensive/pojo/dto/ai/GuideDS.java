package com.sentum.evidencecomprehensive.pojo.dto.ai;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/2/19
 */
@AllArgsConstructor
@NoArgsConstructor
@Data
public class GuideDS {

    /**
     * 指南标题
     */
    private String title;

    /**
     * 重点章节内容 or 相关章节内容 or 关键内容 or 相关内容
     */
    private String content;

    /**
     * 作者
     */
    private String author;

    /**
     * 指南链接
     */
    private String url;

    /**
     * 指南发布时间
     */
    private String publish;

    /**
     * organ
     */
    private String organ;
}
