package com.sentum.evidencecomprehensive.domain.dto.feign;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2024/4/16
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class OutlineDTO {
    /**
     * 请求参数
     */
    private String question;
    /**
     * 开始年份
     */
    private Integer startYear;
    /**
     * 结束年份
     */
    private Integer endYear;
}

