package com.sentum.evidencecomprehensive.domain.vo.req;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.web.bind.annotation.RequestParam;

import java.util.List;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/3/14
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class GenTemplateRequest {
    
    private String id;

    private String source = "pc";

//    private 
}
