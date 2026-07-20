package com.sentum.evidencecomprehensive.domain.vo.req;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/4/1
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class HtaReportSearchRequest {
    
    private List<String> ids;
}
