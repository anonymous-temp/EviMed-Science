package com.sentum.evidencecomprehensive.controller;

import com.sentum.evidencecomprehensive.domain.vo.DataResult;
import com.sentum.evidencecomprehensive.service.DeepSeekService;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiResponse;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/2/10
 */

@Api("deepSeek模块")
@RequestMapping("capi/deepSeek/public")
@RestController
public class DeepSeekController {
    
    @Autowired
    private DeepSeekService deepSeekService;
    
    @PostMapping("/test")
    public DataResult test(){
        deepSeekService.searchGuideTop5("瑞加诺生", "冠状动脉狭窄");
        return DataResult.ok();
    }
}
