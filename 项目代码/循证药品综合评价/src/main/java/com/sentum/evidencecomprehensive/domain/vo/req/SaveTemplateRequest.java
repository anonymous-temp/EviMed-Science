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
public class SaveTemplateRequest {
    
    private String id;

    private List<String> prompt;
}
