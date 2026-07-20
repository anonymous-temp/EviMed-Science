package com.sentum.evidencecomprehensive.pojo.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Description:
 */

@Data
@NoArgsConstructor
@AllArgsConstructor
public class QuestionDto {

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
