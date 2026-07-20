package com.sentum.evidencecomprehensive.domain.vo.ws;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/3/10
 */
@Data
@Builder
@AllArgsConstructor
@NoArgsConstructor
public class WSAuthorizedSuccess {
    
    private String token;
    
    private Long uid;
}
