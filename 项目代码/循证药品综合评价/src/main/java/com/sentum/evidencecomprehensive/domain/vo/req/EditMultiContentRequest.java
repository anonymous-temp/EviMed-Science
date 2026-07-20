package com.sentum.evidencecomprehensive.domain.vo.req;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/3/14
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class EditMultiContentRequest {
    
    private String id;

    private Integer type;
    
    private String content;
}
