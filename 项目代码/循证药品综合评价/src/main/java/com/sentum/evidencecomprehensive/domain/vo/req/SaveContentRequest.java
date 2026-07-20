package com.sentum.evidencecomprehensive.domain.vo.req;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/3/14
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class SaveContentRequest {
    
    private String id;

    private String contChange;

    /**
     * 前端编辑后使用
     */
    private String contHtml;

    /**
     * word 下载使用
     */
    private String wordHtml;
}
